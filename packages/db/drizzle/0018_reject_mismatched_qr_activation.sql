ALTER TABLE public.connection_setups
  DROP CONSTRAINT connection_setup_cleanup_state_matches_terminal,
  ADD CONSTRAINT connection_setup_cleanup_state_matches_terminal
  CHECK (
    (
      (cleanup_state IS NULL)
      OR (state = ANY (
        ARRAY[
          'cancelled'::text,
          'expired'::text,
          'provisioning_failed'::text
        ]
      ))
    )
    AND (
      (state <> ALL (ARRAY['cancelled'::text, 'expired'::text]))
      OR (cleanup_state IS NOT NULL)
    )
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.claim_connection_setup_cleanup(
  requested_setup_id text,
  requested_worker_id text,
  requested_claimed_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  setup public.connection_setups%ROWTYPE;
BEGIN
  IF requested_setup_id !~ '^cst_[A-Za-z0-9_-]{21}$'
    OR requested_worker_id !~ '^cscw_[A-Za-z0-9_-]{43}$'
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Connection Setup cleanup claim';
  END IF;

  SELECT *
  INTO setup
  FROM public.connection_setups
  WHERE id = requested_setup_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF setup.cleanup_state IS NULL THEN
    RETURN 'not_pending';
  END IF;
  IF setup.cleanup_state = 'complete' THEN
    RETURN 'complete';
  END IF;
  IF setup.provisioning_lease_expires_at > requested_claimed_at
    OR setup.cleanup_lease_expires_at > requested_claimed_at
  THEN
    RETURN 'leased';
  END IF;

  UPDATE public.connection_setups
  SET
    provisioning_lease_owner = NULL,
    provisioning_lease_expires_at = NULL,
    cleanup_attempt_count = cleanup_attempt_count + 1,
    cleanup_last_failure_code = NULL,
    cleanup_lease_owner = requested_worker_id,
    cleanup_lease_expires_at = requested_claimed_at + interval '2 minutes',
    updated_at = greatest(updated_at, requested_claimed_at)
  WHERE id = requested_setup_id;

  RETURN 'claimed';
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.list_connection_setup_cleanup_candidates(
  requested_observed_at timestamptz,
  requested_limit integer
)
RETURNS TABLE (setup_id text)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF requested_limit < 1 OR requested_limit > 1000 THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Connection Setup cleanup candidate limit';
  END IF;

  RETURN QUERY
  SELECT setups.id
  FROM public.connection_setups AS setups
  WHERE setups.cleanup_state = 'pending'
    AND (
      setups.provisioning_lease_expires_at IS NULL
      OR setups.provisioning_lease_expires_at <= requested_observed_at
    )
    AND (
      setups.cleanup_lease_expires_at IS NULL
      OR setups.cleanup_lease_expires_at <= requested_observed_at
    )
  ORDER BY setups.updated_at, setups.id
  LIMIT requested_limit;
END
$function$;
--> statement-breakpoint

CREATE FUNCTION public.fail_connection_setup_activation(
  requested_personal_account_id uuid,
  requested_setup_id text,
  requested_failure_code text,
  requested_observed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  setup public.connection_setups%ROWTYPE;
  tenant_context uuid;
BEGIN
  tenant_context := nullif(
    pg_catalog.current_setting('public.personal_account_id', true),
    ''
  )::uuid;
  IF tenant_context IS NULL
    OR tenant_context IS DISTINCT FROM requested_personal_account_id
    OR requested_setup_id !~ '^cst_[A-Za-z0-9_-]{21}$'
    OR requested_failure_code !~ '^[a-z][a-z0-9_]{0,63}$'
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Connection Setup activation failure';
  END IF;

  SELECT *
  INTO setup
  FROM public.connection_setups
  WHERE id = requested_setup_id
    AND personal_account_id = requested_personal_account_id
  FOR UPDATE;

  IF NOT FOUND OR setup.state = 'activated' THEN
    RETURN false;
  END IF;

  IF setup.state = 'provisioning_failed' THEN
    UPDATE public.connection_setups
    SET
      provisioning_last_failure_code = requested_failure_code,
      cleanup_state = 'pending',
      cleanup_last_failure_code = NULL,
      updated_at = greatest(updated_at, requested_observed_at)
    WHERE id = requested_setup_id
      AND personal_account_id = requested_personal_account_id;
    RETURN true;
  END IF;

  IF setup.state <> 'provisioned'
    OR setup.expires_at <= requested_observed_at
    OR NOT EXISTS (
      SELECT 1
      FROM public.connection_setup_provider_sessions AS provider_sessions
      WHERE provider_sessions.personal_account_id = requested_personal_account_id
        AND provider_sessions.connection_setup_id = requested_setup_id
        AND provider_sessions.ordinal = 0
    )
  THEN
    RETURN false;
  END IF;

  UPDATE public.connection_setups
  SET
    state = 'provisioning_failed',
    provisioning_last_failure_code = requested_failure_code,
    provisioning_lease_owner = NULL,
    provisioning_lease_expires_at = NULL,
    cleanup_state = 'pending',
    cleanup_last_failure_code = NULL,
    cleanup_lease_owner = NULL,
    cleanup_lease_expires_at = NULL,
    updated_at = greatest(updated_at, requested_observed_at)
  WHERE id = requested_setup_id
    AND personal_account_id = requested_personal_account_id;

  RETURN true;
END
$function$;
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.fail_connection_setup_activation(uuid, text, text, timestamptz)
  FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
  ON FUNCTION public.fail_connection_setup_activation(uuid, text, text, timestamptz)
  TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.finish_connection_setup_cleanup(
  requested_setup_id text,
  requested_worker_id text,
  requested_observed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  setup public.connection_setups%ROWTYPE;
BEGIN
  SELECT *
  INTO setup
  FROM public.connection_setups
  WHERE id = requested_setup_id
  FOR UPDATE;

  IF NOT FOUND
    OR setup.state NOT IN ('cancelled', 'expired', 'provisioning_failed')
    OR setup.cleanup_state <> 'pending'
    OR setup.cleanup_lease_owner IS DISTINCT FROM requested_worker_id
    OR setup.cleanup_lease_expires_at <= requested_observed_at
  THEN
    RETURN false;
  END IF;

  UPDATE public.whatsapp_number_reservations
  SET released_at = coalesce(released_at, requested_observed_at)
  WHERE personal_account_id = setup.personal_account_id
    AND connection_setup_id = setup.id;

  DELETE FROM public.connection_setup_provider_sessions
  WHERE personal_account_id = setup.personal_account_id
    AND connection_setup_id = setup.id;

  DELETE FROM public.connection_setup_key_envelopes
  WHERE personal_account_id = setup.personal_account_id
    AND connection_setup_id = setup.id;

  UPDATE public.connection_setups
  SET
    cleanup_state = 'complete',
    cleanup_last_failure_code = NULL,
    cleanup_lease_owner = NULL,
    cleanup_lease_expires_at = NULL,
    provisioning_lease_owner = NULL,
    provisioning_lease_expires_at = NULL,
    updated_at = greatest(updated_at, requested_observed_at)
  WHERE id = setup.id;

  RETURN true;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.renew_connection_setup_cleanup_lease(
  requested_setup_id text,
  requested_worker_id text,
  requested_observed_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH renewed AS (
    UPDATE public.connection_setups
    SET
      cleanup_lease_expires_at = requested_observed_at + interval '2 minutes',
      updated_at = greatest(updated_at, requested_observed_at)
    WHERE id = requested_setup_id
      AND state IN ('cancelled', 'expired', 'provisioning_failed')
      AND cleanup_state = 'pending'
      AND cleanup_lease_owner = requested_worker_id
      AND cleanup_lease_expires_at > requested_observed_at
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM renewed)
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.release_connection_setup_cleanup_lease(
  requested_setup_id text,
  requested_worker_id text,
  requested_observed_at timestamptz,
  requested_failure_code text
)
RETURNS boolean
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  released boolean;
BEGIN
  IF requested_failure_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Connection Setup cleanup failure';
  END IF;

  WITH changed AS (
    UPDATE public.connection_setups
    SET
      cleanup_last_failure_code = requested_failure_code,
      cleanup_lease_owner = NULL,
      cleanup_lease_expires_at = NULL,
      updated_at = greatest(updated_at, requested_observed_at)
    WHERE id = requested_setup_id
      AND state IN ('cancelled', 'expired', 'provisioning_failed')
      AND cleanup_state = 'pending'
      AND cleanup_lease_owner = requested_worker_id
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM changed) INTO released;
  RETURN released;
END
$function$;
