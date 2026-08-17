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
and RLS isolation. Personal Account Deletion tests prove both the product and
verified Clerk entry points revoke every API Key, clear every digest, and later
cascade those rows during the bounded purge while API Activity Logs become
the same unlinkable Security Records as MCP events. Worker tests never put
fixture credentials in the production composition root. REST Worker tests prove
bearer parsing, Problem Details, no-CORS protected JSON, current permission
checks, immediate revocation without an authorization cache, Directory contact
paging, WhatsApp Conversation paging, REST-only cursors, and
audit-before-release. Migrated-Postgres tests prove API Key contact and
conversation listing share MCP ordering, selected-Connection isolation,
Recipient Exclusion, and kind or search filters.

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
and adversarial checks switch to `whatsapp_api_runtime` or
`whatsapp_webhook_runtime`, use transaction-local Personal Account or
WhatsApp Connection context, and retain the production RLS policies, bootstrap
functions, and composite tenant foreign keys. Do not replace repositories with
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

## Production exclusion

`bun run build` inspects every Worker output, source map, and Next.js server and
browser chunk. The build fails if any test Layer, controlled identity
credential, fixture secret, or fault-injection marker is present. A failure
reports only the artifact path, never the matched plaintext. Production configuration accepts only
`development`, `preview`, or `production`; no production build variable,
runtime flag, component alias, header, or query parameter can select a test
composition root.

The harness adds no production binding or infrastructure authority. It uses
ephemeral local implementations of the bindings already declared for the API
Worker, and the browser-specific Wrangler manifest is under `apps/api/test`.
