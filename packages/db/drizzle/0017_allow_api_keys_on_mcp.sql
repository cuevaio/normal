-- Keep the access channel independent from the responsible principal. OAuth
-- MCP Authorizations remain MCP-only, while an API Key may authenticate either
-- REST or MCP without being converted into an MCP Authorization.
ALTER TABLE public.tool_call_logs
  DROP CONSTRAINT tool_call_logs_channel_principal;
--> statement-breakpoint

ALTER TABLE public.tool_call_logs
  ADD CONSTRAINT tool_call_logs_channel_principal
    CHECK (
      (
        channel = 'mcp'
        AND mcp_authorization_id IS NOT NULL
        AND api_key_id IS NULL
        AND api_key_public_id IS NULL
        AND api_key_name IS NULL
      )
      OR (
        mcp_authorization_id IS NULL
        AND api_key_id IS NOT NULL
        AND api_key_public_id ~ '^apk_[A-Za-z0-9_-]{21}$'::text
        AND api_key_name IS NOT NULL
        AND length(btrim(api_key_name)) BETWEEN 1 AND 64
        AND api_key_name = btrim(api_key_name)
      )
    );
--> statement-breakpoint

DROP INDEX public.tool_call_logs_api_key_request_quota;
--> statement-breakpoint

CREATE INDEX tool_call_logs_api_key_request_quota
  ON public.tool_call_logs (api_key_id, started_at, id)
  WHERE quota_reserved AND api_key_id IS NOT NULL;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.purge_personal_account(
  requested_marker_id text,
  completed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE selected_account_id uuid;
BEGIN
  IF requested_marker_id !~ '^[a-f0-9]{64}$' THEN
    RAISE invalid_parameter_value;
  END IF;
  SELECT accounts.id INTO selected_account_id
  FROM public.personal_accounts accounts
  WHERE accounts.deletion_marker_id = requested_marker_id
    AND accounts.state = 'deleting'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN EXISTS (
      SELECT 1 FROM public.personal_account_cleanup_audit audit
      WHERE audit.deletion_marker_id = requested_marker_id
    );
  END IF;
  ALTER ROLE whatsapp_restore_runtime
    NOREPLICATION NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  IF EXISTS (
    SELECT 1 FROM public.whatsapp_connections connections
    WHERE connections.personal_account_id = selected_account_id
  ) OR EXISTS (
    SELECT 1 FROM public.connection_setups setups
    WHERE setups.personal_account_id = selected_account_id
      AND setups.cleanup_state IS DISTINCT FROM 'complete'
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO public.security_records(
    category, client_class, outcome, result_count, started_at,
    completed_at, latency_ms, expires_at
  )
  SELECT CASE
      WHEN logs.tool_name = 'read_stored_media' THEN 'protected_resource'
      ELSE 'tool_call'
    END,
    CASE
      WHEN logs.api_key_id IS NOT NULL THEN 'api_key'
      ELSE authorizations.client_class
    END,
    logs.outcome, logs.result_count,
    logs.started_at, logs.completed_at, logs.latency_ms, logs.expires_at
  FROM public.tool_call_logs logs
  LEFT JOIN public.mcp_authorizations authorizations
    ON authorizations.personal_account_id = logs.personal_account_id
   AND authorizations.id = logs.mcp_authorization_id
  WHERE logs.personal_account_id = selected_account_id;

  INSERT INTO public.personal_account_cleanup_audit(
    deletion_marker_id, completed_at, expires_at
  ) VALUES (requested_marker_id, completed_at, completed_at + interval '90 days');
  DELETE FROM public.whatsapp_number_reservations reservations
  WHERE reservations.personal_account_id = selected_account_id;
  DELETE FROM public.connection_setups setups
  WHERE setups.personal_account_id = selected_account_id;
  DELETE FROM public.personal_accounts accounts WHERE accounts.id = selected_account_id;
  RETURN true;
END
$function$;
