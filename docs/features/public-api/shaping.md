---
shaping: true
---

# Public API - Shaping

## Current State

- `apps/api` is the sole public data plane. Signed-in product routes use short-lived Clerk JWTs and exact browser Origin; `/mcp` uses Worker-issued OAuth tokens and live MCP Authorization checks.
- MCP exposes eight capabilities: list Connections, contacts, groups, and conversations; read and search Stored Messages; create Send Operations; and read Send Status. It also exposes non-listable protected Stored Media.
- MCP Authorizations already model four independent permissions and explicit WhatsApp Connection selection. Newly created Connections never enter an existing grant automatically.
- Protected MCP operations fail closed unless a metadata-only Tool Call Log can be written before decryption, media release, or provider access. Neon atomically enforces authoritative quotas.
- Public handles, privacy modules, output schemas, send orchestration, encryption, and database repositories are reusable. MCP request envelopes, OAuth context, audit taxonomy, cursor authority, result wrappers, and media URIs are not protocol-neutral today.
- The dashboard has no API Key destination. The engineering `docs` directory is not deployed, and the product has no OpenAPI document or Scalar dependency.

## Requirements

| ID | Requirement | Status |
|---|---|---|
| R0 | A User can create and revoke API Keys for personal server-side automations and call every capability currently available through MCP. | Core goal |
| R1 | Each API Key has any non-empty subset of `connections:read`, `directory:read`, `messages:read`, and `messages:send`, plus an explicit non-empty set of non-deleted WhatsApp Connections. Permissions remain independent and later Connections are never added automatically. | Must-have |
| R2 | Neon is authoritative for credential validity, Personal Account ownership, permissions, selected Connections, expiry, revocation, quotas, Activity Logs, and lifecycle state. | Must-have |
| R3 | API Key plaintext is shown once. Normal stores only a purpose-specific HMAC digest and safe management metadata; no operator, dashboard, backup-restored runtime, log, or telemetry sink can recover plaintext. | Must-have |
| R4 | Authentication uses a narrow fixed-search-path database bootstrap, restricted runtime role, transaction-local tenant context, RLS, and composite tenant relationships. Unknown and cross-tenant handles retain constant-shape behavior. | Must-have |
| R5 | MCP and REST use protocol-neutral application operations so authorization, privacy, quota, retention, Recipient Exclusion, and send decisions do not diverge between adapters. | Must-have |
| R6 | Every protected REST operation durably begins an Activity Log and reserves applicable quota before decrypting data, releasing media, or invoking the provider. Audit unavailability fails closed. | Must-have |
| R7 | MCP and REST share Personal Account send, returned-message-record, and decrypted-media-byte quotas. REST also enforces per-API-Key request-frequency limits. | Must-have |
| R8 | REST sends require a caller-supplied `Idempotency-Key`, preserve exact content and ambiguous-outcome rules, and create a Send Operation rather than pretending to create a Stored Message. | Must-have |
| R9 | Send Status is available only through the originating active API Key, selected Connection, and `messages:send` permission. | Must-have |
| R10 | REST errors use RFC 9457 Problem Details with a stable safe Normal code. Invalid credentials return 401, missing permission returns 403, and unknown, cross-tenant, or mismatched resources share a 404 boundary. | Must-have |
| R11 | `/v1` is stable and additive. Breaking changes require a future major version with an announced sunset. | Must-have |
| R12 | Search terms remain in a closed POST body and never enter URLs, cursors, Activity Logs, or telemetry. | Must-have |
| R13 | REST message pages return complete retained text, never split a Stored Message, and reduce record count to remain within a 1 MiB encoded JSON hard limit. | Must-have |
| R14 | Stored Media remains non-listable and is served only through an authenticated, nested, no-store endpoint up to 16 MiB after ownership, audit, and quota checks. | Must-have |
| R15 | API Keys are server-side credentials. Protected routes emit no API-key CORS policy, and public docs do not execute requests or persist credentials in a browser. | Must-have |
| R16 | The dashboard provides top-level API Keys and Activity Log destinations and crosses directly to the API Worker with Clerk authentication. API Key creation requires Clerk first-factor verification within five minutes. | Must-have |
| R17 | The OpenAPI 3.1 document is generated from shared closed contracts and route metadata used by runtime handlers, validated in CI, and rendered by a static Scalar-first Astro app on Vercel. | Must-have |
| R18 | Revocation, expiry, Connection Deletion, Personal Account Deletion, and database restore cannot resurrect API access. Safe revoked metadata remains User-visible for 90 days. | Must-have |

## Selected Shape

### Boundary

The existing API Worker remains the only public data plane. It gains a REST adapter parallel to the signed-in product handlers and MCP adapter. Provider behavior remains behind `provider-control` and `packages/wasender`.

The adapters call shared application operations rather than calling each other:

```text
MCP OAuth -> MCP adapter ----\
                              -> protected WhatsApp operations -> Neon/R2/provider seam
API Key  -> REST adapter ----/
```

MCP retains JSON-RPC envelopes, resource links, scope-filtered discovery, and Client Confirmation metadata. REST uses HTTP resources, Problem Details, binary media responses, and an explicit Send Operation creation request. Creating a Send Operation is the API caller's explicit action; no self-attested confirmation field or dashboard approval queue is added.

### API Key Credential

- Management handle: `apk_` plus the existing 21-character opaque payload format.
- Credential: a recognizable `normal_`-prefixed split token containing a non-secret lookup payload and at least 256 bits of random secret entropy.
- Storage: HMAC-SHA-256 of the canonical complete credential using a new purpose-specific `API_KEY_HMAC_SECRET`; plaintext is returned once and never persisted.
- Parsing: strict total length, prefix, alphabet, and separator validation before database work.
- Comparison: the Worker computes the digest and passes only the lookup handle and digest to a narrow database bootstrap. Raw credentials and digests never enter logs or telemetry.
- Management: create, list, and permanent revoke only. The grant, scopes, selected Connections, and expiry are immutable.
- Limit: ten active keys per Personal Account. Expiry is optional and enforced with database time.
- Display: required active-name uniqueness, safe prefix/last characters, handle, scopes, selected Connections, created time, optional expiry, last use, and state. No plaintext redisplay.

The exact external credential grammar and lengths are fixed in the public contract before implementation; they may not expose an internal database ID or creation time.

### API Key Creation

`POST /v1/api-keys` is a signed-in product route, not an API-Key-authenticated public route. It requires:

- exact configured web Origin and Clerk bearer token;
- first-factor verification less than five minutes old;
- a trimmed, unique display name;
- at least one exact permission;
- at least one owned, non-deleted WhatsApp Connection;
- optional future expiry.

One tenant transaction enforces the active-key limit, inserts the grant, selected Connections, permissions, and HMAC digest, and returns the plaintext only in that creation response. A lost creation response means creating a replacement; Normal cannot recover the secret.

`GET /v1/api-keys` lists active, expired, and revoked safe metadata retained within the 90-day history window. `DELETE /v1/api-keys/{api_key_id}` permanently revokes, clears the credential digest immediately, and is idempotent for the owning User.

### Authentication Sequence

For every protected REST request:

1. Strictly parse one `Authorization: Bearer <API Key>` credential and reject duplicate or oversized authorization input.
2. Compute the purpose-specific HMAC digest without logging the input or output.
3. Invoke a narrow `SECURITY DEFINER` bootstrap with the public key handle and digest. The function has a fixed search path, checks active Personal Account, expiry, revocation, and digest, establishes transaction-local tenant context, and returns only the internal grant identity needed by the repository.
4. Check the endpoint permission, explicitly selected WhatsApp Connection, and complete resource ownership chain under RLS.
5. Atomically begin the Activity Log and reserve request plus operation-specific quota before protected work.
6. Complete the Activity Log before releasing JSON or binary content where possible. Durable Send Operations remain authoritative for side effects after the provider-attempt boundary.

Authentication infrastructure or Neon unavailability returns a safe 503 and fails closed. No cache may extend API Key validity or revocation.

### Permissions

| Permission | REST capabilities |
|---|---|
| `connections:read` | List explicitly selected WhatsApp Connections. |
| `directory:read` | List contacts and joined groups for an explicitly selected Connection. |
| `messages:read` | List conversations, read/search Stored Messages, and read eligible Stored Media. |
| `messages:send` | Create Send Operations and read status for operations created by the same API Key. |

Send permission never implies Directory or Stored Message read permission. A send-only caller can use a previously known `ctc_` or `grp_` handle or supply a Direct Address, but cannot discover recipients or content.

### Public REST Resources

All request objects are closed, fields use `snake_case`, timestamps use RFC 3339 UTC strings, and handles retain their existing types.

| Method | Path | Permission | Behavior |
|---|---|---|---|
| GET | `/v1/connections` | `connections:read` | List selected non-deleted WhatsApp Connections. |
| GET | `/v1/connections/{connection_id}/contacts` | `directory:read` | Page active contacts with existing safe Directory filters and freshness metadata. |
| GET | `/v1/connections/{connection_id}/groups` | `directory:read` | Page currently joined groups with freshness metadata. |
| GET | `/v1/connections/{connection_id}/conversations` | `messages:read` | Page WhatsApp Conversations by Conversation Activity. |
| GET | `/v1/connections/{connection_id}/conversations/{conversation_id}/messages` | `messages:read` | Page complete retained Stored Message content, history boundary, and intersecting Ingestion Gaps. |
| POST | `/v1/connections/{connection_id}/messages/search` | `messages:read` | Search exact normalized words from a privacy-safe JSON body. |
| POST | `/v1/connections/{connection_id}/send-operations` | `messages:send` | Create or replay one idempotent text Send Operation for exactly one handle, E.164 phone, or WhatsApp username destination. |
| GET | `/v1/connections/{connection_id}/send-operations/{send_operation_id}` | `messages:send` | Read the originating API Key's local Send Status. |
| GET | `/v1/connections/{connection_id}/messages/{message_id}/media/{media_id}` | `messages:read` | Read eligible binary Stored Media with private no-store headers. |

Search is POST because terms may contain private message content. It is synchronous and creates no persisted search resource. Send creation requires `Idempotency-Key`; exact replay never resends, a changed payload conflicts, and ambiguous provider outcomes are never automatically retried.

### HTTP Contract

- Collection success: `{ "data": [...], "pagination": { "next_cursor": string | null, "has_more": boolean }, "meta": {...} }`. `meta` is omitted when the collection has no resource-specific coverage or freshness data.
- Single-resource success: the closed resource object without a `data` wrapper.
- Binary success: normalized MIME type, sanitized optional filename, `Cache-Control: private, no-store`, no range/chunk support in v1.
- Error: RFC 9457 `application/problem+json` with `type`, `title`, `status`, safe `detail`, stable `code`, and optional `retryable`, `retry_after_seconds`, or `resets_at`.
- Cursor: short-lived HMAC cursor bound to API Key grant, endpoint, explicit Connection, normalized filters or search digest, limit, sort version, boundary, and expiry. MCP and API cursor formats are not interchangeable.
- Pagination: default 20 and maximum 50 where MCP currently pages; search remains maximum 20. Message pages may return fewer records to remain below 1 MiB encoded JSON and never truncate or split one Stored Message.
- Caching: protected JSON and media are non-cacheable. Public OpenAPI and docs assets may use static cache headers.
- CORS: API-Key-authenticated routes do not opt into browser CORS. Signed-in product management routes retain the exact configured web Origin policy.

### Activity Log and Quotas

Generalize Tool Call Log to Activity Log rather than creating a parallel API audit system. Each record includes an allowlisted channel (`mcp` or `api`), operation category, safe API Key or MCP Client presentation identity, opaque resource references, timing, outcome, counts, and latency. It never contains credentials, credential hashes, authorization headers, message content, media, search terms, full phone numbers, provider payloads, raw bodies, or tenant identifiers.

Existing send, returned-record, and decrypted-media quotas become channel-neutral Personal Account limits shared by MCP and REST. Request-frequency reservations include the exact grant and support per-API-Key limits without allowing edge rate limiting to grant capacity. Quota and Activity Log insertion remain in the same authoritative transaction as protected operation admission.

### Lifecycle and Restore

| Event | Required behavior |
|---|---|
| Expiry | Database-time check denies authentication immediately; clear the digest and retain safe metadata for 90 days. |
| User revocation | Clear the digest in the revocation transaction; later requests fail authentication immediately. |
| Disconnection | Historical authorized reads remain available; new sends fail as connection unavailable. |
| Connection Deletion | Remove that Connection from every key before protected access. If it was a key's last selected Connection, automatically revoke the key and clear its digest. |
| Personal Account Deletion | Revoke every API Key and clear every digest before tenant access or key use can continue; active rows later cascade during purge. |
| Database restore | Before verification traffic reopens, revoke all restored API Keys, clear their digests, rotate `API_KEY_HMAC_SECRET`, and record aggregate completion evidence. Users create replacement keys after recovery. No ordinary revoked key may reappear within the Neon RPO window. |
| Retention | Active grants persist until expiry, revocation, or deletion. Safe expired/revoked metadata remains User-visible for 90 days, then purges. Activity Logs retain their independent original 90-day expiry. |

Routine HMAC rotation requires an explicit dual-generation migration if active keys must survive. Suspected HMAC compromise and every production restore instead use intentional global invalidation; the old authority must not remain accepted as a fallback.

### Dashboard

- Add `/dashboard/api-keys` as a top-level destination with an extracted dedicated client component rather than extending the 2,500-line `PublicBoundaryJourney` branch.
- Create flow: name, four independent permission checkboxes, explicit Connection selection including disconnected non-deleted Connections, optional expiry, recent-verification challenge, and one-time secret reveal.
- List flow: active/expired/revoked state, safe credential hint, permissions, selected Connections, created/expires/last-used/revoked timestamps, and revoke action.
- Rename Tool Call Logs to Activity Log and add channel and API Key filters while preserving metadata-only presentation.
- Browser requests continue directly to the API Worker with the fixed Clerk token template. No Next.js data proxy or API Key enters browser persistence.

### Scalar Documentation App

- Add `apps/docs` as an Astro static-output workspace deployed as a separate Vercel project at `docs.normal.fast`.
- Render one official `@scalar/astro` component in its default static mode. Add no custom UI components or bespoke docs shell.
- Generate `/openapi.json` from explicit route metadata and shared Effect contracts in `packages/contracts`; runtime handlers parse the same contracts.
- Put getting started, authentication, permissions, pagination, errors, idempotency, send ambiguity, retention/history coverage, and privacy guidance in OpenAPI Markdown descriptions, tags, schemas, and examples rendered by Scalar.
- Set `hideTestRequestButton: true`, `persistAuth: false`, disable the Scalar Agent and telemetry, and provide generated curl plus server-side language examples.
- Self-host the exact pinned Scalar browser bundle as a static asset with immutable caching. Do not load `latest`, use Scalar's request proxy, or send the OpenAPI document to a hosted registry at runtime.
- Validate OpenAPI 3.1 and the generated static site in CI. The document contains no secrets, tenant examples, real phone numbers, message content, or controlled test credentials.

## Rejected Shapes

### Unkey plus Neon

Unkey would verify and manage secrets, but Normal would still need Neon checks for ownership, selected Connections, permissions, lifecycle, quotas, and audit. The extra root key, external availability dependency, duplicated policy, and documented revocation propagation window do not justify the integration for ten immutable keys per Personal Account.

### Unkey as authority

This conflicts with the existing decision that Neon is authoritative for authorization and tenant state and would place sensitive Personal Account relationships in external key metadata.

### API wrapper over MCP JSON-RPC

This would leak MCP envelopes and tool naming into HTTP, retain the wrong cursor and authorization binding, and make media and errors non-conventional. Shared application operations are the correct seam; one public protocol must not call the other.

### Browser API Keys and interactive Scalar requests

Long-lived bearer credentials are unsafe in browser storage, and enabling docs-origin CORS would contradict the server-only contract. Scalar remains a static reference and code-example generator.

### Restore-external per-key revocation journal

It could preserve individual active keys through restore but adds a second restore journal and sensitive operational complexity. Global invalidation is simpler, fail-closed, and appropriate for a rare recovery event during the current product stage.
