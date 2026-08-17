import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { personalAccountsInApp } from "./accounts";
import { activityLogsInApp } from "./activity-logs";
import { apiKeysInApp } from "./api-keys";
import { bytea, publicSchema } from "./common";
import { whatsappConnectionsInApp } from "./connections";
import { mcpAuthorizationsInApp } from "./mcp-authorizations";

export const sendOperationsInApp = publicSchema.table(
  "send_operations",
  {
    id: uuid().primaryKey().notNull(),
    publicId: text("public_id").notNull(),
    personalAccountId: uuid("personal_account_id").notNull(),
    grantType: text("grant_type").notNull().default("mcp"),
    mcpAuthorizationId: uuid("mcp_authorization_id"),
    apiKeyId: uuid("api_key_id"),
    activityLogId: uuid("tool_call_log_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    recipientType: text("recipient_type").notNull(),
    recipientPublicId: text("recipient_public_id").notNull(),
    status: text().notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    statusChangedAt: timestamp("status_changed_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    attemptClaimedAt: timestamp("attempt_claimed_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    messageIdentity: text("message_identity"),
  },
  (table) => [
    uniqueIndex("send_operations_message_identity")
      .using(
        "btree",
        table.whatsappConnectionId.asc().nullsLast().op("text_ops"),
        table.messageIdentity.asc().nullsLast().op("uuid_ops"),
      )
      .where(sql`(message_identity IS NOT NULL)`),
    foreignKey({
      columns: [table.personalAccountId, table.mcpAuthorizationId],
      foreignColumns: [
        mcpAuthorizationsInApp.id,
        mcpAuthorizationsInApp.personalAccountId,
      ],
      name: "send_operations_personal_account_id_mcp_authorization_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.personalAccountId, table.apiKeyId],
      foreignColumns: [apiKeysInApp.personalAccountId, apiKeysInApp.id],
      name: "send_operations_api_key_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      foreignColumns: [
        whatsappConnectionsInApp.id,
        whatsappConnectionsInApp.personalAccountId,
      ],
      name: "send_operations_personal_account_id_whatsapp_connection_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.personalAccountId, table.activityLogId],
      foreignColumns: [
        activityLogsInApp.id,
        activityLogsInApp.personalAccountId,
      ],
      name: "send_operations_personal_account_id_tool_call_log_id_fkey",
    }).onDelete("cascade"),
    unique("send_operations_public_id_key").on(table.publicId),
    unique("send_operations_tool_call_log_id_key").on(table.activityLogId),
    unique("send_operations_personal_account_id_id_key").on(
      table.id,
      table.personalAccountId,
    ),
    pgPolicy("send_operations_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "send_operations_public_id_check",
      sql`public_id ~ '^snd_[A-Za-z0-9_-]{21}$'::text`,
    ),
    check(
      "send_operations_recipient_type_check",
      sql`recipient_type = ANY (ARRAY['contact'::text, 'group'::text])`,
    ),
    check(
      "send_operations_recipient_public_id_check",
      sql`recipient_public_id ~ '^(ctc|grp)_[A-Za-z0-9_-]{21}$'::text`,
    ),
    check(
      "send_operations_status_check",
      sql`status = ANY (ARRAY['processing'::text, 'accepted'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'failed'::text, 'unknown'::text])`,
    ),
    check(
      "send_operations_check",
      sql`lease_expires_at = (attempt_claimed_at + '00:00:30'::interval)`,
    ),
    check(
      "send_operations_check1",
      sql`expires_at = (created_at + '90 days'::interval)`,
    ),
    check(
      "send_operations_grant_type_check",
      sql`grant_type = ANY (ARRAY['mcp'::text, 'api'::text])`,
    ),
    check(
      "send_operations_grant_principal",
      sql`((grant_type = 'mcp'::text) AND (mcp_authorization_id IS NOT NULL) AND (api_key_id IS NULL)) OR ((grant_type = 'api'::text) AND (mcp_authorization_id IS NULL) AND (api_key_id IS NOT NULL))`,
    ),
  ],
);

export const sendQuotaReservationsInApp = publicSchema.table(
  "send_quota_reservations",
  {
    sendOperationId: uuid("send_operation_id").primaryKey().notNull(),
    personalAccountId: uuid("personal_account_id").notNull(),
    grantType: text("grant_type").notNull().default("mcp"),
    mcpAuthorizationId: uuid("mcp_authorization_id"),
    apiKeyId: uuid("api_key_id"),
    reservedAt: timestamp("reserved_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    index("send_quota_account_time").using(
      "btree",
      table.personalAccountId.asc().nullsLast().op("timestamptz_ops"),
      table.reservedAt.asc().nullsLast().op("timestamptz_ops"),
    ),
    index("send_quota_authorization_time").using(
      "btree",
      table.mcpAuthorizationId.asc().nullsLast().op("uuid_ops"),
      table.reservedAt.asc().nullsLast().op("uuid_ops"),
    ),
    index("send_quota_api_key_time")
      .using(
        "btree",
        table.apiKeyId.asc().nullsLast().op("timestamptz_ops"),
        table.reservedAt.asc().nullsLast().op("timestamptz_ops"),
      )
      .where(sql`(api_key_id IS NOT NULL)`),
    foreignKey({
      columns: [table.personalAccountId],
      foreignColumns: [personalAccountsInApp.id],
      name: "send_quota_reservations_personal_account_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.personalAccountId, table.mcpAuthorizationId],
      foreignColumns: [
        mcpAuthorizationsInApp.id,
        mcpAuthorizationsInApp.personalAccountId,
      ],
      name: "send_quota_reservations_personal_account_id_mcp_authorizat_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.personalAccountId, table.apiKeyId],
      foreignColumns: [apiKeysInApp.personalAccountId, apiKeysInApp.id],
      name: "send_quota_reservations_api_key_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sendOperationId, table.personalAccountId],
      foreignColumns: [
        sendOperationsInApp.id,
        sendOperationsInApp.personalAccountId,
      ],
      name: "send_quota_reservations_personal_account_id_send_operation_fkey",
    }).onDelete("cascade"),
    pgPolicy("send_quota_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "send_quota_reservations_grant_type_check",
      sql`grant_type = ANY (ARRAY['mcp'::text, 'api'::text])`,
    ),
    check(
      "send_quota_reservations_grant_principal",
      sql`((grant_type = 'mcp'::text) AND (mcp_authorization_id IS NOT NULL) AND (api_key_id IS NULL)) OR ((grant_type = 'api'::text) AND (mcp_authorization_id IS NULL) AND (api_key_id IS NOT NULL))`,
    ),
  ],
);

export const pendingSendContentsInApp = publicSchema.table(
  "pending_send_contents",
  {
    sendOperationId: uuid("send_operation_id").primaryKey().notNull(),
    personalAccountId: uuid("personal_account_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    ciphertextVersion: smallint("ciphertext_version").notNull(),
    keyVersion: integer("key_version").notNull(),
    nonce: bytea("nonce").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      foreignColumns: [
        whatsappConnectionsInApp.id,
        whatsappConnectionsInApp.personalAccountId,
      ],
      name: "pending_send_contents_personal_account_id_whatsapp_connect_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sendOperationId, table.personalAccountId],
      foreignColumns: [
        sendOperationsInApp.id,
        sendOperationsInApp.personalAccountId,
      ],
      name: "pending_send_contents_personal_account_id_send_operation_i_fkey",
    }).onDelete("cascade"),
    pgPolicy("pending_send_contents_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "pending_send_contents_ciphertext_version_check",
      sql`ciphertext_version = 1`,
    ),
    check("pending_send_contents_key_version_check", sql`key_version > 0`),
    check("pending_send_contents_nonce_check", sql`octet_length(nonce) = 12`),
    check(
      "pending_send_contents_ciphertext_check",
      sql`octet_length(ciphertext) > 16`,
    ),
  ],
);

export const sendIdempotencyBindingsInApp = publicSchema.table(
  "send_idempotency_bindings",
  {
    personalAccountId: uuid("personal_account_id").notNull(),
    grantType: text("grant_type").notNull().default("mcp"),
    grantId: uuid("grant_id").notNull(),
    mcpAuthorizationId: uuid("mcp_authorization_id"),
    apiKeyId: uuid("api_key_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    sendOperationId: uuid("send_operation_id").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.personalAccountId, table.mcpAuthorizationId],
      foreignColumns: [
        mcpAuthorizationsInApp.id,
        mcpAuthorizationsInApp.personalAccountId,
      ],
      name: "send_idempotency_bindings_personal_account_id_mcp_authoriz_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.personalAccountId, table.sendOperationId],
      foreignColumns: [
        sendOperationsInApp.id,
        sendOperationsInApp.personalAccountId,
      ],
      name: "send_idempotency_bindings_personal_account_id_send_operati_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.personalAccountId, table.apiKeyId],
      foreignColumns: [apiKeysInApp.personalAccountId, apiKeysInApp.id],
      name: "send_idempotency_bindings_api_key_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.idempotencyKey, table.grantId],
      name: "send_idempotency_bindings_pkey",
    }),
    unique("send_idempotency_bindings_send_operation_id_key").on(
      table.sendOperationId,
    ),
    pgPolicy("send_bindings_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "send_idempotency_bindings_idempotency_key_check",
      sql`idempotency_key ~ '^[A-Za-z0-9_-]{21}$'::text`,
    ),
    check(
      "send_idempotency_bindings_request_fingerprint_check",
      sql`request_fingerprint ~ '^sf1_[A-Za-z0-9_-]{43}$'::text`,
    ),
    check(
      "send_idempotency_bindings_check",
      sql`expires_at = (created_at + '90 days'::interval)`,
    ),
    check(
      "send_idempotency_bindings_grant_type_check",
      sql`grant_type = ANY (ARRAY['mcp'::text, 'api'::text])`,
    ),
    check(
      "send_idempotency_bindings_grant_principal",
      sql`((grant_type = 'mcp'::text) AND (grant_id = mcp_authorization_id) AND (mcp_authorization_id IS NOT NULL) AND (api_key_id IS NULL)) OR ((grant_type = 'api'::text) AND (grant_id = api_key_id) AND (mcp_authorization_id IS NULL) AND (api_key_id IS NOT NULL))`,
    ),
  ],
);
