-- Scheduled API Key expiry clears credential digests using database time.
-- Safe expired and revoked metadata stays User-visible for 90 days, then
-- purges. Activity Logs keep independent 90-day expiry and denormalized
-- presentation, so key metadata deletion cannot remove or rewrite them.
UPDATE public.api_keys
SET metadata_expires_at = revoked_at + interval '90 days'
WHERE state = 'revoked'
  AND metadata_expires_at IS NULL
  AND revoked_at IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.api_keys
  DROP CONSTRAINT api_keys_state_check;
--> statement-breakpoint

ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_state_check
    CHECK (state = ANY (ARRAY['active'::text, 'expired'::text, 'revoked'::text]));
--> statement-breakpoint

ALTER TABLE public.api_keys
  DROP CONSTRAINT api_keys_state_revocation;
--> statement-breakpoint

ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_state_revocation
    CHECK (
      (
        state = 'active'
        AND revoked_at IS NULL
        AND credential_digest IS NOT NULL
        AND metadata_expires_at IS NULL
      )
      OR (
        state = 'revoked'
        AND revoked_at IS NOT NULL
        AND credential_digest IS NULL
        AND metadata_expires_at IS NOT NULL
      )
      OR (
        state = 'expired'
        AND revoked_at IS NULL
        AND expires_at IS NOT NULL
        AND credential_digest IS NULL
        AND metadata_expires_at IS NOT NULL
      )
    );
--> statement-breakpoint

CREATE INDEX api_keys_expiry_processing
  ON public.api_keys (expires_at, id)
  WHERE state = 'active' AND expires_at IS NOT NULL;
--> statement-breakpoint

CREATE INDEX api_keys_metadata_expiry
  ON public.api_keys (metadata_expires_at, id)
  WHERE metadata_expires_at IS NOT NULL;
--> statement-breakpoint

CREATE FUNCTION public.expire_api_key_credentials(maximum_rows integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  updated_count integer;
BEGIN
  IF maximum_rows < 1 OR maximum_rows > 1000 THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'maximum_rows must be between 1 and 1000';
  END IF;

  WITH expired AS (
    SELECT keys.id
    FROM public.api_keys AS keys
    WHERE keys.state = 'active'
      AND keys.expires_at IS NOT NULL
      AND keys.expires_at <= statement_timestamp()
    ORDER BY keys.expires_at, keys.id
    LIMIT maximum_rows
    FOR UPDATE SKIP LOCKED
  ), updated AS (
    UPDATE public.api_keys AS keys
    SET
      state = 'expired',
      credential_digest = NULL,
      metadata_expires_at = keys.expires_at + interval '90 days'
    FROM expired
    WHERE keys.id = expired.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO updated_count FROM updated;

  RETURN updated_count;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.expire_api_key_credentials(integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.expire_api_key_credentials(integer)
  TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE FUNCTION public.purge_expired_api_key_metadata(maximum_rows integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  deleted_count integer;
BEGIN
  IF maximum_rows < 1 OR maximum_rows > 1000 THEN
    RAISE invalid_parameter_value
      USING MESSAGE = 'maximum_rows must be between 1 and 1000';
  END IF;

  WITH expired AS (
    SELECT keys.id
    FROM public.api_keys AS keys
    WHERE keys.credential_digest IS NULL
      AND keys.state IN ('expired', 'revoked')
      AND keys.metadata_expires_at IS NOT NULL
      AND keys.metadata_expires_at <= statement_timestamp()
    ORDER BY keys.metadata_expires_at, keys.id
    LIMIT maximum_rows
    FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM public.api_keys AS keys
    USING expired
    WHERE keys.id = expired.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO deleted_count FROM deleted;

  RETURN deleted_count;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.purge_expired_api_key_metadata(integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.purge_expired_api_key_metadata(integer)
  TO whatsapp_api_runtime;
