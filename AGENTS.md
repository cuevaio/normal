# Working in this repository

## Sources of truth

- Read `CONTEXT.md` before changing names, behavior, copy, or tests; its glossary is authoritative.
- Read the relevant ADR in `docs/adr` and the relevant contract, configuration, testing, or runbook document under `docs` before changing that boundary. Do not introduce a second model when an ADR already decides it.
- Prefer package scripts, CI workflows, and manifests over prose when they conflict. The executable production order is `.github/workflows/deploy-production.yml`; keep `docs/runbooks/deployment.md` aligned with that workflow.

## Repository boundaries

- `apps/web`: Next.js product UI on Vercel. Browser data requests go directly to the configured API origin; do not add a Vercel API proxy or rewrite.
- `apps/docs`: static Astro/Scalar API reference on a separate Vercel project. It must not proxy authenticated requests or retain API Keys.
- `apps/api`: public Cloudflare Worker for HTTP, OAuth, MCP, REST, webhooks, reconciliation, Queue consumers, and scheduled work.
- `apps/provider-control`: private Cloudflare RPC service for provider provisioning/control. Provider credentials and provider-specific behavior stay here and in `packages/wasender`.
- `apps/deletion-coordinator` and `apps/restore-coordinator`: scheduled Workers that preserve deletion and serving-branch recovery invariants. `apps/recovery-control` is the authenticated, serialized Workflow boundary for non-serving production drills and has no production object-delete binding. `apps/recovery-verifier` and `apps/recovery-game-day` are private recovery evidence Workers. `apps/operations-control` is the authenticated availability and pager boundary.
- `packages/domain`: pure rules; `packages/contracts`: schemas, public handles, and OpenAPI; `packages/db`: migrations and RLS-aware repositories; `packages/wasender`: provider-neutral Effect capabilities.
- Shared packages expose explicit subpaths. Do not add root or catch-all barrel exports.
- Runtime configuration may select only `development`, `preview`, or `production`. Production and test composition roots are statically separate; no request or runtime switch may select test wiring.
- Neon is authoritative for identity, tenant data, authorization, quotas, audit, and lifecycle state. KV, R2, and Queues must not become alternate authorities.
- Public resources use contract-defined prefixed opaque handles. Never expose internal database IDs or provider identifiers.

## Domain and security invariants

- Preserve the distinctions in `CONTEXT.md`, especially disconnection versus Connection Deletion and Send Operation versus Stored Message. Read and send permissions are independent, and new WhatsApp Connections never enter an existing grant automatically.
- Every outbound tool call requires Client Confirmation, but it is not a server-verified security boundary. Never automatically retry a Send Operation after an ambiguous provider outcome.
- Fail closed when authentication, authorization, audit persistence, quotas, encryption, required bindings, or required configuration are unavailable.
- Enforce Personal Account and WhatsApp Connection ownership in database access with RLS, tenant context, restricted runtime roles, and composite ownership constraints.
- Preserve constant-shape not-found behavior for unknown and cross-tenant handles.
- Never log or emit message/search content, media, credentials, tokens, full phone numbers, provider payloads or identifiers, raw request bodies, or tenant identifiers unless an existing allowlisted contract explicitly requires the field.
- Keep cryptographic keys purpose-specific. Never place secrets in Wrangler vars, Vercel config, source, fixtures, snapshots, or committed environment files.
- For every persisted value, establish ownership, encryption, access, retention, deletion, restore, audit, and telemetry behavior. Deletion stops access and key use immediately; restore must not resurrect terminal data or access.

## Commands

Use Bun `1.3.14` and the checked lockfile:

```sh
bun install --frozen-lockfile
bun x playwright install --with-deps chromium
```

`bun run dev` starts only API and web. API uses `apps/api/.dev.vars`; web uses `apps/web/.env.local`.

```sh
bun run dev
bun run --cwd apps/api dev
bun run --cwd apps/web dev
bun run --cwd apps/provider-control dev
```

Run the local CI-equivalent checks in workflow order. `bun run test` is the
complete local equivalent of CI's concurrent `test:without-db` command and four
database test shards:

```sh
bun run format:check
bun run lint
bun run typecheck
bun run validate:infra
bun run test
bun run build
bun run manifests:validate
bun run observability:validate
bun run infra:validate
```

- `format:check` checks formatting only; `lint` runs workspace Biome checks plus `.sandcastle` and `scripts`.
- Use root `bun run typecheck` as workspace truth; the root TypeScript project references omit `apps/docs`, both coordinators, the recovery Workers, and `apps/operations-control`. Those packages typecheck through Turbo.
- `bun run build` also renders/dry-runs production Worker bundles and scans Worker, source-map, Next.js, and docs output for forbidden test fixtures and controls.
- Infrastructure/release-only gates include `bun run launch:gate`, `bun run release:public-api`, and `bun run deploy:smoke`; do not run operational gates without their documented environment and runbook.

## Focused verification

Use Turbo directly to avoid the root `test` script's unconditional `scripts/*.test.ts` run:

```sh
bun x turbo run test --filter=@whatsapp-mcp/api
bun x turbo run typecheck --filter=@whatsapp-mcp/web
bun run --cwd packages/domain test test/connection-setup.test.ts
bun run --cwd packages/db test test/recipient-exclusion.test.ts
```

API tests use two compositions; run the public-boundary root explicitly when relevant:

```sh
cd apps/api
bun x vitest run test/rest.test.ts
bun x vitest run --config vitest.public-boundary.config.ts
```

Browser tests build/start the production web app and a test-only Wrangler API automatically:

```sh
cd apps/web
bun x playwright test test/browser/api-keys.spec.ts
```

- API, provider-control, and recovery-control use the pinned Cloudflare Vitest pool. The deletion and restore coordinators currently use ordinary Vitest.
- Database tests apply production migrations in PGlite and switch to restricted production runtime roles with RLS; do not replace repository behavior with in-memory fakes.
- Fake external systems only through dedicated test roots. When adding controlled test values or markers, update production bundle-exclusion checks.

## Database and generated files

- Database changes live in `packages/db/drizzle` as versioned production migrations. Do not edit a migration that has shipped.
- `db:migrate`, `db:check`, and `db:generate` require a direct TLS Neon `MIGRATION_DATABASE_URL`; never bind that owner URL to an app.

```sh
bun run --cwd packages/db db:generate
bun run db:migrate
bun run db:check
bun run --cwd packages/db test
```

- Generate the public API with `bun run --cwd packages/contracts generate:openapi`.
- Docs build regenerates `apps/docs/public/openapi.json` and the pinned Scalar asset under `apps/docs/public/vendor`; do not hand-edit them.
- API manifests under `apps/api/.wrangler` are generated and ignored. Never commit sensitive binding IDs in a manifest.

## Operations

- Deployment, replay, recovery, deletion, key rotation, break-glass access, and teardown are runbook-driven. Do not improvise commands from local manifests.
- Production deployment order is encoded in `.github/workflows/deploy-production.yml`: migrate/check DB, provider-control, deletion coordinator, restore coordinator, operations control, recovery game day, recovery verifier, recovery control, rendered API, web, docs, then smoke.
- Development, preview, and production infrastructure/state are separate. `validate:infra` and `infra:validate` are distinct checks; CI pins OpenTofu `1.12.5`.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

Next.js is pinned to `16.2.12` and has breaking API/convention changes. Read the relevant guide in `node_modules/next/dist/docs/` before writing web code and heed deprecation notices.
<!-- END:nextjs-agent-rules -->
