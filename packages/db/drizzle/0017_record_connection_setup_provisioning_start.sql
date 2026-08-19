-- Persist the first successful provisioning claim so latency is measured from
-- durable phase transitions rather than Queue attempts or status polling.
ALTER TABLE public.connection_setups
  ADD COLUMN provisioning_started_at timestamptz,
  ADD CONSTRAINT connection_setups_provisioning_started_at_check
    CHECK (
      provisioning_started_at IS NULL
      OR provisioning_started_at >= created_at
    );
--> statement-breakpoint

DROP FUNCTION public.claim_connection_setup_provisioning(
  text,
  text,
  timestamptz
);
--> statement-breakpoint

CREATE FUNCTION public.claim_connection_setup_provisioning(
  requested_setup_id text,
  requested_worker_id text,
  requested_claimed_at timestamptz
)
RETURNS TABLE (
  outcome text,
  personal_account_id uuid,
  account_key_version integer,
  account_kms_key_id text,
  account_key_ciphertext bytea,
  connection_key_account_version integer,
  connection_key_version integer,
  connection_key_nonce bytea,
  connection_key_ciphertext bytea,
  number_ciphertext_version smallint,
  number_key_version integer,
  number_nonce bytea,
  number_ciphertext bytea,
  created_at timestamptz,
  provisioning_started_at timestamptz,
  first_claim boolean
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  account_key public.personal_account_key_envelopes%ROWTYPE;
  connection_key public.connection_setup_key_envelopes%ROWTYPE;
  setup public.connection_setups%ROWTYPE;
BEGIN
  IF requested_setup_id !~ '^cst_[A-Za-z0-9_-]{21}$'
    OR requested_worker_id !~ '^cspw_[A-Za-z0-9_-]{43}$'
  THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'invalid Connection Setup provisioning claim';
  END IF;

  SELECT *
  INTO setup
  FROM public.connection_setups
  WHERE id = requested_setup_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'not_found'::text,
      NULL::uuid,
      NULL::integer,
      NULL::text,
      NULL::bytea,
      NULL::integer,
      NULL::integer,
      NULL::bytea,
      NULL::bytea,
      NULL::smallint,
      NULL::integer,
      NULL::bytea,
      NULL::bytea,
      NULL::timestamptz,
      NULL::timestamptz,
      NULL::boolean;
    RETURN;
  END IF;

  IF setup.state <> 'provisioning_pending' THEN
    RETURN QUERY SELECT
      'not_pending'::text,
      NULL::uuid,
      NULL::integer,
      NULL::text,
      NULL::bytea,
      NULL::integer,
      NULL::integer,
      NULL::bytea,
      NULL::bytea,
      NULL::smallint,
      NULL::integer,
      NULL::bytea,
      NULL::bytea,
      NULL::timestamptz,
      NULL::timestamptz,
      NULL::boolean;
    RETURN;
  END IF;

  IF setup.expires_at <= requested_claimed_at THEN
    RETURN QUERY SELECT
      'expired'::text,
      NULL::uuid,
      NULL::integer,
      NULL::text,
      NULL::bytea,
      NULL::integer,
      NULL::integer,
      NULL::bytea,
      NULL::bytea,
      NULL::smallint,
      NULL::integer,
      NULL::bytea,
      NULL::bytea,
      NULL::timestamptz,
      NULL::timestamptz,
      NULL::boolean;
    RETURN;
  END IF;

  IF setup.provisioning_lease_expires_at > requested_claimed_at THEN
    RETURN QUERY SELECT
      'leased'::text,
      NULL::uuid,
      NULL::integer,
      NULL::text,
      NULL::bytea,
      NULL::integer,
      NULL::integer,
      NULL::bytea,
      NULL::bytea,
      NULL::smallint,
      NULL::integer,
      NULL::bytea,
      NULL::bytea,
      NULL::timestamptz,
      NULL::timestamptz,
      NULL::boolean;
    RETURN;
  END IF;

  SELECT *
  INTO connection_key
  FROM public.connection_setup_key_envelopes AS connection_keys
  WHERE connection_keys.personal_account_id = setup.personal_account_id
    AND connection_keys.connection_setup_id = setup.id;

  SELECT *
  INTO account_key
  FROM public.personal_account_key_envelopes AS account_keys
  WHERE account_keys.personal_account_id = setup.personal_account_id
    AND account_keys.key_version = connection_key.account_key_version
    AND account_keys.unavailable_at IS NULL
    AND account_keys.ciphertext IS NOT NULL;

  IF connection_key.personal_account_id IS NULL
    OR account_key.personal_account_id IS NULL
  THEN
    RAISE data_exception
      USING MESSAGE = 'Connection Setup provisioning key unavailable';
  END IF;

  UPDATE public.connection_setups AS setups
  SET
    provisioning_attempt_count = setups.provisioning_attempt_count + 1,
    provisioning_last_failure_code = NULL,
    provisioning_lease_expires_at = requested_claimed_at + interval '2 minutes',
    provisioning_lease_owner = requested_worker_id,
    provisioning_started_at = CASE
      WHEN setups.provisioning_attempt_count = 0 THEN requested_claimed_at
      ELSE setups.provisioning_started_at
    END,
    updated_at = greatest(setups.updated_at, requested_claimed_at)
  WHERE setups.id = setup.id;

  RETURN QUERY SELECT
    'claimed'::text,
    setup.personal_account_id,
    account_key.key_version,
    account_key.kms_key_id,
    account_key.ciphertext,
    connection_key.account_key_version,
    connection_key.key_version,
    connection_key.nonce,
    connection_key.ciphertext,
    setup.number_ciphertext_version,
    setup.number_key_version,
    setup.number_nonce,
    setup.number_ciphertext,
    setup.created_at,
    CASE
      WHEN setup.provisioning_attempt_count = 0 THEN requested_claimed_at
      ELSE setup.provisioning_started_at
    END,
    setup.provisioning_attempt_count = 0;
END
$function$;
--> statement-breakpoint

REVOKE ALL
  ON FUNCTION public.claim_connection_setup_provisioning(
    text,
    text,
    timestamptz
  )
  FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE
  ON FUNCTION public.claim_connection_setup_provisioning(
    text,
    text,
    timestamptz
  )
  TO whatsapp_api_runtime;
