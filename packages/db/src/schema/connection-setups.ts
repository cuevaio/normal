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
import { bytea, publicSchema } from "./common";

export const connectionSetupsInApp = publicSchema.table(
  "connection_setups",
  {
    id: text().primaryKey().notNull(),
    personalAccountId: uuid("personal_account_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    displayNameCiphertextVersion: smallint("display_name_ciphertext_version"),
    displayNameKeyVersion: integer("display_name_key_version"),
    displayNameNonce: bytea("display_name_nonce"),
    displayNameCiphertext: bytea("display_name_ciphertext"),
    displayNameFallback: text("display_name_fallback").default(
      sql`public.random_whatsapp_connection_name()`,
    ),
    state: text().notNull(),
    numberCiphertextVersion: smallint("number_ciphertext_version").notNull(),
    numberKeyVersion: integer("number_key_version").notNull(),
    numberNonce: bytea("number_nonce").notNull(),
    numberCiphertext: bytea("number_ciphertext").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    provisioningLeaseOwner: text("provisioning_lease_owner"),
    provisioningLeaseExpiresAt: timestamp("provisioning_lease_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    provisioningAttemptCount: integer("provisioning_attempt_count")
      .default(0)
      .notNull(),
    provisioningStartedAt: timestamp("provisioning_started_at", {
      withTimezone: true,
      mode: "string",
    }),
    provisioningLastFailureCode: text("provisioning_last_failure_code"),
    cleanupState: text("cleanup_state"),
    cleanupLeaseOwner: text("cleanup_lease_owner"),
    cleanupLeaseExpiresAt: timestamp("cleanup_lease_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    cleanupAttemptCount: integer("cleanup_attempt_count").default(0).notNull(),
    cleanupLastFailureCode: text("cleanup_last_failure_code"),
    webhookIngressId: uuid("webhook_ingress_id").defaultRandom().notNull(),
  },
  (table) => [
    index("connection_setups_cleanup_candidates")
      .using(
        "btree",
        table.updatedAt.asc().nullsLast().op("text_ops"),
        table.id.asc().nullsLast().op("text_ops"),
      )
      .where(sql`(cleanup_state = 'pending'::text)`),
    index("connection_setups_provisioning_candidates")
      .using(
        "btree",
        table.createdAt.asc().nullsLast().op("timestamptz_ops"),
        table.id.asc().nullsLast().op("timestamptz_ops"),
      )
      .where(sql`(state = 'provisioning_pending'::text)`),
    foreignKey({
      columns: [table.personalAccountId],
      foreignColumns: [personalAccountsInApp.id],
      name: "connection_setups_personal_account_id_fkey",
    }).onDelete("cascade"),
    unique("connection_setups_personal_account_id_id_key").on(
      table.id,
      table.personalAccountId,
    ),
    unique("connection_setups_personal_account_id_idempotency_key_key").on(
      table.idempotencyKey,
      table.personalAccountId,
    ),
    unique("connection_setups_webhook_ingress_unique").on(
      table.webhookIngressId,
    ),
    unique("connection_setups_activation_ingress_unique").on(
      table.id,
      table.personalAccountId,
      table.webhookIngressId,
    ),
    pgPolicy("connection_setups_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "connection_setups_id_check",
      sql`id ~ '^cst_[A-Za-z0-9_-]{21}$'::text`,
    ),
    check(
      "connection_setups_idempotency_key_check",
      sql`idempotency_key ~ '^[A-Za-z0-9_-]{21}$'::text`,
    ),
    check(
      "connection_setups_display_name_storage_check",
      sql`(display_name_fallback ~ '^(Bright|Calm|Clever|Kind|Lucky|Quiet|Swift|Warm) (Badger|Falcon|Fox|Otter|Panda|Robin|Tiger|Turtle)$' AND display_name_ciphertext_version IS NULL AND display_name_key_version IS NULL AND display_name_nonce IS NULL AND display_name_ciphertext IS NULL) OR (display_name_fallback IS NULL AND display_name_ciphertext_version = 1 AND display_name_key_version > 0 AND octet_length(display_name_nonce) = 12 AND octet_length(display_name_ciphertext) > 16)`,
    ),
    check(
      "connection_setups_number_ciphertext_version_check",
      sql`number_ciphertext_version > 0`,
    ),
    check(
      "connection_setups_number_key_version_check",
      sql`number_key_version > 0`,
    ),
    check(
      "connection_setups_number_nonce_check",
      sql`octet_length(number_nonce) = 12`,
    ),
    check(
      "connection_setups_number_ciphertext_check",
      sql`octet_length(number_ciphertext) > 16`,
    ),
    check(
      "connection_setups_check",
      sql`expires_at = (created_at + '00:15:00'::interval)`,
    ),
    check("connection_setups_check1", sql`updated_at >= created_at`),
    check(
      "connection_setups_provisioning_lease_owner_check",
      sql`(provisioning_lease_owner IS NULL) OR (provisioning_lease_owner ~ '^cspw_[A-Za-z0-9_-]{43}$'::text)`,
    ),
    check(
      "connection_setups_provisioning_attempt_count_check",
      sql`provisioning_attempt_count >= 0`,
    ),
    check(
      "connection_setups_provisioning_started_at_check",
      sql`(provisioning_started_at IS NULL) OR (provisioning_started_at >= created_at)`,
    ),
    check(
      "connection_setups_provisioning_last_failure_code_check",
      sql`(provisioning_last_failure_code IS NULL) OR (provisioning_last_failure_code ~ '^[a-z][a-z0-9_]{0,63}$'::text)`,
    ),
    check(
      "connection_setup_provisioning_lease_complete",
      sql`(provisioning_lease_owner IS NULL) = (provisioning_lease_expires_at IS NULL)`,
    ),
    check(
      "connection_setups_cleanup_state_check",
      sql`(cleanup_state IS NULL) OR (cleanup_state = ANY (ARRAY['pending'::text, 'complete'::text]))`,
    ),
    check(
      "connection_setups_cleanup_lease_owner_check",
      sql`(cleanup_lease_owner IS NULL) OR (cleanup_lease_owner ~ '^cscw_[A-Za-z0-9_-]{43}$'::text)`,
    ),
    check(
      "connection_setups_cleanup_attempt_count_check",
      sql`cleanup_attempt_count >= 0`,
    ),
    check(
      "connection_setups_cleanup_last_failure_code_check",
      sql`(cleanup_last_failure_code IS NULL) OR (cleanup_last_failure_code ~ '^[a-z][a-z0-9_]{0,63}$'::text)`,
    ),
    check(
      "connection_setup_cleanup_state_matches_terminal",
      sql`(state = ANY (ARRAY['cancelled'::text, 'expired'::text])) = (cleanup_state IS NOT NULL)`,
    ),
    check(
      "connection_setup_cleanup_lease_complete",
      sql`(cleanup_lease_owner IS NULL) = (cleanup_lease_expires_at IS NULL)`,
    ),
    check(
      "connection_setup_cleanup_complete_has_no_lease",
      sql`(cleanup_state <> 'complete'::text) OR ((cleanup_lease_owner IS NULL) AND (cleanup_lease_expires_at IS NULL))`,
    ),
    check(
      "connection_setup_non_cancellable_terminal_has_no_lease",
      sql`(state = ANY (ARRAY['provisioning_pending'::text, 'cancelled'::text, 'expired'::text])) OR ((provisioning_lease_owner IS NULL) AND (provisioning_lease_expires_at IS NULL))`,
    ),
    check(
      "connection_setups_state_check",
      sql`state = ANY (ARRAY['provisioning_pending'::text, 'provisioned'::text, 'provisioning_failed'::text, 'provisioning_quarantined'::text, 'cancelled'::text, 'expired'::text, 'activated'::text])`,
    ),
  ],
);

export const whatsappNumberReservationsInApp = publicSchema.table(
  "whatsapp_number_reservations",
  {
    numberToken: bytea("number_token").notNull(),
    personalAccountId: uuid("personal_account_id").notNull(),
    connectionSetupId: text("connection_setup_id").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    releasedAt: timestamp("released_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    uniqueIndex("whatsapp_number_reservations_active_token")
      .using("btree", table.numberToken.asc().nullsLast().op("bytea_ops"))
      .where(sql`(released_at IS NULL)`),
    foreignKey({
      columns: [table.personalAccountId, table.connectionSetupId],
      foreignColumns: [
        connectionSetupsInApp.id,
        connectionSetupsInApp.personalAccountId,
      ],
      name: "whatsapp_number_reservations_personal_account_id_connectio_fkey",
    }).onDelete("restrict"),
    primaryKey({
      columns: [table.connectionSetupId, table.personalAccountId],
      name: "whatsapp_number_reservations_pkey",
    }),
    pgPolicy("whatsapp_number_reservations_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "whatsapp_number_reservation_token_length",
      sql`octet_length(number_token) = 32`,
    ),
    check(
      "whatsapp_number_reservation_release_order",
      sql`(released_at IS NULL) OR (released_at >= created_at)`,
    ),
  ],
);

export const connectionSetupKeyEnvelopesInApp = publicSchema.table(
  "connection_setup_key_envelopes",
  {
    personalAccountId: uuid("personal_account_id").notNull(),
    connectionSetupId: text("connection_setup_id").notNull(),
    accountKeyVersion: integer("account_key_version").notNull(),
    keyVersion: integer("key_version").notNull(),
    nonce: bytea("nonce").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.personalAccountId, table.connectionSetupId],
      foreignColumns: [
        connectionSetupsInApp.id,
        connectionSetupsInApp.personalAccountId,
      ],
      name: "connection_setup_key_envelope_personal_account_id_connecti_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.connectionSetupId, table.personalAccountId],
      name: "connection_setup_key_envelopes_pkey",
    }),
    pgPolicy("connection_setup_key_envelopes_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "connection_setup_key_envelopes_account_key_version_check",
      sql`account_key_version > 0`,
    ),
    check(
      "connection_setup_key_envelopes_key_version_check",
      sql`key_version > 0`,
    ),
    check(
      "connection_setup_key_envelopes_nonce_check",
      sql`octet_length(nonce) = 12`,
    ),
    check(
      "connection_setup_key_envelopes_ciphertext_check",
      sql`octet_length(ciphertext) > 16`,
    ),
  ],
);

export const connectionSetupProviderSessionsInApp = publicSchema.table(
  "connection_setup_provider_sessions",
  {
    personalAccountId: uuid("personal_account_id").notNull(),
    connectionSetupId: text("connection_setup_id").notNull(),
    ordinal: smallint().notNull(),
    locatorCiphertextVersion: smallint("locator_ciphertext_version").notNull(),
    locatorKeyVersion: integer("locator_key_version").notNull(),
    locatorNonce: bytea("locator_nonce").notNull(),
    locatorCiphertext: bytea("locator_ciphertext").notNull(),
    authorityCiphertextVersion: smallint(
      "authority_ciphertext_version",
    ).notNull(),
    authorityKeyVersion: integer("authority_key_version").notNull(),
    authorityNonce: bytea("authority_nonce").notNull(),
    authorityCiphertext: bytea("authority_ciphertext").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.personalAccountId, table.connectionSetupId],
      foreignColumns: [
        connectionSetupsInApp.id,
        connectionSetupsInApp.personalAccountId,
      ],
      name: "connection_setup_provider_ses_personal_account_id_connecti_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [
        table.connectionSetupId,
        table.ordinal,
        table.personalAccountId,
      ],
      name: "connection_setup_provider_sessions_pkey",
    }),
    pgPolicy("connection_setup_provider_sessions_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "connection_setup_provider_sessions_ordinal_check",
      sql`ordinal >= 0`,
    ),
    check(
      "connection_setup_provider_sess_locator_ciphertext_version_check",
      sql`locator_ciphertext_version > 0`,
    ),
    check(
      "connection_setup_provider_sessions_locator_key_version_check",
      sql`locator_key_version > 0`,
    ),
    check(
      "connection_setup_provider_sessions_locator_nonce_check",
      sql`octet_length(locator_nonce) = 12`,
    ),
    check(
      "connection_setup_provider_sessions_locator_ciphertext_check",
      sql`octet_length(locator_ciphertext) > 16`,
    ),
    check(
      "connection_setup_provider_se_authority_ciphertext_version_check",
      sql`authority_ciphertext_version > 0`,
    ),
    check(
      "connection_setup_provider_sessions_authority_key_version_check",
      sql`authority_key_version > 0`,
    ),
    check(
      "connection_setup_provider_sessions_authority_nonce_check",
      sql`octet_length(authority_nonce) = 12`,
    ),
    check(
      "connection_setup_provider_sessions_authority_ciphertext_check",
      sql`octet_length(authority_ciphertext) > 16`,
    ),
  ],
);
