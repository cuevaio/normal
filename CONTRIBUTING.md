# Contributing

Thanks for helping improve Normal. This project handles private communications, so small changes can affect authorization, retention, deletion, and recovery. A good contribution is focused, tested at the right boundary, and clear about its security and data lifecycle impact.

## Before you start

For a bug fix or a small documentation improvement, you can usually start with an issue or a focused change.

For a new feature, public contract change, database design change, or infrastructure change, open an issue first. Describe the user problem and the constraints before investing in an implementation. This gives maintainers a chance to confirm the direction and point you to the relevant architecture decisions.

Do not open a public issue for a security vulnerability. Use [GitHub private vulnerability reporting](https://github.com/cuevaio/normal/security/advisories/new) instead.

## Understand the project

Read these before changing code:

1. [`CONTEXT.md`](CONTEXT.md) for the product language and domain invariants.
2. [`AGENTS.md`](AGENTS.md) for architecture, privacy, testing, and workflow rules.
3. The relevant ADRs under [`docs/adr`](docs/adr).
4. The relevant contract or runbook under [`docs`](docs).

Use the exact domain terms from `CONTEXT.md`. For example, use Personal Account instead of workspace, WhatsApp Connection instead of provider session, and MCP Client instead of integration.

## Set up the repo

You need Bun 1.3.14, OpenTofu, and Chromium for the complete verification suite.

```sh
git clone https://github.com/cuevaio/normal.git
cd normal
bun install --frozen-lockfile
bun x playwright install --with-deps chromium
```

Copy only the environment examples needed for the app you are running:

```sh
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/provider-control/.dev.vars.example apps/provider-control/.dev.vars
cp apps/web/.env.example apps/web/.env.local
```

Never commit local environment files or real credentials. The test suite does not need production data, a real Clerk tenant, a Provider Account, or a Provider API Credential.

Start the main development apps with:

```sh
bun run dev
```

See [`README.md`](README.md) and [`docs/configuration.md`](docs/configuration.md) for more setup details.

## Make a focused change

Create a branch from the latest `main` and keep each pull request focused on one problem.

```sh
git switch main
git pull --ff-only
git switch -c your-name/short-description
```

While working:

* Follow the existing Effect composition and error patterns.
* Parse untrusted data at the boundary with the existing schemas.
* Preserve authorization, RLS, audit, quota, encryption, deletion, and restore behavior.
* Keep provider specific behavior behind `packages/whatsapp-provider` and `apps/provider-control`.
* Keep production and test composition roots separate.
* Never log message content, credentials, tokens, full phone numbers, provider payloads, or tenant identifiers.
* Do not add a dependency when the existing stack can solve the problem clearly.
* Update contracts, docs, ADRs, and runbooks when their behavior changes.

If you change the Next.js app, read the relevant guide in `node_modules/next/dist/docs` before writing code. This repo uses a version with breaking changes that may differ from familiar Next.js conventions.

## Test your change

Run focused tests during development. Examples:

```sh
bun run --cwd packages/domain test
bun run test --filter=@whatsapp-mcp/api
bun run typecheck --filter=@whatsapp-mcp/web
```

Before opening a pull request, run the checks relevant to your change. The normal repository suite is:

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

Tests should prove behavior at the highest practical boundary:

* Use package tests for pure domain rules.
* Use the Cloudflare Vitest runtime for Worker behavior.
* Use migrated Postgres with production RLS for database behavior.
* Use Playwright against the production built web app for browser behavior.

Do not weaken a check or introduce a production selectable test path to make a test pass.

## Database and infrastructure changes

Treat migrations and infrastructure as security sensitive.

Database changes must use versioned migrations in `packages/db`. Preserve RLS, tenant foreign keys, fixed search paths, runtime role separation, retention rules, and restore behavior. Test the real migration path.

Infrastructure changes must preserve separate development, preview, and production state and authority. Run the relevant OpenTofu and deployment manifest checks. Follow the matching runbook before changing deployment, recovery, replay, key rotation, break glass access, or teardown behavior.

Do not commit Terraform plan files, state, generated bundles, local secrets, or tool caches.

## Open a pull request

Your pull request should explain:

* the problem being solved
* the approach and important tradeoffs
* security, privacy, retention, deletion, and restore impact
* user visible or contract changes
* the checks you ran
* the related issue, if one exists

Keep unrelated refactors out of the same pull request. Add screenshots for visible UI changes and include migration or rollout notes when deployment order matters.

Maintainers may ask for additional boundary tests or an ADR when a change creates a lasting architectural decision.
