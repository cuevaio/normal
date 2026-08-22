# Deployment configuration

Configuration is validated in each production Effect composition root before a
request is accepted. Production roots accept only `development`, `preview`, or
`production`; `test` is reserved for statically separate test Layers.

The table below is the environment and secret inventory. “Source and rotation”
states both the generation or issuance method and the rotation expectation.
The checked example files are the placeholder-example contract: secrets and
environment-specific values are deliberately unusable and contain
`replace-with`, an example-only hostname or account, or an explicitly
non-production development value. Fixed non-secret policy values such as the
KMS region remain exact. A production composition root, manifest renderer,
operator command, or infrastructure variable must reject placeholder forms.
Secret examples never contain usable key material.

| Value | Sensitivity | Consumer | Source and rotation |
| --- | --- | --- | --- |
| `DEPLOYMENT_ENVIRONMENT` | Non-secret | Web, API, provider-control | Set to the deployed environment. Change only as part of a deployment. |
| `NEXT_PUBLIC_API_ORIGIN` | Non-secret | Web browser bundle and web startup validation | OpenTofu sets the same-environment API Worker's bare HTTPS origin. It is frozen into the browser bundle at build time. |
| `NEXT_PUBLIC_WEB_ORIGIN` | Non-secret | Web metadata, robots, XML sitemap, and web startup validation | OpenTofu sets the same-environment Vercel custom origin. It is frozen into the web build and must be a bare HTTPS origin. |
| Docs origin | Non-secret | Static Scalar documentation | OpenTofu `docs_hostname` assigns `docs.normal.fast` in production and a distinct same-environment hostname in development and preview. The Astro app is static output only. It self-hosts a pinned Scalar browser bundle, publishes the generated OpenAPI artifact, and must not receive API Key HMAC material, Clerk secrets, or a Vercel rewrite to the API Worker. Deployment and launch-gate smoke read the same origin as `SMOKE_DOCS_ORIGIN` or `DOCS_ORIGIN`. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Public identifier | Web browser bundle and web startup validation | Copy the publishable key from the same-environment Clerk instance. OpenTofu freezes it into that environment's browser bundle. |
| `NEXT_PUBLIC_POSTHOG_KEY` | Public project key | Web browser product analytics | Optional same-environment PostHog project key. OpenTofu `posthog_project_key` freezes it into the browser bundle only when `posthog_host` is also set. Public browser configuration, not a secret. Leave both unset to disable analytics collection. |
| `NEXT_PUBLIC_POSTHOG_HOST` | Non-secret | Web browser product analytics | Optional bare HTTPS PostHog ingest origin for the same project. OpenTofu `posthog_host` must be set together with `posthog_project_key`. Browser analytics go directly to this origin; do not add a Vercel rewrite or first-party proxy. |
| `CLERK_API_AUDIENCE` | Non-secret | API | Exact bare HTTPS API origin. OpenTofu derives it from `api_hostname`; the custom JWT template's `aud` claim must match it exactly. |
| `CLERK_AUTHORIZED_PARTY` | Non-secret | API | Exact bare HTTPS web origin allowed by both the token `azp` claim and request `Origin`. OpenTofu derives it from `web_hostname`. |
| `CLERK_ISSUER` | Non-secret | API | Exact HTTPS issuer for the same-environment Clerk instance. |
| `CLERK_JWT_KEY` | Secret deployment material | API | PEM public key for the custom Clerk JWT template. Store it only as a Cloudflare Worker secret so verification does not depend on a network lookup. Replace it when Clerk rotates the template signing key. |
| `CLERK_SECRET_KEY` | Secret deployment material | API | Same-environment Clerk Backend API secret used only after durable Personal Account Deletion intent to delete the owning Clerk User. |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Secret deployment material | API | Signing secret for Clerk deliveries. Configure `user.deleted` delivery to `/v1/webhooks/clerk`; invalid deliveries fail closed before identity lookup. |
| `OAUTH_ISSUER` | Non-secret | API OAuth provider | Exact API HTTPS origin and RFC 8414 issuer. It must equal `CLERK_API_AUDIENCE`; OpenTofu derives both from `api_hostname`. |
| `OAUTH_RESOURCE` | Non-secret | API OAuth provider | Exact protected MCP resource, formed as `OAUTH_ISSUER` plus `/mcp`. |
| `OAUTH_PROTOCOL_ENCRYPTION_KEY` | Secret | API OAuth provider | Dedicated 32-byte hex AES key for short-lived consent handoff records. Generate with `openssl rand -hex 32`; never reuse another platform key. |
| `SMOKE_CHECK_SECRET` | Secret | API deployed-smoke boundary and deployment runner | Dedicated 32-byte hex bearer secret. Generate independently with `openssl rand -hex 32`, store it in the Worker and deployment secret stores, and rotate both together. It authorizes only disposable smoke canaries and must never be reused as an OAuth, encryption, or HMAC key. |
| Operations control origin | Non-secret | Recovery verifier, recovery game day, and observability canary | OpenTofu assigns `https://operations.normal.fast` in production. Use `/v1/availability`, `/v1/alerts`, and `/v1/receipts` only with their separate bearer credentials. It is not an application API origin. |
| `CLOUDFLARE_ANALYTICS_TOKEN` | Secret | Operations control only | Zone scoped Cloudflare token with Analytics Read and no write authority. It queries HTTP request and Email Service delivery evidence for the production zone. |
| `CLOUDFLARE_ZONE_ID` | Sensitive identifier | Operations control and infrastructure runners | Exact production zone containing the API, operations, and pager sending hostnames. Store it with the operations Worker secrets so a request cannot redirect an analytics query. |
| `MCP_SMOKE_CLIENT_ID` | Public authorization-policy identifier | Deployment and launch-gate workflows | The reviewed public OAuth client ID used by the dedicated deployment-smoke MCP Authorization. Change only with the corresponding client-policy review and reauthorization. |
| `MCP_SMOKE_REFRESH_SECRET_ID` | Sensitive identifier | Deployment and launch-gate workflows | The exact AWS Secrets Manager secret created by `mcp-smoke-credential.template.json`. Its plaintext is the current one-time refresh credential and is read and replaced only by the environment-bound smoke role. |
| `AWS_MCP_SMOKE_CREDENTIAL_ROLE_ARN` | Non-secret authority identifier | GitHub Actions OIDC | Exact role allowed to read and rotate only the production smoke refresh secret. Trust is limited to this repository's `production` and `production-launch-gate` protected environments. |
| `MCP_REQUESTS_PER_MINUTE` | Non-secret approved quota | API MCP and REST resource server | Authoritative per-Personal-Account request reservations allowed in an exact rolling minute, shared by MCP and REST. REST also applies the same reviewed value as the per-API-Key minute limit. Set the reviewed positive integer through `mcp_requests_per_minute`; there is no production default. |
| `MCP_REQUESTS_PER_HOUR` | Non-secret approved quota | API MCP and REST resource server | Authoritative per-Personal-Account request reservations allowed in an exact rolling hour, shared by MCP and REST. REST also applies the same reviewed value as the per-API-Key hour limit. Set the reviewed integer through `mcp_requests_per_hour`; it must be at least the minute value and has no production default. |
| `READ_MESSAGE_RECORDS_PER_DAY` | Non-secret approved quota | API MCP resource server | Authoritative per-Personal-Account Stored Message records returned per UTC day. Tombstones count and there is no production default. |
| `DECRYPTED_MEDIA_BYTES_PER_DAY` | Non-secret approved quota | API MCP resource server | Authoritative per-Personal-Account full plaintext Stored Media bytes reserved per UTC day before decryption. There is no production default. |
| `MCP_CURSOR_HMAC_SECRET` | Secret | API MCP and REST resource server | Dedicated 32-byte hex HMAC key for authorization-bound pagination cursors. REST Directory cursors use a distinct signing document that binds the API Key grant and operation ID, so MCP and REST cursors are not interchangeable. Generate independently with `openssl rand -hex 32`; never reuse OAuth, content, provider-reference, webhook, reservation, or deletion keys. Rotation invalidates outstanding short-lived cursors. |
| `API_KEY_HMAC_SECRET` | Secret | API API Key management, REST authentication, and direct MCP authentication | Dedicated 32-byte hex HMAC key for User-created API Key credential digests. The Worker computes the digest and passes only the public handle and digest to `bootstrap_api_key`. API Key-shaped credentials at `POST /mcp` take this path before OAuth middleware; failure never falls back to OAuth. Generate independently with `openssl rand -hex 32`; never reuse OAuth, cursor, content, provider-reference, webhook, reservation, or deletion keys. A Personal Account may retain at most ten active API Keys. Creating an API Key requires Clerk first-factor verification within five minutes. Optional expiry is enforced with database time on the next request; hourly scheduled work then clears the digest and later purges safe expired or revoked metadata after 90 days. Connection Deletion removes that WhatsApp Connection from every API Key and permanently revokes a key that loses its last selected Connection, clearing the digest. Disconnection does not revoke the key. Every production database restore revokes every restored API Key, clears every digest, and requires a newly generated secret before traffic reopens; the predecessor is not accepted as a verification fallback. Users create replacement keys after recovery. Routine rotation that preserves active keys is not part of v1. |
| `SEND_FINGERPRINT_HMAC_SECRET` | Secret | API outbound-send workflow | Dedicated 32-byte hex HMAC key for domain-separated non-reversible exact-request and request-shape fingerprints retained with idempotency bindings, including image MIME and optional exact caption. Generate independently; do not replace it while any 90-day binding remains live. |
| `SENDS_PER_MINUTE` | Non-secret approved quota | API outbound-send workflow | Per-authorization exact rolling-minute send reservation limit. There is no production default. |
| `SENDS_PER_DAY` | Non-secret approved quota | API outbound-send workflow | Per-Personal-Account UTC-day send reservation limit. There is no production default. |
| `MESSAGE_RETENTION_DAY_OPTIONS` | Non-secret reviewed product policy | API and web Message Retention Policy controls | Set to the reviewed strictly increasing comma-separated finite-day choices containing the 30-day default; `7,30,90` is the private-beta example. Change only through a reviewed product deployment. |
| `DATABASE_URL` | Secret | Database tooling that consumes `@whatsapp-mcp/db/config` | Issue a restricted Neon role URL, store it in the deployment secret store, and rotate it through Neon plus the deployment platform. API production traffic uses Hyperdrive instead. |
| `MIGRATION_DATABASE_URL` | Secret | `bun run db:migrate` and `bun run db:check` | Obtain the direct, unpooled owner URL from the sensitive OpenTofu output. It must be a TLS Neon URL and must never be configured on a Worker or web deployable. Rotate it by rotating the Neon migration-owner password. |
| `NEON_API_KEY` | Secret | OpenTofu Neon provider | Issue an organization-scoped automation key, keep it only in the infrastructure runner, and rotate it in Neon. |
| `CLOUDFLARE_API_TOKEN` | Secret | OpenTofu Cloudflare provider and Wrangler | Scope it to the declared Workers, R2, KV, Queues, schedules, Hyperdrive, and API custom domain in the current environment's account. Rotate it in Cloudflare. |
| `CLOUDFLARE_ACCOUNT_ID` | Sensitive identifier | Wrangler | Cloudflare account selected for Worker deployment. |
| `CLOUDFLARE_HYPERDRIVE_ID` | Sensitive identifier | API Wrangler config renderer | Set from OpenTofu output `api_hyperdrive_id`; it is rendered into a mode-0600 generated config, not committed. |
| `CLOUDFLARE_OAUTH_KV_ID` | Sensitive identifier | API Wrangler config renderer | Set from the sensitive `infra/compute` output `oauth_kv_namespace_id`; the renderer rejects a missing or malformed identifier. |
| `CLOUDFLARE_RECOVERY_KV_ID` | Sensitive identifier | Recovery game-day Wrangler config renderer | Set from the sensitive `infra/compute` output `recovery_kv_namespace_id`. This namespace contains disposable recovery fixtures only and must never be the OAuth namespace. |
| `CLOUDFLARE_OPERATIONS_KV_ID` | Sensitive identifier | Operations control Wrangler config renderer | Set from the sensitive `infra/compute` output `operations_kv_namespace_id`. This namespace retains only pager message IDs and observation timestamps for one day. |
| `CLOUDFLARE_WEBHOOK_HYPERDRIVE_ID` | Sensitive identifier | API Wrangler config renderer | Set from OpenTofu output `webhook_hyperdrive_id`; it is rendered into a mode-0600 generated config, not committed. |
| `AWS_KMS_REGION` | Non-secret | API and deletion coordinator | Must be exactly `us-east-1`, matching ADR 0013 and the KMS stack region. |
| `KMS_CONTENT_ROOT_KEY_ARN` | Non-secret | API | The environment's `ContentRootKeyArn` CloudFormation output. The production root accepts only a `us-east-1` KMS key ARN. |
| `KMS_DELETION_COORDINATOR_KEY_ARN` | Non-secret | API Deletion Capsule writer and deletion coordinator | The environment's distinct `DeletionCoordinatorKeyArn` output. The Content Runtime role may encrypt capsules but cannot decrypt them; the coordinator role may decrypt but cannot encrypt. |
| Break-glass role ARN | Non-secret | Incident credential broker only | The environment's `BreakGlassRoleArn` output. Sessions require MFA, last at most one hour, and must carry the approved `personalAccountId` and `breakGlassRequestId` tags. Never configure this role on an application Worker. |
| `DELETION_COORDINATOR_DATABASE_URL` | Secret | Deletion coordinator | TLS Neon URL authenticated only as `whatsapp_deletion_runtime`. The role can list marker IDs and confirm provider absence, but cannot select tenant tables. |
| `DELETION_MARKER_HMAC_SECRET` | Secret | API deletion-marker writer | Dedicated 32-byte hex HMAC key for restore-external marker object keys. Generate independently with `openssl rand -hex 32`, retain it in the recovery inventory, and never reuse a provider-reference, webhook, cursor, or content key. |
| `RECIPIENT_TRANSITION_HMAC_SECRET` | Secret | API WhatsApp Recipient Exclusion writer and restore coordinator | Dedicated 32-byte hex HMAC key that derives the non-reversible recipient transition journal prefix from environment, WhatsApp Connection identity, recipient kind, and stable recipient locator. Generate independently with `openssl rand -hex 32`, retain it in the recovery inventory, and never reuse a deletion-marker, provider-reference, webhook, cursor, OAuth, WhatsApp Number, or content key. Losing it makes existing journal evidence unreadable and keeps a restored branch closed. |
| `NEON_BRANCH_ID` | Internal | API and restore coordinator | The exact opaque Neon branch identity. Readiness is bound to it so a restored branch inherits a non-matching approval and remains closed. |
| `RESTORE_DATABASE_URL` | Secret | Restore coordinator only | Direct TLS Neon URL for the `whatsapp_restore_runtime` role. It exposes only restore replay functions and must never be bound to the API or other Workers. |
| Recovery control origin | Non-secret | Protected `production-recovery` GitHub environment | OpenTofu assigns the distinct `https://recovery.normal.fast/drills` production endpoint. Store it as `RECOVERY_AUTOMATION_URL`; it is not an application API origin and accepts only the closed authenticated drill contract. |
| `RECOVERY_CONTROL_TOKEN` | Secret | Recovery control and protected `production-recovery` GitHub environment | Generate an independent random bearer credential. The Worker compares fixed-size SHA-256 digests without data-dependent early return. Rotate both stores together; never reuse an API Key, OAuth, smoke, or provider credential. |
| `NEON_RECOVERY_API_KEY` | Secret | Recovery control and recovery verifier | Issue a project-scoped Neon control-plane key limited to recovery branch lifecycle. It must not be an organization-wide infrastructure key or database credential. Rotate both Worker stores together. |
| `NEON_PROJECT_ID` | Sensitive identifier | Recovery control and recovery verifier | Exact project selected by the project-scoped recovery key. Store with Worker secrets so it cannot be redirected by a request. |
| `NEON_PARENT_BRANCH_ID` | Sensitive identifier | Recovery control and recovery verifier | Exact production parent branch allowed for PITR children. It is independent from serving `NEON_BRANCH_ID`; every create, reconcile, reset, URI, and delete operation rechecks it. |
| `RECOVERY_EVIDENCE_TOKEN` | Secret | Recovery control and recovery verifier only | Dedicated bearer credential on the private recovery-control-to-verifier service binding. Generate independently and never reuse an API, provider, or observability credential. |
| `RECOVERY_VERIFIER_DATABASE_PASSWORD` | Secret | Recovery control and recovery verifier only | Dedicated 32-byte hex password for the SQL-created `whatsapp_recovery_auditor` role on disposable recovery branches. Recovery control rotates the role to this value only after forward migrations, and the verifier uses it only through a direct TLS connection. Generate independently and never reuse a Neon API, migration-owner, serving runtime, or application credential. |
| `OBSERVABILITY_QUERY_URL` / `OBSERVABILITY_QUERY_TOKEN` | Secret operational endpoint and read credential | Recovery verifier and operations control | Set the URL to `https://operations.normal.fast/v1/availability` and use an independent bearer credential. Operations control returns exact seven day first party, Wasender, and WhatsApp availability plus the deployed API smoke result. The verifier derives RPO from the requested point and the committed heartbeat read from the recovered Neon branch, never from observability input. The query exposes no request, content, provider, or tenant identifiers. |
| `QUARTERLY_RECEIPT_SECRET` | Secret | Recovery game-day executor only | Dedicated 32-byte hex HMAC key binding quarterly receipts to operation, branch, nonce, and replay digest. |
| `PAGER_WEBHOOK_URL` / `PAGER_WEBHOOK_TOKEN` | Secret operational endpoint and write credential | Recovery game-day executor and observability canary | Set the URL to `https://operations.normal.fast/v1/alerts`. The independent bearer credential authorizes only the closed identity free alert envelope. |
| `PAGER_RECEIPT_URL` / `PAGER_RECEIPT_TOKEN` | Secret operational endpoint and read credential | Recovery game-day executor and observability canary | Set the URL to `https://operations.normal.fast/v1/receipts`. It confirms the matching final Cloudflare Email Service delivery event; HTTP acceptance by `PAGER_WEBHOOK_URL` is not sufficient evidence. |
| `PAGER_DESTINATION_ADDRESS` | Secret operational route | Operations control only | Set to the verified production pager destination. The Worker email binding independently restricts delivery to `hi@cueva.io`, and the sender to `pager@alerts.normal.fast`. |
| `KMS_RECOVERY_GAME_DAY_KEY_ARN` | Non-secret identifier | Recovery game-day executor only | Purpose-specific `us-east-1` KMS key restricted to the `recovery-game-day` encryption context. It is not the Content Root or Deletion Coordinator key. |
| `AWS_RECOVERY_GAME_DAY_ROLE_ARN` | Non-secret identifier | Protected `production` and `production-recovery` GitHub environments | GitHub OIDC role that can use only the purpose-specific recovery game-day key. Deployment uploads an initial one-hour session, while the quarterly runner obtains a fresh OIDC session and atomically rotates all four private Worker bindings at most every twenty minutes until the drill finishes. |
| `WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET` | Secret | API Connection Setup writer | Dedicated 32-byte hex HMAC key for platform-wide WhatsApp Number reservations. Generate independently with `openssl rand -hex 32`; never reuse Directory index, deletion-marker, provider-reference, webhook, cursor, OAuth, or content keys. Rotation requires rebuilding every retained reservation under a stopped-provisioning migration. |
| `AWS_ACCESS_KEY_ID` | Secret | API and deletion coordinator | Per-Worker short-lived access key from the API's `ContentRuntimeRole` or coordinator's `DeletionCoordinatorRole`; never copy one Worker's credential to the other. |
| `AWS_SECRET_ACCESS_KEY` | Secret | API and deletion coordinator | Short-lived secret paired with that Worker's `AWS_ACCESS_KEY_ID`; never log or commit it. |
| `AWS_SESSION_TOKEN` | Secret | API and deletion coordinator | Required role-session token. Its absence prevents the owning production composition root from running. |
| `WASENDER_API_CREDENTIAL` | Secret | Provider-control | Account-level Wasender Personal Access Token used only for lifecycle endpoints. Store it as a Worker secret and rotate it in Wasender and Cloudflare together. |
| `WASENDER_REFERENCE_SECRET` | Secret | Provider-control | Stable 32-byte hex HMAC key used to turn raw provider session IDs into opaque adapter locators. Generate with `openssl rand -hex 32`; rotate only through the reconciliation procedure below. |
| `WEBSHARE_API_KEY` | Secret | Provider-control | Webshare account API key used only to read the assigned proxy list. The plan must contain static shared ISP proxies allocated exclusively to Colombia with Auto-Refresh disabled. Store it as a Worker secret and rotate it in Webshare and Cloudflare together. |

Wasender Directory reads do not add a platform-wide environment secret. The
owning API workflow decrypts the selected WhatsApp Connection's envelope-
encrypted session authority only for the duration of that connection-scoped
operation and constructs `makeWasenderSessionDirectory` with the resulting
redacted value. The constructor rejects empty, oversized, or control-character
authority values before network access. Its provider origin is fixed in the
production adapter, so configuration cannot redirect credentials to another
host or select a fake implementation.

The WhatsApp Connection row lock serializes every projection that can create
or restore readable content — message upsert, edit, deletion, send evidence,
and Stored Media finalization — against an exclusion transition, so a purge
cannot commit between a suppression check and its write. An acknowledged
transition also keeps a 90-day replay binding for its idempotency key, so a
retry after a lost response replays the recorded result instead of colliding
with its own effect.

The read and ingestion enforcement predicates run with invoker rights so row
level security stays in force, and they raise rather than answer when the
transaction is not already in the recipient's own Personal Account context.
A missing tenant context therefore fails the operation instead of reporting an
excluded recipient as trackable.

A WhatsApp Recipient Exclusion is a User-owned rule, so provider Directory
reconciliation and webhook projection never write it. Its current state lives
in a tenant-owned Neon relation under forced row level security, and every
acknowledged transition is also appended to the locked, restore-external
`RECIPIENT_TRANSITIONS` bucket before the API answers. The bucket keeps an
indefinite object lock, has its public r2.dev domain disabled, and is bound to
the API Worker and the restore coordinator only. Journal objects carry version,
transition identity, desired state, effective time, and purge cutoff — no
tenant identifier, connection identifier, public handle, provider identifier,
name, phone data, content, or credential.

Directory contact provider identities, display names, and phone numbers are
stored only as connection-scoped envelope ciphertext. The approved derived
normalized display-name sort value and HMAC blind indexes for provider
identity, normalized name prefixes, and exact E.164 lookup are the only query
material. Webhook projection is idempotent and evidence ordered;
the five-minute provider snapshot is authoritative for removals only when it
is complete. `list_contacts` rechecks the live authorization, selected
connection, and contact state, decrypts only inside the API Worker, and returns
at most a nullable display name plus the final four phone digits. A projection
older than ten minutes is reported as stale even if the last provider read had
succeeded. `list_groups` and `GET /v1/connections/{connection_id}/groups`
recheck the live grant, selected Connection, and joined state, decrypt only
inside the API Worker, and return at most a nullable display name with a
`grp_` recipient handle that is never a WhatsApp Conversation handle.

Stored Message exact-word search adds no deployment environment secret. Each
WhatsApp Connection owns a dedicated random 32-byte message-search key wrapped
through the existing Personal Account and Connection KMS hierarchy. The key is
purpose-specific and must not be derived from or reused as a Directory,
webhook, provider-reference, cursor, send-fingerprint, reservation, deletion,
or content-encryption key. The versioned full HMAC-SHA-256 tokens are bound to
the internal Connection identifier, so equal words cannot be correlated across
Connections from Neon alone.

`search_messages`, `POST /v1/connections/{connection_id}/messages/search`, and
`GET /v1/connections/{connection_id}/conversations/{conversation_id}/messages`
require `messages:read`, reserve from the same
`READ_MESSAGE_RECORDS_PER_DAY` quota as `read_messages`, and use the existing
authoritative Personal Account request quotas. REST message pages and search
results return complete retained text and reduce record count to stay within
1 MiB encoded JSON instead of applying MCP's duplicated-text cap. Search
queries are limited to 256 Unicode scalar values and eight unique normalized
terms; result limits default to and cannot exceed 20. REST search accepts
those terms only in a closed POST body. Plaintext queries, normalized terms, HMAC values,
message text, and snippets are prohibited from Activity Logs, telemetry,
traces, database logs, cursor payloads, and error details. Cursor binding uses
only a domain-separated keyed query digest. During bounded newest-to-oldest
application backfill, responses expose the indexed coverage boundary and
remain partial until all eligible retained Stored Messages are covered. Search
key rotation or tokenizer changes require a distinct version and tracked
backfill rather than a configuration switch or mixed-version reads.
Backfill telemetry contains only `message_search.backfill.completed`, the API
service name, and an allowlisted `success` or `failed` outcome.

`GET /v1/connections/{connection_id}/send-operations/{send_operation_id}`
requires `messages:send`, the selected WhatsApp Connection, and the
originating still-active API Key. It reads local Send Status only: it never
calls the provider, does not consume send quota, and shares the Personal
Account and per-key request quotas. Replacement, separately authorized,
expired, revoked, cross-Connection, deleted, and unknown handles share the
same constant-shape 404 as other REST resources, except a revoked or expired
credential itself returns 401.

The API Worker receives `PROVIDER_CONTROL`, `HYPERDRIVE`,
`WEBHOOK_HYPERDRIVE`, `OAUTH_KV`, `WEBHOOK_INGRESS`, `STORED_MEDIA`,
`DELETION_CAPSULES`, `DELETION_MARKERS`, `RECIPIENT_TRANSITIONS`, the
`INGESTION_QUEUE` producer binding, and the dedicated
`CONNECTION_SETUP_PROVISIONING_QUEUE` producer and consumer binding. These are not string environment values and cannot be
supplied by a public request. The production composition root fails closed
when any required binding is absent or has the wrong runtime capability.
`/health` remains a non-sensitive liveness endpoint; every other API route
passes the database readiness gate, and `/ready` returns unavailable unless
`HYPERDRIVE` can report exactly the compiled schema version.

`PROVIDER_CONTROL` is a Cloudflare RPC service binding with the closed
`listSessions`, `createSession`, `connectSession`, `getQrCode`,
`reconcileSession`, and `deleteSession` method set. API startup rejects a
fetch-only or incomplete binding. Provider-control validates each RPC argument
as a closed object before loading its credential-backed lifecycle Layer.
Malformed calls therefore cannot trigger provider access. The account-level
Provider API Credential is neither an RPC argument nor a result. A successful
create, adopt, connect, or reconciliation result may carry the narrower
per-session authority to the API Worker, which must envelope-encrypt it before
persistence.

The API Worker is also the declared consumer for the ingestion Queue, its
dead-letter Queue, and the operator-only immutable replay Queue. It receives no
DLQ or replay producer binding. The replay Queue accepts requests only through
Cloudflare's authenticated API with a separate token restricted to Queues
Write; the Worker resolves each opaque incident reference to canonical source
metadata and publishes that metadata through its existing `INGESTION_QUEUE`
binding. Provider-control has no
KV, R2, Queue, Hyperdrive, database role, tenant-decryption service, route, or
custom-domain authority and has both `workers_dev` and preview URLs disabled,
so the service binding is its only declared ingress. Bundle inspection also
rejects tenant KMS, database, Stored Media, and Webhook ingress authority from
the provider-control artifact and rejects provider-control secret names from
the API and web artifacts.
The API also disables generated Cloudflare hostnames and is public only on its
declared custom domain.

## MCP OAuth discovery and client policy

The API Worker serves RFC 8414 authorization-server metadata at
`/.well-known/oauth-authorization-server` and RFC 9728 protected-resource
metadata at `/.well-known/oauth-protected-resource` and its MCP-specific
`/mcp` suffix. It advertises the API origin as issuer, the exact `/mcp`
resource, S256-only PKCE, and the four MCP scopes. Implicit flow and dynamic
client registration are disabled. Client ID Metadata Documents are enabled for
reviewed ChatGPT and Claude clients and fetched with Cloudflare's strict-public
global fetch protection.

Before consent, the API exactly matches `client_id`, `redirect_uri`,
`resource`, response type, and PKCE against the source-defined client policy.
Fixed clients use the local allowlist. A URL-shaped ChatGPT client ID must be an
HTTPS `chatgpt.com` OAuth metadata document ending in `/client.json`; the OAuth
provider fetches and validates that document, and every advertised redirect
must also be HTTPS on `chatgpt.com`. ChatGPT metadata may identify the client as
`none` or `private_key_jwt`; the API admits either reviewed shape as the same
public PKCE client because the OAuth provider's CIMD token flow supports public
clients only. Metadata discovery is limited to authorization admission; token
exchange uses the validated normalized public-client record. Other token
endpoint authentication methods fail closed. Failures
return locally and never redirect. Claude uses only the exact
`https://claude.ai/oauth/mcp-oauth-client-metadata` client ID, the exact
`https://claude.ai/api/mcp/auth_callback` redirect, and the `none` token
endpoint authentication method.
A valid request is parsed by Cloudflare's
OAuth provider, AES-256-GCM encrypted, stored in OAuth KV for at most ten
minutes under a SHA-256 lookup key, and handed to the web consent origin using
a random 256-bit opaque value. Client IDs and redirects do not appear in that
handoff URL or KV key. The provider stores protocol secrets only by hash and
encrypts grant props. Per ADR 0003, Neon—not KV—remains authoritative for MCP
Authorization, scopes, selected WhatsApp Connections, account state, and
revocation.

The web consent page opens only from the opaque handoff. It retrieves the
allowlisted client name, requested scopes, and current existing WhatsApp
Connections directly from the API. No scope, Connection, read-sharing
confirmation, or send-authority confirmation starts selected. Approval requires
at least one explicit Connection and one independently selected requested
scope. Any read scope requires the separate read-sharing confirmation;
`messages:send` requires the separate send-authority confirmation and never
adds a read scope. A presentation digest bound to the handoff and verified
Clerk User rejects a changed request before persistence.

Approval also requires Clerk's standard first-factor verification-age (`fva`)
claim to be less than five minutes old. The browser invokes Clerk's
first-factor reverification flow when needed, clears its cached session token,
and submits a newly minted session token. The API independently verifies the
signed `fva` value together with the token's signed issuance time; missing,
malformed, or stale values fail closed.

Migration 0006 gives each existing WhatsApp Connection an ADR 0023 `con_`
public handle and creates RLS-protected MCP Authorization and explicit
authorization-to-Connection rows. Neon stores exactly the independently
selected scopes and Connections; a Connection created later has no join row
and therefore does not expand the grant. OAuth KV protocol records use an
unlinkable per-authorization subject instead of Clerk identity; encrypted grant
props contain that subject and the authorization lookup ID. The only
application metadata outside those encrypted props is the allowlisted client
class.

Migration 0007 adds the RLS-protected refresh-credential ledger and
authorization-family revocation state. Neon stores only SHA-256 credential
hashes. One current hash is allowed per MCP Authorization; a successful
refresh locks and consumes it before committing one descendant. A concurrent
or later presentation of a consumed hash atomically revokes the family. Each
descendant expires after 30 days without use and is capped by the
authorization's 90-day absolute expiry. The OAuth KV grant is retained only
up to that 90-day ceiling so it cannot expire before Neon's moving inactivity
window, but KV never decides application validity.

Every refresh rechecks the current Clerk identity mapping, active Personal
Account, active MCP Authorization, non-revoked family, absolute expiry, and at
least one still-selected existing WhatsApp Connection through the restricted
API role. Access tokens remain bound to the exact `/mcp` resource and expire
after ten minutes. No additional Cloudflare binding or API runtime authority is
required beyond the existing OAuth KV and API Hyperdrive; migration 0007 grants
only `SELECT`, `INSERT`, and `UPDATE` on the ledger plus execute access to its
narrow fixed-search-path bootstrap functions to `whatsapp_api_runtime`.

Deployment automation keeps its current plaintext refresh credential only in
the purpose-specific AWS Secrets Manager secret. Before refresh, the workflow
proves that it can durably write that secret; after exchange it persists the
descendant before invoking MCP and keeps the ten-minute access token in process
memory only. Deployment, migration, recovery drills, launch gate, and the
public API release gate share the `production-operations` concurrency group
with production credential rotation, preserving one serialized credential
lineage.
Neither token may enter GitHub secrets, command arguments, outputs, artifacts,
telemetry, repository state, or OpenTofu state.

Migration 0009 adds an ADR 0023 `mca_` management handle and the consent-time
MCP Client display name. Historical rows without a stored display name safely
fall back to their public OAuth client ID. A narrow fixed-search-path bootstrap,
executable only by `whatsapp_api_runtime`, preserves the Neon authority check
for access tokens issued before OAuth props included the client ID; newly
issued tokens retain the stricter client binding. The signed-in product reads
`GET /v1/mcp-authorizations` and idempotently revokes one owned grant with
`DELETE /v1/mcp-authorizations/{authorization_id}`. Responses contain only the
management handle, MCP Client ID and name, selected Connection handles, scopes,
creation and absolute-expiry times, and explicit expiry and revocation states.
They never contain the internal authorization UUID, OAuth subject, access or
refresh token, credential hash, or KV artifact.

Revocation updates the MCP Authorization state and its refresh-family state in
one Neon row transaction. Existing access-token checks, protected resource
reads, and refresh rotation all re-read those authoritative fields, so a
successful response makes cached OAuth KV or edge artifacts insufficient for
access immediately. RLS and the Clerk-to-Personal-Account bootstrap make an
unknown handle and another Personal Account's handle the same not-found result.
The API runtime already has the minimum required `SELECT` and `UPDATE`
privileges on MCP Authorizations; no new secret, Cloudflare binding, OpenTofu
resource, or production-selectable substitute is introduced.

Consent decision telemetry contains only
`oauth.authorization.decision.completed`, the allowlisted client class,
`approved` or `denied`, and the API service name. Never add the User, Personal
Account, MCP Authorization, Connection, scope set, redirect, token, handoff, or
presentation digest. Refresh telemetry contains only
`oauth.refresh.completed`, the allowlisted client class, and an allowlisted
`rotated`, `invalid`, `reuse`, or `unavailable` outcome. A `reuse` outcome is
an incident signal that the family has already been revoked; it must never
include either credential, its hash, or a tenant identifier.

Authorization-management telemetry contains only
`mcp_authorization.management.completed`, `list` or `revoke`, `success` or
`not_found`, and the API service name. Never add the User, Personal Account,
authorization handle or internal ID, MCP Client, Connection, scope set,
timestamp, token, credential hash, or request path.

API Key management telemetry contains only `api_key.management.completed`,
`create`, `list`, or `revoke`, an allowlisted outcome, and the API service
name. Never add the User, Personal Account, API Key handle or internal ID,
credential, digest, hint, name, Connection, permission set, timestamp, or
request path.

Migration 0017 adds the RLS-protected, metadata-only Activity Log and the
stateless MCP `list_connections` boundary. Migration 0018 adds encrypted group
projections and `list_groups`. Each invocation first locks its Personal Account
quota subject, rechecks the current MCP Authorization and the tool's
`connections:read` or `directory:read` scope, and atomically persists the audit
row with one request reservation. Exact rolling minute and hour counts use only committed
`quota_reserved` rows. Authorization failures and pre-reservation audit failures
do not consume quota. When either window is exhausted, the API returns the
binding window's safe retry and reset values without reading Connection state.
Missing or invalid quota configuration prevents the production root from
serving.

Activity Logs expire after 90 days and contain only the tenant, channel,
allowlisted MCP Client or API Key presentation, operation name, timestamps,
normalized outcome and error code, bounded result count, latency, and whether
request quota was reserved. The signed-in `GET /v1/activity-logs` view
resolves the owning MCP Client or API Key and records applicable public
`mca_`, `apk_`, `con_`, and `snd_` handles plus an additive `channel` field.
Its response is an explicit allowlist and never exposes internal IDs, message
or media content, full phone numbers, credentials, OAuth tokens, API Key
secrets, provider identifiers, scope sets, request or response content, or raw
payloads. MCP-channel rows remain compatible; API-channel rows omit
`mcp_authorization_id` and present the `apk_` handle instead. MCP tool telemetry
is limited to `mcp.tool_call.completed`, one fixed contract-defined tool name
(`list_connections`, `list_contacts`, `list_groups`, `list_chats`,
`read_messages`, `search_messages`, `send_text_message`, `send_pdf_file`,
`send_image`, or `get_send_status`), an allowlisted outcome, the API service
name, and the bounded result count on success. REST telemetry is limited to
`rest.operation.completed`, one fixed contract-defined operation name
(`list_connections`, `list_contacts`, `list_groups`, `list_chats`,
`read_messages`, `read_stored_media`, `search_messages`, `send_text_message`,
`send_pdf_file`, `send_image`, or `get_send_status`), an allowlisted outcome,
the API service name, and the bounded result count on success. Do not enrich
either event with tenant, authorization, client, Connection, quota, credential,
request, or response fields.

The endpoint returns at most 100 newest-first records at a time. Follow its
opaque `next_cursor` until it is `null` to traverse the complete unexpired
history. Cursors use dedicated random `tcl_` handles for keyset traversal and
are not internal database IDs.

The hourly Worker schedule removes expired Activity Logs in bounded batches
through `public.purge_expired_tool_call_logs`. The same hour also expires due
API Key credentials through `public.expire_api_key_credentials` and then
purges safe expired or revoked API Key metadata through
`public.purge_expired_api_key_metadata`. Authentication already denies a key
on the first request after its configured `expires_at` using database time;
the scheduled functions only clear the digest and later delete User-visible
metadata after the independent 90-day history window. The runtime role can
execute those fixed-search-path functions, but each function derives its
cutoff from database time and cannot be directed to expire or delete future
or unexpired rows. The role has no broad cross-tenant table delete grant.
Retention telemetry is limited to `api_key.retention.completed`, the bounded
expired and purged counts, and the API service name.
Review telemetry contains only `activity_log.review.completed`, a bounded log
count, and the API service name; do not add tenant, Client, authorization,
Connection, send, network, or capability identifiers.

The signed-in `GET /v1/personal-account/insights` overview returns a closed
allowlist of aggregate counts for the last 30 UTC days: WhatsApp Connection
state totals, retained inbound and outbound Stored Message totals,
conversation mix and weekly activity, Send Operation confirmed/failed/unknown
totals, active MCP Authorization count, and a 30-point daily series. Counts
exclude WhatsApp Connections in Connection Deletion. It never returns message
content, media, conversation or recipient identity, phone numbers, credentials,
public handles, tenant identifiers, or provider identifiers, and it does not
compare against a prior retention window. Review telemetry is
`account_insights.review.completed` with only inbound and outbound counts,
window days, and the API service name.

The public OAuth clients are defined in `apps/api/src/oauth.ts`:

```text
Claude: client_id=claude, redirect_uri=https://claude.ai/api/mcp/auth_callback
Claude CIMD: client_id=https://claude.ai/oauth/mcp-oauth-client-metadata, redirect_uri=https://claude.ai/api/mcp/auth_callback
ChatGPT: client_id=chatgpt, redirect_uri=https://chatgpt.com/connector/oauth/djePJ1RTfjI5 or https://chatgpt.com/connector_platform_oauth_redirect
ChatGPT CIMD: client_id=https://chatgpt.com/oauth/.../client.json, redirects supplied by that validated document on https://chatgpt.com
```

Client IDs identify public PKCE clients and are not credentials. Treat every
client, redirect, metadata-document origin, or client-class source change as an
authorization-policy change. Authorization requires exact string equality, and KV never acts as the
client registry.

Provider-control startup validates the two Wasender secrets and the Webshare API
key before serving
even its private health route or an RPC method. The Wrangler manifest declares
all three names as required secrets, so deployment fails before serving when any
secret has not been configured. Its lifecycle adapter calls only the fixed
`https://www.wasenderapi.com` origin with the account-level credential, forces
provider message logging and automatic incoming-message reads off during
creation, and assigns one unused static Colombian SOCKS5 proxy through
`p.webshare.io`. Proxy selection reads only the fixed
`https://proxy.webshare.io/api/v2/subscription/plan/` and
`https://proxy.webshare.io/api/v2/proxy/list/` endpoints, accepts only one
active shared ISP plan with exactly 20 `CO` proxies and Auto-Refresh disabled,
then requires its complete Backbone list, preserves an existing listed assignment, and
fails closed when no valid unused proxy remains. The Webshare plan keeps
Auto-Refresh disabled; proxy credential or inventory changes require a reviewed
configuration reconciliation. One named provider-control Durable Object
represents the environment's proxy pool and serializes create, reconcile, repair,
and reconnect validation across Worker isolates. Before a proxy-changing write,
it persists only the opaque Connection Setup marker and a settlement deadline;
definitive completion deletes that reservation, while ambiguous completion keeps
the pool quarantined until alarm-driven or caller-driven safe reconciliation.
It never persists a proxy assignment, proxy credential, provider identifier, or
tenant identifier. Wasender's current session configuration is reread inside
every operation. Disconnect and deletion do not depend on the gate's Webshare
validation. The adapter emits only operation class,
normalized outcome, attempt, duration,
bounded response size, RPC method, and normalized result code. No telemetry
field contains a Connection Setup marker, WhatsApp Number, provider locator,
per-session authority, Provider API Credential, proxy URL, proxy credential, or
raw result. No runtime value can select a fake provider or an alternate origin.

`WASENDER_REFERENCE_SECRET` must remain stable because persisted adapter
locators are keyed by it. To rotate it, stop provisioning, retain the old value,
reconcile every retained Connection Setup and WhatsApp Connection against the
provider under an audited maintenance workflow, persist locators derived with
the new value, verify that no old locator remains, deploy the new secret, and
resume provisioning. A direct replacement without reconciliation makes existing
provider sessions unresolvable and therefore fails closed.

The web production root requires `NEXT_PUBLIC_API_ORIGIN` and
`NEXT_PUBLIC_WEB_ORIGIN` to be bare HTTPS origins with no credentials, path,
query, or fragment. The web origin supplies canonical metadata, robots, and
the XML sitemap. The Vercel manifest has no rewrite or proxy to the API.
Browser data-plane requests therefore go directly to the API Worker.

## Clerk human identity and Personal Account bootstrap

Each deployment environment uses its own Clerk instance or satellite domain.
Create the `whatsapp-api` custom JWT template with a 60-second lifetime and an
`aud` claim equal to that environment's exact API origin. Do not add tenant,
role, email, name, or other profile claims: the API consumes only Clerk's
standard `sub`, `iss`, `aud`, `azp`, `iat`, `nbf`, `exp`, `sts`, and `fva`
claims.
Set the Clerk session token's custom claims to the same `aud` value. Consent
approval uses the session token because Clerk's signed `fva` claim is
session-bound and is not present in a custom JWT template token.
Configure the Clerk application to allow only the exact web origin represented
by `CLERK_AUTHORIZED_PARTY`.

Enable Waitlist mode and email authentication in each Clerk instance. Clerk is
the sole waitlist and approval authority. The web app opens Clerk's native
waitlist for new applicants and keeps sign-in available for approved Users.
Clerk approval does not reserve provider capacity.

The API verifies the token locally with `CLERK_JWT_KEY` and independently
requires the exact issuer, audience, authorized party, short expiry, and request
Origin. It then maps the verified Clerk User through narrow fixed-search-path
database functions, starts a transaction with `SET LOCAL
app.personal_account_id`, and relies on RLS for the remaining tenant access.
Neon serializes bootstrap before the first successful request can create one
active Personal Account and one KMS-wrapped Personal Account data key. It also
stores the three-Connection limit, the 5 GB Stored Media limit, and the default
30-day Message Retention Policy and is the value source for the bootstrap
response. Bootstrap does not invoke provider-control or reserve provider
capacity. Provider availability is evaluated when a Connection Setup attempts
to provision a WhatsApp Connection; a definitive provider rejection leaves no
WhatsApp Connection and is shown as temporary capacity unavailability.
A deleting or deleted mapping, invalid identity, wrong tenant, wrong Origin, or
unavailable key returns the same public not-found boundary and never discloses
an identifier.

Successful bootstrap telemetry is limited to
`personal_account.bootstrap.completed`, the API service name, and an
allowlisted `created` or `recovered` outcome. Never add
Clerk User IDs, Personal Account IDs, token claims, Origin values, network
addresses, key identifiers, ciphertext, or profile data to this event.

## First-connection onboarding profile

A signed-in User with no WhatsApp Connection completes a short first-connection
onboarding journey before Connection Setup. The journey collects one structured
research profile owned by the Personal Account:

- primary use case
- WhatsApp usage context (`personal`, `work`, or `both`)
- role
- intended MCP Client
- research-call interest

Choices are constrained enums only. Free text is rejected. The authenticated
browser reads and upserts the profile at
`/v1/personal-account/onboarding-profile` with no-store responses and the same
Origin/CORS rules as other Personal Account browser routes. Neon remains
authoritative. The profile has one row per Personal Account, tenant RLS, and
cascades on Personal Account purge. Personal Account Deletion removes it with
other User-addressable tenant data; a terminally deleted profile must not become
readable after restore.

The same profile row records security-stage completion. The browser marks that
transition through an idempotent `PATCH` on the profile route before showing
Connection Setup. A refresh therefore resumes Connection Setup without replaying
the security disclosures, including when no Connection Setup has been created.
Neon also requires this durable completion before the first Connection Setup,
so browser state alone cannot bypass the security stage.

The first Connection Setup is rejected at the API boundary until a completed
profile exists, except when the Personal Account already retains a WhatsApp
Connection (grandfathered). Profile values never enter Activity Logs, Security
Records, or worker telemetry beyond the allowlisted outcome event
`onboarding_profile.upsert.completed`.

The Normal team may query completed profiles through existing restricted
operational database access. Do not copy profile answers, Clerk User IDs, or
Personal Account identifiers into tickets, telemetry, or PostHog. Useful
starting queries:

```sql
SELECT primary_use_case, count(*) AS profiles
FROM public.personal_account_onboarding_profiles
GROUP BY 1
ORDER BY profiles DESC;

SELECT whatsapp_usage_context, role, intended_mcp_client,
  research_call_interest, count(*) AS profiles
FROM public.personal_account_onboarding_profiles
GROUP BY 1, 2, 3, 4
ORDER BY profiles DESC;

SELECT date_trunc('day', completed_at) AS completed_on, count(*) AS profiles
FROM public.personal_account_onboarding_profiles
GROUP BY 1
ORDER BY 1;

SELECT
  profiles.intended_mcp_client,
  EXISTS (
    SELECT 1
    FROM public.whatsapp_connections AS connections
    WHERE connections.personal_account_id = profiles.personal_account_id
      AND connections.state = 'connected'
  ) AS has_active_whatsapp_connection,
  count(*) AS profiles
FROM public.personal_account_onboarding_profiles AS profiles
GROUP BY 1, 2
ORDER BY 1, 2;

SELECT identities.clerk_user_id, profiles.role, profiles.intended_mcp_client,
  profiles.research_call_interest, profiles.completed_at
FROM public.personal_account_onboarding_profiles AS profiles
JOIN public.clerk_identities AS identities
  ON identities.personal_account_id = profiles.personal_account_id
WHERE profiles.research_call_interest = 'yes'
ORDER BY profiles.completed_at DESC;
```

Join Clerk identity only when preparing a specific research call. Do not export
these rows into a CRM or analytics warehouse.

## Browser product analytics

PostHog is an aggregate behavioral analytics destination only. Neon remains
authoritative for identity and profile state. Browser product code emits typed
events through a small analytics boundary that:

- accepts only explicitly allowlisted event names and bounded properties
- disables automatic capture and session replay
- uses an ephemeral random browser-session identifier that is not persisted
  beyond the browser session and cannot be joined to Neon or Clerk
- never blocks profile persistence, Connection Setup, navigation, or rendering

Allowed funnel events cover onboarding stage viewed/completed, profile
completed, security education reached, Connection Setup started/completed by
normalized outcome, anonymous Connection Setup timing by bounded phase and
duration, onboarding completed, and selected aggregate feature-use events.
Events must not contain or derive from Clerk IDs, email, Personal Account IDs,
public handles, WhatsApp Connection IDs, WhatsApp Numbers, connection names,
profile answers tied to a persistent User identity, message, contact, media,
provider, request-body, or code material.

`NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` are public browser
configuration validated per environment. When either is absent, analytics is
disabled. Update CSP, privacy disclosures, retention configuration, and the
subprocessor inventory before enabling collection in production. PostHog must
not receive a person profile, session replay, or a durable identifier that can
be joined to Neon or Clerk.

OpenTofu requires `posthog_privacy_controls_approved = true` before it can
publish PostHog browser configuration. Set it only after reviewing the exact
environment's retention period, disabling IP capture or configuring immediate
IP discard, and confirming the privacy disclosure, CSP, and subprocessor
inventory. The approval is an explicit deployment gate, not a runtime flag.

## Connection Setup creation

The first Connection Setup for a Personal Account also requires a completed
onboarding profile unless the account already retains a WhatsApp Connection.
Additional WhatsApp Connections keep the existing compact Connection Setup
dialog and do not repeat profile collection.

The signed-in browser creates a fresh 21-character NanoID idempotency key for
each named WhatsApp Number intent and retains it for exact transport retries. It
sends the key, a required 1-64 character WhatsApp Connection name, and the
explicitly international number directly to `POST
/v1/connection-setups`; the response does not echo either value. The API
accepts only the configured browser Origin and a valid audience-bound Clerk
token, removes permitted visual formatting from the number, and validates the
result as E.164 before persistence.

`WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET` derives a domain-separated,
platform-wide 32-byte token from the normalized number. This key and token are
separate from the future connection-scoped Directory phone indexes. Neon
serializes each Personal Account's setup transaction, binds one browser key to
one token, enforces the three retained Connection/setup slots, and rejects a
token already reserved anywhere on the platform. The normalized number and
User-chosen name are independently encrypted with a setup-scoped data key
wrapped by the Personal Account key. Their authenticated contexts use the
Connection Setup identifier as both connection and record, with
`whatsapp-number` and `display-name` purposes. Neon stores neither value in
plaintext. Exact idempotent replay decrypts the stored name after ownership has
been established and compares normalized plaintext; randomized ciphertext is
never used as an equality fingerprint.

The committed row begins in `provisioning_pending` and expires exactly 15
minutes after creation. It is the durable provisioning intent consumed by the
reconciled saga and owns a database-generated random webhook ingress identity;
this creation route never invokes provider-control. An exact
retry returns the original Connection Setup, while a changed number with the
bound browser key returns `idempotency_conflict`. Telemetry contains only
`connection_setup.start.completed`, service name, and the allowlisted outcome.
It never contains the number, token, idempotency key, Connection Setup
identifier, Personal Account identifier, ciphertext, or key metadata.

## Connection Setup provisioning

After the setup transaction commits, the API publishes only the opaque setup
identifier and a fixed message version to
`CONNECTION_SETUP_PROVISIONING_QUEUE`. A failed publication makes the HTTP
request unavailable but does not roll back durable intent; an exact browser
retry republishes the same setup, and the minute recovery scan republishes up
to 100 unleased, unexpired intents. Duplicate Queue deliveries are expected.

One restricted worker claims a two-minute Neon lease, asks provider-control to
reconcile the setup identifier as the deterministic provider marker, and only
permits create after confirmed absence. It renews the lease immediately before
that write. One match is adopted without create. Two or more matches are
stored as encrypted duplicate records and move the setup to
`provisioning_quarantined`; no matching session is selected as usable.
Successful create or adoption encrypts both the opaque provider locator and
per-session authority under the setup key in one Neon transition to
`provisioned`. Plaintext WhatsApp Number, provider locator, and session
authority exist only in worker memory for the bounded attempt.

For a confirmed-absent setup, the create request also supplies the exact API
origin plus the setup's persisted ingress identity to provider-control as a
protected webhook endpoint. The Wasender adapter enables only the reviewed
message, receipt, Directory, and connection-state events, keeps provider
message logging and incoming-message reads disabled, and requires the create
response to contain a unique webhook secret before the session can become
`provisioned`. Reconciliation after an ambiguous create adopts the same
deterministic provider marker; it never invents a second endpoint or secret.

Lifecycle write failure, timeout, or a crash never authorizes a repeated
create. The lease is released with only an allowlisted failure code when
possible, and every later attempt begins with reconciliation. A definitive
`do_not_retry` lifecycle rejection enters visible `provisioning_failed` state
and is not selected by recovery; it cannot become a repeated create loop.
Queue delivery
uses batches of one, a three-minute visibility timeout, ten 30-second delivery
retries, and seven-day retention. The durable setup and minute recovery scan
remain authoritative if Cloudflare exhausts a delivery. Telemetry contains only
`connection_setup.provision.claimed` with first-claim delay,
`connection_setup.provision.completed` with service, allowlisted outcome,
optional normalized failure code, and terminal duration, plus recovery candidate
counts. It never contains setup/account identifiers, number material, provider
values, or ciphertext.

## Connection Setup cancellation, expiry, and cleanup

The owning User cancels an incomplete setup with `DELETE
/v1/connection-setups/{setup_id}`. The transition to `cancelled` is
idempotent and immediately prevents provisioning from advancing. The existing
minute cron transitions every incomplete setup whose fixed 15-minute deadline
has passed to `expired`; expiry does not depend on a browser request.

Both terminal transitions persist `cleanup_state: pending` and publish a
`connection_setup.cleanup` message to the existing Connection Setup Queue.
The durable minute recovery scan republishes eligible cleanup work if request
publication or Queue delivery fails. Cleanup waits for any provisioning lease
that was active at the terminal transition to expire, then obtains its own
two-minute lease. This closes the race in which an already-authorized provider
create could otherwise occur after cleanup observed absence.

Every cleanup attempt asks provider-control to reconcile the deterministic
setup marker. Confirmed absence atomically sets `cleanup_state: complete`,
releases the WhatsApp Number reservation, and destroys the setup key envelope
and encrypted provisional provider-session rows. Presence deletes at most one
reconciled provider session; the next attempt must reconcile again before
another delete or reservation release. Duplicate sessions are therefore
removed one reconcile-first attempt at a time. Read, delete, timeout, and
lease failures retain the reservation, record only an allowlisted normalized
failure code, and remain eligible for recovery. A cancelled or expired state
is never changed by cleanup.

No new production secret, binding, public route to provider-control, or test
provider selection is introduced. Cleanup reuses the API's restricted Neon
role, existing same-environment provider-control service binding, and existing
durable Queue. Safe telemetry is limited to cancellation outcome, expired and
candidate counts, cleanup outcome, and optional normalized failure code.

## WhatsApp Connection activation and QR delivery

The owning signed-in browser reads
`GET /v1/connection-setups/{connection_setup_id}/qr` directly from the API
Worker. The API resolves the verified Clerk User through the narrow activation
bootstrap function before it invokes provider-control. It first reconciles the
deterministic setup marker, starts QR linking only after that reconciliation
shows a single non-connected provider session, and then asks provider-control
for the current generated SVG. An available SVG is streamed directly as
`image/svg+xml` with `Cache-Control: no-store`, a restrictive content security
policy, and `X-Content-Type-Options: nosniff`. The bytes exist only in the
bounded provider-control RPC result, API response, and browser object URL; no
database, R2, Queue, analytics, trace, snapshot, or telemetry field receives
them.

Every later observation reconciles again. Only a single provider session in
trusted `connected` state can activate the Setup. One Neon transaction locks
the Setup and creates or returns exactly one WhatsApp Connection, changes the
Setup to `activated`, and persists:

- a fresh `con_` public handle and internal identifier;
- a new KMS-rooted per-connection key envelope;
- the Setup's random non-enumerable webhook ingress identity;
- a fresh 32-byte webhook normalization identity key encrypted under the
  connection;
- the provider-neutral locator and per-session authority re-encrypted under
  the connection; and
- the User-chosen name decrypted from the Connection Setup and re-encrypted
  under the connection key with `whatsapp-connection` / `display-name`
  authenticated context; and
- only the last four digits of the normalized WhatsApp Number as queryable
  display metadata.

The owning User can later rename a non-deleting WhatsApp Connection with `PUT
/v1/whatsapp-connections/{connection_id}/name`. Names are normalized, limited
to 64 characters, tenant-scoped by RLS, removed by Connection or Personal
Account Deletion, and restored with the owning connection. Browser and MCP
lists decrypt names only after their respective User or grant authorization.
Migration 0004 gives existing Connections and incomplete Setups generated
adjective-animal fallback names; an XOR constraint makes those recognizable
fallbacks mutually exclusive with the complete ciphertext tuple. A fallback
Setup is converted to connection ciphertext during activation.

The stable product state vocabulary is `connected`, `connecting`,
`disconnected`, `reconnect_required`, `degraded`, and `deleting`. Only
`connected` permits a later new Send Operation. The product reads
`GET /v1/whatsapp-connections` without pagination and receives only the opaque
handle, required display name, number suffix, normalized state, and state-change
time. Provider identifiers, credentials, webhook material, setup identifiers,
full numbers, key metadata, and ciphertext never enter that response.

This behavior adds no environment value or infrastructure authority.
Provider-control already owns the closed `connectSession`, `getQrCode`, and
`reconcileSession` lifecycle methods, and the API already has the sole
same-environment service binding. The Vercel app still calls the API directly
and receives no Provider API Credential, database binding, KMS authority, or
provider-control binding. Production cannot select the protocol-observable
provider used by the acceptance tests.

Safe QR telemetry is limited to `connection_setup.qr.completed`, service, and
one normalized outcome. A setup's first successful provisioning claim emits
`connection_setup.provision.claimed` with only `queueDelayMs`, measured from
durable setup creation to the persisted first claim. Provision completion emits
normalized outcome, optional normalized failure code, and
first-claim-to-terminal-transition `durationMs`; retries carry no duration and
legacy in-flight setups without a first-claim timestamp do not invent one. Safe listing
telemetry adds only the connection count
to `whatsapp_connection.list.completed`. Neither event contains a User,
Personal Account, Connection Setup, WhatsApp Connection, number, QR byte,
provider value, credential, ingress identity, secret, ciphertext, or key
reference.

The approved first-party target is p95 observation lag at or below 750 ms in
the deterministic browser scheduler fixture, independent of provider time. The
fixture replays 18 fixed transition offsets from 0 through 5 seconds. The old
fixed 750 ms policy measured p50/p95/p99 of 250/700/700 ms. The bounded policy
measured 200/600/600 ms before code observation and 200/750/750 ms from code
observation to active observation. These are measured fixture results, not
production provider percentiles. The schedule starts at 250 ms, steps up by 250
ms, and caps at 1 second before code display or 2 seconds while waiting for
activation, reducing early waits and repeated reads without weakening the
reconciled lifecycle boundaries.

Anonymous browser metrics use the literal observable phases
`start_to_code_observed` and `code_observed_to_active_observed`; they do not
claim to know when WhatsApp accepted a scan. Each phase is emitted once per
browser flow. Repeated API status reads emit outcomes without setup-age timing,
so polling frequency cannot weight latency percentiles.

## WhatsApp Connection disconnect and reconnect

The signed-in product sends `POST
/v1/whatsapp-connections/{connection_id}/disconnect` or `/reconnect` directly
to the API. These lifecycle commands are separate from Connection Deletion:
disconnect retains the WhatsApp Connection row, encrypted keys, Message
Retention Policy data, MCP selection, provider session, and platform-wide
WhatsApp Number reservation. Reconnect operates on that same `con_` identity.

Migration 0012 adds a narrow durable lifecycle claim to each WhatsApp
Connection. The restricted API function serializes the command, records the
desired connected or disconnected availability, and gives one caller a
two-minute opaque lease. A disconnect claim changes local state to `degraded`
before provider access, and a reconnect claim changes it to `connecting`, so
new side effects fail closed throughout reconciliation. A later claim can
replace an expired lease; its opaque claim UUID prevents a slow earlier result
from regressing the newer state.

The claim holder reconciles the deterministic retained setup marker before any
lifecycle write. An already-satisfied provider state completes without a
write. Otherwise provider-control performs exactly one connect or disconnect
attempt. An ambiguous result is never repeated: the API reconciles provider
state again and persists the normalized observation. Confirmed absence during
disconnect converges to `disconnected`; absence during reconnect converges to
`reconnect_required`; duplicate sessions or unresolved evidence converge to
`degraded`. A reconnect that needs user linking streams the current SVG QR
with the same no-store, no-persistence controls as initial activation and
continues reconciliation after scanning.

This behavior adds no environment value, public provider-control route, Queue,
storage binding, or infrastructure permission. It reuses the restricted Neon
API role and the existing same-environment API-to-provider-control service
binding. Safe telemetry is limited to
`whatsapp_connection.lifecycle.completed`, `disconnect` or `reconnect`, and
the normalized outcome `complete`, `in_progress`, `qr_available`, or
`recovery_required`; identifiers and provider values are prohibited.

## Wasender media authority

The Wasender media adapter has no hostname, endpoint, redirect, timeout, or
byte-limit environment override. Its production Layer fixes the decrypt
endpoint and approved download hostname to `www.wasenderapi.com`, resolves that
host through bounded DNS-over-HTTPS at `cloudflare-dns.com`, and fails closed
when the per-session authority is empty, non-printable, or otherwise invalid.
The session authority is provider data encrypted under the owning WhatsApp
Connection; it is decrypted only to construct that connection's adapter Layer
and is not a deploy-time environment variable. This fixed configuration keeps
an environment change from broadening the media SSRF boundary.

## Encrypted Stored Media container

The API production root constructs the versioned Stored Media container from
the `STORED_MEDIA` R2 binding and the same real AWS KMS-rooted envelope
encryption authority described above. Startup requires the R2 binding to
support `get`, `put`, `delete`, and `createMultipartUpload`; the last capability
allows an unknown-length encrypted stream to be written without pre-buffering
the plaintext to calculate a total object length.

The production plaintext encryption chunk ceiling is fixed at 1 MiB and R2
multipart transport parts are bounded at 5 MiB. Neither value has an
environment override. R2 receives no filename, MIME type, identity, plaintext
hash, or other Stored Media metadata. The complete format and authenticated
context are documented in [the encrypted Stored Media container
specification](stored-media-container.md).

## Wasender outbound-send authority

Text, PDF, and image sending do not add an account-level Provider API Credential, endpoint
override, public route, service binding, or infrastructure secret. The
production adapters always call their fixed Wasender send and upload endpoints
over the Worker's existing outbound HTTPS capability, reject unapproved
redirects, and cannot select a test transport at runtime. Provider upload URLs
remain adapter-local and are never persisted. This zero-binding infrastructure
delta keeps ordinary connection operations outside provider-control and
preserves ADR 0004's least-privilege split.

The adapter is composed per WhatsApp Connection with two values already
protected by the connection's encryption boundary: its session-specific
authority and a 32-byte connection-scoped identity-protection key. It fails
closed when the authority contains control characters or is empty, when the
key is not exactly 32 bytes, or when the domain resolver cannot supply the
encrypted provider identity for the selected Directory recipient. These are
runtime connection records, not deployment environment variables, so they do
not belong in `.dev.vars`, Wrangler bindings, OpenTofu state, or operator
configuration.

Outbound-send telemetry is mandatory at composition and is limited to operation
class, normalized outcome, upload and send attempt counts where applicable,
duration, and bounded byte counts. It must not include text or captions, image
bytes or MIME, PDF filenames, phone numbers, recipient or message tokens,
session authority, raw response data, source or provider URLs, or provider
status values.

## Infrastructure inputs

`infra/compute` represents exactly one deployment environment and remote state.
Supply these non-secret values in an operator-owned `.tfvars` file outside the
repository:

| Variable | Purpose |
| --- | --- |
| `deployment_environment` | Exactly `development`, `preview`, or `production`. |
| `cloudflare_account_id` | Account restricted to that environment's authority scope. |
| `cloudflare_zone_id` | Zone that contains the API hostname. |
| `api_hyperdrive_id` | Exact same-environment Hyperdrive ID backed by the restricted API runtime role; obtain it from `infra/production` output. |
| `webhook_hyperdrive_id` | Distinct same-environment Hyperdrive ID backed by the restricted webhook runtime role; obtain it from `infra/production` output. |
| `vercel_team_id` | Team restricted to that environment's authority scope. |
| `api_hostname` | Public custom hostname routed to the API Worker. |
| `web_hostname` | Distinct public hostname assigned to the Vercel web project. |
| `docs_hostname` | Distinct public hostname assigned to the static Vercel Scalar documentation project. Production uses `docs.normal.fast`. Development and preview use isolated hostnames under the same environment authority. The docs project name is `whatsapp-mcp-docs` in production and `whatsapp-mcp-docs-<environment>` otherwise. |
| `clerk_issuer` | Exact HTTPS issuer for the same-environment Clerk instance. |
| `clerk_publishable_key` | Public browser key for the same-environment Clerk instance. |
| `posthog_project_key` | Optional public PostHog project key. Empty disables browser analytics. Must be set together with `posthog_host`. |
| `posthog_host` | Optional exact HTTPS PostHog ingest origin. Empty disables browser analytics. Must be set together with `posthog_project_key`. |
| `posthog_privacy_controls_approved` | Explicit environment approval for PostHog retention, IP handling, privacy disclosure, CSP, and subprocessor controls. Must be true before non-empty PostHog configuration can be deployed. |
| `mcp_requests_per_minute` | Required approved positive integer for authoritative per-Personal-Account requests in an exact rolling minute. |
| `mcp_requests_per_hour` | Required approved integer for authoritative per-Personal-Account requests in an exact rolling hour; at least the minute value. |
| `read_message_records_per_day` | Required approved positive integer for UTC-day Stored Message record reservations. |
| `decrypted_media_bytes_per_day` | Required approved positive integer for UTC-day decrypted Stored Media byte reservations. |
| `sends_per_minute` | Required approved positive integer for per-authorization rolling-minute send reservations. |
| `sends_per_day` | Required approved positive integer for per-Personal-Account UTC-day send reservations. |

Provider and backend credentials are ambient only:

| Value | Sensitivity | Scope |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | The current environment's account and only the Worker, R2 bucket configuration, KV, Queue, schedule, custom-domain, and Hyperdrive permissions required by the declared plan. |
| `VERCEL_API_TOKEN` | Secret | The current environment's Vercel team. |
| AWS workload identity or short-lived credentials | Secret | The current environment's exact state object/lock and state KMS key. |

Never pass provider credentials as OpenTofu variables or write them into a
backend file. Cloudflare Worker bindings and Vercel environment values declared
by the compute topology are non-secret. Secret bindings must be populated
through the platform secret stores, not through OpenTofu resource arguments
that would serialize them into state.

Each environment declares four separate R2 buckets. Encrypted Webhook Events
expire after seven days and incomplete multipart uploads abort after one day.
Stored Media, including Pending Send Files, has no blanket object-expiry rule
because Message Retention Policy can be shorter or explicitly retain content
until deletion; application retention jobs own object deletion, while
incomplete multipart uploads still abort after one day. Encrypted Deletion Capsules have no age-based deletion
rule: only confirmed provider absence permits the deletion coordinator to
destroy one, and an overdue capsule must alert rather than silently lose the
cleanup identifier. The capsule bucket is protected from OpenTofu destroy.
Deletion markers cover every object path with an indefinite bucket lock and the
marker bucket is also protected from OpenTofu destroy. All four buckets
explicitly disable the public `r2.dev` managed domain and declare no custom
domain or CORS exposure.

The provisioning, ingestion, and operator replay Queues retain unconsumed
messages for seven days. Provisioning uses the bounded reconcile-first retry
policy above.
Ingestion allows exactly seven retries and uses a three-hour default delay,
giving the roughly 21-hour bound required by ADR 0005; ingestion code may
select a jittered per-message delay inside that cap. Exhausted ingestion items
move to the actively consumed DLQ, whose unconsumed retention is four days.
API cron triggers run durable provisioning recovery and other maintenance each
minute, connection and webhook health reconciliation every five minutes, and
retention/deletion cleanup hourly. Resource names use the
deployment-environment suffix outside production so development, preview, and
production never share state by name.

The private deletion-coordinator Worker runs every minute with only the
Deletion Capsule bucket, the deletion-coordinator KMS role, provider-control,
and a `whatsapp_deletion_runtime` Neon credential. It confirms provider absence
before recording that content-free fact and destroying the capsule. The API
minute job then deletes the connection's encrypted Webhook Event and Stored
Media objects, releases retained-media quota only after each Stored Media
delete succeeds, and invokes the fixed-search-path purge function. A risk event
is emitted at 23 hours so operators have warning before the 24-hour deadline.

The five-minute reconciliation claims only due, non-deleting WhatsApp
Connections through a fixed-`search_path` database function executable by the
restricted API role. Each claim has a four-minute lease so an interrupted cron
can recover without allowing an older completion to overwrite newer evidence.
The API calls provider-control's bounded safe `reconcileSession` read with the
Connection Setup marker and exact persisted webhook ingress URL. No message,
conversation, or Directory activity timestamp participates in the decision.

Directory reconciliation treats every newly activated WhatsApp Connection as
an initial, partial projection until its first bounded provider observation.
Contact reads are claimed by the five-minute schedule and joined groups by the
hourly schedule. Public Directory freshness is evaluated at read time: either
projection is stale ten minutes after its latest complete provider snapshot,
or immediately when stored reconciliation evidence or Connection health cannot
confirm the source. A known Ingestion Gap after that snapshot, an initial or
failed/partial sync, or an explicit retention limitation keeps `partial` true;
a later complete snapshot supersedes only gaps that ended before it.

A confirmed connected session with the exact disabled-message-logging,
disabled-auto-read, enabled-webhook URL and event set advances the last
confirmed healthy point and closes active reconciliation gaps. Confirmed
absence, disconnection, reconnect requirement, unresolved connecting state,
degraded state, or duplicate sessions opens `connection_unavailable`; confirmed
webhook drift opens `webhook_configuration`. Other safe-read failures make the
Connection `degraded` but preserve existing gaps and do not create one. Gap
starts use the prior confirmed healthy point, closed rows remain associated
with the Connection's Message History Window, and no healthy result deletes a
row or certifies complete provider delivery.

Measured ingress/Queue incidents, bounded processing loss, and restore loss use
the restricted `record_ingestion_gap_evidence` function with
`ingress_failure`, `processing_failure`, or `restore_loss`. Only a concrete
incident measurement or restore report may invoke it; inactivity is not an
input. Operators invoke the same production repository through
`bun run db:record-gap -- <internal-connection-uuid> <cause> <open|close>
<utc-timestamp>` with a restricted API-runtime `DATABASE_URL`; the command
requires the exact `whatsapp_api_runtime` role on a TLS Neon URL, rejects
authority query overrides, and never prints the Connection identifier.
`connection_health.reconciliation.completed` telemetry contains only the
normalized state, gap evidence class, applied-or-superseded outcome, and service
name. It must never contain a User, Personal Account, Connection, Connection
Setup, webhook URL, provider identifier, authority, or payload.

OpenTofu variables `cloudflare_account_id` and `neon_org_id` for
`infra/production` are supplied through an uncommitted variable file or
`TF_VAR_` environment values. The checked example contains deliberately invalid
placeholders. Production database state contains generated passwords and must
use the encrypted, access-controlled S3-compatible backend configured during
`tofu init`; never store a local production state file.

The API production root also fails closed before serving requests when its KMS
region, either key ARN, the dedicated marker HMAC secret, or any short-lived
role credential is absent or invalid. The two configured KMS key ARNs must be
different. Both ARNs are safe to place in deployment configuration, while the
marker HMAC and all three credential values belong in the platform secret
store. The SDK receives redacted Effect configuration values and no credential,
plaintext key, plaintext content, provider cleanup identifier, or ciphertext is
included in application telemetry.

Example files contain placeholders only. Add secrets with the platform secret
command; never commit a populated environment file or `.dev.vars`.

## Per-connection webhook identity material

Webhook normalization uses a cryptographically random key of at least 32 bytes
for each WhatsApp Connection. This is connection data, not deployment
configuration: generate it while provisioning the connection, envelope-encrypt
it under the connection boundary, and import it with
`importWebhookIdentityKey` before constructing the production Wasender
normalization Layer. Do not introduce a shared `WASENDER_WEBHOOK_IDENTITY_KEY`
environment value, place plaintext key material in Neon or OpenTofu state, or
reuse the key across WhatsApp Connections. Key import fails closed when the
decoded value is shorter than 256 bits.

## Authenticated Webhook Event ingress

Wasender delivers to
`POST /webhooks/wasender/{webhook_ingress_id}` on the exact API origin. The
ingress ID is the random UUID retained with one WhatsApp Connection; it is
neither a public Connection handle nor authority by itself. The API accepts
only `application/json`, reads at most 1 MiB even when `Content-Length` is
absent or false, and resolves the ingress through `WEBHOOK_HYPERDRIVE` under
the restricted `whatsapp_webhook_runtime` role. That role receives only the
fixed-search-path bootstrap needed to obtain encrypted material for an active
Personal Account and non-deleting WhatsApp Connection. It cannot query the
connection key or provider-authority tables directly.

The Wasender adapter compares `X-Webhook-Signature` with the unique secret in
the connection's envelope-encrypted provider authority. If a documented
`sessionId`, `session_id`, `data.sessionId`, or `data.session_id` is present,
every supplied value must also match the encrypted per-session credential.
Missing authority, unavailable keys, an invalid secret, or a mismatched
session fails closed. There is no deployment-wide webhook authentication
secret and neither authentication value may enter a log, trace, metric, Queue
message, R2 metadata, or database plaintext.

After authentication, the exact original request bytes are AES-256-GCM
encrypted with context bound to the Personal Account, WhatsApp Connection,
random Webhook Event object ID, and `original-request` purpose. The private
`WEBHOOK_INGRESS` bucket receives only the versioned ciphertext envelope and
safe receipt metadata: version, internal Personal Account and WhatsApp
Connection context, SHA-256 ciphertext hash, payload byte count, and receipt
time. `INGESTION_QUEUE` receives exactly the opaque object ID and the same
connection context and receipt metadata. A `200` response is emitted only
after the R2 write and Queue publication both finish. R2 failure publishes
nothing; Queue failure returns `503` and intentionally leaves the encrypted
object with enough safe metadata for the orphan recovery workflow to
reconstruct the same Queue reference. Unknown or unauthenticated ingress
returns the same `404` boundary, malformed authenticated JSON returns `400`,
and an oversized delivery returns `413`.

Safe telemetry is limited to `webhook_ingress.completed`, service name, and
one of `accepted`, `authentication_failed`, `invalid_payload`, `not_found`,
`too_large`, or `unavailable`. Never add an ingress ID, object ID, Personal
Account, WhatsApp Connection, network address, header, session identity,
payload, ciphertext, hash, key metadata, or object path.

## Webhook Event normalization and connection-state projection

The API Worker consumes the environment-specific `whatsapp-mcp-ingestion`
Queue with the existing `WEBHOOK_INGRESS` R2 binding and
`WEBHOOK_HYPERDRIVE`. It validates the complete opaque Queue envelope against
the R2 object's safe metadata and ciphertext hash before loading any key
material. The restricted `whatsapp_webhook_runtime` bootstrap returns only the
matching Personal Account key envelope, WhatsApp Connection key envelope, and
encrypted per-connection webhook identity key. Missing bindings, objects,
metadata, compatible keys, or database access fail closed and leave the Queue
message unacknowledged for the configured bounded retry policy.

One authenticated delivery becomes one `webhook_events` row pointing to its
encrypted R2 source. The decrypted delivery is normalized into logical items;
each connection-state item claims its opaque connection-scoped identity in the
same Neon transaction that locks and updates the WhatsApp Connection. Provider
occurrence/version evidence is compared before verified receive order. An
older item, an item without evidence after stronger evidence, and an exact
duplicate cannot regress the current projection. The signed-in WhatsApp
Connection inventory reads that same authoritative row.

Malformed items, adapter-unsupported items, and normalized kinds whose
projector is not yet deployed are recorded as safe quarantine references with
no provider payload or identifier. Valid siblings continue independently.
Only after every item is applied, deduplicated, superseded, or quarantined does
the consumer mark the Webhook Event complete and explicitly acknowledge the
Queue message. Safe telemetry is limited to
`webhook_event.processing.completed`, normalized outcome, and aggregate item
counts; it must never include tenant, connection, event, item, provider,
payload, ciphertext, hash, or key values. The existing seven-day R2 lifecycle
remains the encrypted-source retention authority, so no new deployment secret
or public binding is introduced.

## Webhook recovery and bounded retry

The minute maintenance trigger scans at most 100 encrypted objects under the
private Webhook Event prefix. It ignores objects newer than one minute,
reconstructs the closed Queue envelope only from the object key and the six
safe custom-metadata fields, and asks `WEBHOOK_HYPERDRIVE` under
`whatsapp_webhook_runtime` which exact events already exist. Only unclaimed
objects are republished. The next opaque R2 listing cursor is checkpointed
under a maintenance-only key in the existing API KV binding after publication,
so a bounded page cannot permanently starve later object keys; a missing,
stale, or eventually consistent checkpoint safely restarts from the first
page. A race with provider redelivery or Queue consumption is safe because
both deliveries retain the original Webhook Item identities and the projector
claims those identities transactionally.

Transient R2, Neon, KMS, and Worker failures leave the ingestion message
unacknowledged. The consumer selects a per-attempt delay from 9,900 through
11,700 seconds; Cloudflare's validated `max_retries: 7` policy is the durable
limit, producing seven jittered retries over roughly 21 hours. The Queue's
10,800-second configured delay is the fail-closed default if application code
does not provide an override. Permanent malformed, unsupported, and
not-yet-projected items are quarantined and do not enter that retry schedule.

The API Worker actively consumes the environment's ingestion DLQ. For a valid
exhausted receipt it transactionally creates or verifies the `webhook_events`
source reference, marks it dead-lettered, and inserts one connection-scoped
`processing_failure` Ingestion Gap beginning at the verified receipt time. A
duplicate already completed by another delivery creates no false gap. Only
after the transaction and the safe `webhook_event.dead_letter.completed`
alert event succeed is the DLQ message acknowledged. The DLQ consumer uses
Cloudflare's maximum 100 retries at five-minute intervals, keeping failed gap
recording eligible beyond the four-hour recovery objective rather than reusing
the ingestion consumer's seven-retry exhaustion policy. The transaction also
creates a stable random incident reference. That single opaque reference is
allowlisted in the alert so an operator can request replay without receiving an
object key, tenant, connection, provider identifier, payload, ciphertext, or
key value. The source ciphertext remains in R2 for the seven-day diagnostic and
immutable-replay window.

The dedicated replay consumer accepts a closed message containing only the
incident reference, random request ID, 64-character opaque operator reference,
allowlisted reason code, request time, and version. The restricted webhook
database role creates the audit attempt before it resolves and publishes the
original closed ingestion envelope. A repeated dispatched request is
acknowledged without publication; a crash between Queue publication and audit
completion can publish the same canonical envelope again, which safely
converges through the ordinary parser, validator, normalizer, and Webhook Item
deduplication transaction. No replay flag or payload field exists.

The `MESSAGE_RETENTION_DAY_OPTIONS` API variable is the strictly increasing,
comma-separated set of finite choices shown in the product. It must include
the 30-day default; `7,30,90` is the private-beta configuration. Retain until
Connection Deletion is a separate explicit choice and is never inferred from
an omitted API value.

The hourly retention handler explicitly removes each expired R2 object before
deleting its `webhook_events` row and quarantine references. Dead-letter
incident source links become null at that point, while `webhook_items` retain
their non-reversible deduplication identities. The bucket lifecycle remains a
defense-in-depth seven-day deletion rule.

The operator command uses four validated process-only values that are never
Worker bindings:

| Variable | Sensitivity | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Internal | Exact Cloudflare account containing the replay Queue. |
| `CLOUDFLARE_INGESTION_REPLAY_QUEUE_ID` | Internal | Sensitive OpenTofu output identifying only the environment's replay Queue. |
| `CLOUDFLARE_REPLAY_API_TOKEN` | Secret | Short-lived token restricted to Queues Write for the target account. |
| `WEBHOOK_REPLAY_OPERATOR_REFERENCE` | Internal | Random 64-character lowercase hexadecimal reference mapped to the authorized operator in the external access record. |
