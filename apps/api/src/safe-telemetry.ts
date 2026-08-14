import type { SafeTelemetryEvent } from "./services";

type TelemetryRecord = Readonly<Record<string, unknown>>;
type TelemetryScalar = boolean | null | number | string;

const common = ["event", "service"] as const;

/** The complete runtime field allowlist for every production telemetry event. */
export const safeTelemetryFieldsByEvent = {
  "api_key.management.completed": [...common, "operation", "outcome"],
  "connection_health.reconciliation.completed": [
    ...common,
    "gapEvidence",
    "outcome",
    "state",
  ],
  "connection_setup.cancel.completed": [...common, "outcome"],
  "connection_setup.cleanup.completed": [...common, "failureCode", "outcome"],
  "connection_setup.cleanup.recovery_enqueued": [
    ...common,
    "candidateCount",
    "expiredCount",
  ],
  "connection_setup.provision.completed": [...common, "failureCode", "outcome"],
  "connection_setup.provision.recovery_enqueued": [...common, "candidateCount"],
  "connection_setup.qr.completed": [...common, "outcome"],
  "connection_setup.start.completed": [...common, "outcome"],
  "directory.contacts.reconciliation.completed": [
    ...common,
    "contactCount",
    "outcome",
  ],
  "directory.provider_read.completed": [
    ...common,
    "attempts",
    "durationMs",
    "operation",
    "outcome",
    "responseBytes",
  ],
  "group_directory.reconciliation.completed": [
    ...common,
    "appliedCount",
    "outcome",
    "unjoinedCount",
  ],
  "http.request.completed": [...common, "method", "route", "status"],
  "mcp.tool_call.completed": [
    ...common,
    "failureStage",
    "outcome",
    "resultCount",
    "tool",
  ],
  "mcp_authorization.management.completed": [...common, "operation", "outcome"],
  "message_retention.policy_update.completed": [...common, "outcome"],
  "message_retention.purge.completed": [...common, "purgedCount"],
  "message_search.backfill.completed": [...common, "outcome"],
  "oauth.authorization.decision.completed": [
    ...common,
    "clientClass",
    "code",
    "constraint",
    "outcome",
  ],
  "oauth.authorization.request.completed": [
    ...common,
    "clientClass",
    "outcome",
  ],
  "oauth.protocol.request.failed": [...common, "code", "status"],
  "oauth.refresh.completed": [...common, "clientClass", "outcome"],
  "onboarding_profile.upsert.completed": [...common, "outcome"],
  "personal_account.bootstrap.completed": [...common, "outcome"],
  "personal_account.deletion.completed": [...common, "outcome", "source"],
  "personal_account.deletion.deadline_risk": [
    ...common,
    "deadlineAt",
    "marker",
  ],
  "provider.directory.completed": [
    ...common,
    "attemptCount",
    "durationMs",
    "operation",
    "outcome",
    "responseBytes",
  ],
  "provider.text_send.completed": [
    ...common,
    "attemptCount",
    "durationMs",
    "operationClass",
    "outcome",
    "responseBytes",
  ],
  "recipient_exclusion.cleanup.completed": [
    ...common,
    "outcome",
    "removedCount",
  ],
  "recipient_exclusion.list.completed": [
    ...common,
    "outcome",
    "recipientCount",
  ],
  "recipient_exclusion.recovery.completed": [
    ...common,
    "outcome",
    "recoveredCount",
  ],
  "recipient_exclusion.transition.completed": [
    ...common,
    "outcome",
    "transitionKind",
  ],
  "send.dispatch_lease.sweep_completed": [...common, "expiredCount"],
  "stored-media.container.completed": [
    ...common,
    "chunkCount",
    "containerVersion",
    "operation",
    "outcome",
    "plaintextBytes",
  ],
  "tool_call_log.review.completed": [...common, "logCount"],
  "webhook_event.dead_letter.completed": [
    ...common,
    "incidentReference",
    "outcome",
  ],
  "webhook_event.processing.completed": [
    ...common,
    "appliedCount",
    "duplicateCount",
    "outcome",
    "quarantinedCount",
    "supersededCount",
    "suppressedCount",
  ],
  "webhook_event.replay.completed": [...common, "attemptReference", "outcome"],
  "webhook_event.source_retention.completed": [...common, "deletedCount"],
  "webhook_ingress.completed": [...common, "outcome"],
  "webhook_ingress.recovery.completed": [
    ...common,
    "candidateCount",
    "enqueuedCount",
    "invalidObjectCount",
  ],
  "whatsapp_connection.deletion.completed": [...common, "outcome"],
  "whatsapp_connection.deletion.deadline_risk": [
    ...common,
    "deadlineAt",
    "marker",
  ],
  "whatsapp_connection.lifecycle.completed": [
    ...common,
    "operation",
    "outcome",
  ],
  "whatsapp_connection.list.completed": [...common, "connectionCount"],
  "whatsapp_connection.rename.completed": common,
} as const satisfies Record<SafeTelemetryEvent["event"], ReadonlyArray<string>>;

export class SafeTelemetryViolation extends Error {
  constructor(location: string) {
    super(location);
    this.name = "SafeTelemetryViolation";
  }
}

const isRecord = (value: unknown): value is TelemetryRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTelemetryScalar = (value: unknown): value is TelemetryScalar =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

export const serializeSafeTelemetry = (value: unknown): string => {
  if (!isRecord(value) || typeof value.event !== "string") {
    throw new SafeTelemetryViolation("telemetry.event");
  }
  const allowed =
    safeTelemetryFieldsByEvent[
      value.event as keyof typeof safeTelemetryFieldsByEvent
    ];
  if (allowed === undefined) {
    throw new SafeTelemetryViolation("telemetry.event");
  }
  const allowedFields = new Set<string>(allowed);
  const safe: Record<string, unknown> = {};
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field) || value[field] === undefined) {
      continue;
    }
    if (!isTelemetryScalar(value[field])) {
      throw new SafeTelemetryViolation(`telemetry.${field}`);
    }
    safe[field] = value[field];
  }
  return JSON.stringify(safe);
};
