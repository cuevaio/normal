# Normal

Normal is a personal platform that lets approved AI clients work with a connected WhatsApp account through the Model Context Protocol.

Each User owns one Personal Account. A Personal Account can hold up to three WhatsApp Connections and can grant each MCP Client access to an explicit set of Connections and capabilities. Read access and send access are separate permissions. Every outbound message requires confirmation in the MCP Client.

The platform is currently built for a private beta. Privacy, deletion, auditability, and safe recovery are part of the core design, not optional layers added later.

## What is in this repo

This is a Bun and Turbo monorepo with five deployable apps:

| Path | Purpose | Runtime |
| --- | --- | --- |
| `apps/web` | Product UI, connection management, and OAuth consent | Next.js on Vercel |
| `apps/api` | Public HTTP API, OAuth server, MCP endpoint, webhook ingestion, and scheduled reconciliation | Cloudflare Workers |
| `apps/provider-control` | Private boundary for provider session provisioning and control | Cloudflare Workers |
| `apps/deletion-coordinator` | Continues deletion after access and key use have stopped | Cloudflare Workers |
| `apps/restore-coordinator` | Reconciles restored data with deletion markers and recovery rules | Cloudflare Workers |

Shared code is split by responsibility:

| Path | Purpose |
| --- | --- |
| `packages/domain` | Pure domain rules and state transitions |
| `packages/contracts` | MCP, API, health, handle, and service binding schemas |
| `packages/db` | Drizzle schema, migrations, RLS aware repositories, and database tools |
| `packages/wasender` | Thin provider adapter for sessions, control, media, and webhook normalization |
| `infra` | OpenTofu configuration for Cloudflare, Vercel, Neon, and AWS KMS |
| `scripts` | Deployment, validation, recovery, observability, and launch gate tooling |

The API Worker is the public data plane. Provider credentials stay behind the private `provider-control` service binding. Neon is the authoritative data store, while Cloudflare bindings handle edge protocol state, queues, and encrypted webhook payloads.

## Requirements

You need:

* [Bun](https://bun.sh/) 1.3.14
* Node.js 20 or newer for supporting tools
* [Wrangler](https://developers.cloudflare.com/workers/wrangler/) through the pinned workspace dependency
* [OpenTofu](https://opentofu.org/) for infrastructure validation
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

Run the normal checks before opening a pull request:

```sh
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

The complete infrastructure and deployment validation set is:

```sh
bun run validate:infra
bun run manifests:validate
bun run infra:validate
bun run observability:validate
bun run launch:gate
bun run release:public-api
```

Install the pinned browser once before the first full test run:

```sh
bun x playwright install --with-deps chromium
```

Tests intentionally exercise production shaped boundaries. Worker tests run in the Cloudflare runtime, browser tests use a production Next.js build, and database tests apply real migrations with production RLS policies. Test composition roots must never become selectable from a production build.

For focused work, use Turbo filters or workspace commands:

```sh
bun run test --filter=@whatsapp-mcp/api
bun run typecheck --filter=@whatsapp-mcp/web
bun run --cwd packages/db test
```

## Database changes

Database code and migrations live in `packages/db`. Set the environment described in `docs/configuration.md`, then use:

```sh
bun run db:check
bun run db:migrate
```

Treat migration changes as security sensitive. Preserve tenant foreign keys, runtime role grants, fixed search paths, RLS policies, deletion behavior, and restore behavior. Tests must exercise the actual production migration path.

## Architecture and operations

Start with these documents:

* [`CONTEXT.md`](CONTEXT.md) defines the product language and invariants.
* [`docs/architecture.md`](docs/architecture.md) maps the production boundaries and primary data flows.
* [`docs/mcp-contract.md`](docs/mcp-contract.md) defines MCP tools, resources, authorization, errors, and pagination.
* [`docs/configuration.md`](docs/configuration.md) lists runtime configuration and secret ownership.
* [`docs/testing.md`](docs/testing.md) explains the public boundary test strategy.
* [`docs/wasender-seam.md`](docs/wasender-seam.md) defines the provider boundary.
* [`docs/stored-media-container.md`](docs/stored-media-container.md) describes encrypted Stored Media.
* [`docs/adr`](docs/adr) records architectural decisions.
* [`docs/runbooks`](docs/runbooks) contains deployment, incident, recovery, security, and teardown procedures.

The most important rules are simple:

* Use the terms in `CONTEXT.md` in code, tests, and docs.
* Keep provider details behind `packages/wasender` and `apps/provider-control`.
* Fail closed when identity, authorization, audit, quota, encryption, or configuration is unavailable.
* Never retry an outbound send when provider acceptance is ambiguous.
* Keep logs and telemetry free of message content, credentials, full phone numbers, provider identifiers, and tenant identifiers unless an approved contract explicitly allows them.
* Make deletion and restore behavior explicit for every new persisted record.

## Deployment

Development, preview, and production have separate configuration and infrastructure authority. Do not deploy by improvising commands from local manifests.

Follow [`docs/runbooks/deployment.md`](docs/runbooks/deployment.md), validate the rendered manifests, and run the deployment smoke checks after a release. Production recovery, key rotation, replay, break glass access, and environment teardown each have dedicated runbooks under `docs/runbooks`.

## Sandcastle

Sandcastle can run issue agents in isolated Docker worktrees. After authenticating Docker, GitHub CLI, and Codex:

```sh
bun run sandcastle:build-image
bun run sandcastle
```

Agent specific issue and triage guidance lives in `docs/agents`.
