# Production observability and SLO reporting

The production reporting contract is [`observability/production.json`](../../observability/production.json). `bun run observability:validate` rejects missing operational coverage, merged first-party/dependency availability, undeclared fields, identity-shaped dashboard dimensions, incomplete alert coverage, or an unsafe alert payload. CI runs this check on every change.

## Ownership and access

Platform Operations owns the dashboards, alert policies, weekly delivery canary, and incident response. The observability role may read persisted Cloudflare Worker logs, traces, and platform metrics and may manage dashboards and alert rules. It receives no database, R2, KV, KMS, Hyperdrive, Provider API Credential, OAuth secret, or Worker-secret access. It cannot decrypt Stored Messages, Stored Media, provider payloads, or identifiers. Do not copy tenant or User identity into annotations, alert destinations, tickets, or support tools.

Configure the production alert destination as the protected GitHub Actions environment secret `PAGER_WEBHOOK_URL`. The URL must be HTTPS and must not be stored in source or Worker configuration. The destination must route `page` severity to the primary on-call and `ticket` severity to the Platform Operations queue.

## Provisioning

In the production Cloudflare account, create the four dashboards and eight alert policies with the exact IDs, sources, fields, filters, thresholds, and windows in the reporting contract. Cloudflare platform fields come from Workers Analytics/Queues/KV/R2 service metrics; `workerTelemetry` fields come only from the structured events accepted by the runtime allowlist. Treat configuration drift from the committed contract as a deployment failure.

The availability dashboard must show three independent series. The first-party series is successful API/MCP service responses divided by eligible first-party requests over a rolling 30-day window, with scheduled maintenance included, against 99.5%. Wasender and WhatsApp series are dependency evidence and have no inherited objective; never subtract dependency failures from the first-party numerator or denominator.

Queue lag and dead letters use Cloudflare Queue metrics. Quota pressure is authoritative Neon quota utilization exported as an aggregate only. KMS, Stored Media, deletion-deadline, and restore-gate panels count aggregate safe outcomes only. No query may group by an opaque reference, even when that reference is permitted in an incident log event.

Vendor dashboard and alert API credentials are an external rollout gate and are intentionally not committed. After provisioning, run:

```sh
bun run observability:validate
bun run observability:canary
```

Confirm the `alert-delivery-canary` arrives in the ticket destination with only `alert`, `severity`, `status`, and `observedAt`. GitHub Actions repeats this every Monday at 15:00 UTC; a failed workflow is itself a delivery-path incident.

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

Retain monthly first-party SLO reports and dependency reports as separate aggregate artifacts. Record objective, achieved availability, error-budget consumption, incident counts, and reporting window only; do not attach raw logs or tenant-level samples.
