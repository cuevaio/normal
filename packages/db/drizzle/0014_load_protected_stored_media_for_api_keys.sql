-- REST Stored Media reads use the same ownership, readiness, size, and
-- Recipient Exclusion checks as MCP, but authorize through an API Key grant
-- instead of an MCP Authorization.
CREATE FUNCTION public.load_protected_stored_media_for_api_key(
  candidate_api_key_id uuid,
  candidate_connection_public_id text,
  candidate_message_public_id text,
  candidate_media_public_id text
)
RETURNS TABLE (
  media_id uuid, object_key text, plaintext_size_bytes bigint,
  metadata_ciphertext_version smallint, metadata_key_version integer,
  metadata_nonce bytea, metadata_ciphertext bytea,
  account_key_version integer, kms_key_id text, account_key_ciphertext bytea,
  connection_account_key_version integer, connection_key_version integer,
  connection_key_nonce bytea, connection_key_ciphertext bytea, connection_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, public
AS $function$
  SELECT media.id,media.object_key,media.plaintext_size_bytes,
    media.metadata_ciphertext_version,media.metadata_key_version,media.metadata_nonce,media.metadata_ciphertext,
    keys.key_version,keys.kms_key_id,keys.ciphertext,
    connection_keys.account_key_version,connection_keys.key_version,connection_keys.nonce,
    connection_keys.ciphertext,connections.id
  FROM public.stored_media media
  JOIN public.stored_messages messages ON messages.personal_account_id=media.personal_account_id
    AND messages.whatsapp_connection_id=media.whatsapp_connection_id AND messages.id=media.stored_message_id
  JOIN public.whatsapp_conversations conversations ON conversations.personal_account_id=messages.personal_account_id
    AND conversations.whatsapp_connection_id=messages.whatsapp_connection_id
    AND conversations.id=messages.conversation_id
  JOIN public.whatsapp_connections connections ON connections.personal_account_id=media.personal_account_id
    AND connections.id=media.whatsapp_connection_id
  JOIN public.api_keys grants ON grants.personal_account_id=media.personal_account_id
    AND grants.id=candidate_api_key_id
  JOIN public.api_key_connections selected ON selected.personal_account_id=media.personal_account_id
    AND selected.whatsapp_connection_id=media.whatsapp_connection_id
    AND selected.api_key_id=grants.id
  JOIN public.whatsapp_connection_key_envelopes connection_keys ON connection_keys.personal_account_id=media.personal_account_id
    AND connection_keys.whatsapp_connection_id=media.whatsapp_connection_id
  JOIN public.personal_account_key_envelopes keys ON keys.personal_account_id=media.personal_account_id
    AND keys.key_version=connection_keys.account_key_version
  WHERE media.personal_account_id=nullif(pg_catalog.current_setting('public.personal_account_id',true),'')::uuid
    AND connections.public_id=candidate_connection_public_id
    AND messages.public_id=candidate_message_public_id
    AND media.public_id=candidate_media_public_id AND media.state='ready'
    AND media.plaintext_size_bytes <= 16777216 AND messages.deleted_at IS NULL
    AND connections.state <> 'deleting' AND keys.unavailable_at IS NULL
    AND grants.state='active'
    AND (grants.expires_at IS NULL OR grants.expires_at > transaction_timestamp())
    AND 'messages:read' = ANY(grants.permissions)
    AND NOT EXISTS (SELECT 1 FROM public.whatsapp_recipient_exclusions rules
      WHERE rules.personal_account_id=connections.personal_account_id
        AND rules.whatsapp_connection_id=connections.id
        AND rules.recipient_locator=conversations.recipient_locator AND rules.excluded)
    AND keys.ciphertext IS NOT NULL AND connection_keys.unavailable_at IS NULL
    AND connection_keys.ciphertext IS NOT NULL;
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.load_protected_stored_media_for_api_key(uuid,text,text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.load_protected_stored_media_for_api_key(uuid,text,text,text) TO whatsapp_api_runtime;
