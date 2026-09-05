-- A completed restore must stay quiescent. The scheduled coordinator may keep
-- calling this function after the restored branch becomes the serving branch,
-- but new live deletion markers belong to the ordinary deletion path.
CREATE OR REPLACE FUNCTION public.begin_restore_replay(
  requested_branch_id text,
  requested_at timestamptz,
  require_verification boolean DEFAULT false
)
RETURNS TABLE (deletion_kind text, opaque_entity_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE replay_started boolean := false;
BEGIN
  IF requested_branch_id !~ '^br-[A-Za-z0-9_-]{1,120}$' THEN
    RAISE invalid_parameter_value;
  END IF;
  INSERT INTO public.restore_readiness(
    singleton, branch_id, state, started_at, verification_required,
    api_keys_revoked, api_key_digests_cleared
  )
  VALUES (
    true, requested_branch_id, 'replaying', requested_at,
    require_verification, 0, 0
  )
  ON CONFLICT (singleton) DO UPDATE SET branch_id = excluded.branch_id,
    state = 'replaying', started_at = excluded.started_at, completed_at = NULL,
    marker_count = NULL, deleted_entity_count = NULL, expired_record_count = NULL,
    api_keys_revoked = 0, api_key_digests_cleared = 0,
    verification_required = excluded.verification_required,
    rls_probe_first_account_id = NULL, rls_probe_second_account_id = NULL
  WHERE restore_readiness.branch_id IS DISTINCT FROM excluded.branch_id
    OR restore_readiness.state = 'replaying'
  RETURNING true INTO replay_started;

  IF replay_started IS DISTINCT FROM true THEN RETURN; END IF;
  RETURN QUERY
    SELECT 'whatsapp_connection'::text, connections.id FROM public.whatsapp_connections connections
    UNION ALL
    SELECT 'personal_account'::text, accounts.id FROM public.personal_accounts accounts;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.is_restore_replay_complete(requested_branch_id text)
RETURNS boolean LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.restore_readiness AS readiness
    WHERE readiness.singleton
      AND readiness.branch_id = requested_branch_id
      AND readiness.state IN ('ready', 'awaiting_verification', 'drill_verified')
  )
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.is_restore_replay_complete(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.is_restore_replay_complete(text)
  TO whatsapp_restore_runtime;
--> statement-breakpoint

-- Restore replay can remove a Connection row before current provider cleanup
-- has finished. Retain only the opaque marker-to-Setup relationship needed for
-- the deletion coordinator to finish that continuation safely.
CREATE TABLE public.restore_connection_deletion_continuations (
  deletion_marker_id text PRIMARY KEY
    REFERENCES public.deleted_whatsapp_connection_handles (deletion_marker_id)
    ON DELETE CASCADE,
  personal_account_id uuid NOT NULL,
  connection_setup_id text NOT NULL,
  requested_at timestamptz NOT NULL,
  FOREIGN KEY (personal_account_id, connection_setup_id)
    REFERENCES public.connection_setups (personal_account_id, id)
    ON DELETE CASCADE
);
--> statement-breakpoint
REVOKE ALL ON public.restore_connection_deletion_continuations FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.list_whatsapp_connection_deletion_candidates(
  observed_at timestamptz,
  requested_limit integer
)
RETURNS TABLE (
  deletion_marker_id text,
  requested_at timestamptz,
  deadline_at timestamptz,
  deadline_risk boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN
    RAISE EXCEPTION 'invalid Connection Deletion candidate limit';
  END IF;
  RETURN QUERY
  SELECT candidates.deletion_marker_id, candidates.requested_at,
    candidates.requested_at + interval '24 hours',
    observed_at >= candidates.requested_at + interval '23 hours'
  FROM (
    SELECT connections.deletion_marker_id,
      connections.deletion_requested_at AS requested_at, 0 AS priority
    FROM public.whatsapp_connections AS connections
    WHERE connections.state = 'deleting'
    UNION ALL
    SELECT continuations.deletion_marker_id, continuations.requested_at, 1 AS priority
    FROM public.restore_connection_deletion_continuations AS continuations
  ) AS candidates
  ORDER BY candidates.priority, candidates.requested_at, candidates.deletion_marker_id
  LIMIT requested_limit;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.confirm_whatsapp_connection_provider_absence(
  requested_marker_id text,
  confirmed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE continuation public.restore_connection_deletion_continuations%ROWTYPE;
BEGIN
  UPDATE public.whatsapp_connections AS connections
  SET provider_absence_confirmed_at = COALESCE(
    connections.provider_absence_confirmed_at,
    confirmed_at
  )
  WHERE connections.deletion_marker_id = requested_marker_id
    AND connections.state = 'deleting'
    AND confirmed_at >= connections.deletion_requested_at;
  IF FOUND THEN RETURN true; END IF;

  SELECT pending.* INTO continuation
  FROM public.restore_connection_deletion_continuations AS pending
  WHERE pending.deletion_marker_id = requested_marker_id
    AND confirmed_at >= pending.requested_at
  FOR UPDATE;
  IF FOUND THEN
    DELETE FROM public.whatsapp_number_reservations AS reservations
    WHERE reservations.personal_account_id = continuation.personal_account_id
      AND reservations.connection_setup_id = continuation.connection_setup_id;
    DELETE FROM public.connection_setups AS setups
    WHERE setups.personal_account_id = continuation.personal_account_id
      AND setups.id = continuation.connection_setup_id;
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.deleted_whatsapp_connection_handles AS deleted
    WHERE deleted.deletion_marker_id = requested_marker_id
  );
END
$function$;
--> statement-breakpoint

-- Connection Deletion destroys only the selected Connection key. The Personal
-- Account key remains available for other Connections and future Setups.
CREATE OR REPLACE FUNCTION public.replay_restore_deletion(
  requested_kind text, requested_entity_id uuid, requested_marker_id text,
  requested_at timestamptz
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE selected_account_id uuid;
DECLARE selected_setup_id text;
BEGIN
  IF requested_marker_id !~ '^[a-f0-9]{64}$'
    OR requested_kind NOT IN ('personal_account', 'whatsapp_connection') THEN
    RAISE invalid_parameter_value;
  END IF;
  IF requested_kind = 'personal_account' THEN
    selected_account_id := requested_entity_id;
  ELSE
    SELECT personal_account_id, connection_setup_id
    INTO selected_account_id, selected_setup_id
    FROM public.whatsapp_connections WHERE id = requested_entity_id;
  END IF;
  IF selected_account_id IS NULL THEN RETURN false; END IF;

  IF requested_kind = 'personal_account' THEN
    UPDATE public.personal_accounts AS accounts
    SET state = 'deleting',
      deletion_requested_at = COALESCE(accounts.deletion_requested_at, requested_at),
      deletion_marker_id = COALESCE(accounts.deletion_marker_id, requested_marker_id),
      updated_at = GREATEST(accounts.updated_at, requested_at)
    WHERE accounts.id = selected_account_id
      AND (
        accounts.deletion_marker_id IS NULL
        OR accounts.deletion_marker_id = requested_marker_id
      );
    IF NOT FOUND THEN RETURN false; END IF;
    UPDATE public.connection_setups AS setups
    SET state = 'cancelled', cleanup_state = 'pending',
      cleanup_lease_owner = NULL, cleanup_lease_expires_at = NULL,
      provisioning_lease_owner = NULL, provisioning_lease_expires_at = NULL,
      updated_at = GREATEST(setups.updated_at, requested_at)
    WHERE setups.personal_account_id = selected_account_id
      AND setups.state NOT IN ('activated', 'cancelled', 'expired');
    UPDATE public.personal_account_key_envelopes SET ciphertext = NULL,
      key_version = NULL, kms_key_id = NULL,
      unavailable_at = COALESCE(unavailable_at, requested_at)
    WHERE personal_account_id = selected_account_id;
  END IF;
  UPDATE public.whatsapp_connection_key_envelopes SET nonce = NULL,
    ciphertext = NULL, account_key_version = NULL, key_version = NULL,
    unavailable_at = COALESCE(unavailable_at, requested_at)
  WHERE personal_account_id = selected_account_id
    AND (requested_kind = 'personal_account' OR whatsapp_connection_id = requested_entity_id);

  INSERT INTO public.restore_object_deletions(
    bucket, object_key, personal_account_id, retained_bytes
  )
  SELECT 'stored_media', objects.object_key, objects.personal_account_id,
    objects.plaintext_size_bytes
  FROM public.send_operation_objects objects
  WHERE objects.personal_account_id = selected_account_id
    AND (requested_kind = 'personal_account'
      OR objects.whatsapp_connection_id = requested_entity_id)
  ON CONFLICT (bucket, object_key) DO UPDATE SET
    personal_account_id = excluded.personal_account_id,
    retained_bytes = excluded.retained_bytes;
  DELETE FROM public.stored_media_object_deletions deletions
  USING public.send_operation_objects objects
  WHERE objects.personal_account_id = selected_account_id
    AND (requested_kind = 'personal_account'
      OR objects.whatsapp_connection_id = requested_entity_id)
    AND deletions.personal_account_id = objects.personal_account_id
    AND deletions.object_key = objects.object_key;
  DELETE FROM public.send_operation_objects objects
  WHERE objects.personal_account_id = selected_account_id
    AND (requested_kind = 'personal_account'
      OR objects.whatsapp_connection_id = requested_entity_id);

  INSERT INTO public.restore_object_deletions(bucket, object_key)
  SELECT 'stored_media', media.object_key FROM public.stored_media media
  WHERE media.personal_account_id = selected_account_id AND media.object_key IS NOT NULL
    AND (requested_kind = 'personal_account' OR media.whatsapp_connection_id = requested_entity_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.restore_object_deletions(bucket, object_key)
  SELECT 'webhook_ingress', 'webhook-events/' || events.id::text
  FROM public.webhook_events events
  WHERE events.personal_account_id = selected_account_id
    AND (requested_kind = 'personal_account' OR events.whatsapp_connection_id = requested_entity_id)
  ON CONFLICT DO NOTHING;

  IF requested_kind = 'personal_account' THEN
    IF EXISTS (
      SELECT 1 FROM public.whatsapp_connections AS connections
      WHERE connections.personal_account_id = selected_account_id
    ) OR EXISTS (
      SELECT 1 FROM public.restore_connection_deletion_continuations AS continuations
      WHERE continuations.personal_account_id = selected_account_id
    ) THEN
      RETURN false;
    END IF;
    DELETE FROM public.personal_accounts WHERE id = requested_entity_id;
  ELSE
    INSERT INTO public.deleted_whatsapp_connection_handles(public_id, deletion_marker_id, deleted_at)
    SELECT public_id, requested_marker_id, requested_at FROM public.whatsapp_connections
    WHERE id = requested_entity_id ON CONFLICT DO NOTHING;
    IF selected_setup_id IS NOT NULL THEN
      INSERT INTO public.restore_connection_deletion_continuations(
        deletion_marker_id, personal_account_id, connection_setup_id, requested_at
      ) VALUES (
        requested_marker_id, selected_account_id, selected_setup_id, requested_at
      ) ON CONFLICT (deletion_marker_id) DO NOTHING;
    END IF;
    DELETE FROM public.whatsapp_connections WHERE id = requested_entity_id;
  END IF;
  RETURN true;
END
$function$;
--> statement-breakpoint

-- Recover continuations created by the serving-branch replay defect before
-- this table existed. Exact key-unavailability/deletion timestamps and an
-- activated Setup no longer referenced by a Connection make the match unique;
-- ambiguous matches remain fail-closed for operator recovery.
WITH matches AS (
  SELECT deleted.deletion_marker_id, keys.personal_account_id,
    setups.id AS connection_setup_id, deleted.deleted_at AS requested_at,
    count(*) OVER (PARTITION BY deleted.deletion_marker_id) AS marker_matches,
    count(*) OVER (
      PARTITION BY keys.personal_account_id, setups.id
    ) AS setup_matches
  FROM public.deleted_whatsapp_connection_handles AS deleted
  JOIN public.personal_account_key_envelopes AS keys
    ON keys.unavailable_at = deleted.deleted_at
  JOIN public.personal_accounts AS accounts
    ON accounts.id = keys.personal_account_id
   AND accounts.state = 'active'
  JOIN public.connection_setups AS setups
    ON setups.personal_account_id = accounts.id
   AND setups.state = 'activated'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.whatsapp_connections AS connections
    WHERE connections.personal_account_id = setups.personal_account_id
      AND connections.connection_setup_id = setups.id
  )
)
INSERT INTO public.restore_connection_deletion_continuations(
  deletion_marker_id, personal_account_id, connection_setup_id, requested_at
)
SELECT deletion_marker_id, personal_account_id, connection_setup_id, requested_at
FROM matches
WHERE marker_matches = 1 AND setup_matches = 1
ON CONFLICT (deletion_marker_id) DO NOTHING;
--> statement-breakpoint

-- Repair only accounts for which the bad replay already removed every
-- Connection. Activated Setups and their number reservations remain terminal
-- deletion evidence; a later bootstrap creates a fresh account key.
DELETE FROM public.personal_account_key_envelopes AS keys
USING public.personal_accounts AS accounts
WHERE accounts.id = keys.personal_account_id
  AND accounts.state = 'active'
  AND keys.unavailable_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.whatsapp_connections AS connections
    WHERE connections.personal_account_id = accounts.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.connection_setups AS setups
    WHERE setups.personal_account_id = accounts.id
      AND setups.state <> 'activated'
  );
--> statement-breakpoint

DO $migration$
DECLARE function_definition text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.verify_recovery_branch(text,timestamptz)'::regprocedure
  ) INTO function_definition;
  IF pg_catalog.strpos(function_definition, '1787678308000') = 0 THEN
    RAISE EXCEPTION 'verify_recovery_branch schema version is unexpected';
  END IF;
  EXECUTE pg_catalog.replace(
    function_definition, '1787678308000', '1787689711458');
END
$migration$;
