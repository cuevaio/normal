-- Personal Account Deletion revokes every API Key and clears every digest in
-- the same prepare transition that revokes MCP Authorizations. Active rows
-- remain until the existing bounded Personal Account purge cascades them.
CREATE OR REPLACE FUNCTION public.prepare_personal_account_deletion(
  verified_clerk_user_id text,
  observed_at timestamptz
)
RETURNS TABLE (
  personal_account_id uuid,
  account_state text,
  requested_at timestamptz,
  connection_public_id text
)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE selected_account_id uuid;
BEGIN
  SELECT accounts.id INTO selected_account_id
  FROM public.clerk_identities identities
  JOIN public.personal_accounts accounts
    ON accounts.id = identities.personal_account_id
  WHERE identities.clerk_user_id = verified_clerk_user_id
  FOR UPDATE OF accounts;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.personal_accounts accounts
  SET state = 'deleting', deletion_requested_at = observed_at,
      updated_at = greatest(accounts.updated_at, observed_at)
  WHERE accounts.id = selected_account_id
    AND accounts.deletion_requested_at IS NULL;
  UPDATE public.connection_setups setups
  SET state = 'cancelled', cleanup_state = 'pending',
      cleanup_lease_owner = NULL, cleanup_lease_expires_at = NULL,
      provisioning_lease_owner = NULL, provisioning_lease_expires_at = NULL,
      updated_at = greatest(setups.updated_at, observed_at)
  WHERE setups.personal_account_id = selected_account_id
    AND setups.state NOT IN ('activated', 'cancelled', 'expired');
  DELETE FROM public.mcp_authorization_connections selected
  WHERE selected.personal_account_id = selected_account_id;
  DELETE FROM public.mcp_refresh_credentials credentials
  WHERE credentials.personal_account_id = selected_account_id;
  UPDATE public.mcp_authorizations authorizations
  SET state = 'revoked', revoked_at = coalesce(authorizations.revoked_at, observed_at),
      refresh_family_state = 'revoked',
      refresh_family_revoked_at = coalesce(authorizations.refresh_family_revoked_at, observed_at)
  WHERE authorizations.personal_account_id = selected_account_id
    AND (authorizations.state <> 'revoked' OR authorizations.refresh_family_state <> 'revoked');
  UPDATE public.api_keys keys
  SET state = 'revoked',
      revoked_at = coalesce(keys.revoked_at, observed_at),
      credential_digest = NULL,
      metadata_expires_at = coalesce(
        keys.metadata_expires_at,
        observed_at + interval '90 days'
      )
  WHERE keys.personal_account_id = selected_account_id
    AND keys.state = 'active';
  RETURN QUERY
  SELECT accounts.id, accounts.state, accounts.deletion_requested_at, connections.public_id
  FROM public.personal_accounts accounts
  LEFT JOIN public.whatsapp_connections connections
    ON connections.personal_account_id = accounts.id
   AND connections.state <> 'deleting'
  WHERE accounts.id = selected_account_id
  ORDER BY connections.public_id;
END
$function$;
