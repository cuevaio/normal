# Environment teardown

Teardown retires an environment; it is not rollback or a shortcut around
Personal Account Deletion. Use a dedicated reviewed change and exact remote
state. Never use `tofu destroy` against an unreviewed plan, a broad directory,
or the wrong environment. Production teardown requires evidence that external
onboarding is closed and every Personal Account entered the ordinary terminal
deletion workflow.

## Preconditions

1. Disable onboarding and new MCP Authorization grants, then stop new sends and
   webhook registration without making provider-control public.
2. Complete every Personal Account and Connection Deletion. Confirm provider
   absence, no Deletion Capsule remains, active R2/Neon cleanup finished, and
   the 24-hour escalation queue is empty. Do not release a WhatsApp Number on
   ambiguous provider state.
3. Drain ingestion, replay, and deletion Queues through their consumers. Record
   counts and normalized outcomes only; do not purge encrypted sources to make
   the count zero.
4. Export no tenant data. Retain required Security Records, provider-cleanup
   audit, infrastructure audit, deployment evidence, and locked markers under
   their existing policies.

## Destruction order

1. Remove public DNS and web/docs/API routes, verify data-plane traffic is closed,
   then retire Vercel web and static docs deployments.
2. Remove schedules and Queue producers; after verified drain, retire consumers,
   Queues, OAuth KV, disposable R2 buckets, API Worker, and provider-control
   Worker. Revoke their scoped credentials at each issuer.
3. Delete disposable Hyperdrive configurations. Keep the retired Neon project
   non-serving and restricted to the audit-retention authority until every
   Security Record and provider-cleanup audit reaches its defined expiry; then
   delete the project. Do not shorten retention or create custom database dumps.
4. Apply a reviewed infrastructure plan that removes disposable compute and
   storage. Inspect every destroy action and preserve encrypted state history.
5. Retire ordinary runtime roles and credentials. Retain KMS keys while any
   managed ciphertext, retained audit, or recovery evidence requires them; key
   deletion is a separate reviewed lifecycle decision with recovery time.

The locked deletion-marker bucket, its indefinite object lock, stable marker
HMAC recovery material, encrypted state needed to manage it, and immutable audit
evidence are retained under the isolated recovery authority. They are not
disposable resources and must not appear as destroys in the teardown plan. The
Deletion Capsule bucket remains protected until absence is proven and every
capsule is gone; removing `prevent_destroy` requires its own reviewed change.

Complete teardown only after a second operator confirms the final plan matched
the recorded environment, public routes are absent, provider-control is not
reachable, disposable credentials are revoked, retained evidence is readable
only by its designated audit/recovery roles, and the locked markers remain
enumerable for future restore defense.
