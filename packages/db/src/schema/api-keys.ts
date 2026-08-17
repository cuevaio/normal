import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgPolicy,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { personalAccountsInApp } from "./accounts";
import { bytea, publicSchema } from "./common";
import { whatsappConnectionsInApp } from "./connections";

export const apiKeysInApp = publicSchema.table(
  "api_keys",
  {
    id: uuid().primaryKey().notNull(),
    personalAccountId: uuid("personal_account_id").notNull(),
    publicId: text("public_id").notNull(),
    name: text().notNull(),
    credentialDigest: bytea("credential_digest"),
    credentialHint: text("credential_hint").notNull(),
    permissions: text().array().notNull(),
    state: text().default("active").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    reverifiedAt: timestamp("reverified_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    revokedAt: timestamp("revoked_at", {
      withTimezone: true,
      mode: "string",
    }),
    lastUsedAt: timestamp("last_used_at", {
      withTimezone: true,
      mode: "string",
    }),
    metadataExpiresAt: timestamp("metadata_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    foreignKey({
      columns: [table.personalAccountId],
      foreignColumns: [personalAccountsInApp.id],
      name: "api_keys_personal_account_id_fkey",
    }).onDelete("cascade"),
    unique("api_keys_personal_account_id_id_key").on(
      table.personalAccountId,
      table.id,
    ),
    unique("api_keys_public_id_unique").on(table.publicId),
    uniqueIndex("api_keys_active_name")
      .on(table.personalAccountId, sql`lower(${table.name})`)
      .where(sql`state = 'active'`),
    pgPolicy("api_keys_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "api_keys_public_id_format",
      sql`public_id ~ '^apk_[A-Za-z0-9_-]{21}$'::text`,
    ),
    check(
      "api_keys_name_check",
      sql`(length(btrim(name)) BETWEEN 1 AND 64) AND (name = btrim(name))`,
    ),
    check(
      "api_keys_credential_digest_check",
      sql`(credential_digest IS NULL) OR (octet_length(credential_digest) = 32)`,
    ),
    check(
      "api_keys_credential_hint_check",
      sql`credential_hint ~ '^normal_apk_[A-Za-z0-9_-]{21}\\.…[A-Za-z0-9_-]{4}$'::text`,
    ),
    check(
      "api_keys_permissions_check",
      sql`((cardinality(permissions) >= 1) AND (cardinality(permissions) <= 4)) AND (permissions <@ ARRAY['connections:read'::text, 'directory:read'::text, 'messages:read'::text, 'messages:send'::text]) AND (cardinality(permissions) = ((((('connections:read'::text = ANY (permissions)))::integer + (('directory:read'::text = ANY (permissions)))::integer) + (('messages:read'::text = ANY (permissions)))::integer) + (('messages:send'::text = ANY (permissions)))::integer))`,
    ),
    check(
      "api_keys_state_check",
      sql`state = ANY (ARRAY['active'::text, 'expired'::text, 'revoked'::text])`,
    ),
    check(
      "api_keys_state_revocation",
      sql`((state = 'active'::text) AND (revoked_at IS NULL) AND (credential_digest IS NOT NULL) AND (metadata_expires_at IS NULL)) OR ((state = 'revoked'::text) AND (revoked_at IS NOT NULL) AND (credential_digest IS NULL) AND (metadata_expires_at IS NOT NULL)) OR ((state = 'expired'::text) AND (revoked_at IS NULL) AND (expires_at IS NOT NULL) AND (credential_digest IS NULL) AND (metadata_expires_at IS NOT NULL))`,
    ),
    check(
      "api_keys_reverified_at_check",
      sql`(reverified_at <= created_at) AND (reverified_at > (created_at - '00:05:00'::interval))`,
    ),
    check(
      "api_keys_expires_at_check",
      sql`(expires_at IS NULL) OR (expires_at > created_at)`,
    ),
    check(
      "api_keys_revoked_at_check",
      sql`(revoked_at IS NULL) OR (revoked_at >= created_at)`,
    ),
    check(
      "api_keys_last_used_at_check",
      sql`(last_used_at IS NULL) OR (last_used_at >= created_at)`,
    ),
  ],
);

export const apiKeyConnectionsInApp = publicSchema.table(
  "api_key_connections",
  {
    personalAccountId: uuid("personal_account_id").notNull(),
    apiKeyId: uuid("api_key_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.personalAccountId, table.apiKeyId],
      foreignColumns: [apiKeysInApp.personalAccountId, apiKeysInApp.id],
      name: "api_key_connections_grant_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      foreignColumns: [
        whatsappConnectionsInApp.personalAccountId,
        whatsappConnectionsInApp.id,
      ],
      name: "api_key_connections_connection_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.apiKeyId, table.whatsappConnectionId],
      name: "api_key_connections_pkey",
    }),
    pgPolicy("api_key_connections_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
  ],
);
