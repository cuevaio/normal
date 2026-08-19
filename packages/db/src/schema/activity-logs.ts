import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { personalAccountsInApp } from "./accounts";
import { publicSchema } from "./common";
import { mcpAuthorizationsInApp } from "./mcp-authorizations";

export const activityLogsInApp = publicSchema.table(
  "tool_call_logs",
  {
    id: uuid().primaryKey().notNull(),
    personalAccountId: uuid("personal_account_id").notNull(),
    mcpAuthorizationId: uuid("mcp_authorization_id"),
    channel: text("channel").default("mcp").notNull(),
    apiKeyId: uuid("api_key_id"),
    apiKeyPublicId: text("api_key_public_id"),
    apiKeyName: text("api_key_name"),
    toolName: text("tool_name").notNull(),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    outcome: text().notNull(),
    errorCode: text("error_code"),
    resultCount: integer("result_count"),
    latencyMs: integer("latency_ms"),
    quotaReserved: boolean("quota_reserved").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    mediaBytesReserved: bigint("media_bytes_reserved", { mode: "number" })
      .default(0)
      .notNull(),
    publicId: text("public_id")
      .default(
        sql`(\'tcl_\'::text || translate(SUBSTRING(encode(decode(md5((gen_random_uuid())::text), \'hex\'::text), \'base64\'::text) FROM 1 FOR 21), \'+/\'::text, \'-_\'::text))`,
      )
      .notNull(),
    connectionPublicId: text("connection_public_id"),
    sendPublicId: text("send_public_id"),
  },
  (table) => [
    index("tool_call_logs_expiry").using(
      "btree",
      table.expiresAt.asc().nullsLast().op("timestamptz_ops"),
      table.id.asc().nullsLast().op("uuid_ops"),
    ),
    index("tool_call_logs_media_quota")
      .using(
        "btree",
        table.personalAccountId.asc().nullsLast().op("uuid_ops"),
        table.startedAt.asc().nullsLast().op("uuid_ops"),
        table.mediaBytesReserved.asc().nullsLast().op("timestamptz_ops"),
      )
      .where(sql`(media_bytes_reserved > 0)`),
    index("tool_call_logs_request_quota")
      .using(
        "btree",
        table.personalAccountId.asc().nullsLast().op("uuid_ops"),
        table.startedAt.asc().nullsLast().op("timestamptz_ops"),
        table.id.asc().nullsLast().op("timestamptz_ops"),
      )
      .where(sql`quota_reserved`),
    index("tool_call_logs_api_key_request_quota")
      .using(
        "btree",
        table.apiKeyId.asc().nullsLast().op("uuid_ops"),
        table.startedAt.asc().nullsLast().op("timestamptz_ops"),
        table.id.asc().nullsLast().op("uuid_ops"),
      )
      .where(sql`(quota_reserved AND (api_key_id IS NOT NULL))`),
    index("tool_call_logs_review_page").using(
      "btree",
      table.personalAccountId.asc().nullsLast().op("text_ops"),
      table.startedAt.desc().nullsFirst().op("text_ops"),
      table.publicId.desc().nullsFirst().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.personalAccountId],
      foreignColumns: [personalAccountsInApp.id],
      name: "tool_call_logs_personal_account_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.personalAccountId, table.mcpAuthorizationId],
      foreignColumns: [
        mcpAuthorizationsInApp.id,
        mcpAuthorizationsInApp.personalAccountId,
      ],
      name: "tool_call_logs_personal_account_id_mcp_authorization_id_fkey",
    }).onDelete("cascade"),
    unique("tool_call_logs_tenant_id_unique").on(
      table.id,
      table.personalAccountId,
    ),
    unique("tool_call_logs_public_id_unique").on(table.publicId),
    pgPolicy("tool_call_logs_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "tool_call_logs_tool_name_check",
      sql`tool_name ~ '^[a-z][a-z0-9_]{0,63}$'::text`,
    ),
    check(
      "tool_call_logs_outcome_check",
      sql`outcome = ANY (ARRAY['started'::text, 'success'::text, 'execution_error'::text, 'rate_limited'::text, 'authorization_denied'::text])`,
    ),
    check(
      "tool_call_logs_error_code_check",
      sql`(error_code IS NULL) OR (error_code ~ '^[a-z][a-z0-9_]{0,63}$'::text)`,
    ),
    check(
      "tool_call_logs_result_count_check",
      sql`(result_count IS NULL) OR (result_count >= 0)`,
    ),
    check(
      "tool_call_logs_latency_ms_check",
      sql`(latency_ms IS NULL) OR (latency_ms >= 0)`,
    ),
    check(
      "tool_call_logs_check",
      sql`expires_at = (started_at + '90 days'::interval)`,
    ),
    check(
      "tool_call_logs_check1",
      sql`((outcome = 'started'::text) AND (completed_at IS NULL)) OR ((outcome <> 'started'::text) AND (completed_at IS NOT NULL))`,
    ),
    check(
      "tool_call_logs_check2",
      sql`((outcome = 'success'::text) AND (error_code IS NULL)) OR (outcome <> 'success'::text)`,
    ),
    check(
      "tool_call_logs_media_bytes_reserved_check",
      sql`media_bytes_reserved >= 0`,
    ),
    check(
      "tool_call_logs_media_reservation",
      sql`((tool_name = 'read_stored_media'::text) AND quota_reserved) OR ((tool_name <> 'read_stored_media'::text) AND (media_bytes_reserved = 0))`,
    ),
    check(
      "tool_call_logs_connection_public_id_format",
      sql`(connection_public_id IS NULL) OR (connection_public_id ~ '^con_[A-Za-z0-9_-]{21}$'::text)`,
    ),
    check(
      "tool_call_logs_public_id_format",
      sql`public_id ~ '^tcl_[A-Za-z0-9_-]{21}$'::text`,
    ),
    check(
      "tool_call_logs_send_public_id_format",
      sql`(send_public_id IS NULL) OR (send_public_id ~ '^snd_[A-Za-z0-9_-]{21}$'::text)`,
    ),
    check(
      "tool_call_logs_channel_check",
      sql`channel = ANY (ARRAY['mcp'::text, 'api'::text])`,
    ),
    check(
      "tool_call_logs_channel_principal",
      sql`((channel = 'mcp'::text) AND (mcp_authorization_id IS NOT NULL) AND (api_key_id IS NULL) AND (api_key_public_id IS NULL) AND (api_key_name IS NULL)) OR ((mcp_authorization_id IS NULL) AND (api_key_id IS NOT NULL) AND (api_key_public_id ~ '^apk_[A-Za-z0-9_-]{21}$'::text) AND (api_key_name IS NOT NULL) AND (length(btrim(api_key_name)) >= 1) AND (length(btrim(api_key_name)) <= 64) AND (api_key_name = btrim(api_key_name)))`,
    ),
  ],
);
