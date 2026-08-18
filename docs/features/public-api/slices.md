---
shaping: true
---

# Public API - Implementation Slices

## Slice Summary

| # | Slice | Demo |
|---|---|---|
| V1 | Contract and one end-to-end read | Create an API Key in the dashboard, copy it once, call `GET /v1/connections`, and observe the API request in Activity Log through real Worker and migrated-Postgres boundaries. |
| V2 | Directory and conversation reads | Page contacts, groups, conversations, and complete Stored Messages with key-bound cursors, shared quotas, privacy filtering, history coverage, and 1 MiB response limiting. |
| V3 | Search and Stored Media | POST private search terms without URL leakage and read eligible media from the authenticated nested endpoint after audit and byte reservation. |
| V4 | Send Operations | Create and replay idempotent sends, preserve ambiguous outcomes, and read status only with the originating active API Key. |
| V5 | Lifecycle and recovery | Prove expiry, revocation, Connection Deletion, Personal Account Deletion, 90-day metadata purge, and global post-restore invalidation. |
| V6 | Scalar reference and deployment | Serve the validated OpenAPI contract through a static Astro/Scalar app at `docs.normal.fast` with self-hosted pinned assets and no browser execution. |
| Release | Public API release gate | Prove formatting, lint, typecheck, tests, builds, migrated Postgres, manifests, infrastructure, observability, browser-to-Worker, lifecycle, bundle inspection, docs smoke, restore invalidation, and HMAC rotation evidence together. Any failed gate blocks release. |

## V1: Contract and One End-to-End Read

This tracer slice establishes every security boundary before broadening the resource surface.

### Contracts

- Add `apk_` to the explicit opaque-handle contract and ADR 0023's inventory.
- Add closed API Key management, REST Connection list, Activity Log, pagination, and Problem Details schemas under explicit `packages/contracts` subpath exports.
- Add an explicit route registry that generates OpenAPI 3.1 and supplies runtime request/response schemas.
- Add contract tests for excess-property rejection, handle cross-type rejection, OpenAPI generation, security schemes, examples, and stable operation IDs.

### Database

- Add a versioned migration for API Key grants, credential digests, exact permissions, selected Connections, expiry/revocation metadata, 90-day purge deadlines, tenant composite foreign keys, RLS, and the ten-active-key invariant.
- Add the narrow API Key bootstrap function with fixed search path and minimum runtime grants.
- Generalize the protected-operation admission/audit model from MCP-only Tool Call Log to channel-aware Activity Log without weakening existing MCP behavior.
- Bind REST cursors and request-frequency reservations to the API Key grant identity.
- Test against migrated Postgres as the production runtime role: valid/invalid digest, expiry by database time, cross-tenant constant shape, scope denial, explicit Connection selection, later-Connection exclusion, active-key limit, and atomic audit/quota admission.

### API Worker

- Add a purpose-specific API Key credential parser/HMAC service and production secret binding.
- Add API Key management product handlers using Clerk and recent verification for creation.
- Add a REST adapter and `GET /v1/connections` over a protocol-neutral protected operation.
- Keep MCP and production/test composition roots statically separate; no environment flag, header, or alias may select a credential verifier.
- Add safe 401, 403, 404, 429, and 503 Problem Details mappings and no-store headers.

### Dashboard

- Add the top-level API Keys route and extracted component.
- Implement create/list/revoke, exact permission and Connection selection, optional expiry, one-time reveal, copy state, and responsive/accessible loading, empty, error, and confirmation states.
- Rename the existing Activity destination and render MCP/API channel identity without protected content.

### Verification

- Worker fetch tests invoke the production API Key route boundary in the pinned Cloudflare runtime.
- Browser tests create a key through the production-built Next.js app, prove plaintext appears once, revoke it, and cross directly to the API Worker with Clerk JWTs.
- Database tests retain RLS and production migrations.
- Production bundle inspection rejects fixture keys, credential markers, and test verifier code.

## V2: Directory and Conversation Reads

- Extract or deepen protocol-neutral operations for contacts, groups, conversations, and Stored Message pages while preserving the current privacy/decryption modules.
- Add the nested GET endpoints and closed query contracts.
- Issue REST-only keyset cursors bound to API Key, endpoint, Connection, filters, limit, sort version, and expiry.
- Return `{ data, pagination, meta }` envelopes with Directory freshness or Message History Window/Ingestion Gap coverage.
- Return complete retained text. Select fewer records before release to keep encoded JSON at or below 1 MiB; never split a Stored Message.
- Preserve Recipient Exclusion filtering beneath every grant and the constant not-found relationship checks.
- Share returned-record quotas with MCP and prove switching channels cannot exceed the Personal Account limit.
- Add parity tests showing MCP and REST observe the same domain records and exclusions while retaining different protocol envelopes.

## V3: Search and Stored Media

- Add `POST /v1/connections/{connection_id}/messages/search` with a closed body for query, optional conversation, direction, time range, limit, and cursor.
- Reuse keyed exact-word indexes and plaintext verification; bind cursors to a keyed digest of normalized terms, never the terms themselves.
- Add the authenticated nested media endpoint with strict handle parsing, complete ownership-chain checks, audit and full-byte reservation before decryption, 16 MiB maximum, normalized MIME type, sanitized filename, and private no-store response.
- Return an authenticated REST media path in REST message metadata, never an MCP URI, provider URL, public R2 URL, presigned URL, or bearer capability URL.
- Add tests proving terms are absent from URLs, logs, cursors, telemetry, and errors; media remains non-listable and cross-linked handles share the not-found boundary.

## V4: Send Operations

- Generalize the send authority context so MCP Authorization and API Key remain distinct grant identities over one atomic send operation.
- Add `POST /v1/connections/{connection_id}/send-operations` requiring `Idempotency-Key`, recipient handle, and exact text.
- Bind idempotency and Send Status to the originating API Key; replacement or separately authorized keys cannot read or replay prior operations.
- Preserve connected-state admission, Recipient Exclusions, current Directory eligibility, exact-text fingerprinting, quota transaction, durable provider-attempt boundary, and no automatic retry after ambiguity.
- Return a normal Send Operation resource for accepted, failed, or unknown post-boundary outcomes. Use Problem Details only for pre-operation execution failures.
- Add race, replay, payload-conflict, lost-response, provider-failure, ambiguous-outcome, audit-failure, quota, revoked-key, and cross-key status tests.

## V5: Lifecycle and Recovery

- Revoke and clear digests immediately on User revocation, expiry processing, last-selected Connection Deletion, and Personal Account Deletion.
- Keep safe expired/revoked metadata for 90 days, then purge it without breaking retained Activity Log presentation.
- Update the restore coordinator and traffic gate to revoke every restored API Key and clear every digest before verification access.
- Add the operational step and aggregate evidence required to rotate `API_KEY_HMAC_SECRET` after restore; never retain the predecessor as a verification fallback.
- Update deletion transformation so API Activity Logs become the same unlinkable Security Records as MCP events.
- Add migrated-Postgres, restore-coordinator, scheduled purge, Connection Deletion, Personal Account Deletion, and recovery-drill tests.

## V6: Scalar Reference and Deployment

- Add `apps/docs` with Astro static output and the official `@scalar/astro` component in default static mode.
- Generate and validate `openapi.json` from shared contracts during build; fail on stale generated output or handler/contract mismatch.
- Put all v1 guide prose and safe examples in OpenAPI Markdown and descriptions.
- Hide request execution/auth UI, disable credential persistence, Agent, proxy, and telemetry, and expose server-side code examples.
- Copy and self-host the exact pinned Scalar browser asset with immutable cache headers and a strict CSP compatible with Scalar's documented inline-style requirement.
- Add a separate Vercel project/domain in OpenTofu, manifest validation, deployment smoke coverage, sitemap/robots policy as applicable, and static artifact checks.
- Test static generation, OpenAPI validation, broken links/assets, security headers, no secret/test markers, and mobile/desktop reference loading.

## Required Documentation Ripple

Implementation must update the affected documents in the same slices:

- `CONTEXT.md`: API Key and Activity Log terminology is already introduced during shaping; keep implementation and UI aligned.
- `docs/architecture.md`: add the server-side API caller, API Key path, and static docs deployment without changing the sole data-plane boundary.
- `docs/configuration.md`: document `API_KEY_HMAC_SECRET`, API Key limits, channel-neutral quotas, docs origin/build configuration, and validation.
- `docs/testing.md`: add API Key, REST, Activity Log, docs, and restore-invalidating boundaries.
- `docs/runbooks/security-operations.md`: add credential/HMAC compromise, User key revocation, and intentional global invalidation.
- `docs/runbooks/deletion-recovery.md`: add API Key revocation, digest clearing, post-restore HMAC rotation evidence, and traffic-gate criteria.
- `docs/runbooks/deployment.md`: provision and verify the purpose-specific secret and `docs.normal.fast` Vercel project/domain.
- `docs/runbooks/observability.md`: add safe REST channel metrics and exclude credentials, search terms, content, raw bodies, and tenant identifiers.
- `docs/adr/0012-fail-closed-when-tool-audit-is-unavailable.md`: supersede or broaden the tool-only wording with Activity Log audit-before-release.
- `docs/adr/0018-keep-authoritative-quotas-in-neon.md`: broaden MCP-oriented operation language to shared MCP/API Personal Account quotas.
- `docs/adr/0023-use-prefixed-opaque-public-handles.md`: add `apk_`.
- `docs/adr/0024-use-bound-keyset-cursors.md`: add API Key and endpoint binding without making cursor formats interchangeable.
- `docs/adr/0025-use-non-listable-protected-media-resources.md`: preserve MCP URI behavior while documenting authenticated REST media paths.

## Delivery Gate

Do not expose any API Key creation UI or protected REST route until V1 proves, in one deployable slice, one-time secret handling, narrow bootstrap, RLS, current permission and Connection checks, Activity Log admission, shared quota reservation, immediate revocation, constant-shape failures, production composition, and bundle exclusion. Later resource slices must build on that gate rather than temporarily bypassing it.

## Release Gate

`bun run release:public-api` and the `Public API release gate` workflow prove the
integrated public API before release. They rerun repository quality checks,
migrated-Postgres suites, manifest and infrastructure validation, browser-to-Worker
coverage, lifecycle and recovery suites, production bundle inspection, and the
deployed `docs.normal.fast` smoke. They also require the complete v1 OpenAPI
surface and restore evidence that every API Key was revoked, every digest was
cleared, `API_KEY_HMAC_SECRET` was rotated, and the predecessor HMAC is rejected.
Any failed or missing gate blocks release. Do not add an exception or reduced
check.
