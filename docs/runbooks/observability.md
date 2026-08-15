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
- A five-minute Wasender or WhatsApp outage pages as a dependency incident and remains distinct from first-party SLO reporting.

Retain monthly first-party SLO reports and dependency reports as separate aggregate artifacts. Record objective, achieved availability, error-budget consumption, incident counts, and reporting window only; do not attach raw logs or tenant-level samples.
