-- Every production restore globally invalidates restored API Keys before
-- verification access can reopen. The restore gate records aggregate
-- revocation and digest-clearing evidence and stays closed while any
-- authenticable grant remains. HMAC rotation is a separate recovery step;
-- this function never accepts a predecessor digest as still valid.
ALTER TABLE public.restore_readiness
  ADD COLUMN api_keys_revoked integer
    CHECK (api_keys_revoked IS NULL OR api_keys_revoked >= 0),
  ADD COLUMN api_key_digests_cleared integer
    CHECK (api_key_digests_cleared IS NULL OR api_key_digests_cleared >= 0);
--> statement-breakpoint

ALTER TABLE public.restore_replay_audit
  ADD COLUMN api_keys_revoked integer NOT NULL DEFAULT 0
    CHECK (api_keys_revoked >= 0),
  ADD COLUMN api_key_digests_cleared integer NOT NULL DEFAULT 0
    CHECK (api_key_digests_cleared >= 0);
--> statement-breakpoint

-- A serving branch that completed replay before this migration has no
-- invalidation counters. Treat that historical completion as zero so the
-- ready-state check can be tightened without rewriting lifecycle state.
UPDATE public.restore_readiness
SET api_keys_revoked = coalesce(api_keys_revoked, 0),
    api_key_digests_cleared = coalesce(api_key_digests_cleared, 0)
WHERE state = 'ready';
--> statement-breakpoint

ALTER TABLE public.restore_readiness
  DROP CONSTRAINT restore_readiness_check;
--> statement-breakpoint

ALTER TABLE public.restore_readiness
  ADD CONSTRAINT restore_readiness_check
    CHECK (
      (state = 'replaying' AND completed_at IS NULL)
      OR (
        state = 'ready'
        AND completed_at IS NOT NULL
        AND marker_count IS NOT NULL
        AND deleted_entity_count IS NOT NULL
        AND expired_record_count IS NOT NULL
        AND api_keys_revoked IS NOT NULL
        AND api_key_digests_cleared IS NOT NULL
      )
    );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.begin_restore_replay(
  requested_branch_id text, requested_at timestamptz
)
RETURNS TABLE (deletion_kind text, opaque_entity_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF requested_branch_id !~ '^br-[A-Za-z0-9_-]{1,120}$' THEN
    RAISE invalid_parameter_value;
  END IF;
  INSERT INTO public.restore_readiness(
    singleton, branch_id, state, started_at,
    api_keys_revoked, api_key_digests_cleared
  )
  VALUES (true, requested_branch_id, 'replaying', requested_at, 0, 0)
  ON CONFLICT (singleton) DO UPDATE SET branch_id = excluded.branch_id,
    state = 'replaying', started_at = excluded.started_at, completed_at = NULL,
    marker_count = NULL, deleted_entity_count = NULL, expired_record_count = NULL,
    api_keys_revoked = 0, api_key_digests_cleared = 0
  WHERE restore_readiness.branch_id IS DISTINCT FROM excluded.branch_id
    OR restore_readiness.state IS DISTINCT FROM 'ready';
  RETURN QUERY
    SELECT 'personal_account'::text, accounts.id FROM public.personal_accounts accounts
    UNION ALL
    SELECT 'whatsapp_connection'::text, connections.id FROM public.whatsapp_connections connections;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.invalidate_restored_api_keys(
  requested_at timestamptz,
  requested_limit integer
)
RETURNS TABLE (revoked integer, digests_cleared integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  revoked_count integer := 0;
  digest_count integer := 0;
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'requested_limit must be between 1 and 1000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.restore_readiness
    WHERE singleton AND state = 'replaying'
  ) THEN
    RAISE EXCEPTION 'restore replay is not active';
  END IF;

  WITH candidates AS (
    SELECT keys.id,
      keys.state AS previous_state,
      keys.credential_digest IS NOT NULL AS had_digest
    FROM public.api_keys AS keys
    WHERE keys.state = 'active' OR keys.credential_digest IS NOT NULL
    ORDER BY keys.id
    LIMIT requested_limit
    FOR UPDATE
  ), updated AS (
    UPDATE public.api_keys AS keys
    SET
      state = CASE WHEN keys.state = 'active' THEN 'revoked' ELSE keys.state END,
      revoked_at = CASE
        WHEN keys.state = 'active' THEN coalesce(keys.revoked_at, requested_at)
        ELSE keys.revoked_at
      END,
      credential_digest = NULL,
      metadata_expires_at = CASE
        WHEN keys.state = 'active' THEN coalesce(
          keys.metadata_expires_at,
          requested_at + interval '90 days'
        )
        ELSE keys.metadata_expires_at
      END
    FROM candidates
    WHERE keys.id = candidates.id
    RETURNING candidates.previous_state, candidates.had_digest
  )
  SELECT
    count(*) FILTER (WHERE previous_state = 'active')::integer,
    count(*) FILTER (WHERE had_digest)::integer
  INTO revoked_count, digest_count
  FROM updated;

  UPDATE public.restore_readiness
  SET api_keys_revoked = coalesce(api_keys_revoked, 0) + revoked_count,
      api_key_digests_cleared = coalesce(api_key_digests_cleared, 0) + digest_count
  WHERE singleton AND state = 'replaying';

  revoked := revoked_count;
  digests_cleared := digest_count;
  RETURN NEXT;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.complete_restore_replay(
  requested_branch_id text, requested_at timestamptz, requested_marker_count integer,
  requested_deleted_count integer, requested_expired_count integer
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  revoked_count integer;
  digest_count integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.restore_readiness
    WHERE singleton AND branch_id = requested_branch_id AND state = 'ready'
  ) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.restore_object_deletions)
    OR EXISTS (SELECT 1 FROM public.stored_media_object_deletions) THEN
    RAISE EXCEPTION 'restore object deletions remain';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.whatsapp_recipient_exclusions
    WHERE transition_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'recipient exclusion transitions remain unresolved';
  END IF;
  SELECT readiness.api_keys_revoked, readiness.api_key_digests_cleared
    INTO revoked_count, digest_count
  FROM public.restore_readiness readiness
  WHERE readiness.singleton AND readiness.branch_id = requested_branch_id
    AND readiness.state = 'replaying';
  IF NOT FOUND THEN RAISE EXCEPTION 'restore replay is not active'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.api_keys
    WHERE state = 'active' OR credential_digest IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'restored api keys remain authenticable';
  END IF;
  IF revoked_count IS NULL OR digest_count IS NULL THEN
    RAISE EXCEPTION 'restore api key invalidation evidence is incomplete';
  END IF;
  UPDATE public.restore_readiness SET state = 'ready', completed_at = requested_at,
    marker_count = requested_marker_count, deleted_entity_count = requested_deleted_count,
    expired_record_count = requested_expired_count,
    api_keys_revoked = revoked_count, api_key_digests_cleared = digest_count
  WHERE singleton AND branch_id = requested_branch_id AND state = 'replaying';
  IF NOT FOUND THEN RAISE EXCEPTION 'restore replay is not active'; END IF;
  INSERT INTO public.restore_replay_audit
    (branch_id, completed_at, marker_count, deleted_entity_count, expired_record_count,
     api_keys_revoked, api_key_digests_cleared)
  VALUES (requested_branch_id, requested_at, requested_marker_count,
    requested_deleted_count, requested_expired_count, revoked_count, digest_count)
  ON CONFLICT (branch_id) DO UPDATE SET completed_at = excluded.completed_at,
    marker_count = excluded.marker_count, deleted_entity_count = excluded.deleted_entity_count,
    expired_record_count = excluded.expired_record_count,
    api_keys_revoked = excluded.api_keys_revoked,
    api_key_digests_cleared = excluded.api_key_digests_cleared;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.invalidate_restored_api_keys(timestamptz,integer)
  FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.invalidate_restored_api_keys(timestamptz,integer)
  TO whatsapp_restore_runtime;
