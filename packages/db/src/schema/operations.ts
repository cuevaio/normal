import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { personalAccountsInApp } from "./accounts";
import { publicSchema } from "./common";

export const breakGlassRequestsInAppPrivate = publicSchema.table(
  "break_glass_requests",
  {
    id: uuid().primaryKey().notNull(),
    incidentReference: text("incident_reference").notNull(),
    reason: text().notNull(),
    requesterReference: text("requester_reference").notNull(),
    personalAccountId: uuid("personal_account_id").notNull(),
    capability: text().notNull(),
    legalNotificationProhibition: text("legal_notification_prohibition"),
    requestedAt: timestamp("requested_at", {
      withTimezone: true,
      mode: "string",
    })
      .default(sql`statement_timestamp()`)
      .notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    credentialSha256: text("credential_sha256"),
    credentialIssuedAt: timestamp("credential_issued_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    foreignKey({
      columns: [table.personalAccountId],
      foreignColumns: [personalAccountsInApp.id],
      name: "break_glass_requests_personal_account_id_fkey",
    }),
    check(
      "break_glass_requests_incident_reference_check",
      sql`(length(incident_reference) >= 1) AND (length(incident_reference) <= 200)`,
    ),
    check(
      "break_glass_requests_reason_check",
      sql`(length(reason) >= 1) AND (length(reason) <= 2000)`,
    ),
    check(
      "break_glass_requests_requester_reference_check",
      sql`requester_reference ~ '^[A-Za-z0-9_-]{3,128}$'::text`,
    ),
    check(
      "break_glass_requests_capability_check",
      sql`capability = ANY (ARRAY['message_content'::text, 'stored_media'::text])`,
    ),
    check(
      "break_glass_requests_legal_notification_prohibition_check",
      sql`(legal_notification_prohibition IS NULL) OR ((length(legal_notification_prohibition) >= 1) AND (length(legal_notification_prohibition) <= 2000))`,
    ),
    check(
      "break_glass_requests_credential_sha256_check",
      sql`credential_sha256 ~ '^[a-f0-9]{64}$'::text`,
    ),
    check(
      "break_glass_requests_check",
      sql`(expires_at > requested_at) AND (expires_at <= (requested_at + '01:00:00'::interval))`,
    ),
    check(
      "break_glass_requests_check1",
      sql`(credential_sha256 IS NULL) = (credential_issued_at IS NULL)`,
    ),
  ],
);

export const breakGlassAuditEventsInAppPrivate = publicSchema.table(
  "break_glass_audit_events",
  {
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({
      name: "public.break_glass_audit_events_id_seq",
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: "9223372036854775807",
      cache: 1,
    }),
    requestId: uuid("request_id").notNull(),
    eventType: text("event_type").notNull(),
    actorReference: text("actor_reference").notNull(),
    outcome: text().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" })
      .default(sql`statement_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.requestId],
      foreignColumns: [breakGlassRequestsInAppPrivate.id],
      name: "break_glass_audit_events_request_id_fkey",
    }),
    check(
      "break_glass_audit_events_event_type_check",
      sql`event_type = ANY (ARRAY['requested'::text, 'approved'::text, 'credential_issued'::text, 'decryption_attempt_allowed'::text, 'decryption_attempt_denied'::text, 'decryption_succeeded'::text, 'decryption_failed'::text, 'expired'::text])`,
    ),
    check(
      "break_glass_audit_events_actor_reference_check",
      sql`actor_reference ~ '^[A-Za-z0-9_-]{3,128}$'::text`,
    ),
    check(
      "break_glass_audit_events_outcome_check",
      sql`outcome = ANY (ARRAY['recorded'::text, 'allowed'::text, 'denied'::text])`,
    ),
  ],
);

export const breakGlassUserNotificationsInAppPrivate = publicSchema.table(
  "break_glass_user_notifications",
  {
    requestId: uuid("request_id").primaryKey().notNull(),
    personalAccountId: uuid("personal_account_id").notNull(),
    queuedAt: timestamp("queued_at", { withTimezone: true, mode: "string" })
      .default(sql`statement_timestamp()`)
      .notNull(),
    deliveredAt: timestamp("delivered_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    foreignKey({
      columns: [table.requestId],
      foreignColumns: [breakGlassRequestsInAppPrivate.id],
      name: "break_glass_user_notifications_request_id_fkey",
    }),
    foreignKey({
      columns: [table.personalAccountId],
      foreignColumns: [personalAccountsInApp.id],
      name: "break_glass_user_notifications_personal_account_id_fkey",
    }),
    check(
      "break_glass_user_notifications_check",
      sql`(delivered_at IS NULL) OR (delivered_at >= queued_at)`,
    ),
  ],
);

export const breakGlassApprovalsInAppPrivate = publicSchema.table(
  "break_glass_approvals",
  {
    requestId: uuid("request_id").notNull(),
    approverReference: text("approver_reference").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" })
      .default(sql`statement_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.requestId],
      foreignColumns: [breakGlassRequestsInAppPrivate.id],
      name: "break_glass_approvals_request_id_fkey",
    }),
    primaryKey({
      columns: [table.approverReference, table.requestId],
      name: "break_glass_approvals_pkey",
    }),
    check(
      "break_glass_approvals_approver_reference_check",
      sql`approver_reference ~ '^[A-Za-z0-9_-]{3,128}$'::text`,
    ),
  ],
);

export const restoreReplayAuditInAppPrivate = publicSchema.table(
  "restore_replay_audit",
  {
    branchId: text("branch_id").primaryKey().notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    markerCount: integer("marker_count").notNull(),
    deletedEntityCount: integer("deleted_entity_count").notNull(),
    expiredRecordCount: integer("expired_record_count").notNull(),
    apiKeysRevoked: integer("api_keys_revoked").default(0).notNull(),
    apiKeyDigestsCleared: integer("api_key_digests_cleared")
      .default(0)
      .notNull(),
  },
  (_table) => [
    check(
      "restore_replay_audit_branch_id_check",
      sql`branch_id ~ '^br-[A-Za-z0-9_-]{1,120}$'::text`,
    ),
    check("restore_replay_audit_marker_count_check", sql`marker_count >= 0`),
    check(
      "restore_replay_audit_deleted_entity_count_check",
      sql`deleted_entity_count >= 0`,
    ),
    check(
      "restore_replay_audit_expired_record_count_check",
      sql`expired_record_count >= 0`,
    ),
    check(
      "restore_replay_audit_api_keys_revoked_check",
      sql`api_keys_revoked >= 0`,
    ),
    check(
      "restore_replay_audit_api_key_digests_cleared_check",
      sql`api_key_digests_cleared >= 0`,
    ),
  ],
);

export const personalAccountEnvelopeRecoveryOperationsInAppPrivate =
  publicSchema.table(
    "personal_account_envelope_recovery_operations",
    {
      changeReference: text("change_reference").primaryKey().notNull(),
      personalAccountId: uuid("personal_account_id").notNull().unique(),
      sourcePointAt: timestamp("source_point_at", {
        withTimezone: true,
        mode: "string",
      }).notNull(),
      recoveredKeyVersion: integer("recovered_key_version").notNull(),
      completedAt: timestamp("completed_at", {
        withTimezone: true,
        mode: "string",
      })
        .default(sql`statement_timestamp()`)
        .notNull(),
    },
    (table) => [
      foreignKey({
        columns: [table.personalAccountId],
        foreignColumns: [personalAccountsInApp.id],
        name: "personal_account_envelope_recovery_operations_account_fkey",
      }).onDelete("cascade"),
      check(
        "personal_account_envelope_recovery_operations_reference_check",
        sql`change_reference ~ '^change_[a-f0-9]{32}$'::text`,
      ),
      check(
        "personal_account_envelope_recovery_operations_key_version_check",
        sql`recovered_key_version > 0`,
      ),
      check(
        "personal_account_envelope_recovery_operations_time_check",
        sql`source_point_at <= completed_at`,
      ),
    ],
  );

export const restoreReadinessInAppPrivate = publicSchema.table(
  "restore_readiness",
  {
    singleton: boolean().default(true).primaryKey().notNull(),
    branchId: text("branch_id").notNull(),
    state: text().notNull(),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    markerCount: integer("marker_count"),
    deletedEntityCount: integer("deleted_entity_count"),
    expiredRecordCount: integer("expired_record_count"),
    apiKeysRevoked: integer("api_keys_revoked"),
    apiKeyDigestsCleared: integer("api_key_digests_cleared"),
    verificationRequired: boolean("verification_required")
      .default(false)
      .notNull(),
  },
  (_table) => [
    check("restore_readiness_singleton_check", sql`CHECK (singleton)`),
    check(
      "restore_readiness_branch_id_check",
      sql`branch_id ~ '^br-[A-Za-z0-9_-]{1,120}$'::text`,
    ),
    check(
      "restore_readiness_state_check",
      sql`state = ANY (ARRAY['replaying'::text, 'awaiting_verification'::text, 'drill_verified'::text, 'ready'::text])`,
    ),
    check(
      "restore_readiness_marker_count_check",
      sql`(marker_count IS NULL) OR (marker_count >= 0)`,
    ),
    check(
      "restore_readiness_deleted_entity_count_check",
      sql`(deleted_entity_count IS NULL) OR (deleted_entity_count >= 0)`,
    ),
    check(
      "restore_readiness_expired_record_count_check",
      sql`(expired_record_count IS NULL) OR (expired_record_count >= 0)`,
    ),
    check(
      "restore_readiness_api_keys_revoked_check",
      sql`(api_keys_revoked IS NULL) OR (api_keys_revoked >= 0)`,
    ),
    check(
      "restore_readiness_api_key_digests_cleared_check",
      sql`(api_key_digests_cleared IS NULL) OR (api_key_digests_cleared >= 0)`,
    ),
    check(
      "restore_readiness_check",
      sql`((state = 'replaying'::text) AND (completed_at IS NULL)) OR ((state = ANY (ARRAY['awaiting_verification'::text, 'drill_verified'::text, 'ready'::text])) AND (completed_at IS NOT NULL) AND (marker_count IS NOT NULL) AND (deleted_entity_count IS NOT NULL) AND (expired_record_count IS NOT NULL) AND (api_keys_revoked IS NOT NULL) AND (api_key_digests_cleared IS NOT NULL) AND ((verification_required AND (state = ANY (ARRAY['awaiting_verification'::text, 'drill_verified'::text]))) OR ((NOT verification_required) AND (state = 'ready'::text))))`,
    ),
  ],
);

export const restoreObjectDeletionsInAppPrivate = publicSchema.table(
  "restore_object_deletions",
  {
    bucket: text().notNull(),
    objectKey: text("object_key").notNull(),
    personalAccountId: uuid("personal_account_id"),
    retainedBytes: bigint("retained_bytes", { mode: "number" }),
  },
  (table) => [
    primaryKey({
      columns: [table.bucket, table.objectKey],
      name: "restore_object_deletions_pkey",
    }),
    check(
      "restore_object_deletions_bucket_check",
      sql`bucket = ANY (ARRAY['stored_media'::text, 'webhook_ingress'::text])`,
    ),
    check(
      "restore_object_deletions_object_key_check",
      sql`object_key <> ''::text`,
    ),
    check(
      "restore_object_deletions_retained_bytes_check",
      sql`retained_bytes > 0`,
    ),
  ],
);

export const securityRecordsInAppPrivate = publicSchema.table(
  "security_records",
  {
    category: text().notNull(),
    clientClass: text("client_class").notNull(),
    outcome: text().notNull(),
    resultCount: integer("result_count"),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    latencyMs: integer("latency_ms"),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    index("security_records_expiry").using(
      "btree",
      table.expiresAt.asc().nullsLast().op("timestamptz_ops"),
    ),
    check(
      "security_records_category_check",
      sql`category = ANY (ARRAY['tool_call'::text, 'protected_resource'::text])`,
    ),
    check(
      "security_records_client_class_check",
      sql`client_class ~ '^[a-z][a-z0-9_-]{0,63}$'::text`,
    ),
    check(
      "security_records_outcome_check",
      sql`outcome = ANY (ARRAY['started'::text, 'success'::text, 'execution_error'::text, 'rate_limited'::text, 'authorization_denied'::text])`,
    ),
    check(
      "security_records_result_count_check",
      sql`(result_count IS NULL) OR (result_count >= 0)`,
    ),
    check(
      "security_records_latency_ms_check",
      sql`(latency_ms IS NULL) OR (latency_ms >= 0)`,
    ),
    check(
      "security_records_check",
      sql`expires_at = (started_at + '90 days'::interval)`,
    ),
  ],
);

export const personalAccountCleanupAuditInAppPrivate = publicSchema.table(
  "personal_account_cleanup_audit",
  {
    deletionMarkerId: text("deletion_marker_id").primaryKey().notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    index("personal_account_cleanup_audit_expiry").using(
      "btree",
      table.expiresAt.asc().nullsLast().op("timestamptz_ops"),
    ),
    check(
      "personal_account_cleanup_audit_deletion_marker_id_check",
      sql`deletion_marker_id ~ '^[a-f0-9]{64}$'::text`,
    ),
    check(
      "personal_account_cleanup_audit_check",
      sql`expires_at = (completed_at + '90 days'::interval)`,
    ),
  ],
);
