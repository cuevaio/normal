# Public-boundary testing

Public behavior is tested at the highest available boundary. Browser tests use
Playwright against a production `next build`/`next start` server and cross the
browser-to-API boundary over HTTP. Worker tests run inside the pinned
`@cloudflare/vitest-pool-workers` runtime and invoke fetch, Queue, and scheduled
handlers with local KV, R2, Queue, and service bindings.

## Test composition roots

External identity, provider behavior, time, identifiers, and controlled
failures are deterministic Effect services composed only by
`apps/api/test/support/public-boundary-worker.ts`. The browser uses the same
test-only Worker through `apps/api/test/wrangler.browser.jsonc`; production
Worker entrypoints never import that module and accept no header, query,
environment value, or runtime flag that enables it.

The test root supplies its Layers to `createPublicBoundaryWorker` from
`apps/api/src/public-boundary-worker.ts`. Public HTTP routing, binding calls,
Queue acknowledgement, and scheduled work therefore remain application code;
the fixture contains only deterministic external services and fault
selection. The runtime suite also invokes the deployed production Worker
export directly before exercising the Layer-composed boundary root.

The browser journey sends a deterministic external identity credential to the
test API Worker. It does not replace a React component, application handler, or
repository. As signed-in product behavior is added, journeys should keep the
same shape: drive the production-built web app, cross directly to the API
Worker, and fake only external organizations through the test composition
root.

The WhatsApp Recipient Exclusion journey drives the same seam: it selects a
WhatsApp Connection, filters by recipient kind, searches by a safe display-name
prefix, changes an exclusion, observes the live status region, reloads to prove
the state came from Normal rather than an optimistic local choice, and confirms
Personal Account Deletion stays usable after a scoped recipient failure.
Database coverage separately proves the transition, purge, suppression, and
restore invariants against migrated Postgres under the production runtime role.

The signed-in overview uses `GET /v1/personal-account/insights` for
account-scoped counts only: WhatsApp Connection state totals, retained inbound
and outbound Stored Message totals, conversation mix, confirmed or unknown Send
Operations, active MCP Authorizations, and a 30-day UTC series. The response
never includes message content, media, conversation names, phone numbers,
credentials, tenant identifiers, or provider identifiers. Database coverage
proves RLS isolation and that tombstones, expired content, and other Personal
Accounts are excluded.

The signed-in Activity Log review uses `GET /v1/activity-logs` and the
canonical Activity Log contracts. The persisted table remains `tool_call_logs`
as a storage name. MCP Authorization management lists and revokes through that
same browser-to-Worker seam. Database coverage separately applies the production
migrations and switches to `whatsapp_api_runtime` to prove RLS isolation,
idempotent atomic authorization/family revocation, and immediate access and
refresh denial. The HTTP fixture contains only safe product metadata and never
models or returns token material.

The API Key management journey creates, lists, and revokes through the same
signed-in browser-to-Worker seam with exact Origin and Clerk JWT. Creation
requires first-factor verification within five minutes and returns the
plaintext credential once. The same journey then calls `GET /v1/connections`
from the test runner with that one-time credential and observes the API-channel
Activity Log in the production-built dashboard. Database coverage applies the
production migrations under `whatsapp_api_runtime` to prove digest-only
persistence, the ten-active key limit, unique active names, disconnected
Connection selection, selected-Connection listing, constant not-found for
unknown or cross-tenant handles, idempotent revocation that clears the digest,
database-time expiry that denies authentication before scheduled cleanup,
bounded digest clearing, 90-day expired and revoked metadata retention and
purge, independent Activity Log retention, and RLS isolation. Personal Account
Deletion tests prove both the product and verified Clerk entry points revoke
every API Key, clear every digest, and later cascade those rows during the
bounded purge while API Activity Logs become the same unlinkable Security
Records as MCP events. Worker scheduled tests prove hourly expiry and metadata
purge without a request and emit only metadata counts. Dashboard tests render
expired and revoked states without recovering plaintext. Worker tests never put
fixture credentials in the production composition root. REST Worker tests prove
bearer parsing, Problem Details, no-CORS protected JSON, current permission
checks, immediate revocation without an authorization cache, Directory contact
and group paging, WhatsApp Conversation paging, complete Stored Message pages,
private POST search that keeps terms out of URLs, cursors, telemetry, and
Problem Details, REST-only cursors, 1 MiB message-page reduction without
truncation, Unicode completeness, Message History Window and Ingestion Gap
coverage, audit-before-release, last-selected Connection Deletion as invalid
credentials, constant-shape not found for a deleted, excluded, or unselected
Connection or Conversation, and retained disconnected reads. REST Send
Operation tests prove `POST /v1/connections/{connection_id}/send-operations`
requires `messages:send`, an `Idempotency-Key`, exactly one text or PDF content
form, and exactly one `ctc_`/`grp_` handle, E.164 phone, or WhatsApp username
destination; exact replay and payload conflict stay on the shared send
operation; failed and unknown post-boundary outcomes remain Send Operation
resources; and pre-operation failures use Problem Details.
`GET /v1/connections/{connection_id}/send-operations/{send_operation_id}`
returns local Send Status only to the originating still-active API Key with
`messages:send`; replacement, revoked, cross-Connection, and unknown handles
share constant-shape 404 or 401, and the read never calls the provider or
consumes send quota. MCP and REST share
that grant-aware send service so fingerprints, quota, and receipts cannot
diverge by adapter. Migrated-Postgres tests prove API Key contact, group,
conversation, Stored Message listing, and private Stored Message search share
MCP ordering or exact-word matches, selected-Connection isolation, Recipient
Exclusion, joined-only group membership, kind or search filters, retention,
Ingestion Gap and index-coverage metadata, and shared returned-record quota,
and that Connection Deletion removes selection, revokes a last-selected key
and clears its digest, keeps remaining grants, leaves disconnection in place,
and rejects new sends while remaining selected Connections can still send.
Restore-coordinator and migrated-Postgres restore tests prove every restored
API Key is revoked and every digest is cleared before `is_restore_ready`,
aggregate invalidation evidence is recorded, incomplete batches, authority
failure, and branch mismatch keep the gate closed, and a predecessor HMAC
generation is not accepted as a verification fallback. Recovery-drill
evidence requires those restore checks plus HMAC-rotation attestation.

The browser always renders `apps/web/src/app/home-experience.tsx`; there is no
test component alias or selectable web composition root. Playwright supplies
only the external Clerk-shaped identity boundary and test network routing from
the configured HTTPS API origin to the local Wrangler process. The component,
event handling, credential lookup, request construction, and response
rendering are the production UI path.

The Worker runtime suite proves:

- the actual fetch boundary and CORS behavior;
- deterministic identity, provider, clock, and identifier Layers;
- active bootstrap and fail-closed provider-capacity exhaustion outcomes;
- controlled external failure behavior;
- KV and R2 persistence through real local bindings;
- Queue publication and explicit consumer acknowledgement;
- authenticated R2-to-Queue Webhook Event normalization, permanent sibling
  quarantine, deduplication, evidence-ordered connection-state projection, and
  visibility through the signed-in WhatsApp Connection inventory;
- rejection of content-free provider message items before Message Store
  projection, plus migration cleanup that preserves Deleted Message Tombstones,
  removes empty WhatsApp Conversations, and recalculates retained Conversation
  Activity;
- five-minute safe-read connection and webhook reconciliation with
  evidence-based Ingestion Gap opening, recovery closure, and stale-snapshot
  suppression;
- minute-scheduled orphan discovery from real R2 metadata, republishing through
  the Queue binding, convergence with later provider redelivery, jittered
  transient retries, and DLQ acknowledgment after Ingestion Gap persistence;
- opaque incident alerting, audited immutable replay through the ordinary
  ingestion Queue, and seven-day source/quarantine cleanup that retains
  non-reversible Webhook Item identities;
- provider-control service-binding calls;
- scheduled-handler effects through the supported runtime helpers;
- an OAuth authorization redirect over signed-in HTTP;
- MCP tool discovery over HTTP JSON-RPC;
- authorization-scoped `list_contacts` discovery, encrypted Directory
  projection, connection-scoped normalized name-prefix and exact E.164 blind
  indexes, query-bound deterministic cursor pagination, suffix-only output,
  empty-result privacy for unavailable contacts, and audit-before-release
  behavior; and
- an authenticated, non-cacheable protected-resource read; and
- the signed-in WhatsApp Recipient Exclusion boundary: exact Origin and CORS
  behavior, closed query and body parsing, opaque handle pagination, stale
  expected state, constant-shape not found, journal-append failure leaving no
  acknowledged transition, and byte-stable idempotent journal replay.

Controlled values, credentials, and failure selection are reachable only from
the test Worker composition root. The HTTP and event handlers live under
`apps/api/src`; production entrypoints never import the test root, and bundle
inspection proves that the test Layer and its controls are absent. The
test-only readiness and binding-probe routes are not production diagnostics.

## Database boundary

Database tests apply the versioned production migrations to an isolated PGlite
Postgres environment. Fixture setup may use migration authority, but behavior
and adversarial checks switch to `whatsapp_api_runtime`,
`whatsapp_webhook_runtime`, or `whatsapp_restore_runtime`, use
transaction-local Personal Account or WhatsApp Connection context, and retain
the production RLS policies, bootstrap functions, and composite tenant
foreign keys. Do not replace repositories with
in-memory implementations when data is involved. Send Operation tests prove
MCP Authorization and API Key remain distinct grant identities for create,
replay, quota, and status, and that public receipts omit internal IDs.

## Commands

Install the pinned Chromium build and its host dependencies once:

```sh
bun x playwright install --with-deps chromium
```

Run the coordinated suite:

```sh
bun run test
```

The API public-boundary suite can be run alone with:

```sh
cd apps/api
bun x vitest run --config vitest.public-boundary.config.ts
```

The browser suite can be run alone from `apps/web` with:

```sh
bun x playwright test
```

Playwright starts a test-only Wrangler API Worker and a production Next.js
server automatically. It never requires a Clerk tenant, Provider Account,
Provider API Credential, or production data.

The static Scalar documentation suite builds `apps/docs`, validates the
generated OpenAPI 3.1 artifact against the shared contracts, checks
self-hosted Scalar assets, CSP, caching, Problem Details type URLs, and safe
examples, then loads the production-built reference at mobile and desktop
viewports. The site cannot execute authenticated requests or persist an API
Key.

`bun run deploy:smoke` also fetches the deployed docs origin after web health.
It requires a distinct `docs.normal.fast` (or same-environment docs) origin,
HTML that self-hosts the pinned Scalar bundle, the generated OpenAPI document,
reviewed security headers, and no Vercel rewrite to the API Worker. A docs
failure reports only the `docs` subsystem; it never prints the document or
credential material.

`bun run release:public-api` is the public API release gate. It fails closed
when any repository quality, database, infrastructure, browser-to-Worker,
lifecycle, bundle-inspection, docs-smoke, recovery-drill, restore-invalidation,
or HMAC-rotation attestation is missing, and when the generated OpenAPI 3.1
document is missing a required v1 path or guide. A failed gate blocks release;
there is no skip, ignore-failure, or reduced-check mode. The workflow reruns
every command before it may attest `passed`.

## Production exclusion

`bun run build` inspects every Worker output, source map, Next.js server and
browser chunk, and the static docs output. The build fails if any test Layer, controlled identity
credential, fixture secret, or fault-injection marker is present. A failure
reports only the artifact path, never the matched plaintext. Production configuration accepts only
`development`, `preview`, or `production`; no production build variable,
runtime flag, component alias, header, or query parameter can select a test
composition root.

The harness adds no production binding or infrastructure authority. It uses
ephemeral local implementations of the bindings already declared for the API
Worker, and the browser-specific Wrangler manifest is under `apps/api/test`.
