# Production incident response

Platform Operations owns coordination. Open an incident with an opaque UUID,
start and detection times, affected surface, aggregate safe signals, and the
current deployment versions. Do not put User, Personal Account, WhatsApp
Connection, provider, message, credential, payload, ciphertext, or object-key
data in the incident system. Prefer containment that stops new work while
preserving durable state. Never retry an ambiguous Send Operation.

For every incident: page the owning on-call, freeze unrelated deployment,
record the SLO and dependency impact separately, contain, recover through the
ordinary authenticated path, verify the public boundary, and retain only
metadata-safe evidence. Close only when alerts clear for two evaluation
windows, backlog trends downward or reaches zero, and the affected smoke check
passes.

## Provider outage

- Contain: pause new Connection Setup when lifecycle reconciliation is impaired.
  Connected-state reads may continue, but block new sends when evidence changes
  a WhatsApp Connection to disconnected, reconnect-required, or degraded.
- Preserve: reservations, encrypted provider references, Pending Send Content,
  and Send Operations. Do not switch provider origin, expose provider-control,
  or insert a production fake. A timeout after possible send acceptance is
  `unknown`, never a retry request.
- Recover: restore Wasender/WhatsApp access, let reconcile-first lifecycle and
  five-minute health jobs observe state, and close only evidence-based
  Ingestion Gaps after confirmed recovery. Exit after two healthy observations
  and one normal provider-control operation on the designated canary.

## Health observer lapse

- Contain: confirm the API Worker deployment still has the five-minute Cron Trigger and scheduled handler. Do not infer a gap from message inactivity or manually change a Connection state.
- Recover: restore scheduled execution and let the next completed observation record a closed `health_check_failure` Ingestion Gap from the previous completed observation through recovery. Investigate any overlapping provider or webhook gap independently. Exit after two on-time healthy observations and confirmation that the gap is visible through an authorized message read.

## Webhook ingress failure

- Contain: keep failed HTTP delivery responses honest; do not acknowledge until
  encrypted R2 storage and Queue publication both succeed. Record measured
  affected intervals as `ingress_failure` Ingestion Gaps through
  `bun run db:record-gap`, never direct SQL.
- Recover: restore R2, KMS, route, Hyperdrive, or Queue authority; allow the
  orphan sweeper and provider retries to converge by original identity. Do not
  copy, edit, or republish payloads. Exit when ingress succeeds, orphan count is
  zero, and duplicate delivery produces one projected item.

## Queue backlog

- Contain: pause new Connection Setup and nonessential replay before saturation.
  Do not purge, manually acknowledge, increase consumers past reviewed quotas,
  or create replacement messages.
- Recover: restore the downstream dependency and let configured consumers drain
  at the declared rate. Confirm oldest-message age and count decline, scheduled
  handlers remain healthy, and no item exceeds the bounded seven-retry path.
  Open `processing_failure` Ingestion Gaps only where concrete loss or DLQ
  evidence exists.

## Dead-letter replay

The active DLQ consumer first preserves the encrypted source, records the
Ingestion Gap, emits an opaque incident reference, and acknowledges the DLQ
message. Resolve the dependency or deploy reviewed schema support before replay.
With a token restricted to the immutable replay Queue, run:

```sh
bun run ingestion:replay <incident-reference> dependency_recovered
```

Use only the documented reason codes. `already_dispatched` is success; never
invent a new incident reference to force dispatch. Verify the ordinary parsing,
validation, deduplication, projection, and gap-closing path. If the source has
expired or the envelope is invalid, do not reconstruct it; retain the gap.

## Stored Media loss

R2 is the sole retained Stored Media copy and has no backup RPO. Mark a missing,
truncated, or unauthenticated primary object `failed` through the owning
workflow, make it unavailable before releasing quota, and return the normal
indistinguishable not-found boundary. Never return a verified prefix, rebuild
bytes from provider logs, or claim recovery. Exit when metadata and quota agree,
affected resources report `failed`, and no public/cacheable URL exists.

## KMS failure

Stop operations that require the affected key; they must fail closed before
plaintext or side effects. Check AWS availability, short-lived role expiry,
key state, alias, region `us-east-1`, encryption context, and policy changes.
Restore the reviewed policy or credentials and publish a new Worker version if
needed. Never replace or schedule deletion of a content or Deletion Capsule key,
reuse another environment's key, or bypass encryption. Reopen after allowed and
denied CloudTrail canaries behave as expected and envelope/container checks pass.

## Quota incident

Neon is authoritative. Do not raise limits in Durable Objects, clear ledger
rows, refund a post-attempt send, or bypass capacity with provider-account
sharding. If configuration drifted, restore the last reviewed positive values;
if demand is genuine, keep deterministic `quota_exceeded` responses and pause
new Connection Setup at approved capacity. Reconcile retained-media bytes only
through the audited owning workflow. Exit when ledger invariants pass and
configured, observed, and vendor-approved limits agree.

## Partial deployment

Immediately stop promotion and identify the deployed schema, provider-control,
API, web, configuration, and infrastructure versions without printing secrets.
Keep traffic closed when schema readiness, branch identity, deletion restore
gate, Hyperdrive, KMS, or private service binding fails. If compatibility is
proven, complete the ordered deployment; otherwise use the deployment
[rollback decision matrix](deployment.md#rollback-decision-matrix). Preserve
Queues and durable operations throughout. Exit only after the complete version
set is recorded, readiness and `bun run deploy:smoke` pass, and no production
route selects a fake or exposes provider-control.
