import type {
  DeployableName,
  DeploymentEnvironment,
} from "@whatsapp-mcp/domain/deployment";
import { Context, type Effect } from "effect";
import type { DeletionCapsuleWriter } from "./deletion/capsule";
import type { DeletionMarkerStore } from "./deletion/marker";
import type { StoredMediaContainerEvent } from "./encryption/stored-media-container";

export interface ApplicationConfig {
  readonly environment: DeploymentEnvironment;
  readonly service: DeployableName;
}

export const ApplicationConfig = Context.GenericTag<ApplicationConfig>(
  "@whatsapp-mcp/api/ApplicationConfig",
);

export interface DatabaseReadiness {
  readonly check: Effect.Effect<void, unknown>;
}

export const DatabaseReadiness = Context.GenericTag<DatabaseReadiness>(
  "@whatsapp-mcp/api/DatabaseReadiness",
);

export interface RestoreSafeDeletion {
  readonly capsules: DeletionCapsuleWriter;
  readonly markers: DeletionMarkerStore;
}

export const RestoreSafeDeletion = Context.GenericTag<RestoreSafeDeletion>(
  "@whatsapp-mcp/api/RestoreSafeDeletion",
);

export interface HttpCompletedEvent {
  readonly event: "http.request.completed";
  readonly method: string;
  readonly route: "health" | "ready" | "unmatched";
  readonly service: DeployableName;
  readonly status: number;
}

export interface PersonalAccountBootstrapCompletedEvent {
  readonly event: "personal_account.bootstrap.completed";
  readonly outcome: "created" | "recovered";
  readonly service: "api";
}

export interface PersonalAccountDeletionCompletedEvent {
  readonly event: "personal_account.deletion.completed";
  readonly outcome: "deleting" | "unknown_identity";
  readonly service: "api";
  readonly source: "clerk_webhook" | "product";
}

export interface OnboardingProfileUpsertCompletedEvent {
  readonly event: "onboarding_profile.upsert.completed";
  readonly outcome: "not_found" | "success";
  readonly service: "api";
}

export interface ConnectionSetupStartCompletedEvent {
  readonly event: "connection_setup.start.completed";
  readonly outcome:
    | "connection_limit_reached"
    | "created"
    | "idempotency_conflict"
    | "number_unavailable"
    | "onboarding_profile_required"
    | "replay";
  readonly service: "api";
}

export interface ConnectionSetupCancelCompletedEvent {
  readonly event: "connection_setup.cancel.completed";
  readonly outcome: "cancelled" | "replay";
  readonly service: "api";
}

export interface ConnectionSetupCleanupCompletedEvent {
  readonly event: "connection_setup.cleanup.completed";
  readonly failureCode?: string | undefined;
  readonly outcome: "complete" | "ignored" | "retry";
  readonly service: "api";
}

export interface ConnectionSetupCleanupRecoveryEnqueuedEvent {
  readonly candidateCount: number;
  readonly event: "connection_setup.cleanup.recovery_enqueued";
  readonly expiredCount: number;
  readonly service: "api";
}

export interface ConnectionSetupProvisionCompletedEvent {
  readonly event: "connection_setup.provision.completed";
  readonly failureCode?: string | undefined;
  readonly outcome:
    | "failed"
    | "ignored"
    | "provisioned"
    | "quarantined"
    | "retry";
  readonly service: "api";
}

export interface ConnectionSetupProvisionRecoveryEnqueuedEvent {
  readonly candidateCount: number;
  readonly event: "connection_setup.provision.recovery_enqueued";
  readonly service: "api";
}

export interface ConnectionSetupQrCompletedEvent {
  readonly event: "connection_setup.qr.completed";
  readonly outcome:
    | "connected"
    | "connecting"
    | "pending"
    | "provider_capacity_unavailable"
    | "provisioning_failed"
    | "provisioning_quarantined"
    | "qr_available";
  readonly service: "api";
}

export interface WhatsAppConnectionListCompletedEvent {
  readonly connectionCount: number;
  readonly event: "whatsapp_connection.list.completed";
  readonly service: "api";
}

export interface WhatsAppConnectionRenameCompletedEvent {
  readonly event: "whatsapp_connection.rename.completed";
  readonly service: "api";
}

export interface WebhookIngressCompletedEvent {
  readonly event: "webhook_ingress.completed";
  readonly outcome:
    | "accepted"
    | "authentication_failed"
    | "invalid_payload"
    | "not_found"
    | "too_large"
    | "unavailable";
  readonly service: "api";
}

export interface WebhookIngressRecoveryCompletedEvent {
  readonly candidateCount: number;
  readonly enqueuedCount: number;
  readonly event: "webhook_ingress.recovery.completed";
  readonly invalidObjectCount: number;
  readonly service: "api";
}

export interface WebhookEventProcessingCompletedEvent {
  readonly appliedCount: number;
  readonly duplicateCount: number;
  readonly event: "webhook_event.processing.completed";
  readonly outcome: "completed" | "invalid_message" | "retry";
  readonly quarantinedCount: number;
  readonly service: "api";
  readonly supersededCount: number;
  readonly suppressedCount: number;
}

export interface WebhookEventDeadLetterCompletedEvent {
  readonly event: "webhook_event.dead_letter.completed";
  readonly incidentReference: string | null;
  readonly outcome:
    | "already_completed"
    | "gap_recorded"
    | "invalid_message"
    | "source_unavailable";
  readonly service: "api";
}

export interface WebhookEventReplayCompletedEvent {
  readonly attemptReference: string | null;
  readonly event: "webhook_event.replay.completed";
  readonly outcome:
    | "already_dispatched"
    | "dispatched"
    | "invalid_message"
    | "source_unavailable";
  readonly service: "api";
}

export interface WebhookEventSourceRetentionCompletedEvent {
  readonly deletedCount: number;
  readonly event: "webhook_event.source_retention.completed";
  readonly service: "api";
}

export interface WhatsAppConnectionLifecycleCompletedEvent {
  readonly event: "whatsapp_connection.lifecycle.completed";
  readonly operation: "disconnect" | "reconnect";
  readonly outcome:
    | "complete"
    | "in_progress"
    | "qr_available"
    | "recovery_required";
  readonly service: "api";
}
export interface WhatsAppConnectionDeletionCompletedEvent {
  readonly event: "whatsapp_connection.deletion.completed";
  readonly outcome: "complete";
  readonly service: "api";
}

export interface WhatsAppConnectionDeletionDeadlineRiskEvent {
  readonly deadlineAt: string;
  readonly event: "whatsapp_connection.deletion.deadline_risk";
  readonly marker: string;
  readonly service: "api";
}

export interface PersonalAccountDeletionDeadlineRiskEvent {
  readonly deadlineAt: string;
  readonly event: "personal_account.deletion.deadline_risk";
  readonly marker: string;
  readonly service: "api";
}

export interface ConnectionHealthReconciliationCompletedEvent {
  readonly event: "connection_health.reconciliation.completed";
  readonly gapEvidence:
    | "healthy"
    | "connection_unavailable"
    | "webhook_configuration"
    | "unknown";
  readonly outcome: "applied" | "superseded";
  readonly service: "api";
  readonly state:
    | "connected"
    | "degraded"
    | "disconnected"
    | "reconnect_required";
}

export interface OAuthAuthorizationRequestCompletedEvent {
  readonly clientClass?: string | undefined;
  readonly event: "oauth.authorization.request.completed";
  readonly outcome: "accepted" | "invalid_request";
  readonly service: "api";
}

export interface OAuthProtocolRequestFailedEvent {
  readonly code: string;
  readonly event: "oauth.protocol.request.failed";
  readonly service: "api";
  readonly status: number;
}

export interface OAuthAuthorizationDecisionCompletedEvent {
  readonly clientClass: string;
  readonly code?: string | undefined;
  readonly constraint?: string | undefined;
  readonly event: "oauth.authorization.decision.completed";
  readonly outcome:
    | "approved"
    | "denied"
    | "unavailable_identifiers"
    | "unavailable_oauth"
    | "unavailable_persistence";
  readonly service: "api";
}

export interface OAuthRefreshCompletedEvent {
  readonly clientClass?: string | undefined;
  readonly event: "oauth.refresh.completed";
  readonly outcome: "invalid" | "reuse" | "rotated" | "unavailable";
  readonly service: "api";
}

export interface McpAuthorizationManagementCompletedEvent {
  readonly event: "mcp_authorization.management.completed";
  readonly operation: "list" | "revoke";
  readonly outcome: "not_found" | "success";
  readonly service: "api";
}

export interface ApiKeyManagementCompletedEvent {
  readonly event: "api_key.management.completed";
  readonly operation: "create" | "list" | "revoke";
  readonly outcome:
    | "created"
    | "duplicate_name"
    | "invalid"
    | "limit_reached"
    | "not_found"
    | "success";
  readonly service: "api";
}

export interface RestOperationCompletedEvent {
  readonly event: "rest.operation.completed";
  readonly operation: "list_connections" | "list_contacts" | "list_chats";
  readonly outcome:
    | "audit_unavailable"
    | "authorization_denied"
    | "invalid_cursor"
    | "rate_limited"
    | "success"
    | "unavailable";
  readonly resultCount?: number | undefined;
  readonly service: "api";
}

export interface McpToolCallCompletedEvent {
  readonly event: "mcp.tool_call.completed";
  readonly failureStage?:
    | "audit_completion"
    | "configuration"
    | "decryption_account_key"
    | "decryption_ciphertext"
    | "decryption_connection_key"
    | "decryption"
    | "output"
    | "query"
    | undefined;
  readonly outcome:
    | "audit_unavailable"
    | "authorization_denied"
    | "execution_error"
    | "invalid_cursor"
    | "rate_limited"
    | "service_unavailable"
    | "success";
  readonly resultCount?: number | undefined;
  readonly service: "api";
  readonly tool:
    | "list_connections"
    | "list_contacts"
    | "list_groups"
    | "get_send_status"
    | "send_text_message"
    | "list_chats"
    | "read_messages"
    | "search_messages";
}

export interface ActivityLogReviewCompletedEvent {
  readonly event: "activity_log.review.completed";
  readonly logCount: number;
  readonly service: "api";
}

export interface GroupDirectoryReconciliationCompletedEvent {
  readonly appliedCount?: number | undefined;
  readonly event: "group_directory.reconciliation.completed";
  readonly outcome: "failed" | "success";
  readonly service: "api";
  readonly unjoinedCount?: number | undefined;
}

export interface ProviderDirectoryCompletedEvent {
  readonly attemptCount: number;
  readonly durationMs: number;
  readonly event: "provider.directory.completed";
  readonly operation: "safe-read";
  readonly outcome: "complete" | "failed" | "partial";
  readonly responseBytes: number;
  readonly service: "api";
}

export interface ContactReconciliationCompletedEvent {
  readonly contactCount: number;
  readonly event: "directory.contacts.reconciliation.completed";
  readonly outcome: "complete" | "failed" | "partial";
  readonly service: "api";
}

export interface DirectoryProviderReadCompletedEvent {
  readonly attempts: number;
  readonly durationMs: number;
  readonly event: "directory.provider_read.completed";
  readonly operation: "safe-read";
  readonly outcome: "complete" | "failed" | "partial";
  readonly responseBytes: number;
  readonly service: "api";
}

export interface ProviderTextSendCompletedEvent {
  readonly attemptCount: 0 | 1;
  readonly durationMs: number;
  readonly event: "provider.text_send.completed";
  readonly operationClass: "text-send";
  readonly outcome:
    | "ambiguous"
    | "definitive_failure"
    | "identity_evidence"
    | "provider_acknowledgement";
  readonly responseBytes: number | null;
  readonly service: "api";
}

export interface SendDispatchLeaseSweepCompletedEvent {
  readonly event: "send.dispatch_lease.sweep_completed";
  readonly expiredCount: number;
  readonly service: "api";
}

export interface MessageRetentionPolicyUpdateCompletedEvent {
  readonly event: "message_retention.policy_update.completed";
  readonly outcome: "conflict_or_not_found" | "success";
  readonly service: "api";
}

export interface MessageRetentionPurgeCompletedEvent {
  readonly event: "message_retention.purge.completed";
  readonly purgedCount: number;
  readonly service: "api";
}

export interface MessageSearchBackfillCompletedEvent {
  readonly event: "message_search.backfill.completed";
  readonly outcome: "failed" | "success";
  readonly service: "api";
}

export interface RecipientExclusionCleanupCompletedEvent {
  readonly event: "recipient_exclusion.cleanup.completed";
  readonly outcome: "success";
  readonly removedCount: number;
  readonly service: "api";
}

export interface RecipientExclusionListCompletedEvent {
  readonly event: "recipient_exclusion.list.completed";
  readonly outcome: "success";
  readonly recipientCount: number;
  readonly service: "api";
}

export interface RecipientExclusionRecoveryCompletedEvent {
  readonly event: "recipient_exclusion.recovery.completed";
  readonly outcome: "success";
  readonly recoveredCount: number;
  readonly service: "api";
}

export interface RecipientExclusionTransitionCompletedEvent {
  readonly event: "recipient_exclusion.transition.completed";
  readonly outcome: "conflict" | "replayed" | "success" | "unchanged";
  readonly service: "api";
  readonly transitionKind: "exclude" | "re_enable";
}

export interface SafeTelemetry {
  readonly emit: (event: SafeTelemetryEvent) => Effect.Effect<void>;
}

export type SafeTelemetryEvent =
  | ContactReconciliationCompletedEvent
  | DirectoryProviderReadCompletedEvent
  | ConnectionHealthReconciliationCompletedEvent
  | ConnectionSetupCancelCompletedEvent
  | ConnectionSetupCleanupCompletedEvent
  | ConnectionSetupCleanupRecoveryEnqueuedEvent
  | ConnectionSetupProvisionCompletedEvent
  | ConnectionSetupProvisionRecoveryEnqueuedEvent
  | ConnectionSetupQrCompletedEvent
  | ConnectionSetupStartCompletedEvent
  | GroupDirectoryReconciliationCompletedEvent
  | HttpCompletedEvent
  | ApiKeyManagementCompletedEvent
  | RestOperationCompletedEvent
  | McpAuthorizationManagementCompletedEvent
  | McpToolCallCompletedEvent
  | MessageRetentionPolicyUpdateCompletedEvent
  | MessageRetentionPurgeCompletedEvent
  | MessageSearchBackfillCompletedEvent
  | OAuthAuthorizationDecisionCompletedEvent
  | OAuthAuthorizationRequestCompletedEvent
  | OAuthProtocolRequestFailedEvent
  | OAuthRefreshCompletedEvent
  | OnboardingProfileUpsertCompletedEvent
  | PersonalAccountBootstrapCompletedEvent
  | PersonalAccountDeletionCompletedEvent
  | PersonalAccountDeletionDeadlineRiskEvent
  | ProviderDirectoryCompletedEvent
  | ProviderTextSendCompletedEvent
  | RecipientExclusionCleanupCompletedEvent
  | RecipientExclusionListCompletedEvent
  | RecipientExclusionRecoveryCompletedEvent
  | RecipientExclusionTransitionCompletedEvent
  | SendDispatchLeaseSweepCompletedEvent
  | StoredMediaContainerEvent
  | ActivityLogReviewCompletedEvent
  | WebhookEventDeadLetterCompletedEvent
  | WebhookEventReplayCompletedEvent
  | WebhookEventSourceRetentionCompletedEvent
  | WebhookEventProcessingCompletedEvent
  | WebhookIngressCompletedEvent
  | WebhookIngressRecoveryCompletedEvent
  | WhatsAppConnectionLifecycleCompletedEvent
  | WhatsAppConnectionDeletionCompletedEvent
  | WhatsAppConnectionDeletionDeadlineRiskEvent
  | WhatsAppConnectionListCompletedEvent
  | WhatsAppConnectionRenameCompletedEvent;

export const SafeTelemetry = Context.GenericTag<SafeTelemetry>(
  "@whatsapp-mcp/api/SafeTelemetry",
);
