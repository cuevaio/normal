# Production observability and SLO reporting

The production reporting contract is [`observability/production.json`](../../observability/production.json). `bun run observability:validate` rejects missing operational coverage, merged first-party/dependency availability, undeclared fields, identity-shaped dashboard dimensions, incomplete alert coverage, or an unsafe alert payload. CI runs this check on every change.

## Ownership and access

Platform Operations owns the dashboards, alert policies, weekly delivery canary, and incident response. The observability role may read persisted Cloudflare Worker logs, traces, and platform metrics and may manage dashboards and alert rules. It receives no database, R2, KV, KMS, Hyperdrive, Provider API Credential, OAuth secret, or Worker-secret access. It cannot decrypt Stored Messages, Stored Media, provider payloads, or identifiers. Do not copy tenant or User identity into annotations, alert destinations, tickets, or support tools.

The production alert boundary is `https://operations.normal.fast`. Store its three paths and separate bearer credentials in the protected GitHub environments as `OBSERVABILITY_QUERY_URL`, `OBSERVABILITY_QUERY_TOKEN`, `PAGER_WEBHOOK_URL`, `PAGER_WEBHOOK_TOKEN`, `PAGER_RECEIPT_URL`, and `PAGER_RECEIPT_TOKEN`. The operations Worker routes both severities to the verified `hi@cueva.io` destination during private beta. The email contains only the four allowlisted alert fields.

## Provisioning

In the production Cloudflare account, create the four dashboards and eight alert policies with the exact IDs, sources, fields, filters, thresholds, and windows in the reporting contract. Cloudflare platform fields come from Workers Analytics, Queues, KV, and R2 service metrics; `workerTelemetry` fields come only from the structured events accepted by the runtime allowlist. Treat configuration drift from the committed contract as a deployment failure.

Activate Cloudflare Email Sending for `alerts.normal.fast`, complete every DNS verification record, and verify `hi@cueva.io` as the production pager destination. Provision a zone scoped token with Analytics Read only and store it as `CLOUDFLARE_ANALYTICS_TOKEN` on operations control. Store the exact zone as `CLOUDFLARE_ZONE_ID`. Bind Email Service as `PAGER_EMAIL`, allow only `pager@alerts.normal.fast` as sender and `hi@cueva.io` as destination, and bind the dedicated `ALERT_RECEIPTS` KV namespace. Do not grant database, R2, Queue, KMS, Neon, or provider access.

The availability dashboard must show three independent series. Operations control computes the first party series from the production API hostname in Cloudflare HTTP analytics as one minus the 5xx response ratio over the exact rolling 30 day window, with scheduled maintenance included, against 99.5%. The production zone must expose `httpRequestsAdaptiveGroups` with `maxDuration` and `notOlderThan` of at least 2,592,000 seconds; verify both through the GraphQL settings node before launch and after a Cloudflare plan change. It reads Wasender's published 30 day uptime and WhatsApp component outage evidence separately. These dependency series have no inherited objective; never subtract dependency failures from the first party numerator or denominator.

Queue lag and dead letters use Cloudflare Queue metrics. Quota pressure is authoritative Neon quota utilization exported as an aggregate only. KMS, Stored Media, deletion-deadline, and restore-gate panels count aggregate safe outcomes only. No query may group by an opaque reference, even when that reference is permitted in an incident log event.

The recovery availability query also runs the deployed API smoke boundary. That proof must complete the real database, provider safe read, Queue, R2, and sampled KMS path. Recovery RPO comes from the committed heartbeat inside the restored Neon branch, not from the operations Worker.

After provisioning, run:

```sh
bun run observability:validate
bun run observability:canary
```

Confirm the `alert-delivery-canary` arrives in the ticket destination with only `alert`, `severity`, `status`, and `observedAt`. The canary succeeds only after `/v1/receipts` observes the matching final `delivered` Email Service event. Acceptance by `/v1/alerts` is not delivery proof. GitHub Actions repeats this every Monday at 15:00 UTC; a failed workflow is itself a delivery path incident.

## Alert response

- Active dead letters page immediately. Follow the immutable replay process in the deployment runbook; never paste source payloads into an incident.
- Deletion cleanup pages with six hours remaining before the 24-hour deadline, preserving time for recovery.
- Restore-gate and key failures page immediately. Keep serving and verification access closed until the failing gate is healthy.
- A rising WhatsApp Recipient Exclusion transition failure rate, or an exclusion cleanup panel that stops draining while Stored Media object deletions stay overdue, creates an incident. Investigate the R2 journal bucket, the recipient transition HMAC secret, and the scheduled drain; never inspect the recipient, its Directory record, or message content to triage. The dashboards carry only aggregate operation class, desired-state class, normalized outcome, counts, timing, and latency.
- Quota utilization at or above 80% for 15 minutes creates a capacity ticket.
- REST `rest.operation.completed` is an allowlisted Worker telemetry event with
  only operation name, outcome, optional result count, and service. Do not add
  credentials, search terms, message content, raw bodies, or tenant identifiers.
- Connection Setup timing uses privacy-safe transition events. Anonymous
  browser `connection_setup_timing_recorded` events measure
  `start_to_code_observed` and `code_observed_to_active_observed` once per flow.
  API `connection_setup.provision.claimed.queueDelayMs` measures durable setup
  creation to its persisted first Neon claim, while
  `connection_setup.provision.completed.durationMs` measures that first claim
  to a committed terminal provisioning transition. Retry events carry no
  duration, and a legacy in-flight setup without a persisted first claim emits
  no fabricated sample. `provider_control.rpc.completed.durationMs`, grouped by
  method, measures the private control boundary. `provider.call.completed`,
  grouped by operation, measures Wasender attempts; safe-read calls are the
  Wasender component of reconciliation. None may include identifiers, numbers,
  names, code payloads, or provider session values.

## Connection Setup performance verification

The committed deterministic scheduler regression is the only locally asserted
percentile. Run `bun test test/connection-setup-observation.test.ts` from
`apps/web`; its fixed 18-transition corpus reports the documented before/after
values and enforces p95 first-party observation lag at or below 750 ms. It does
not emulate Wasender or WhatsApp and must not be presented as an end-to-end
production baseline.

After deployment, query a minimum seven complete days with at least 100
successful Connection Setups. Compute p50/p95/p99 separately for each browser
phase and each Worker event/field above, grouping only by phase, event, method,
operation, normalized outcome, and service. Filter provisioning duration to
terminal `provisioned`, `quarantined`, and `failed` outcomes because retries
intentionally have no duration. Compare aggregate first-claim and terminal
counts with successful setup counts to detect duplicate or missing transition
samples; do not join on or add a setup, User, tenant, number, or provider
identifier. Record sample count, environment, release commit, window, and the
three percentiles in the release evidence. Browser phases provide the
observable end-to-end distributions; Worker, provider-control, and Wasender
distributions attribute aggregate components and must not be added together as
if independently sampled percentiles belonged to the same setup.

Provider-dependent end-to-end p50/p95/p99 cannot be asserted from local fake
provider runs. Platform Operations must use that production baseline to propose
and approve total start-to-code and code-to-active targets. Until then, only the
750 ms p95 first-party observation target is approved; Wasender and WhatsApp
time remains reported separately and has no invented objective.
- API Key retention telemetry is limited to `api_key.retention.completed`, the
  bounded expired and purged counts, and the API service name. Do not add
  handles, names, hints, digests, credentials, or tenant identifiers.
- A five-minute Wasender or WhatsApp outage pages as a dependency incident and remains distinct from first-party SLO reporting.
- A `health_check_failure` Ingestion Gap creates a first-party scheduled-execution incident. Confirm two on-time observations after recovery and keep this distinct from message inactivity.

Retain weekly first-party SLO reports and dependency reports as separate aggregate artifacts. The first-party report aggregates seven adjacent one-day hostname-filtered Cloudflare Analytics partitions. Record objective, achieved availability, error-budget consumption, incident counts, and reporting window only; do not attach raw logs or tenant-level samples.
