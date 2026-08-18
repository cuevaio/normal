# Stored Media ingestion

Stored Media is projected as `pending` from an authenticated message before provider retrieval begins. The provider source and all metadata remain envelope-encrypted; logs and metrics contain only state, byte counts, duration, and failure class.

Processing uses the production Wasender media adapter and its guarded HTTPS download boundary. It applies the media-type limits from ADR 0008 to actual streamed bytes, hashes plaintext while streaming it into the chunked AES-256-GCM R2 container, and reads the completed container once to authenticate its complete structure. Only then may the Neon finalization transaction reserve the verified byte count and change the row to `ready`.

The API Worker's one-minute scheduled handler loads up to 10 pending rows with their encrypted key envelopes, provider authority, and provider source. Overlapping invocations use distinct opaque object keys; the quota transaction chooses the sole winner and every losing object is deleted. Failed R2 deletions enter the opaque Neon deletion outbox and are retried by later scheduled runs.

## Failure handling

- Invalid sources and size-policy violations become `rejected`.
- Metadata, download, encryption, structural verification, or storage failures become `failed` after the configured processing attempts are exhausted.
- A quota-losing finalization becomes unavailable and its R2 object is deleted.
- If a ready row's sole R2 object is missing, mark it `failed` with `object_missing`; do not claim recovery or retry the provider source, which was destroyed at finalization.

Object deletion failures are safe to retry by opaque object key. Never log provider URLs, filenames, MIME metadata ciphertext, hashes tied to a User, or decrypted bytes. A retained-byte discrepancy is an incident: stop new finalizations for the affected Personal Account, compare ready-row byte totals to `stored_media_used_bytes`, and repair the ledger under audited operator procedure before resuming.

## Protected MCP reads

`resources/templates/list` advertises the non-listable `whatsapp-media://` template only for an active MCP Authorization with `messages:read`; `resources/list` remains empty. Each read rechecks the selected WhatsApp Connection and complete Stored Message–Stored Media ownership chain in Neon, atomically writes the Activity Log and reserves the verified full plaintext byte count, and only then decrypts metadata and the private R2 container. Responses are attachments with the verified MIME type, a sanitized filename when available, private zero-TTL cache metadata, and `Cache-Control: no-store`.

## Protected REST reads

`GET /v1/connections/{connection_id}/messages/{message_id}/media/{media_id}` is the authenticated nested REST path returned from eligible Stored Message metadata. It is not listable, does not accept ranges or chunks, and never emits a public, provider, R2, or presigned URL. The request requires `messages:read`, an explicitly selected WhatsApp Connection, and the complete Stored Message–Stored Media ownership chain. Activity Log admission and the verified full plaintext byte reservation complete before metadata or container decryption. Successful responses use the normalized MIME type, a sanitized optional filename, and `Cache-Control: private, no-store`. Unknown, unauthorized, deleted, excluded, cross-linked, non-ready, and oversized media share one constant-shape 404.

Configure `DECRYPTED_MEDIA_BYTES_PER_DAY` to the approved positive per-Personal-Account UTC-day limit. Unknown, revoked, cross-linked, deleted, non-ready, oversized, malformed, missing, or authentication-failed reads deliberately share the resource-not-found boundary. Investigate using safe outcome counts and container failure classes only; never log the URI, filename, object key, plaintext, provider URL, or authorization token.
