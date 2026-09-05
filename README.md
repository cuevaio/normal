# Normal

Normal is a personal platform that lets approved AI clients work with a connected WhatsApp account through the Model Context Protocol.

Each User owns one Personal Account. A Personal Account can hold up to three WhatsApp Connections and can grant each MCP Client access to an explicit set of Connections and capabilities. Read access and send access are separate permissions. Every outbound message requires confirmation in the MCP Client.

The platform is currently built for a private beta. Privacy, deletion, auditability, and safe recovery are part of the core design, not optional layers added later.

## What is in this repo

This is a Bun and Turbo monorepo with ten deployable apps:

| Path | Purpose | Runtime |
| --- | --- | --- |
| `apps/web` | Product UI, connection management, and OAuth consent | Next.js on Vercel |
| `apps/docs` | Static API reference generated from the shared OpenAPI contracts | Astro and Scalar on Vercel |
| `apps/api` | Public HTTP API, OAuth server, MCP endpoint, webhook ingestion, and scheduled reconciliation | Cloudflare Workers |
| `apps/provider-control` | Private boundary for provider provisioning and control | Cloudflare Workers |
| `apps/deletion-coordinator` | Continues deletion after access and key use have stopped | Cloudflare Workers |
| `apps/restore-coordinator` | Reconciles restored data with deletion markers and recovery rules | Cloudflare Workers |
| `apps/operations-control` | Authenticated availability evidence and pager delivery | Cloudflare Workers |
| `apps/recovery-control` | Runs authenticated, serialized, non-serving production recovery drills | Cloudflare Workers and Workflows |
| `apps/recovery-verifier` | Independently verifies guarded recovery branches and aggregate objectives | Cloudflare Workers |
| `apps/recovery-game-day` | Exercises disposable quarterly KV, Queue, R2, KMS, and pager capabilities | Cloudflare Workers |

Shared code is split by responsibility:

| Path | Purpose |
| --- | --- |
| `packages/domain` | Pure domain rules and state transitions |
| `packages/contracts` | MCP, API, health, handle, and service binding schemas |
| `packages/db` | Drizzle schema, migrations, RLS-aware repositories, and database tools |
| `packages/whatsapp-provider` | Provider seam for connection lifecycle, Directory, text, PDF and image sending, media, and webhook normalization |
| `infra` | OpenTofu configuration for Cloudflare, Vercel, Neon, and AWS KMS |
| `scripts` | Deployment, validation, recovery, observability, and launch gate tooling |

The API Worker is the public data plane. Provider credentials stay behind the private `provider-control` service binding. Neon is the authoritative data store, while Cloudflare bindings handle edge protocol state, queues, and encrypted webhook payloads.

## Requirements

You need:

* [Bun](https://bun.sh/) 1.3.14
* Node.js 20 or newer for supporting tools
* [Wrangler](https://developers.cloudflare.com/workers/wrangler/) through the pinned workspace dependency
* [OpenTofu](https://opentofu.org/) 1.12.5 for infrastructure validation
* Chromium and its host dependencies for browser tests

For local provider or deployment work, you will also need access to the relevant Clerk, Cloudflare, Neon, AWS, Vercel, and Wasender environments.

## Local setup

Install the pinned dependencies:

```sh
bun install --frozen-lockfile
```

Create local secret files only for the apps you plan to run:

```sh
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/provider-control/.dev.vars.example apps/provider-control/.dev.vars
cp apps/deletion-coordinator/.dev.vars.example apps/deletion-coordinator/.dev.vars
cp apps/restore-coordinator/.dev.vars.example apps/restore-coordinator/.dev.vars
cp apps/recovery-control/.dev.vars.example apps/recovery-control/.dev.vars
cp apps/web/.env.example apps/web/.env.local
```

The example files document the required values. Never commit `.dev.vars`, `.env.local`, credentials, tokens, phone numbers, provider payloads, or decrypted message content.

Start the web app and API Worker together:

```sh
bun run dev
```

You can also run one workspace directly:

```sh
bun run --cwd apps/web dev
bun run --cwd apps/api dev
bun run --cwd apps/provider-control dev
```

If a real external webhook needs to reach your local Worker, run the configured Cloudflare tunnel in another terminal:

```sh
bun run dev:tunnel
```

## Verification

CI runs these checks in order:

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

The release and deployed-environment gates are separate from ordinary pull request verification:

```sh
bun run launch:gate
bun run release:public-api
bun run deploy:smoke
```

Install the pinned browser once before the first full test run:

```sh
bun x playwright install --with-deps chromium
```

Tests intentionally exercise production-shaped boundaries. API, provider-control, and recovery-control tests use the pinned Cloudflare Vitest runtime; the deletion and restore coordinator suites use ordinary Vitest. Browser tests use a production Next.js build and a test-only Wrangler API, while database tests apply production migrations in PGlite and switch to restricted runtime roles with RLS. Test composition roots must never become selectable from a production build.

`bun run build` also dry-runs production Worker bundles and scans Worker, source-map, Next.js, and docs output for test fixtures, controlled credentials, and fault-injection markers.

For focused work, use Turbo filters or workspace commands:

```sh
bun x turbo run test --filter=@whatsapp-mcp/api
bun x turbo run typecheck --filter=@whatsapp-mcp/web
bun run --cwd packages/db test
```

The root `test` script always runs `scripts/*.test.ts` before Turbo. Run the API public-boundary composition or one browser journey directly with:

```sh
(cd apps/api && bun x vitest run --config vitest.public-boundary.config.ts)
(cd apps/web && bun x playwright test test/browser/api-keys.spec.ts)
```

## Database changes

Database code and versioned production migrations live in `packages/db`. These commands require the direct TLS Neon owner URL in `MIGRATION_DATABASE_URL`; never configure it on a deployable app.

```sh
bun run --cwd packages/db db:generate
bun run db:migrate
bun run db:check
```

Do not edit a migration that has shipped. Preserve tenant foreign keys, runtime role grants, fixed search paths, RLS policies, deletion behavior, and restore behavior. Tests must exercise the production migration path.

Generate the public OpenAPI artifact with `bun run --cwd packages/contracts generate:openapi`. Building `apps/docs` also regenerates `apps/docs/public/openapi.json` and copies the pinned Scalar browser asset; do not hand-edit either generated file.

## Architecture and operations

Start with these documents:

* [`CONTEXT.md`](CONTEXT.md) defines the product language and invariants.
* [`docs/architecture.md`](docs/architecture.md) maps the production boundaries and primary data flows.
* [`docs/mcp-contract.md`](docs/mcp-contract.md) defines MCP tools, resources, authorization, errors, and pagination.
* [`docs/configuration.md`](docs/configuration.md) lists runtime configuration and secret ownership.
* [`docs/testing.md`](docs/testing.md) explains the public boundary test strategy.
* [`docs/whatsapp-provider-seam.md`](docs/whatsapp-provider-seam.md) defines the provider boundary.
* [`docs/stored-media-container.md`](docs/stored-media-container.md) describes encrypted Stored Media.
* [`docs/adr`](docs/adr) records architectural decisions.
* [`docs/runbooks`](docs/runbooks) contains deployment, incident, recovery, security, and teardown procedures.

The most important rules are simple:

* Use the terms in `CONTEXT.md` in code, tests, and docs.
* Keep provider details behind `packages/whatsapp-provider` and `apps/provider-control`.
* Fail closed when identity, authorization, audit, quota, encryption, or configuration is unavailable.
* Never retry an outbound send when provider acceptance is ambiguous.
* Keep logs and telemetry free of message content, credentials, full phone numbers, provider identifiers, and tenant identifiers unless an approved contract explicitly allows them.
* Make deletion and restore behavior explicit for every new persisted record.

## Deployment

Development, preview, and production have separate configuration and infrastructure authority. Do not deploy by improvising commands from local manifests.

Follow [`docs/runbooks/deployment.md`](docs/runbooks/deployment.md), but use [the production workflow](.github/workflows/deploy-production.yml) as the executable deployment order: migrate and check the database, then deploy provider-control, deletion coordinator, restore coordinator, operations control, recovery game day, recovery verifier, recovery control, the rendered API, web, docs, and finally smoke the release. Production recovery, key rotation, replay, break-glass access, and environment teardown each have dedicated runbooks under `docs/runbooks`.

## Sandcastle

Sandcastle can run issue agents in isolated Docker worktrees. After authenticating Docker, GitHub CLI, and Codex:

```sh
bun run sandcastle:build-image
bun run sandcastle
```

Agent specific issue and triage guidance lives in `docs/agents`.
