# Deployment and rollback

## Prerequisites

- Bun 1.3.14
- OpenTofu 1.12.5
- An authenticated Vercel CLI
- A Cloudflare account and zone with Workers enabled for each authority scope
- A Neon organization with a plan that supports a seven-day history window
- An AWS account with permission to manage OpenTofu state, CloudFormation, KMS,
  and named IAM roles in `us-east-1`
- A Vercel team for each authority scope
- A separate Clerk instance or satellite domain for each authority scope, with
  its publishable key and custom-JWT PEM public key available to the deployer
- Approved API, recovery-control, web, and documentation custom domains
- An encrypted, versioned S3 remote-state bucket and KMS key in `us-east-1`
  for each environment
- Short-lived `NEON_API_KEY`, `CLOUDFLARE_API_TOKEN`, `VERCEL_API_TOKEN`, and
  AWS credentials for exactly the environment being changed
- A Wasender account with approved session capacity and an account-level
  Personal Access Token for each environment

No Clerk tenant or Wasender account is required to build and verify the
source-controlled platform. A real Directory smoke check additionally requires
one vendor-approved Wasender account and one connected non-production WhatsApp
Connection whose session API key is stored through the normal envelope-
encrypted connection-authority path. Exercising the real text-send adapter also
requires a designated test recipient for that connection. Never substitute the
account-level PAT for per-session authority, commit either credential, or add a
production-selectable fake. Provider-control requires its environment's
Wasender Personal Access Token and stable reference secret, while the API
requires its environment-specific AWS KMS stack and short-lived
`ContentRuntimeRole` credentials before either production composition root
becomes healthy.

Production authority must not be available to development or preview jobs.
Use a separate production Cloudflare account and Vercel team, and a separate
production state role and KMS key. Development and preview may use distinct
non-production accounts/teams or separate credentials within a non-production
authority boundary, but their identities must be unable to assume the
production roles or read production CI secrets.

## Initial production deployment

Use one change record and one reviewed commit for the entire release. The
ordered path is **infrastructure → environment population → migration →
provider-control → deletion coordinator → restore coordinator → recovery control
→ API → web → docs → smoke check**. The deployer may stop between
steps, but must not reorder them or serve traffic from a partially compatible
set.

1. Complete [Prerequisites](#prerequisites), including the written external
   rollout gates. External account, billing, domain, DNS, and vendor approvals
   are the only interactive gates; record their approval references without
   credentials or tenant data.
2. [Bootstrap remote state](#bootstrap-remote-state), run [Verify](#verify),
   then create and inspect the saved infrastructure plans.
3. Apply Neon, Hyperdrive, KMS, R2, Queue, KV, Worker-shell, route, and Vercel
   declarations. Do not populate a secret into a plan or state file.
4. Populate every value in [deployment configuration](../configuration.md)
   through its named secret store and validate secret names, bindings, and
   least-privilege roles. Production has no selectable test Layer or fake.
5. Run `bun run db:migrate` followed by `bun run db:check` with the direct
   migration-owner connection, then remove that connection from the shell.
6. Deploy in dependency order: **provider-control → deletion coordinator → restore
   coordinator → recovery control → API → web → docs**. Keep public
   traffic closed if migration readiness or any private service binding fails.
7. Run the non-interactive `bun run deploy:smoke` boundary and retain only its
   normalized results, reviewed commit, deployment versions, plan digest, and
   timestamps as release evidence.

Promotion is complete only when readiness identifies the expected schema and
Neon branch, the smoke check succeeds, Queue consumers and schedules are
healthy, provider-control has no public route, and the observability canary is
delivered. Otherwise follow [Partial deployment](incident-response.md#partial-deployment).

## Bootstrap remote state

Remote state is an operator-owned prerequisite because a stack cannot safely
create the backend that stores its own state. For each environment:

1. Create an S3 bucket in `us-east-1` with all public access blocked, versioning
   enabled, TLS-only access, and default SSE-KMS using that environment's
   dedicated state key. Enable automatic KMS key rotation.
2. Record S3 object-level data events in CloudTrail and alert on denied access,
   public-policy changes, versioning changes, key-policy changes, and deletion.
3. Create one workload role for the environment. Limit `s3:ListBucket` to its
   key prefix; limit `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` to
   its exact state and `.tflock` objects; limit `kms:Encrypt`, `kms:Decrypt`,
   `kms:GenerateDataKey`, and `kms:DescribeKey` to its state key.
4. Explicitly deny development and preview principals access to the production
   state prefix and KMS key. Restrict production role assumption to the
    protected production deployment identity and audited break-glass operators.
5. Copy the matching file under `infra/compute/backends/` outside the
   repository, replace its bucket and KMS key placeholders, and keep the
   resulting backend file out of source control.

The checked-in backend enables S3 conditional-write locking and server-side
encryption. Bucket policy must require the declared KMS key rather than
accepting S3-managed encryption. Review state-role access quarterly and after
every incident or operator departure. Treat state, saved plans, crash logs, and
provider debug logs as sensitive operational artifacts. The compute state has
no application secrets, but the production database state contains generated
database passwords and must receive the same protections.

## Verify

```sh
bun install --frozen-lockfile
bun x playwright install --with-deps chromium
bun run format:check
bun run lint
bun run typecheck
bun run validate:infra
bun run test
bun run build
bun run manifests:validate
bun run infra:validate
```

`bun run build` performs Wrangler dry-run production bundles for every Worker,
builds the Next.js application, and rejects any production output or source map
containing a test Layer, controlled credential, fixture secret, or fault
injector. Findings identify only the artifact path and never print matched
plaintext.
`bun run test` includes the production-built Playwright browser-to-API journey,
the Cloudflare fetch, OAuth/MCP, protected-resource, binding, Queue, and
scheduled-handler harnesses, and the production-migration restricted-role
checks described in `docs/testing.md`.
Manifest validation dry-runs development, preview, and production.
Infrastructure validation checks formatting and provider schemas, then runs
mocked OpenTofu plans for all environments. Mock providers exist only in
`topology.tftest.hcl`; no production input can select them.

## Plan and apply

Set the environment for this operator session. The examples below use
`production`; substitute `development` or `preview` consistently.

```sh
export DEPLOYMENT_ENVIRONMENT=production
export TFVARS_PATH=/secure/operator/production.tfvars
export BACKEND_CONFIG_PATH=/secure/operator/production.s3.tfbackend
export CLOUDFLARE_API_TOKEN=...
export VERCEL_API_TOKEN=...
```

Authenticate to AWS with the matching short-lived state role, then initialize
and build the deployable artifacts:

```sh
tofu -chdir=infra/compute init \
  -reconfigure \
  -backend-config="$BACKEND_CONFIG_PATH"
bun run build
```

Populate `api_hyperdrive_id` and `webhook_hyperdrive_id` in the protected
compute `.tfvars` from the matching `infra/production` outputs. They must be
distinct and from the same environment. The compute plan binds them as
`HYPERDRIVE` and `WEBHOOK_HYPERDRIVE`; no post-deployment dashboard edit is
permitted.

For a new environment only, create the Worker shells before the full plan so
Cloudflare has targets for their version-scoped secrets. Review and apply this
bootstrap target; it contains no Worker version or secret value:

```sh
tofu -chdir=infra/compute plan \
  -target=cloudflare_worker.provider_control \
  -target=cloudflare_worker.deletion_coordinator \
  -target=cloudflare_worker.restore_coordinator \
  -target=cloudflare_worker.recovery_control \
  -target=cloudflare_worker.api \
  -var-file="$TFVARS_PATH" \
  -out="$DEPLOYMENT_ENVIRONMENT-worker-shell-bootstrap.tfplan"
tofu -chdir=infra/compute show \
  "$DEPLOYMENT_ENVIRONMENT-worker-shell-bootstrap.tfplan"
tofu -chdir=infra/compute apply \
  "$DEPLOYMENT_ENVIRONMENT-worker-shell-bootstrap.tfplan"
```

Generate the 32-byte locator key inside the approved recovery inventory, where
it can remain stable for the environment. Load that value and the account-level
Personal Access Token without echoing either one, then create both required
bindings atomically. The pipe does not put either plaintext value in a file,
saved plan, or OpenTofu state:

```sh
read -rsp "WASENDER_REFERENCE_SECRET: " WASENDER_REFERENCE_SECRET
echo
read -rsp "WASENDER_API_CREDENTIAL: " WASENDER_API_CREDENTIAL
echo
export WASENDER_REFERENCE_SECRET WASENDER_API_CREDENTIAL
bun -e 'process.stdout.write(JSON.stringify({
  WASENDER_API_CREDENTIAL: process.env.WASENDER_API_CREDENTIAL,
  WASENDER_REFERENCE_SECRET: process.env.WASENDER_REFERENCE_SECRET,
}))' | wrangler secret bulk \
  --cwd apps/provider-control \
  --env "$DEPLOYMENT_ENVIRONMENT"
wrangler secret list \
  --cwd apps/provider-control \
  --env "$DEPLOYMENT_ENVIRONMENT"
unset WASENDER_REFERENCE_SECRET WASENDER_API_CREDENTIAL
```

The secret list must contain exactly the two names; it never returns their
values. Delete the bootstrap plan after the Worker shell and bindings exist.
For an existing environment where the list already contains both names, skip
the bootstrap target and bulk upload.

Populate recovery control only after the project-scoped Neon key, exact project
and parent branch, independent control token, and separate evidence authority
are available. Bulk upload exactly `NEON_RECOVERY_API_KEY`, `NEON_PROJECT_ID`,
`NEON_PARENT_BRANCH_ID`, `RECOVERY_CONTROL_TOKEN`, `RECOVERY_EVIDENCE_URL`,
`RECOVERY_EVIDENCE_TOKEN`, `DELETION_MARKER_HMAC_SECRET`, and
`RECIPIENT_TRANSITION_HMAC_SECRET` to the recovery-control Worker. It receives
only the locked marker and transition R2 bindings, its serialization Durable
Object, and its Workflow. Never add `MIGRATION_DATABASE_URL`, Stored Media,
Webhook Ingress, API/Clerk/provider credentials, KMS, KV, Queue, Hyperdrive, or
ordinary runtime authority. Set the protected `production-recovery`
`RECOVERY_AUTOMATION_URL` to the `recovery_control_origin` output and its token
to the same `RECOVERY_CONTROL_TOKEN`. Missing verifier/monitoring authority must
leave drills failing closed.

In the same environment's Clerk dashboard, create the `whatsapp-api` custom JWT
template with a 60-second lifetime and only an `aud` claim whose value is the
exact `https://<api_hostname>` origin. Record the exact issuer and publishable
key in the protected `.tfvars` file as `clerk_issuer` and
`clerk_publishable_key`. The browser configuration fixes the template name as
`whatsapp-api`. Set the Clerk session token custom claims to the same `aud`
value so consent approval carries the session-bound `fva` claim. Record the
approved authoritative MCP request limits as the required positive integers
`mcp_requests_per_minute` and `mcp_requests_per_hour`; there are no defaults,
and the hour value must be at least the minute value. Record reviewed positive
`sends_per_minute` and `sends_per_day` limits as well. Copy the template's PEM
public key without changing its line breaks. Load it and a separately generated
32-byte OAuth protocol-encryption key into the API Worker shell:

```sh
wrangler secret put CLERK_JWT_KEY \
  --cwd apps/api \
  --env "$DEPLOYMENT_ENVIRONMENT"
openssl rand -hex 32 | wrangler secret put OAUTH_PROTOCOL_ENCRYPTION_KEY \
  --cwd apps/api \
  --env "$DEPLOYMENT_ENVIRONMENT"
openssl rand -hex 32 | wrangler secret put MCP_CURSOR_HMAC_SECRET \
  --cwd apps/api \
  --env "$DEPLOYMENT_ENVIRONMENT"
openssl rand -hex 32 | wrangler secret put API_KEY_HMAC_SECRET \
  --cwd apps/api \
  --env "$DEPLOYMENT_ENVIRONMENT"
openssl rand -hex 32 | wrangler secret put SEND_FINGERPRINT_HMAC_SECRET \
  --cwd apps/api \
  --env "$DEPLOYMENT_ENVIRONMENT"
wrangler secret list \
  --cwd apps/api \
  --env "$DEPLOYMENT_ENVIRONMENT"
```

The API list must include `CLERK_JWT_KEY`, `OAUTH_PROTOCOL_ENCRYPTION_KEY`,
`MCP_CURSOR_HMAC_SECRET`, `API_KEY_HMAC_SECRET`, `SEND_FINGERPRINT_HMAC_SECRET`,
`CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`, the three short-lived AWS
session credential names, both KMS key ARN names, `DELETION_MARKER_HMAC_SECRET`,
and `WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET`; values are never printed. Keeping
the public verification key in the secret store prevents unreviewed copying
into source, browser bundles, plans, or state. Apply this external Clerk
dashboard gate independently in development, preview, and production. The
exact JWT audience must match `CLERK_API_AUDIENCE`, and Clerk's standard `azp`
must match `CLERK_AUTHORIZED_PARTY`; a mismatch intentionally makes bootstrap
unavailable.

Now create and inspect the complete saved plan:

```sh
tofu -chdir=infra/compute plan \
  -var-file="$TFVARS_PATH" \
  -out="$DEPLOYMENT_ENVIRONMENT.tfplan"
tofu -chdir=infra/compute show "$DEPLOYMENT_ENVIRONMENT.tfplan"
```

Confirm that the plan contains exactly one Vercel web project/domain, one
static Vercel docs project/domain with no runtime environment values, a public
API Worker/custom domain, one private provider-control Worker, disabled
`workers.dev` and preview URLs for both Workers, and an API-to-provider-control
service binding. The API version must inherit `CLERK_JWT_KEY` and the OAuth
protocol-encryption key, and receive exact Clerk audience, authorized-party,
OAuth issuer/resource, reviewed client-registry, and
`MCP_REQUESTS_PER_MINUTE` and `MCP_REQUESTS_PER_HOUR` text bindings;
provider-control must receive none of them. The Vercel project must
receive the public Clerk key, API and web origins, and deployment
environment. Optional `NEXT_PUBLIC_POSTHOG_KEY` and
`NEXT_PUBLIC_POSTHOG_HOST` are added only when both OpenTofu PostHog
inputs are set. It must also contain
four private R2 buckets with disabled
managed domains, the seven-day Webhook Event lifecycle, the isolated Deletion
Capsule bucket with destroy protection, the indefinite deletion-marker lock,
one OAuth KV namespace, an ingestion Queue and active DLQ, the two Queue
consumers, and the three API schedules. Provider-control must have no R2, KV, or
Queue binding. Apply the reviewed plan:

```sh
tofu -chdir=infra/compute apply "$DEPLOYMENT_ENVIRONMENT.tfplan"
```

Delete the local saved plan after a successful apply. If applying fails, retain
it only in encrypted, access-controlled incident storage until reconciliation
is complete.

If Vercel reports that the web or docs domain needs DNS verification, retrieve the
exact current record instead of guessing a shared CNAME:

```sh
WEB_HOSTNAME="$(tofu -chdir=infra/compute output -raw web_hostname)"
VERCEL_PROJECT_ID="$(tofu -chdir=infra/compute output -raw vercel_project_id)"
vercel domains verify "$WEB_HOSTNAME" --project "$VERCEL_PROJECT_ID"
DOCS_HOSTNAME="$(tofu -chdir=infra/compute output -raw docs_hostname)"
VERCEL_DOCS_PROJECT_ID="$(tofu -chdir=infra/compute output -raw vercel_docs_project_id)"
vercel domains verify "$DOCS_HOSTNAME" --project "$VERCEL_DOCS_PROJECT_ID"
```

Add the reported record in the environment's Cloudflare zone, wait for DNS
approval, and repeat the verification command. This is an external DNS
ownership gate; it requires no source or state substitution.

## Provision Neon and Hyperdrive

Copy `infra/production/production.tfvars.example` outside the repository or to
an ignored filename, replace its placeholders, and initialize the encrypted
remote backend. Backend values are intentionally not committed:

```sh
tofu -chdir=infra/production init \
  -backend-config="bucket=replace-with-state-bucket" \
  -backend-config="key=whatsapp-mcp/production.tfstate" \
  -backend-config="region=us-east-1"
tofu -chdir=infra/production plan \
  -var-file=/secure/path/production.tfvars \
  -out=/secure/path/production.tfplan
tofu -chdir=infra/production apply /secure/path/production.tfplan
```

The plan creates one protected Neon project in `aws-us-east-1`, configures
604,800 seconds (seven days) of history, creates separate API and webhook
runtime roles, and creates non-caching TLS Hyperdrive configurations. Neon
control-plane roles initially inherit `neon_superuser`; migration 0001 revokes
that membership and enforces `NOSUPERUSER`, `NOBYPASSRLS`, and the remaining
restricted attributes before the schema can report ready.

Databases that already applied all 40 pre-Drizzle migrations need this one-time
ledger transition before the first `db:migrate` run from this release. Verify
that the legacy ledger contains exactly versions 1 through 40, then run the
following as the migration owner. Do not run it on a new or partially migrated
database.

```sql
BEGIN;

DO $transition$
BEGIN
  IF (
    SELECT count(*) <> 40 OR min(version) <> 1 OR max(version) <> 40
    FROM app_private.schema_migrations
  ) THEN
    RAISE EXCEPTION 'legacy migration ledger is not complete';
  END IF;
END
$transition$;

CREATE TABLE public.drizzle_migrations (
  id serial PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);

INSERT INTO public.drizzle_migrations (hash, created_at)
VALUES (
  '20063ae83cd8d6a8e5849c7f5e7956644aba347643d0608e16dd1711fc132e75',
  1785787776687
);

GRANT SELECT ON public.drizzle_migrations
  TO whatsapp_api_runtime, whatsapp_webhook_runtime,
     whatsapp_deletion_runtime, whatsapp_restore_runtime;

COMMIT;
```

Retain the legacy `app_private.schema_migrations` table as immutable deployment
evidence. Subsequent releases use only the Drizzle ledger and require no
transition step.

Run migrations directly as the database owner, never through Hyperdrive:

```sh
export MIGRATION_DATABASE_URL="$(
  tofu -chdir=infra/production output -raw migration_database_url
)"
bun run db:migrate
bun run db:check
unset MIGRATION_DATABASE_URL
```

Migration execution uses `drizzle-kit migrate` with `packages/db/drizzle.config.ts`.
Drizzle applies pending migrations in a transaction and records their hashes in
`public.drizzle_migrations`. An interrupted migration rolls back; rerun
`bun run db:migrate` after correcting the cause. Never edit an applied
migration - add a new forward migration. The baseline includes the
RLS-protected refresh-credential ledger and least-privilege API-role functions;
future schema changes must be generated as forward Drizzle migrations.
Apply all pending migrations immediately before the matching API Worker
version. The previous Worker and the new Worker intentionally fail readiness
on the other's exact schema version, so complete this step as one controlled
fail-closed deployment.

## Provision encryption authority

Use a dedicated, versioned, non-public S3 bucket for OpenTofu state. Restrict
bucket and object access to the infrastructure deployment authority, retain
default encryption, and do not use either application KMS key to encrypt this
bootstrap state. Native S3 lock files prevent concurrent state changes.

Initialize and deploy one stack per environment. Use five distinct bootstrap
principals for the KMS administrator, API content runtime, deletion coordinator,
provider-control, and ordinary operator variables. Both OpenTofu and
CloudFormation reject a repeated principal.

```sh
tofu -chdir=infra/aws init \
  -backend-config="bucket=replace-with-infrastructure-state-bucket" \
  -backend-config="key=whatsapp-mcp/production/kms.tfstate" \
  -backend-config="region=us-east-1"

tofu -chdir=infra/aws plan \
  -out=kms.tfplan \
  -var="deployment_environment=production" \
  -var="kms_administrator_assumer_arn=arn:aws:iam::111122223333:role/replace-kms-admin-bootstrap" \
  -var="content_runtime_assumer_arn=arn:aws:iam::111122223333:role/replace-api-workload-bootstrap" \
  -var="deletion_coordinator_assumer_arn=arn:aws:iam::111122223333:role/replace-deletion-bootstrap" \
  -var="provider_control_assumer_arn=arn:aws:iam::111122223333:role/replace-provider-bootstrap" \
  -var="ordinary_operator_assumer_arn=arn:aws:iam::111122223333:role/replace-human-operator-bootstrap" \
  -var="break_glass_assumer_arn=arn:aws:iam::111122223333:role/replace-incident-credential-broker"

tofu -chdir=infra/aws apply kms.tfplan
```

Record the `content_root_key_arn`, `content_runtime_role_arn`,
`deletion_coordinator_key_arn`, and `deletion_coordinator_role_arn` OpenTofu
outputs in the environment's deployment inventory. Configure
`KMS_CONTENT_ROOT_KEY_ARN` from `content_root_key_arn` and
`KMS_DELETION_COORDINATOR_KEY_ARN` from `deletion_coordinator_key_arn`; the API
root rejects equal values. The content key and Deletion Capsule key are retained
if a stack is deleted or replaced; never schedule their deletion as part of
ordinary rollback. The owning AWS account principal retains key-policy recovery
authority for lifecycle and policy operations only; that statement grants no
cryptographic operation.

The API credential broker must assume only `ContentRuntimeRole` and continuously
rotate its short-lived access key, secret, and session token in the Cloudflare
secret store before expiration. Production uses the GitHub OIDC broker declared
by `infra/aws/content-credential-broker.template.json`. Its trust is restricted
to this repository's immutable organization and repository IDs plus its
protected `production` environment, and its only authority is `sts:AssumeRole`
for the exact production `ContentRuntimeRole`. The scheduled
`rotate-production-content-credentials.yml` workflow refreshes the three API
Worker secrets every 20 minutes; the deployment workflow performs the same
rotation immediately before publishing the API.

Deploy the broker stack, then update the production KMS stack's
`ContentRuntimeAssumerArn` parameter to the broker role ARN. Store that ARN as
the protected GitHub environment variable
`AWS_CONTENT_CREDENTIAL_BROKER_ROLE_ARN`, and store the production runtime role
ARN as `AWS_CONTENT_RUNTIME_ROLE_ARN`. Run the rotation workflow manually and
verify the three secret names before relying on its schedule. The broker retains
the reviewed emergency assumer in its trust policy for incident recovery, but
neither authority receives content permissions directly.

Production MCP smoke uses the separate
`infra/aws/mcp-smoke-credential.template.json` stack. Deploy it with the
existing GitHub OIDC provider ARN and a distinct emergency recovery assumer,
then store its outputs as protected environment variables
`AWS_MCP_SMOKE_CREDENTIAL_ROLE_ARN` and `MCP_SMOKE_REFRESH_SECRET_ID` in both
`production` and `production-launch-gate`. Store the reviewed public client ID
as `MCP_SMOKE_CLIENT_ID`. The role trusts only those two exact environment
subjects and can only describe, read, and create a version of that one secret.

Do not give Cloudflare the administrator, deletion coordinator,
provider-control, or ordinary operator credentials. Never print the assumed
credentials or store them in GitHub secrets, repository files, workflow
artifacts, or shell history.

Generate the deletion-marker HMAC once per environment, store it only as the
`DELETION_MARKER_HMAC_SECRET` Worker secret and in the encrypted recovery
inventory, and do not rotate it without a marker-rekey recovery design:

```sh
openssl rand -hex 32 | wrangler secret put DELETION_MARKER_HMAC_SECRET \
  --cwd apps/api --env production
```

This secret is unrelated to KMS, provider-reference, webhook, cursor, and
idempotency keys. Losing it prevents deterministic creation of a later marker
for the same opaque identifier; exposing it weakens marker-key privacy.

Generate the WhatsApp Number reservation HMAC independently and store it only
as the API Worker secret:

```sh
openssl rand -hex 32 | \
  wrangler secret put WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET \
  --cwd apps/api --env production
```

Do not reuse the deletion-marker, provider-reference, OAuth, webhook, cursor,
content, or future Directory-index key. Keep this value stable while any
Connection Setup or WhatsApp Connection reservation exists. Rotation requires
stopping provisioning and transactionally rebuilding all retained reservation
tokens before the old key is removed.

Generate the MCP pagination cursor HMAC independently and store it only as the
API Worker secret:

```sh
openssl rand -hex 32 | wrangler secret put MCP_CURSOR_HMAC_SECRET \
  --cwd apps/api --env production
openssl rand -hex 32 | wrangler secret put API_KEY_HMAC_SECRET \
  --cwd apps/api --env production
```

Do not reuse any OAuth, content, provider-reference, webhook, reservation, or
deletion key. Cursor rotation is safe but invalidates every outstanding cursor; MCP
Clients restart the affected listing from its first page.

AWS KMS records cryptographic operations in CloudTrail. Encryption context is
non-secret audit data and is limited here to environment, purpose, opaque
Personal Account or deletion-marker identity, and key version. Alert on denied
decrypts, disabled keys, scheduled deletion, policy changes, and rotation being
disabled. Never copy key plaintext, application plaintext, data-key envelopes,
or ciphertext into application logs or incident tickets.

The API Stored Media binding must support R2 multipart uploads in addition to
read, write, and delete. The production root fails closed when this capability,
the R2 binding, or KMS authority is missing. Before promotion, run the API
Stored Media container suite and the deployment checks:

```sh
bun run --cwd apps/api test -- stored-media-container.test.ts
bun run manifests:validate
bun run infra:validate
```

The suite writes through the Workers R2 test binding and proves authenticated
round trips plus rejection of truncation, reordering, bit changes, trailing
bytes, wrong Personal Account, wrong WhatsApp Connection, wrong Stored Media
object, wrong key version, and unsupported container versions. It also verifies
that R2 HTTP and custom metadata remain empty.

Alert on repeated `stored-media.container.completed` events with
`authentication-failed` or `storage-failed`. Those events contain only the
operation, normalized outcome, format version, authenticated chunk count, and
processed plaintext byte count; do not enrich them with object keys, tenant or
connection identifiers, media metadata, key material, plaintext, ciphertext,
or nonces. Treat an authentication failure or missing primary R2 object as
unavailable Stored Media, never return a verified prefix, and transition the
authoritative Stored Media record to `failed` through its owning workflow.

## Deploy

OpenTofu uploads both Worker bundles and orders provider-control before the API
through the service-binding dependency. It also creates the isolated Vercel web
and static docs projects and their custom domains, but application deployment
to Vercel remains an explicit side effect. The docs project publishes `dist`
from the pinned Bun workspace build and must not receive a runtime secret. For production, replace the initial API version with the
database-enabled build after Hyperdrive exists. Obtain identifiers from state
without printing any secret:

```sh
export CLOUDFLARE_HYPERDRIVE_ID="$(
  tofu -chdir=infra/production output -raw api_hyperdrive_id
)"
export NEON_BRANCH_ID="br_replace_with_exact_neon_branch_id"
export CLOUDFLARE_WEBHOOK_HYPERDRIVE_ID="$(
  tofu -chdir=infra/production output -raw webhook_hyperdrive_id
)"
export CLOUDFLARE_OAUTH_KV_ID="$(
  tofu -chdir=infra/compute output -raw oauth_kv_namespace_id
)"
export CLERK_API_AUDIENCE="$(tofu -chdir=infra/compute output -raw api_origin)"
export CLERK_AUTHORIZED_PARTY="$(tofu -chdir=infra/compute output -raw web_origin)"
export CLERK_ISSUER="$(sed -n 's/^[[:space:]]*clerk_issuer[[:space:]]*=[[:space:]]*\"\\([^\"]*\\)\"[[:space:]]*$/\\1/p' "$TFVARS_PATH")"
export OAUTH_ISSUER="$CLERK_API_AUDIENCE"
export OAUTH_RESOURCE="$OAUTH_ISSUER/mcp"
export MCP_REQUESTS_PER_MINUTE="$(sed -n 's/^[[:space:]]*mcp_requests_per_minute[[:space:]]*=[[:space:]]*\\([0-9][0-9]*\\)[[:space:]]*$/\\1/p' "$TFVARS_PATH")"
export MCP_REQUESTS_PER_HOUR="$(sed -n 's/^[[:space:]]*mcp_requests_per_hour[[:space:]]*=[[:space:]]*\\([0-9][0-9]*\\)[[:space:]]*$/\\1/p' "$TFVARS_PATH")"
export SENDS_PER_MINUTE="$(sed -n 's/^[[:space:]]*sends_per_minute[[:space:]]*=[[:space:]]*\\([0-9][0-9]*\\)[[:space:]]*$/\\1/p' "$TFVARS_PATH")"
export SENDS_PER_DAY="$(sed -n 's/^[[:space:]]*sends_per_day[[:space:]]*=[[:space:]]*\\([0-9][0-9]*\\)[[:space:]]*$/\\1/p' "$TFVARS_PATH")"
bun scripts/render-api-wrangler.ts \
  apps/api/.wrangler/production.jsonc \
  "$DEPLOYMENT_ENVIRONMENT"
CI=true bun run --cwd apps/api wrangler deploy \
  --config .wrangler/production.jsonc \
  --env "$DEPLOYMENT_ENVIRONMENT"
unset CLOUDFLARE_HYPERDRIVE_ID CLOUDFLARE_OAUTH_KV_ID NEON_BRANCH_ID \
  CLOUDFLARE_WEBHOOK_HYPERDRIVE_ID CLERK_API_AUDIENCE \
  CLERK_AUTHORIZED_PARTY CLERK_ISSUER \
  MCP_REQUESTS_PER_HOUR MCP_REQUESTS_PER_MINUTE OAUTH_ISSUER OAUTH_RESOURCE \
  SENDS_PER_DAY SENDS_PER_MINUTE
export VERCEL_ORG_ID="$(tofu -chdir=infra/compute output -raw vercel_team_id)"
export VERCEL_PROJECT_ID="$(tofu -chdir=infra/compute output -raw vercel_project_id)"
vercel deploy --prod --yes --cwd apps/web
export VERCEL_PROJECT_ID="$(tofu -chdir=infra/compute output -raw vercel_docs_project_id)"
vercel deploy --prod --yes --cwd apps/docs
```

The dedicated Vercel web project always uses its Production deployment target; its
validated `DEPLOYMENT_ENVIRONMENT` value records whether the isolated project
represents development, preview, or production. `NEXT_PUBLIC_API_ORIGIN` is set
before the build and points to the same-environment Worker. The docs project is
a second Vercel project on the same-environment `docs_hostname`; production uses
`docs.normal.fast`. There is no Vercel rewrite or server-side API proxy in either
project, and the docs deployment has no Clerk, HMAC, or API origin runtime value. The rendered API config is mode `0600`,
ignored by Git, and fails generation unless both real 32-character Hyperdrive
identifiers and the current environment's real 32-character OAuth KV identifier
are present. The selected environment receives the same four R2 buckets, Queue
producer and consumers, DLQ, and schedules as the reviewed OpenTofu plan. The
Worker manifests set `AWS_KMS_REGION` explicitly. Set
`KMS_CONTENT_ROOT_KEY_ARN` and `KMS_DELETION_COORDINATOR_KEY_ARN` in the API
deployment configuration and populate the marker HMAC plus three AWS credential
secrets before deployment. `CLERK_JWT_KEY` and
`OAUTH_PROTOCOL_ENCRYPTION_KEY`, `MCP_CURSOR_HMAC_SECRET`,
`API_KEY_HMAC_SECRET`, and
`SEND_FINGERPRINT_HMAC_SECRET` must already exist
on the selected API Worker and are preserved as inherited secret bindings.
Rotating the cursor secret invalidates all outstanding pagination cursors but
does not require a data migration. Rendering fails unless the
Clerk audience, authorized party, Clerk issuer, OAuth issuer, exact MCP
resource, non-empty reviewed client registry, and provider-approved session
capacity and approved MCP minute and hour request quotas are valid.

Provider-control authority is populated during the first-deployment bootstrap
above, directly in Cloudflare's secret store. The Wrangler manifest declares
both names under `secrets.required`, so a subsequent Wrangler upload or deploy
fails before publishing code if the selected environment does not already have
both secrets. OpenTofu represents both names as `inherit` bindings, so every
subsequent provider-control version preserves the already stored ciphertext
without putting either plaintext value in input, a saved plan, or state. Run
the bootstrap against `development`, `preview`, and `production` independently;
never rely on one environment's secrets for another.

The credential must be the account-level Personal Access Token, never a
WhatsApp Connection's per-session API key. Provider-control has no public route,
and its Cloudflare deployment identity should be scoped only to that Worker so
the credential cannot enter the web or API deployments. Rotate only the
account-level credential with `wrangler secret put WASENDER_API_CREDENTIAL`
against the exact target environment, deploy provider-control, and verify its
private service-binding health before deploying the API. Never rotate
`WASENDER_REFERENCE_SECRET` directly; use the reconciliation procedure in
`docs/configuration.md` so retained provider sessions remain addressable.

## Smoke check

Create a dedicated approved MCP Authorization for deployment automation with
the minimum discovery scope needed by the release policy. During bootstrap,
complete consent once, capture the returned refresh credential without printing
it, and put it into the exact `MCP_SMOKE_REFRESH_SECRET_ID` through a reviewed
stdin or console operation. Never place it in a command argument, shell history,
OpenTofu input/state, GitHub secret, workflow output, log, or artifact. Store the
independently generated `SMOKE_CHECK_SECRET` in GitHub and the API Worker as
before. The deployment and launch-gate workflows assume the narrow smoke role
through GitHub OIDC and run the same command:

```sh
SMOKE_API_ORIGIN="$(tofu -chdir=infra/compute output -raw api_origin)" \
SMOKE_DOCS_ORIGIN="$(tofu -chdir=infra/compute output -raw docs_origin)" \
SMOKE_WEB_ORIGIN="$(tofu -chdir=infra/compute output -raw web_origin)" \
SMOKE_MCP_CLIENT_ID="$MCP_SMOKE_CLIENT_ID" \
SMOKE_MCP_REFRESH_SECRET_ID="$MCP_SMOKE_REFRESH_SECRET_ID" \
SMOKE_CHECK_SECRET="$DEPLOYMENT_SMOKE_CHECK_SECRET" \
bun run deploy:smoke
```

The command first reads the current refresh credential and proves durable write
authority by creating an equivalent secret version before contacting OAuth. It
then exchanges the one-time credential, persists the descendant, and only then
uses the ephemeral ten-minute access token for MCP smoke. Both workflows use
the `production` concurrency group, so only one production deployment, launch
gate, or credential rotation can operate at a time.

The command validates web and API health, the static docs origin serving the
generated OpenAPI document with reviewed security headers and no Scalar CDN or
request proxy, branch-bound schema and restore
readiness, OAuth metadata, authenticated MCP initialization and discovery, the
restricted Hyperdrive role, private provider-control safe-read reachability,
Queue publication and consumption, and an encrypted disposable R2/KMS round
trip. The docs, web, and API origins must stay distinct. The Queue consumer removes its object before reporting success; KV status
expires automatically. Output contains only safe subsystem or credential
outcomes. Re-run after an ordinary pre-exchange store or network failure. If
descendant persistence fails after exchange, do not retry the predecessor: it
may already be consumed. Revoke the affected MCP Authorization, complete fresh
consent, replace the secret through the bootstrap procedure, and rerun. An
`invalid or reused` outcome requires the same reauthorization and review of
CloudTrail plus `oauth.refresh.completed` outcome counts. Never inspect a secret
version or raw OAuth response as diagnostic evidence, and never print or pass
the access token, refresh credential, or smoke secret on a command line.

For planned rotation, create and bootstrap a new dedicated MCP Authorization,
replace the current secret once, verify one workflow run, then revoke the old
authorization. If the secret is deleted or its current version is unavailable,
recover it only from a descendant known not to have been presented; otherwise
reauthorize. The retained emergency assumer exists for this recovery procedure,
not for routine workflow execution.

Using the designated non-production approved MCP Client, complete consent for
one smoke-test WhatsApp Connection and `connections:read`, then initialize a
fresh MCP session against `$API_ORIGIN/mcp`. Confirm `tools/list` advertises
`list_connections`, a call returns that selected Connection through the exact
public fields, and a newly initialized session behaves identically. Repeat
discovery with an authorization that lacks `connections:read` and confirm the
tool is absent. Revoke the first authorization and confirm the next call is
denied even with its unexpired access token. Through the restricted API database
role, confirm each attempted invocation has one metadata-only Activity Log and
that successful invocations reserve request quota. Do not print or retain the
access token, OAuth subject, internal IDs, Connection fields, or log rows as
deployment evidence; retain only normalized counts and outcomes.

Repeat with `directory:read` for the same disposable Connection. Confirm
`tools/list` advertises `list_groups`, a three-character normalized prefix
search returns only currently joined groups in display-name/handle order, and
following `next_cursor` preserves that order. Reusing the cursor with another
authorization, Connection, search, or limit must return `invalid_cursor`.
Confirm the response contains freshness fields and no roster, description,
profile URL, provider identity, or routing value.

Verify one WhatsApp Recipient Exclusion end to end for the same disposable
Connection. In dashboard Settings, list contacts, exclude one recipient, and
confirm the response reports the new state. Confirm the locked
`whatsapp-mcp-recipient-transitions` bucket gained exactly one object under a
64-character hexadecimal prefix, that its body contains only version,
transition identity, desired state, effective time, and purge cutoff, and that
retrying the same request adds no second object. Confirm the excluded recipient
disappears from `list_contacts` or `list_groups`, that a previously observed
WhatsApp Conversation handle and media URI now fail as not found, and that
`send_text_message` returns `recipient_not_found`. Remove the exclusion and
confirm only future activity is permitted: the recipient reappears in the
Directory, and no previously purged message returns. Retain only normalized
outcomes; never record the recipient handle, locator, journal prefix, or any
message content as deployment evidence.

Sign in through the deployed web application with a designated smoke-test Clerk
User and bootstrap once. Confirm the browser sends `POST
/v1/personal-account/bootstrap` directly to `API_ORIGIN`, the UI reports
`Personal Account ready`, and a retry reports the same state without creating a
second account. Confirm the product states the three-Connection, 5 GB Stored
Media, and default 30-day Message Retention Policy values returned from Neon.
In a non-production environment, set capacity to exactly three, admit one
designated User, and verify a second Clerk-approved User receives transient
service unavailability on retries without persisted applicant state or any
provider-control lifecycle telemetry. Restore the approved value before further onboarding. A wrong
Origin, expired token, or token from another environment
must produce the same not-found response. Do not copy a token into shell
history, query tenant tables with an owner role, or log identifiers to prove
this check. Safe telemetry may show only
`personal_account.bootstrap.completed` with `created` on the first request or
`recovered` on the retry. Capacity exhaustion emits no successful completion.

Enter an explicitly international smoke-test WhatsApp Number in the signed-in
product and start one Connection Setup. Confirm the browser sends `POST
/v1/connection-setups` directly to the API and reports that the Connection
Setup started. Repeat the submission without changing the input and confirm it
returns the same setup as a replay. In an isolated non-production database,
verify that changing the number while retaining the original idempotency key,
reserving the same number from a second Personal Account, and starting beyond
three retained Connection/setup slots return their safe conflict states.
Provider-control must receive no lifecycle call during these creation checks;
the committed Queue message and reconciled provisioning worker are the only
provisioning path. Confirm the worker reports one `provisioned` outcome after
reconciling absence and creating, or after adopting the one matching
non-production provider session. Replaying the Queue message must reconcile and
ack without another create. Inspect only allowlisted outcome telemetry—never
print the number, idempotency key, reservation token, setup identifier,
ciphertext, provider locator, session authority, or key metadata.

From the same signed-in product flow, wait for the current QR image to appear
and scan it from the designated smoke-test WhatsApp account. Confirm the
browser reads the setup-scoped QR route directly from `API_ORIGIN`, that the
response is `image/svg+xml` with `Cache-Control: no-store`, and that no QR
payload or image bytes appear in Worker logs, analytics, traces, database
diagnostics, R2, Queue messages, or saved test artifacts. Do not copy, save, or
screen-capture the QR image as deployment evidence.

After scanning, confirm the next reconciled observation removes the QR image
and the product lists exactly one WhatsApp Connection with a `con_` handle,
required display name, four-digit number suffix, `connected` state, and
state-change time. Repeat the QR observation and connection list reads; they
must return the same Connection and must not create another connection key,
webhook ingress identity, webhook secret, or provider session. Inspect safe
counts through the restricted API role only. A second User requesting the same
setup-scoped QR route must receive the ordinary not-found boundary without a
provider-control call.

Safe telemetry may show `connection_setup.qr.completed` with a normalized
outcome, `connection_setup.provision.claimed` with setup-to-first-claim delay,
`connection_setup.provision.completed` with first-claim-to-terminal duration and safe
outcome, and `whatsapp_connection.list.completed` with a bounded count. A QR
byte, full number, setup or connection handle, provider locator, session
authority, webhook value, ciphertext, or key reference in telemetry is a
credential-handling incident. No infrastructure apply should add a new public
provider-control route or binding for this flow: the existing API-only closed
service binding is the complete lifecycle authority delta.

Trigger one reviewed non-production Wasender event for the activated
WhatsApp Connection and confirm the provider receives `200`. Inspect only
aggregate R2 object and Queue publication counts: one accepted delivery must
add one object under the private Webhook Event prefix and publish one ingestion
message after the object exists. The Queue body must have only version, opaque
object identity, internal connection context, ciphertext SHA-256, payload byte
count, and receipt time. Do not download the object, print R2 metadata, copy
the ingress URL or `X-Webhook-Signature`, or inspect the provider payload as
deployment evidence.

In an isolated test environment, verify that an unknown ingress, changed
signature, changed payload session identity, and body above 1 MiB receive
non-success and change neither the Webhook Event object count nor the Queue
publication count. Then deny R2 writes and confirm Queue publication does not
occur; deny Queue publication and confirm the request returns `503` while one
encrypted unclaimed object remains. Restore both bindings before continuing.
Do not delete that object manually: the orphan recovery workflow owns safe
republication. Repeated `webhook_ingress.completed` outcomes other than
`accepted` require checking restricted database readiness, KMS, R2, Queue, and
provider configuration in that order. Telemetry containing any ingress,
connection, object, network, header, session, payload, ciphertext, hash, or key
value is a credential-handling incident.

Confirm the accepted Queue message is explicitly acknowledged only after one
restricted `webhook_events` row is present and every logical item has a
terminal processing outcome. Deliver a reviewed non-production
`session.status` event with a later provider occurrence time and verify the
signed-in WhatsApp Connection inventory shows the normalized state and
state-change time. Redeliver the same item in a new authenticated delivery,
then deliver an older conflicting state; the inventory must remain unchanged.
In an isolated test environment, include one permanently malformed or
unsupported sibling and confirm it creates only a safe quarantine reference
while valid siblings still commit.

`webhook_event.processing.completed` may contain only `completed`, `retry`, or
`invalid_message` plus aggregate applied, duplicate, superseded, and
quarantined counts. A growing `retry` rate requires checking R2 object
availability and metadata integrity, KMS, `WEBHOOK_HYPERDRIVE`, schema version,
and restricted-role grants in that order. Do not inspect or edit the encrypted
source, manually synthesize a deduplication identity, update connection state,
or acknowledge the Queue message. Permanent item quarantine is handled and
acknowledged; transport or dependency failures remain eligible for the
configured seven Queue retries and active DLQ path.

### Connection health and Ingestion Gap checks

Wait for the next `*/5 * * * *` trigger and confirm one
`connection_health.reconciliation.completed` event per due non-production
WhatsApp Connection. A healthy fixture must report `connected`, `healthy`, and
`applied`. Change only the reviewed provider fixture to disable or redirect its
webhook and confirm the next check reports `degraded` with
`webhook_configuration`; restore the exact webhook configuration and confirm a
later check reports healthy. Separately disconnect the provider session and
confirm `disconnected` with `connection_unavailable`.

Using migration-owner inspection in the isolated environment, verify each
confirmed failure opened one active `app.ingestion_gaps` row at the previous
`health_last_confirmed_at`, and confirmed recovery set `ends_at` without
deleting the row. Deliver provider state evidence whose occurrence time
predates the completed health snapshot and confirm it is superseded. Do not
send or suppress messages as a test signal: message inactivity must leave the
gap count unchanged, and an empty active-gap set is not evidence of
provider-certified completeness.

For a measured ingress or Queue outage, record the affected internal
Connection IDs, measurement start, recovery time, and safe aggregate evidence
in the incident record. Supply the restricted API-runtime `DATABASE_URL` only
to the incident shell, then invoke the production repository path with the
internal Connection UUID, cause, `open` or `close`, and exact UTC evidence time:

```sh
bun run db:record-gap -- \
  00000000-0000-4000-8000-000000000000 \
  ingress_failure \
  open \
  2026-07-31T12:20:00.000Z
```

Use `processing_failure` after bounded ingestion loss and `restore_loss` after
a restore comparison proves loss; record each affected Connection before
enabling reads. Close only causes whose recovery was confirmed. The command
returns only the cause, action, and recorded-or-rejected outcome and never the
Connection ID. Never use it for suspected silence, and never insert, update,
or delete gap rows directly. A rejected or unavailable command must stop the
recovery gate for that Connection.

Alert when reconciliation has no successful run for ten minutes, when
`unknown` or `superseded` outcomes grow, when any active gap remains after the
underlying dependency is reported recovered, or when a reconnect-required or
degraded Connection persists across two checks. Investigate provider-control,
Wasender safe-read availability, exact webhook configuration, Hyperdrive, and
schema version in that order. Telemetry containing any tenant or provider
identifier is an incident.

### Webhook recovery checks

Confirm the next minute trigger republishes the deliberately orphaned object
from the Queue-denial check, then deliver the same provider item again. Both
Queue messages must acknowledge successfully while the restricted database
shows one Webhook Item identity and one projected domain change. Recovery
telemetry may contain only `webhook_ingress.recovery.completed` with candidate,
invalid-object, and enqueued counts. Any object key, event ID, Personal Account,
WhatsApp Connection, hash, receipt metadata, provider value, or payload in that
event is an incident.

For a controlled transient-failure drill, fail each of Neon, KMS, R2, and the
Worker normalization boundary separately. Confirm no message is acknowledged
and its retry delay stays between 9,900 and 11,700 seconds. Restore the
dependency and let normal delivery continue; do not publish a replacement
payload or edit the encrypted object. The deployment manifest and OpenTofu
plan must both retain exactly seven ingestion retries and the active DLQ
consumer.

Page on any `webhook_event.dead_letter.completed` outcome of `gap_recorded` or
`invalid_message`. For `gap_recorded`, copy only the emitted
`incidentReference` and verify through restricted metadata-only
diagnostics that the Webhook Event is marked dead-lettered, exactly one
`processing_failure` Ingestion Gap exists, and the encrypted source remains
under its seven-day R2 lifecycle. Do not acknowledge manually, delete or edit
the source, close the Ingestion Gap without confirmed recovery, or synthesize a
new deduplication identity. Restore the failing dependency first; immutable
operator replay must use the retained source and ordinary validation path.
Set `CLOUDFLARE_ACCOUNT_ID`, the sensitive
`CLOUDFLARE_INGESTION_REPLAY_QUEUE_ID` OpenTofu output, a short-lived
`CLOUDFLARE_REPLAY_API_TOKEN` restricted to Queues Write, and the approved
64-character `WEBHOOK_REPLAY_OPERATOR_REFERENCE`. Then run:

```sh
bun run ingestion:replay <incident-reference> dependency_recovered
```

Use `schema_support_deployed` only after reviewed parser or normalizer support
is deployed, or `transient_incident_resolved` for a resolved incident that is
not a dependency outage. Record the returned `attempt_reference`. Confirm
`webhook_event.replay.completed` reports `dispatched`, then verify the ordinary
`webhook_event.processing.completed` signal. Never place ciphertext, payload,
provider identifiers, tenant IDs, connection IDs, or object keys in the
command. An `already_dispatched` outcome is an idempotent success; do not issue
a new request ID merely to force another delivery.

An `invalid_message` means the DLQ envelope itself is corrupt and requires an
ingestion incident because connection-scoped gap recording cannot be proven
from that envelope.

At the first hourly boundary after source expiry, confirm
`webhook_event.source_retention.completed` advances its bounded deletion count.
`message_retention.purge.completed` reports only the number of Stored Messages
whose readable content expired. Investigate repeated failures of the hourly
schedule. The same run calls the bounded
`public.purge_expired_tool_call_logs` function until fewer than 500 rows
remain, ensuring no Activity Log can be listed after its 90-day expiry. The
same hour calls `public.expire_api_key_credentials` and
`public.purge_expired_api_key_metadata` until each returns fewer than 500
rows. `api_key.retention.completed` reports only the expired-digest and
purged-metadata counts. Verify that the restricted API role can call only the
integer-limit functions and that those functions use database time; never
grant that role a caller-controlled cutoff or broad cross-tenant table
deletion. Activity Log rows keep their original 90-day expiry and
denormalized API Key presentation after key metadata is purged. Do not release retained-media quota manually. The worker first marks
Stored Media unavailable, deletes its R2 object, and only then releases quota.
The R2 object, Webhook Event row, quarantine rows, and incident-to-source link
must be gone, while the content-free Webhook Item deduplication identity
remains. Treat any replay after that point as `source_unavailable`; never
reconstruct or substitute the payload.

From the retained non-production WhatsApp Connection, choose **Disconnect**.
Confirm the product reports `disconnected`, retained history remains described
as available under Message Retention Policy, and the same `con_` handle and
number suffix remain listed. Repeat the request and confirm it completes
without a second provider write. Through the restricted API role, verify that
the WhatsApp Connection, Connection Setup, key envelopes, and WhatsApp Number
reservation still exist; do not inspect content or ciphertext.

Choose **Reconnect** on that same Connection. If linking is required, scan the
ephemeral QR without saving it and confirm the product progresses through
`connecting` to `connected` on the same handle. Exercise the reviewed
ambiguous-disconnect fixture: it must make one write, reconcile, and converge
to `disconnected` when the provider confirms that state, or `degraded` when
the target remains unresolved. Two concurrent requests must expose one active
claim, and a stale claim completion must not change the newer state. During
`connecting`, `disconnected`, `reconnect_required`, or `degraded`, verify a new
side-effect availability decision is blocked. Telemetry may contain only
`whatsapp_connection.lifecycle.completed`, the normalized operation and
outcome, and the API service name. Any handle, setup marker, provider value,
number, QR data, or credential in that event is an incident.

Exercise the reviewed provider-control test fixture for an ambiguous create
timeout and confirm the next Queue delivery reconciles before any create
decision. Exercise its duplicate fixture and confirm Neon exposes only the
safe setup state `provisioning_quarantined` and duplicate count while no session
becomes usable. A production quarantine is an incident: pause new onboarding,
retain every reservation and encrypted provider reference, and do not manually
repeat create or release the number. Use audited restricted diagnostics for
state/counts only, preserve provider evidence, and follow the provider cleanup
procedure below. A growing recovery candidate
count, repeated normalized failure code, or setup approaching its 15-minute
expiry requires paging the on-call operator.

Cancel one incomplete non-production Connection Setup in the product and
confirm `DELETE /v1/connection-setups/{setup_id}` returns `cancelled` with
`cleanup_state: pending`; repeat it and confirm an idempotent replay. Start a
second setup and make no browser request after its deadline. Confirm the minute
cron changes it to `expired` at 15 minutes and enqueues cleanup. For both
paths, verify provider-control reconciles before delete, deletes no more than
one matching session per attempt, reconciles again, and releases the WhatsApp
Number only after confirmed absence. The same number must remain unavailable
while absence is unknown and become available after cleanup completes.

Page the on-call operator when cleanup recovery candidates grow, a normalized
cleanup failure repeats, or a reservation remains held after the expected
provider recovery window. Do not manually delete the reservation, clear a
lease, or change `cancelled`/`expired` back to a provisioning state. First
restore provider-control or Queue health, then let the reconcile-first worker
confirm absence. Inspect only terminal state, cleanup state, attempt count,
lease age, and allowlisted failure code through restricted diagnostics; never
log the setup identifier, number token, encrypted number, provider locator,
session authority, or raw provider response.

In the same non-production environment, start authorization from one reviewed
allowlisted MCP Client. Confirm the consent page names that client and starts
with every WhatsApp Connection, requested scope, read-sharing confirmation,
and send-authority confirmation unselected. Approve one existing Connection
with a reviewed subset of scopes after Clerk first-factor reverification, then
exchange the returned code with S256 PKCE. Inspect only protocol metadata: the
response must report `expires_in: 600`, the exact `$API_ORIGIN/mcp` resource,
the selected scope string, and one refresh credential. Never print either
credential.

Repeat with denial and confirm that the client receives `access_denied` with
its original state and no MCP Authorization row is created. Restart the flow
before each negative case; verify a five-minute-old factor age is rejected, an
altered presentation is rejected as a changed request, and an unregistered
client still fails before consent without a redirect. Query only safe counts
and scope/Connection cardinalities through an audited restricted-role
diagnostic. A later test WhatsApp Connection must not change the original
authorization's selected-Connection count. Safe consent telemetry may contain
only the allowlisted client class and `approved` or `denied`.

Using that disposable non-production authorization, let the client store the
returned refresh credential without printing it. Refresh once and confirm the
response contains a different refresh credential, the same reviewed scope and
resource, and `expires_in: 600`. In the automated acceptance check, submit two
concurrent refreshes with the same current credential: exactly one response
may contain a descendant and the other must be `invalid_grant`. Re-present the
consumed credential and confirm `invalid_grant`, then confirm the descendant
also cannot refresh because reuse revoked the family. Inspect only
`oauth.refresh.completed` outcome counts and the allowlisted client class.
Treat any `reuse` outcome outside this controlled check as a credential-replay
incident: revoke or confirm revocation of the affected MCP Authorization,
notify the User through the incident process, and investigate the MCP Client's
credential storage. Never query, export, or log a credential hash.

In the signed-in product, inspect the disposable authorization and confirm its
MCP Client name, selected WhatsApp Connections, scopes, creation time, absolute
expiry state, and revocation state. Confirm the browser calls
`GET /v1/mcp-authorizations` directly and that the response contains no
internal UUID, OAuth subject, token, refresh credential, credential hash, or KV
artifact. Revoke it once through the product, repeat the same action through an
isolated non-production API check, and confirm both return the original
revocation time. Immediately retry one existing access token and the latest
refresh credential; both must fail even if the OAuth KV records are retained.

Attempt the same management handle as a different disposable Personal Account
and compare it with a random well-formed `mca_` handle. Both must return the
same not-found status and body. Inspect only allowlisted
`mcp_authorization.management.completed` operation/outcome counts. If an
access-token call or refresh succeeds after a successful revoke response,
disable the affected API deployment, preserve metadata-only evidence, and
investigate the Neon authority check before restoring traffic. Never delete KV
as the primary containment action: authoritative Neon revocation must remain
sufficient on its own.

The readiness response proves a restricted Hyperdrive connection can read the
exact expected schema version. It emits only an allowlisted request outcome;
database URLs, SQL, tenant identifiers, and migration errors are never logged.
The repository's provider-control acceptance suite invokes real lifecycle
reconciliation through the Cloudflare RPC entrypoint, rejects malformed RPC
arguments before provider access, and proves that the same lifecycle operation
is unavailable over HTTP. Deployment validation proves that only the
same-environment API Worker receives the service binding. Until the
authenticated operator canary is added to the API, verify the deployed binding
and Worker version in the reviewed Cloudflare deployment output; do not add a
temporary API endpoint or enable `workers.dev` or preview URLs for
provider-control.

Provider-control RPC logs may contain only the RPC method and normalized
success or failure code. Treat a Connection Setup marker, WhatsApp Number,
opaque locator, per-session authority, account credential, request body, or
provider response in logs as a credential-handling incident.

### Wasender media retrieval

No additional Cloudflare binding or public ingress is required for media
retrieval. If an organization-level egress policy is applied outside this
repository, allow outbound HTTPS only as needed to `www.wasenderapi.com` for
decrypt metadata and guarded downloads and to `cloudflare-dns.com` for the
adapter's bounded A and AAAA checks. Do not add an alternate media hostname or
disable DNS validation to work around an outage.

After a real Wasender account and connected session exist, send one test image
to the test WhatsApp Connection and verify through the authenticated ingestion
path that metadata becomes available and the guarded stream's actual byte
count matches the object written by the caller. Repeat with a caller limit one
byte below the object size and verify the stream fails with
`response_too_large` and the partial object is discarded. Operator telemetry
may show only operation class, normalized outcome, attempt count, duration, and
bounded byte count; a URL, credential, provider response, filename, MIME type,
message identity, or media bytes in logs is an incident.

### Wasender text sending

Before enabling sends, set reviewed positive `SENDS_PER_MINUTE` and
`SENDS_PER_DAY` values and install an independently generated
`SEND_FINGERPRINT_HMAC_SECRET` with `openssl rand -hex 32`. Keep that key in
the recovery inventory; do not rotate it by replacement while bindings created
with the current key remain live.

When the outbound-send public boundary is deployed, run its smoke check only
with a dedicated operator-owned WhatsApp Connection and designated recipient.
Confirm one provider attempt and a normalized operation receipt. The currently
documented Wasender response with `status: "in_progress"` must converge only to
`accepted`; do not treat numeric `msgId` as stable message identity. Confirm
logs contain only the normalized outcome, attempt count, duration, and bounded
response-byte count. The provider request and response references are the
[send-text endpoint](https://www.wasenderapi.com/api-docs/messages/send-text-message)
and [error response](https://www.wasenderapi.com/api-docs/responses-errors/error-responses)
documentation; pause rollout on incompatible schema drift rather than adding a
permissive parser or endpoint override.

Alert on elevated ambiguous outcomes, timeouts, server errors, and malformed or
oversized responses. Never replay an ambiguous Send Operation during an
incident. Reconcile it only from authenticated webhook evidence carrying the
same connection and HMAC-protected stable message identity.

For an identity-bearing `sent`, `delivered`, or `read` response or webhook,
confirm the same-connection Send Operation produces exactly one outbound Stored
Message and removes its Pending Send Content. An authenticated outbound upsert
with a different identity must create its own Stored Message without changing
the Send Operation. Treat correlation by recipient, text, timing, status order,
or apparent uniqueness as an incident; telemetry must expose only normalized
outcomes and counts, never either identity or message content.

If a Worker terminates after the durable transaction but before a complete
provider response is recorded, allow the 30-second dispatch lease to expire.
The minute schedule atomically changes unresolved operations to `unknown`; an
exact replay can perform the same convergence before the schedule runs and
must never dispatch. Monitor `send.dispatch_lease.sweep_completed` by its count
only; a sustained nonzero count indicates interrupted or overlong attempts.
Do not delete a Send Operation, idempotency binding, fingerprint, lease, or
quota reservation to force a retry. A post-attempt Activity Log update failure
is investigated as audit degradation; the Send Operation remains authoritative.

During the send smoke check, repeat the exact authorization, Connection,
WhatsApp Recipient, text bytes, and idempotency key after marking the test
Connection degraded and its Directory projection stale. Confirm the original
Send Operation is returned with `idempotent_replay: true`, no provider request
or send-quota reservation is added, and the replay Activity Log has
`quota_reserved = false`. Restore the test state, then reuse the bound key with
one changed Connection, recipient, and exact-text case in turn. Each must return
the non-retryable `idempotency_conflict` before recipient or connection-health
resolution and must not dispatch. Never print the key, recipient, or text while
performing or investigating this check.

### Wasender Directory

Perform the Directory smoke check with a non-production WhatsApp Connection
containing a reviewed disposable contact set. Wait for the five-minute
reconciliation schedule, then call `list_contacts` with an authorization that
has `directory:read` and selects only that connection. Verify deterministic
name ordering, opaque `ctc_` handles, nullable display names, phone suffixes
only, and `as_of`, `stale`, and `partial` metadata. Exercise one exact E.164
lookup and one normalized display-name prefix lookup without printing either
search value.

Confirm the provider contacts read succeeds and telemetry contains only the
operation class, normalized outcome, attempt count, duration, and bounded byte
counts. No session credential, provider identity, full phone number, contact
name, response body, URL, ciphertext, or blind index may appear in Worker logs.
An overdue snapshot (more than ten minutes old), a failed provider read, or a
partial provider response must remain visible through `stale` or `partial`;
do not clear those indicators manually. Connection health older than ten
minutes also makes the projection stale. An Ingestion Gap after the latest
complete Directory snapshot or a recorded retention limitation makes the
projection partial; a complete reconciliation clears only limitations it can
actually supersede. Webhook contact changes may advance a partial projection
between complete snapshots. Remove the disposable
connection through the normal Connection Deletion flow; do not print or pass
its session API key on a command line.

The hourly API schedule reconciles joined groups through that per-connection
authority. A complete observation marks omitted groups unjoined; a partial or
failed observation never does. Confirm `group_directory.reconciliation.completed`
reports only outcome and bounded counts. Repeated failures intentionally make
`list_groups` freshness `stale` and `partial`; investigate provider health and
the connection-specific credential without logging group names, routing
identities, roster data, or ciphertext.

After Stored Message projection is deployed, deliver one authenticated inbound
text upsert and one authenticated outbound text upsert to a disposable
connection. Confirm each creates one encrypted Stored Message and that
`list_chats` (under a `messages:read` authorization) returns only conversation
handle, recipient handle and safe Directory metadata, activity time, direction,
and freshness fields. Replay and reorder the deliveries and confirm the latest
message time still determines activity. Receipt, reaction, status, newsletter,
and call fixtures must not create a conversation. Worker telemetry and Activity
Logs may contain only the tool name, outcome, counts, timing, and opaque handles;
never print message text, provider identities, recipient locators, ciphertext,
or cursor contents during this check.

## Rollback

Vercel uses immutable deployment history. Worker rollback is a reviewed
OpenTofu apply of the last known-good commit:

1. Redeploy the last known-good Vercel deployment.
2. Check out the last known-good source, rebuild the Worker bundles, plan
   against the same remote state, and apply the reviewed rollback plan.
3. Roll back provider-control only after confirming that its API callers remain
   compatible.
4. Repeat the health checks.

## Rollback decision matrix

| Failed surface | Safe response | Must be preserved |
| --- | --- | --- |
| Web only | Redeploy the last known-good immutable Vercel deployment after confirming its API contract remains compatible. | API and Worker versions, current configuration, audit evidence. |
| Docs only | Redeploy the last known-good immutable static docs deployment. Documentation cannot proxy or retry API traffic. | Web, API, and Worker versions, current configuration, audit evidence. |
| API Worker | Stop promotion, deploy a forward-compatible API or rebuild the last known-good compatible API and apply its reviewed Worker plan. | Send Operations, Queue messages, OAuth authority in Neon, R2 sources. |
| Provider-control Worker | Roll back only when the current API remains RPC-compatible; otherwise forward-fix and keep lifecycle writes paused. | Provider references, reservations, cleanup intents, private-only routing. |
| Configuration or secret binding | Restore the reviewed value or binding through its owning secret store and publish a new version. | Stable HMAC identities, KMS keys, token-family revocations, state history. |
| Infrastructure | Create a plan from the last known-good declaration against the same remote state; inspect it before apply. | Locked markers, Deletion Capsules, KMS keys, Neon history, immutable audit. |
| Database | Database migrations are forward-only. Deploy compatible code or a new forward-fix migration. | Migration ledger, RLS, restricted roles, tenant data. |

Do not use destructive database reversal, edit the migration ledger, clear a
Queue or lease, replace a stable HMAC key, or retry an ambiguous side effect to
make rollback appear successful. After any rollback, rerun readiness,
`bun run deploy:smoke`, Queue/schedule checks, and the alert-delivery canary.

If rollback overlaps a text-send timeout or interrupted response, retain the
Send Operation as `unknown` and do not issue a replacement provider call. A
rollback does not relax the single-attempt rule or turn a provider `msgId` into
correlation evidence.

Database migrations are forward-only. If application rollback would target a
binary whose compiled schema version differs from production, it will fail
closed; deploy a forward-compatible application or forward-fix migration
instead of deleting migration records or reverting tenant-isolation DDL. For a
failed, unrecorded migration, correct the cause and rerun the serialized
migration command before deploying application traffic.

Do not destroy, unlock, rename, or remove the deletion-marker bucket during a
rollback or environment teardown. Its OpenTofu resource deliberately has
`prevent_destroy`, and its indefinite lock is the restore-external deletion
authority. The Deletion Capsule bucket also has `prevent_destroy`; retain it
through rollback, and remove that safeguard only in a separately reviewed
environment teardown after the coordinator has confirmed that no capsule
remains. Retire other environment resources only after Queue drain and
retention cleanup; retain the marker bucket and its isolated encrypted state
under the production recovery authority.

## External rollout gates

Clerk Waitlist mode controls private-beta applicant approval. The API has no
second onboarding gate: a User who can authenticate is already approved and
can bootstrap a Personal Account. Provider availability is managed internally
and evaluated only when a Connection Setup provisions a WhatsApp Connection.

The monthly and quarterly schedules in
`.github/workflows/recovery-drills.yml` call the production recovery automation
boundary and retain its validated, metadata-only evidence. The monthly restore
must use a random point from the preceding seven days and a non-serving branch.
The quarterly game day covers endpoint rotation, OAuth KV reconstruction,
immutable Queue replay, KMS/R2 access, permanent Stored Media loss, alert
delivery, and deletion-gate bypass denial. Configure
`RECOVERY_AUTOMATION_URL` and `RECOVERY_AUTOMATION_TOKEN` only in the isolated
`production-recovery` GitHub environment; they are external rollout inputs, not
test substitutes or application runtime bindings.

Run the `External onboarding launch gate` workflow after successful drill
artifacts exist. It reruns the real deployed smoke and production bundle
inspection and requires the exact environment attestations `approved` for
numeric quotas, provider capacity, and Wasender governance terms. Evidence
older than 35 days for the monthly drill or 100 days for the quarterly drill is
rejected. The successful result is release evidence; it does not mutate
application admission state. Any missing artifact, secret, external approval,
malformed report, failed check, missed four-hour RTO, missed five-minute Neon
RPO, or nonzero deletion marker loss blocks the production launch decision.

## Public API release gate

The public API is not released from a green CI job alone. Run the
`Public API release gate` workflow, or `bun run release:public-api` after the
same commands, only when every listed gate has already succeeded on the
reviewed commit:

1. `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`,
   and `bun run build` without weakening or skipping a check.
2. `bun run db:check` and the migrated-Postgres suite under
   `whatsapp_api_runtime` with production RLS intact.
3. `bun run validate:infra`, `bun run manifests:validate`,
   `bun run infra:validate`, and `bun run observability:validate`.
4. The browser-to-Worker API Key, REST resource, Activity Log, Recipient
   Exclusion, quota-sharing, Stored Media, and send-ambiguity suites.
5. Connection Deletion, Personal Account Deletion, expiry, metadata purge,
   restore invalidation, HMAC rotation evidence, and the recovery drill.
6. `bun run inspect:bundles` with no controlled credentials, fixture secrets,
   test verifier controls, fault selectors, or other test-only markers.
7. `bun run deploy:smoke` against the distinct `docs.normal.fast` origin,
   validating the complete OpenAPI 3.1 reference and static security
   configuration.

The evaluator also requires every v1 REST and API Key management path, the
guide topics rendered by Scalar, current monthly and quarterly drill evidence,
and restore checks `api_keys_revoked`, `api_key_digests_cleared`,
`api_key_hmac_rotated`, and `predecessor_hmac_rejected`. Any failed or missing
gate blocks release. Do not add an exception, skip, `continue-on-error`, or
reduced check.

Evidence records achieved first-party monthly availability against the 99.5
percent SLO separately from achieved Wasender and WhatsApp availability.
Reports contain timings, aggregate counts, and normalized checks only; never
include a User, Personal Account, WhatsApp Connection, provider identifier,
key, token, message, or object key.

Applying real infrastructure remains gated on environment-specific Cloudflare
accounts/zones, Vercel teams, state buckets/KMS keys, provider tokens, domain
ownership, and DNS approval. These values are intentionally absent from source.
No code substitution, fake provider, public provider-control route, or
production fallback is needed when the external values become available.

External onboarding and any live Directory rollout remain gated on the written
Wasender terms required by ADR 0004, including approved capacity, data
processing and subprocessors, deletion and backup erasure, security controls,
webhook authentication, and retry behavior. The real adapter remains in the
production bundle while that business gate is closed; do not route production
traffic to a test Layer or alternate origin.

## Subprocessor inventory

Production subprocessors that may process User or product data are:

| Subprocessor | Purpose | Data in scope |
| --- | --- | --- |
| Clerk | Sign-in identity | User identity and session claims. Not WhatsApp content. |
| Neon | Authoritative tenant data | Personal Account state, onboarding profiles, encrypted WhatsApp data, authorization, and lifecycle records. |
| Cloudflare | API, Workers, R2, Queues | Request handling, encrypted objects, and operational queues. |
| Vercel | Web application hosting | Public browser configuration and the signed-in UI. Not the data plane. |
| AWS KMS | Envelope encryption | Key use for Personal Account and WhatsApp Connection content keys. |
| Wasender | WhatsApp provider seam | Provider session lifecycle behind provider-control. |
| PostHog | Optional aggregate product analytics | Allowlisted non-identifying browser events only. No Clerk IDs, emails, Personal Account IDs, public handles, WhatsApp Numbers, profile answers, message content, or QR material. No person profiles or session replay. |

Do not enable production PostHog collection until this inventory, CSP, privacy
copy, retention configuration, and browser-IP handling are reviewed for that
environment. Disable IP capture or configure immediate IP discard in PostHog,
then set `posthog_privacy_controls_approved = true` in the reviewed environment
inputs. Never use that input to bypass an incomplete review.

Roll application code back without rolling back, replacing, disabling, or
deleting either KMS key.
Versioned ciphertext retains the key metadata needed across application
rollbacks and automatic KMS key-material rotation. Treat an incorrect key
policy or alias as a forward-fix: restore the reviewed template, validate it,
deploy it, and confirm denied/allowed CloudTrail events before reopening
traffic.
