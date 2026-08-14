-- User-created API Key grants for the public REST adapter. Neon stores only a
-- purpose-specific HMAC digest and safe management metadata. Permissions and
-- selected WhatsApp Connections are immutable. Later Connections never enter
-- an existing grant. Active names are unique. At most ten keys may be active.
CREATE TABLE public.api_keys (
  id uuid PRIMARY KEY,
  personal_account_id uuid NOT NULL,
  public_id text NOT NULL,
  name text NOT NULL,
  credential_digest bytea,
  credential_hint text NOT NULL,
  permissions text[] NOT NULL,
  state text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  reverified_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  metadata_expires_at timestamptz,
  CONSTRAINT api_keys_personal_account_id_fkey
    FOREIGN KEY (personal_account_id)
    REFERENCES public.personal_accounts (id)
    ON DELETE CASCADE,
  CONSTRAINT api_keys_personal_account_id_id_key
    UNIQUE (personal_account_id, id),
  CONSTRAINT api_keys_public_id_unique UNIQUE (public_id),
  CONSTRAINT api_keys_public_id_format
    CHECK (public_id ~ '^apk_[A-Za-z0-9_-]{21}$'::text),
  CONSTRAINT api_keys_name_check
    CHECK (
      length(btrim(name)) BETWEEN 1 AND 64
      AND name = btrim(name)
    ),
  CONSTRAINT api_keys_credential_digest_check
    CHECK (
      credential_digest IS NULL
      OR octet_length(credential_digest) = 32
    ),
  CONSTRAINT api_keys_credential_hint_check
    CHECK (
      credential_hint ~ '^normal_apk_[A-Za-z0-9_-]{21}\.…[A-Za-z0-9_-]{4}$'::text
    ),
  CONSTRAINT api_keys_permissions_check
    CHECK (
      cardinality(permissions) BETWEEN 1 AND 4
      AND permissions <@ ARRAY[
        'connections:read'::text,
        'directory:read'::text,
        'messages:read'::text,
        'messages:send'::text
      ]
      AND cardinality(permissions) = (
        (('connections:read'::text = ANY (permissions))::integer
          + ('directory:read'::text = ANY (permissions))::integer
          + ('messages:read'::text = ANY (permissions))::integer
          + ('messages:send'::text = ANY (permissions))::integer)
      )
    ),
  CONSTRAINT api_keys_state_check
    CHECK (state = ANY (ARRAY['active'::text, 'revoked'::text])),
  CONSTRAINT api_keys_state_revocation
    CHECK (
      (
        state = 'active'
        AND revoked_at IS NULL
        AND credential_digest IS NOT NULL
      )
      OR (
        state = 'revoked'
        AND revoked_at IS NOT NULL
        AND credential_digest IS NULL
      )
    ),
  CONSTRAINT api_keys_reverified_at_check
    CHECK (
      reverified_at <= created_at
      AND reverified_at > created_at - interval '5 minutes'
    ),
  CONSTRAINT api_keys_expires_at_check
    CHECK (expires_at IS NULL OR expires_at > created_at),
  CONSTRAINT api_keys_revoked_at_check
    CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CONSTRAINT api_keys_last_used_at_check
    CHECK (last_used_at IS NULL OR last_used_at >= created_at)
);
--> statement-breakpoint

CREATE UNIQUE INDEX api_keys_active_name
  ON public.api_keys (personal_account_id, lower(name))
  WHERE state = 'active';
--> statement-breakpoint

CREATE INDEX api_keys_personal_account_created
  ON public.api_keys (personal_account_id, created_at DESC, public_id);
--> statement-breakpoint

CREATE TABLE public.api_key_connections (
  personal_account_id uuid NOT NULL,
  api_key_id uuid NOT NULL,
  whatsapp_connection_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT api_key_connections_pkey
    PRIMARY KEY (api_key_id, whatsapp_connection_id),
  CONSTRAINT api_key_connections_grant_fkey
    FOREIGN KEY (personal_account_id, api_key_id)
    REFERENCES public.api_keys (personal_account_id, id)
    ON DELETE CASCADE,
  CONSTRAINT api_key_connections_connection_fkey
    FOREIGN KEY (personal_account_id, whatsapp_connection_id)
    REFERENCES public.whatsapp_connections (personal_account_id, id)
    ON DELETE CASCADE
);
--> statement-breakpoint

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY api_keys_tenant
  ON public.api_keys
  USING (
    personal_account_id = nullif(
      pg_catalog.current_setting('public.personal_account_id', true),
      ''
    )::uuid
  )
  WITH CHECK (
    personal_account_id = nullif(
      pg_catalog.current_setting('public.personal_account_id', true),
      ''
    )::uuid
  );
--> statement-breakpoint

ALTER TABLE public.api_key_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_key_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY api_key_connections_tenant
  ON public.api_key_connections
  USING (
    personal_account_id = nullif(
      pg_catalog.current_setting('public.personal_account_id', true),
      ''
    )::uuid
  )
  WITH CHECK (
    personal_account_id = nullif(
      pg_catalog.current_setting('public.personal_account_id', true),
      ''
    )::uuid
  );
--> statement-breakpoint

REVOKE ALL ON TABLE public.api_keys FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE public.api_key_connections FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.api_keys TO whatsapp_api_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.api_key_connections
  TO whatsapp_api_runtime;
--> statement-breakpoint

CREATE FUNCTION public.enforce_api_key_active_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF (
    SELECT count(*)
    FROM public.api_keys keys
    WHERE keys.personal_account_id = NEW.personal_account_id
      AND keys.state = 'active'
  ) > 10 THEN
    RAISE check_violation USING MESSAGE = 'api_key_active_limit';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint

CREATE TRIGGER api_keys_active_limit
  AFTER INSERT OR UPDATE OF state ON public.api_keys
  FOR EACH ROW
  WHEN (NEW.state = 'active')
  EXECUTE FUNCTION public.enforce_api_key_active_limit();
--> statement-breakpoint

CREATE FUNCTION public.bootstrap_api_key(
  candidate_public_id text,
  candidate_digest bytea
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  selected_account_id uuid;
  selected_key_id uuid;
BEGIN
  IF candidate_public_id !~ '^apk_[A-Za-z0-9_-]{21}$'::text
    OR octet_length(candidate_digest) <> 32
  THEN
    RETURN NULL;
  END IF;
  SELECT keys.personal_account_id, keys.id
    INTO selected_account_id, selected_key_id
  FROM public.api_keys keys
  JOIN public.personal_accounts accounts
    ON accounts.id = keys.personal_account_id
  WHERE keys.public_id = candidate_public_id
    AND keys.credential_digest = candidate_digest
    AND keys.state = 'active'
    AND (keys.expires_at IS NULL OR keys.expires_at > transaction_timestamp())
    AND accounts.state = 'active';
  IF selected_account_id IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM set_config(
    'public.personal_account_id',
    selected_account_id::text,
    true
  );
  RETURN selected_key_id;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.bootstrap_api_key(text, bytea) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.bootstrap_api_key(text, bytea)
  TO whatsapp_api_runtime;
