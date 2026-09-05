import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgPolicy,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { personalAccountsInApp } from "./accounts";
import { bytea, publicSchema } from "./common";
import { connectionSetupsInApp } from "./connection-setups";

export const whatsappConnectionsInApp = publicSchema.table(
  "whatsapp_connections",
  {
    id: uuid().primaryKey().notNull(),
    personalAccountId: uuid("personal_account_id").notNull(),
    webhookIngressId: uuid("webhook_ingress_id").notNull(),
    displayNameCiphertext: bytea("display_name_ciphertext"),
    displayNameCiphertextVersion: smallint("display_name_ciphertext_version"),
    displayNameKeyVersion: integer("display_name_key_version"),
    displayNameNonce: bytea("display_name_nonce"),
    displayNameFallback: text("display_name_fallback").default(
      sql`public.random_whatsapp_connection_name()`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    publicId: text("public_id")
      .default(
        sql`(\'con_\'::text || translate(SUBSTRING(encode(decode(md5((gen_random_uuid())::text), \'hex\'::text), \'base64\'::text) FROM 1 FOR 21), \'+/\'::text, \'-_\'::text))`,
      )
      .notNull(),
    connectionSetupId: text("connection_setup_id"),
    numberSuffix: text("number_suffix"),
    state: text().default("degraded").notNull(),
    stateChangedAt: timestamp("state_changed_at", {
      withTimezone: true,
      mode: "string",
    })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    desiredState: text("desired_state").default("connected").notNull(),
    lifecycleClaimId: uuid("lifecycle_claim_id"),
    lifecycleLeaseExpiresAt: timestamp("lifecycle_lease_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    stateProviderOccurredAt: timestamp("state_provider_occurred_at", {
      withTimezone: true,
      mode: "string",
    }),
    stateProviderVersion: text("state_provider_version"),
    stateReceivedAt: timestamp("state_received_at", {
      withTimezone: true,
      mode: "string",
    })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    stateWebhookEventId: uuid("state_webhook_event_id"),
    stateWebhookItemIdentity: text("state_webhook_item_identity"),
    healthLastCheckedAt: timestamp("health_last_checked_at", {
      withTimezone: true,
      mode: "string",
    }),
    healthLastConfirmedAt: timestamp("health_last_confirmed_at", {
      withTimezone: true,
      mode: "string",
    }),
    healthClaimId: uuid("health_claim_id"),
    healthLeaseExpiresAt: timestamp("health_lease_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    stateSnapshotObservedAt: timestamp("state_snapshot_observed_at", {
      withTimezone: true,
      mode: "string",
    }),
    messageRetentionDays: smallint("message_retention_days").default(30),
    messageRetentionUpdatedAt: timestamp("message_retention_updated_at", {
      withTimezone: true,
      mode: "string",
    })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    deletionRequestedAt: timestamp("deletion_requested_at", {
      withTimezone: true,
      mode: "string",
    }),
    deletionMarkerId: text("deletion_marker_id"),
    providerAbsenceConfirmedAt: timestamp("provider_absence_confirmed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    foreignKey({
      columns: [table.personalAccountId],
      foreignColumns: [personalAccountsInApp.id],
      name: "whatsapp_connections_personal_account_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.personalAccountId, table.connectionSetupId],
      foreignColumns: [
        connectionSetupsInApp.id,
        connectionSetupsInApp.personalAccountId,
      ],
      name: "whatsapp_connections_connection_setup_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.personalAccountId,
        table.webhookIngressId,
        table.connectionSetupId,
      ],
      foreignColumns: [
        connectionSetupsInApp.id,
        connectionSetupsInApp.personalAccountId,
        connectionSetupsInApp.webhookIngressId,
      ],
      name: "whatsapp_connections_setup_ingress_foreign_key",
    }),
    unique("whatsapp_connections_webhook_ingress_id_key").on(
      table.webhookIngressId,
    ),
    unique("whatsapp_connections_personal_account_id_id_key").on(
      table.id,
      table.personalAccountId,
    ),
    unique("whatsapp_connections_public_id_unique").on(table.publicId),
    unique("whatsapp_connections_connection_setup_unique").on(
      table.connectionSetupId,
    ),
    pgPolicy("whatsapp_connections_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "whatsapp_connections_public_id_format",
      sql`public_id ~ '^con_[A-Za-z0-9_-]{21}$'::text`,
    ),
    check(
      "whatsapp_connections_number_suffix_check",
      sql`(number_suffix IS NULL) OR (number_suffix ~ '^[0-9]{4}$'::text)`,
    ),
    check(
      "whatsapp_connections_display_name_storage_check",
      sql`(display_name_fallback ~ '^(Bright|Calm|Clever|Kind|Lucky|Quiet|Swift|Warm) (Badger|Falcon|Fox|Otter|Panda|Robin|Tiger|Turtle)$' AND display_name_ciphertext_version IS NULL AND display_name_key_version IS NULL AND display_name_nonce IS NULL AND display_name_ciphertext IS NULL) OR (display_name_fallback IS NULL AND display_name_ciphertext_version = 1 AND display_name_key_version > 0 AND octet_length(display_name_nonce) = 12 AND octet_length(display_name_ciphertext) > 16)`,
    ),
    check(
      "whatsapp_connections_state_check",
      sql`state = ANY (ARRAY['connected'::text, 'connecting'::text, 'disconnected'::text, 'reconnect_required'::text, 'degraded'::text, 'deleting'::text])`,
    ),
    check(
      "whatsapp_connections_desired_state_check",
      sql`desired_state = ANY (ARRAY['connected'::text, 'disconnected'::text])`,
    ),
    check(
      "whatsapp_connection_lifecycle_lease_complete",
      sql`((lifecycle_claim_id IS NULL) AND (lifecycle_lease_expires_at IS NULL)) OR ((lifecycle_claim_id IS NOT NULL) AND (lifecycle_lease_expires_at IS NOT NULL))`,
    ),
    check(
      "whatsapp_connections_state_provider_version_check",
      sql`(state_provider_version IS NULL) OR (octet_length(state_provider_version) <= 512)`,
    ),
    check(
      "whatsapp_connection_state_item_identity_format",
      sql`(state_webhook_item_identity IS NULL) OR (state_webhook_item_identity ~ '^wi1_[A-Za-z0-9_-]{43}$'::text)`,
    ),
    check(
      "whatsapp_connection_health_lease_complete",
      sql`((health_claim_id IS NULL) AND (health_lease_expires_at IS NULL)) OR ((health_claim_id IS NOT NULL) AND (health_lease_expires_at IS NOT NULL))`,
    ),
    check(
      "whatsapp_connections_message_retention_days_check",
      sql`(message_retention_days IS NULL) OR (message_retention_days > 0)`,
    ),
    check(
      "whatsapp_connections_deletion_marker_id_check",
      sql`deletion_marker_id ~ '^[a-f0-9]{64}$'::text`,
    ),
    check(
      "whatsapp_connection_deletion_metadata_complete",
      sql`((deletion_requested_at IS NULL) AND (deletion_marker_id IS NULL)) OR ((state = 'deleting'::text) AND (deletion_requested_at IS NOT NULL) AND (deletion_marker_id IS NOT NULL))`,
    ),
    check(
      "whatsapp_connection_provider_absence_after_deletion",
      sql`(provider_absence_confirmed_at IS NULL) OR ((state = 'deleting'::text) AND (provider_absence_confirmed_at >= deletion_requested_at))`,
    ),
  ],
);

export const whatsappConnectionKeyEnvelopesInApp = publicSchema.table(
  "whatsapp_connection_key_envelopes",
  {
    personalAccountId: uuid("personal_account_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    accountKeyVersion: integer("account_key_version"),
    keyVersion: integer("key_version"),
    nonce: bytea("nonce"),
    ciphertext: bytea("ciphertext"),
    unavailableAt: timestamp("unavailable_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      foreignColumns: [
        whatsappConnectionsInApp.id,
        whatsappConnectionsInApp.personalAccountId,
      ],
      name: "whatsapp_connection_key_envel_personal_account_id_whatsapp_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      name: "whatsapp_connection_key_envelopes_pkey",
    }),
    pgPolicy("whatsapp_connection_key_envelopes_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "whatsapp_connection_key_envelopes_account_key_version_check",
      sql`account_key_version > 0`,
    ),
    check(
      "whatsapp_connection_key_envelopes_key_version_check",
      sql`key_version > 0`,
    ),
    check(
      "whatsapp_connection_key_envelopes_check",
      sql`((nonce IS NOT NULL) AND (ciphertext IS NOT NULL) AND (account_key_version IS NOT NULL) AND (key_version IS NOT NULL) AND (unavailable_at IS NULL)) OR ((nonce IS NULL) AND (ciphertext IS NULL) AND (unavailable_at IS NOT NULL))`,
    ),
  ],
);

export const whatsappConnectionSecretsInApp = publicSchema.table(
  "whatsapp_connection_secrets",
  {
    personalAccountId: uuid("personal_account_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
    credentialCiphertext: bytea("credential_ciphertext").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .default(sql`transaction_timestamp()`)
      .notNull(),
    credentialCiphertextVersion: smallint("credential_ciphertext_version"),
    credentialKeyVersion: integer("credential_key_version"),
    credentialNonce: bytea("credential_nonce"),
    messageSearchKeyCiphertextVersion: smallint(
      "message_search_key_ciphertext_version",
    ),
    messageSearchKeyVersion: integer("message_search_key_version"),
    messageSearchKeyNonce: bytea("message_search_key_nonce"),
    messageSearchKeyCiphertext: bytea("message_search_key_ciphertext"),
  },
  (table) => [
    foreignKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      foreignColumns: [
        whatsappConnectionsInApp.id,
        whatsappConnectionsInApp.personalAccountId,
      ],
      name: "whatsapp_connection_secrets_personal_account_id_whatsapp_c_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      name: "whatsapp_connection_secrets_pkey",
    }),
    pgPolicy("whatsapp_connection_secrets_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "whatsapp_connection_secrets_credential_ciphertext_version_check",
      sql`(credential_ciphertext_version IS NULL) OR (credential_ciphertext_version > 0)`,
    ),
    check(
      "whatsapp_connection_secrets_credential_key_version_check",
      sql`(credential_key_version IS NULL) OR (credential_key_version > 0)`,
    ),
    check(
      "whatsapp_connection_secrets_credential_nonce_check",
      sql`(credential_nonce IS NULL) OR (octet_length(credential_nonce) = 12)`,
    ),
    check(
      "whatsapp_connection_secret_envelope_complete",
      sql`((credential_ciphertext_version IS NULL) AND (credential_key_version IS NULL) AND (credential_nonce IS NULL)) OR ((credential_ciphertext_version IS NOT NULL) AND (credential_key_version IS NOT NULL) AND (credential_nonce IS NOT NULL) AND (octet_length(credential_ciphertext) > 16)))) NOT VALID`,
    ),
    check(
      "whatsapp_connection_secrets_message_search_key_complete",
      sql`((message_search_key_ciphertext_version IS NULL) AND (message_search_key_version IS NULL) AND (message_search_key_nonce IS NULL) AND (message_search_key_ciphertext IS NULL)) OR ((message_search_key_ciphertext_version = 1) AND (message_search_key_version > 0) AND (octet_length(message_search_key_nonce) = 12) AND (octet_length(message_search_key_ciphertext) > 16))`,
    ),
  ],
);

export const whatsappConnectionProviderSessionsInApp = publicSchema.table(
  "whatsapp_connection_provider_sessions",
  {
    personalAccountId: uuid("personal_account_id").notNull(),
    whatsappConnectionId: uuid("whatsapp_connection_id").notNull(),
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
    updatedAt: timestamp("updated_at", {
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
      name: "whatsapp_connection_provider__personal_account_id_whatsapp_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.personalAccountId, table.whatsappConnectionId],
      name: "whatsapp_connection_provider_sessions_pkey",
    }),
    pgPolicy("whatsapp_connection_provider_sessions_tenant", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
      withCheck: sql`(personal_account_id = (NULLIF(current_setting('public.personal_account_id'::text, true), ''::text))::uuid)`,
    }),
    check(
      "whatsapp_connection_provider_s_locator_ciphertext_version_check",
      sql`locator_ciphertext_version > 0`,
    ),
    check(
      "whatsapp_connection_provider_sessions_locator_key_version_check",
      sql`locator_key_version > 0`,
    ),
    check(
      "whatsapp_connection_provider_sessions_locator_nonce_check",
      sql`octet_length(locator_nonce) = 12`,
    ),
    check(
      "whatsapp_connection_provider_sessions_locator_ciphertext_check",
      sql`octet_length(locator_ciphertext) > 16`,
    ),
    check(
      "whatsapp_connection_provider_authority_ciphertext_version_check",
      sql`authority_ciphertext_version > 0`,
    ),
    check(
      "whatsapp_connection_provider_sessio_authority_key_version_check",
      sql`authority_key_version > 0`,
    ),
    check(
      "whatsapp_connection_provider_sessions_authority_nonce_check",
      sql`octet_length(authority_nonce) = 12`,
    ),
    check(
      "whatsapp_connection_provider_session_authority_ciphertext_check",
      sql`octet_length(authority_ciphertext) > 16`,
    ),
  ],
);

export const deletedWhatsappConnectionHandlesInAppPrivate = publicSchema.table(
  "deleted_whatsapp_connection_handles",
  {
    publicId: text("public_id").primaryKey().notNull(),
    deletionMarkerId: text("deletion_marker_id").notNull(),
    deletedAt: timestamp("deleted_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    unique("deleted_whatsapp_connection_handles_deletion_marker_id_key").on(
      table.deletionMarkerId,
    ),
    check(
      "deleted_whatsapp_connection_handles_public_id_check",
      sql`public_id ~ '^con_[A-Za-z0-9_-]{21}$'::text`,
    ),
    check(
      "deleted_whatsapp_connection_handles_deletion_marker_id_check",
      sql`deletion_marker_id ~ '^[a-f0-9]{64}$'::text`,
    ),
  ],
);

export const restoreConnectionDeletionContinuationsInAppPrivate =
  publicSchema.table(
    "restore_connection_deletion_continuations",
    {
      deletionMarkerId: text("deletion_marker_id").primaryKey().notNull(),
      personalAccountId: uuid("personal_account_id").notNull(),
      connectionSetupId: text("connection_setup_id").notNull(),
      requestedAt: timestamp("requested_at", {
        withTimezone: true,
        mode: "string",
      }).notNull(),
    },
    (table) => [
      foreignKey({
        columns: [table.deletionMarkerId],
        foreignColumns: [
          deletedWhatsappConnectionHandlesInAppPrivate.deletionMarkerId,
        ],
        name: "restore_connection_deletion_continuations_marker_fkey",
      }).onDelete("cascade"),
      foreignKey({
        columns: [table.personalAccountId, table.connectionSetupId],
        foreignColumns: [
          connectionSetupsInApp.personalAccountId,
          connectionSetupsInApp.id,
        ],
        name: "restore_connection_deletion_continuations_setup_fkey",
      }).onDelete("cascade"),
    ],
  );
