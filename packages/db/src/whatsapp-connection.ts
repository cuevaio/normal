import type { WhatsAppConnectionState } from "@whatsapp-mcp/domain/whatsapp-connection";
import { and, eq, ne, sql } from "drizzle-orm";
import { type Database, makeDatabase, withPgQueryConnection } from "./database";
import { connectionSetupsInApp, whatsappConnectionsInApp } from "./schema";
import { withTransaction } from "./transaction";

export interface WhatsAppConnectionConnection {
  readonly query: <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    text: string,
    values?: Array<unknown>,
  ) => Promise<{ readonly rows: Array<Row> }>;
}

export interface WhatsAppConnectionConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: WhatsAppConnectionConnection) => Promise<Value>,
  ) => Promise<Value>;
}

interface AccountKeyEnvelope {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly kmsKeyId: string;
  readonly personalAccountId: string;
  readonly version: 1;
}

interface ConnectionKeyEnvelope {
  readonly accountKeyVersion: number;
  readonly ciphertext: string;
  readonly connectionId: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly personalAccountId: string;
  readonly version: 1;
}

interface VersionedCiphertext {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly version: 1;
}

export interface WhatsAppConnectionRecord {
  readonly accountKey: AccountKeyEnvelope;
  readonly connectionId: string;
  readonly connectionKey: ConnectionKeyEnvelope;
  readonly displayName: {
    readonly ciphertext: VersionedCiphertext | null;
    readonly fallback: string | null;
  };
  readonly numberSuffix: string;
  readonly publicId: string;
  readonly state: WhatsAppConnectionState;
  readonly stateChangedAt: string;
}

export type WhatsAppConnectionDeletionPreparation =
  | {
      readonly outcome: "complete";
      readonly publicId: string;
      readonly requestedAt: string;
      readonly deletionMarkerId: string;
    }
  | {
      readonly outcome: "prepared";
      readonly publicId: string;
      readonly personalAccountId: string;
      readonly connectionId: string;
      readonly accountKey: AccountKeyEnvelope;
      readonly connectionKey: ConnectionKeyEnvelope;
      readonly providerLocator: VersionedCiphertext;
    };

export interface WhatsAppConnectionDeletionReceipt {
  readonly publicId: string;
  readonly requestedAt: string;
  readonly deletionMarkerId: string;
}

export interface WhatsAppConnectionDeletionCandidate {
  readonly deadlineAt: string;
  readonly deadlineRisk: boolean;
  readonly deletionMarkerId: string;
  readonly requestedAt: string;
}

export interface WhatsAppConnectionDeletionObjects {
  readonly personalAccountId: string;
  readonly storedMediaObjectKeys: ReadonlyArray<string>;
  readonly webhookSourceObjectKeys: ReadonlyArray<string>;
}

export type WhatsAppConnectionLifecycleAction = "disconnect" | "reconnect";

export type WhatsAppConnectionLifecycleClaim =
  | {
      readonly connection: WhatsAppConnectionRecord;
      readonly outcome: "complete" | "in_progress";
    }
  | {
      readonly action: WhatsAppConnectionLifecycleAction;
      readonly connection: WhatsAppConnectionRecord;
      readonly outcome: "claimed";
      readonly setupMarker: string;
    };

export type ConnectionSetupActivation =
  | {
      readonly outcome: "pending" | "provisioning_quarantined";
    }
  | {
      readonly failureCode: string;
      readonly outcome: "provisioning_failed";
    }
  | {
      readonly outcome: "activated";
      readonly connection: WhatsAppConnectionRecord;
    }
  | {
      readonly outcome: "provisioned";
      readonly setup: {
        readonly accountKey: AccountKeyEnvelope;
        readonly displayName: {
          readonly ciphertext: VersionedCiphertext | null;
          readonly fallback: string | null;
        };
        readonly numberCiphertext: VersionedCiphertext;
        readonly personalAccountId: string;
        readonly setupId: string;
        readonly setupKey: ConnectionKeyEnvelope;
        readonly webhookIngressId: string;
      };
    };

export interface ActivateWhatsAppConnectionInput {
  readonly accountKeyVersion: number;
  readonly authorityCiphertext: Uint8Array;
  readonly authorityCiphertextVersion: number;
  readonly authorityKeyVersion: number;
  readonly authorityNonce: Uint8Array;
  readonly connectionId: string;
  readonly connectionKeyCiphertext: Uint8Array;
  readonly connectionKeyNonce: Uint8Array;
  readonly connectionKeyVersion: number;
  readonly connectedAt: string;
  readonly displayNameCiphertext: Uint8Array;
  readonly displayNameCiphertextVersion: number;
  readonly displayNameKeyVersion: number;
  readonly displayNameNonce: Uint8Array;
  readonly locatorCiphertext: Uint8Array;
  readonly locatorCiphertextVersion: number;
  readonly locatorKeyVersion: number;
  readonly locatorNonce: Uint8Array;
  readonly messageSearchKeyCiphertext: Uint8Array;
  readonly messageSearchKeyCiphertextVersion: number;
  readonly messageSearchKeyVersion: number;
  readonly messageSearchKeyNonce: Uint8Array;
  readonly numberSuffix: string;
  readonly personalAccountId: string;
  readonly publicId: string;
  readonly setupId: string;
  readonly webhookIngressId: string;
  readonly webhookSecretCiphertext: Uint8Array;
  readonly webhookSecretCiphertextVersion: number;
  readonly webhookSecretKeyVersion: number;
  readonly webhookSecretNonce: Uint8Array;
}

export interface WhatsAppConnectionRepository {
  readonly activate: (
    input: ActivateWhatsAppConnectionInput,
  ) => Promise<WhatsAppConnectionRecord>;
  readonly listForUser: (
    clerkUserId: string,
  ) => Promise<ReadonlyArray<WhatsAppConnectionRecord>>;
  readonly loadForUser: (input: {
    readonly clerkUserId: string;
    readonly publicId: string;
  }) => Promise<WhatsAppConnectionRecord | null>;
  readonly rename: (input: {
    readonly clerkUserId: string;
    readonly displayNameCiphertext: Uint8Array;
    readonly displayNameCiphertextVersion: number;
    readonly displayNameKeyVersion: number;
    readonly displayNameNonce: Uint8Array;
    readonly publicId: string;
  }) => Promise<WhatsAppConnectionRecord | null>;
  readonly prepareDeletion: (input: {
    readonly clerkUserId: string;
    readonly publicId: string;
  }) => Promise<WhatsAppConnectionDeletionPreparation | null>;
  readonly finishDeletion: (input: {
    readonly clerkUserId: string;
    readonly publicId: string;
    readonly deletionMarkerId: string;
    readonly requestedAt: string;
  }) => Promise<WhatsAppConnectionDeletionReceipt | null>;
  readonly finishDeletionCleanup: (input: {
    readonly deletionMarkerId: string;
    readonly providerAbsenceConfirmedAt: string;
  }) => Promise<boolean>;
  readonly confirmProviderAbsence: (input: {
    readonly confirmedAt: string;
    readonly deletionMarkerId: string;
  }) => Promise<boolean>;
  readonly listDeletionCandidates: (input: {
    readonly limit: number;
    readonly observedAt: string;
  }) => Promise<ReadonlyArray<WhatsAppConnectionDeletionCandidate>>;
  readonly listDeletionPurgeCandidates: (input: {
    readonly limit: number;
    readonly observedAt: string;
  }) => Promise<ReadonlyArray<WhatsAppConnectionDeletionCandidate>>;
  readonly prepareDeletionCleanup: (input: {
    readonly deletionMarkerId: string;
    readonly limit: number;
    readonly requestedAt: string;
  }) => Promise<WhatsAppConnectionDeletionObjects | null>;
  readonly finishWebhookSourceDeletion: (input: {
    readonly deletionMarkerId: string;
    readonly objectKey: string;
  }) => Promise<boolean>;
  readonly claimLifecycle: (input: {
    readonly action: WhatsAppConnectionLifecycleAction;
    readonly claimId: string;
    readonly clerkUserId: string;
    readonly publicId: string;
    readonly requestedAt: string;
  }) => Promise<WhatsAppConnectionLifecycleClaim | null>;
  readonly finishLifecycle: (input: {
    readonly claimId: string;
    readonly clerkUserId: string;
    readonly observedAt: string;
    readonly publicId: string;
    readonly state: Exclude<WhatsAppConnectionState, "deleting">;
  }) => Promise<WhatsAppConnectionRecord | null>;
  readonly loadSetupForActivation: (input: {
    readonly clerkUserId: string;
    readonly observedAt: string;
    readonly setupId: string;
  }) => Promise<ConnectionSetupActivation | null>;
  readonly failSetupActivation: (input: {
    readonly failureCode: string;
    readonly observedAt: string;
    readonly personalAccountId: string;
    readonly setupId: string;
  }) => Promise<boolean>;
}

const enterPersonalAccountContext = async (
  db: Database,
  personalAccountId: string,
): Promise<void> => {
  await db.execute(
    sql`SELECT set_config('public.personal_account_id', ${personalAccountId}, true)`,
  );
};

const positiveInteger = (value: unknown): number | null => {
  const parsed =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && /^[0-9]+$/u.test(value)
        ? Number(value)
        : value;
  return typeof parsed === "number" &&
    Number.isSafeInteger(parsed) &&
    parsed > 0
    ? parsed
    : null;
};

const bytes = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return new Uint8Array(value);
  }
  return null;
};

const encodeBase64 = (value: Uint8Array): string =>
  Buffer.from(value).toString("base64");

const timestamp = (value: unknown): string | null => {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : null;
  return date !== null && Number.isFinite(date.valueOf())
    ? date.toISOString()
    : null;
};

const connectionStates = new Set<WhatsAppConnectionState>([
  "connected",
  "connecting",
  "disconnected",
  "reconnect_required",
  "degraded",
  "deleting",
]);

interface ConnectionRow extends Record<string, unknown> {
  readonly account_key_ciphertext?: unknown;
  readonly account_key_version?: unknown;
  readonly account_kms_key_id?: unknown;
  readonly connection_id?: unknown;
  readonly connection_key_account_version?: unknown;
  readonly connection_key_ciphertext?: unknown;
  readonly connection_key_nonce?: unknown;
  readonly connection_key_version?: unknown;
  readonly connection_display_name?: unknown;
  readonly connection_number_suffix?: unknown;
  readonly connection_public_id?: unknown;
  readonly connection_state?: unknown;
  readonly connection_state_changed_at?: unknown;
  readonly display_name?: unknown;
  readonly display_name_ciphertext?: unknown;
  readonly display_name_ciphertext_version?: unknown;
  readonly display_name_fallback?: unknown;
  readonly display_name_key_version?: unknown;
  readonly display_name_nonce?: unknown;
  readonly number_suffix?: unknown;
  readonly public_id?: unknown;
  readonly state?: unknown;
  readonly state_changed_at?: unknown;
}

interface LifecycleClaimRow extends ConnectionRow {
  readonly lifecycle_action: unknown;
  readonly outcome: unknown;
  readonly setup_marker: unknown;
}

interface DeletionRow extends Record<string, unknown> {
  readonly outcome?: unknown;
  readonly public_id: unknown;
  readonly deletion_requested_at: unknown;
  readonly deletion_marker_id: unknown;
  readonly personal_account_id?: unknown;
  readonly whatsapp_connection_id?: unknown;
  readonly account_key_version?: unknown;
  readonly account_kms_key_id?: unknown;
  readonly account_key_ciphertext?: unknown;
  readonly connection_key_account_version?: unknown;
  readonly connection_key_version?: unknown;
  readonly connection_key_nonce?: unknown;
  readonly connection_key_ciphertext?: unknown;
  readonly locator_ciphertext_version?: unknown;
  readonly locator_key_version?: unknown;
  readonly locator_nonce?: unknown;
  readonly locator_ciphertext?: unknown;
}

interface DeletionCandidateRow extends Record<string, unknown> {
  readonly deadline_at: unknown;
  readonly deadline_risk: unknown;
  readonly deletion_marker_id: unknown;
  readonly requested_at: unknown;
}

interface DeletionObjectsRow extends Record<string, unknown> {
  readonly personal_account_id: unknown;
  readonly stored_media_object_keys: unknown;
  readonly webhook_source_object_keys: unknown;
}

const stringArray = (value: unknown): ReadonlyArray<string> | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : null;

const deletionCandidate = (
  row: DeletionCandidateRow,
): WhatsAppConnectionDeletionCandidate => {
  const deadlineAt = timestamp(row.deadline_at);
  const requestedAt = timestamp(row.requested_at);
  if (
    deadlineAt === null ||
    requestedAt === null ||
    typeof row.deadline_risk !== "boolean" ||
    typeof row.deletion_marker_id !== "string"
  ) {
    throw new Error("invalid Connection Deletion candidate");
  }
  return {
    deadlineAt,
    deadlineRisk: row.deadline_risk,
    deletionMarkerId: row.deletion_marker_id,
    requestedAt,
  };
};

const deletionReceipt = (
  row: DeletionRow | undefined,
): WhatsAppConnectionDeletionReceipt | null => {
  const requestedAt = timestamp(row?.deletion_requested_at);
  if (
    typeof row?.public_id !== "string" ||
    requestedAt === null ||
    typeof row.deletion_marker_id !== "string"
  )
    return null;
  return {
    publicId: row.public_id,
    requestedAt,
    deletionMarkerId: row.deletion_marker_id,
  };
};

const deletionPreparation = (
  row: DeletionRow | undefined,
): WhatsAppConnectionDeletionPreparation | null => {
  if (row === undefined) return null;
  if (row.outcome === "complete") {
    const receipt = deletionReceipt(row);
    if (receipt === null)
      throw new Error("invalid Connection Deletion receipt");
    return { outcome: "complete", ...receipt };
  }
  const accountCiphertext = bytes(row.account_key_ciphertext);
  const connectionNonce = bytes(row.connection_key_nonce);
  const connectionCiphertext = bytes(row.connection_key_ciphertext);
  const accountVersion = positiveInteger(row.account_key_version);
  const connectionAccountVersion = positiveInteger(
    row.connection_key_account_version,
  );
  const connectionVersion = positiveInteger(row.connection_key_version);
  const providerLocator = versionedCiphertext(
    row.locator_ciphertext_version,
    row.locator_key_version,
    row.locator_nonce,
    row.locator_ciphertext,
  );
  if (
    row.outcome !== "prepared" ||
    typeof row.public_id !== "string" ||
    typeof row.personal_account_id !== "string" ||
    typeof row.whatsapp_connection_id !== "string" ||
    typeof row.account_kms_key_id !== "string" ||
    accountCiphertext === null ||
    accountVersion === null ||
    connectionAccountVersion === null ||
    connectionVersion === null ||
    connectionNonce === null ||
    connectionCiphertext === null ||
    providerLocator === null
  ) {
    throw new Error("invalid Connection Deletion preparation");
  }
  return {
    outcome: "prepared",
    publicId: row.public_id,
    personalAccountId: row.personal_account_id,
    connectionId: row.whatsapp_connection_id,
    accountKey: {
      ciphertext: encodeBase64(accountCiphertext),
      keyVersion: accountVersion,
      kmsKeyId: row.account_kms_key_id,
      personalAccountId: row.personal_account_id,
      version: 1,
    },
    connectionKey: {
      accountKeyVersion: connectionAccountVersion,
      ciphertext: encodeBase64(connectionCiphertext),
      connectionId: row.whatsapp_connection_id,
      keyVersion: connectionVersion,
      nonce: encodeBase64(connectionNonce),
      personalAccountId: row.personal_account_id,
      version: 1,
    },
    providerLocator,
  };
};

const connectionRecord = (
  row: ConnectionRow | undefined,
  prefix = "",
): WhatsAppConnectionRecord | null => {
  const accountKeyCiphertext = bytes(row?.account_key_ciphertext);
  const accountKeyVersion = positiveInteger(row?.account_key_version);
  const connectionKeyAccountVersion = positiveInteger(
    row?.connection_key_account_version,
  );
  const connectionKeyCiphertext = bytes(row?.connection_key_ciphertext);
  const connectionKeyNonce = bytes(row?.connection_key_nonce);
  const connectionKeyVersion = positiveInteger(row?.connection_key_version);
  const connectionId = row?.connection_id;
  const displayNameCiphertext = versionedCiphertext(
    row?.display_name_ciphertext_version,
    row?.display_name_key_version,
    row?.display_name_nonce,
    row?.display_name_ciphertext,
  );
  const displayNameFallback =
    typeof row?.display_name_fallback === "string"
      ? row.display_name_fallback
      : null;
  const numberSuffix = row?.[`${prefix}number_suffix`];
  const publicId = row?.[`${prefix}public_id`];
  const state = row?.[`${prefix}state`];
  const stateChangedAt = timestamp(row?.[`${prefix}state_changed_at`]);
  if (
    accountKeyCiphertext === null ||
    accountKeyVersion === null ||
    typeof row?.account_kms_key_id !== "string" ||
    typeof row?.personal_account_id !== "string" ||
    typeof connectionId !== "string" ||
    connectionKeyAccountVersion === null ||
    connectionKeyCiphertext === null ||
    connectionKeyNonce === null ||
    connectionKeyVersion === null ||
    (displayNameCiphertext === null) === (displayNameFallback === null) ||
    typeof numberSuffix !== "string" ||
    !/^[0-9]{4}$/u.test(numberSuffix) ||
    typeof publicId !== "string" ||
    !/^con_[A-Za-z0-9_-]{21}$/u.test(publicId) ||
    typeof state !== "string" ||
    !connectionStates.has(state as WhatsAppConnectionState) ||
    stateChangedAt === null
  ) {
    return null;
  }
  return {
    accountKey: {
      ciphertext: encodeBase64(accountKeyCiphertext),
      keyVersion: accountKeyVersion,
      kmsKeyId: row.account_kms_key_id,
      personalAccountId: row.personal_account_id,
      version: 1,
    },
    connectionId,
    connectionKey: {
      accountKeyVersion: connectionKeyAccountVersion,
      ciphertext: encodeBase64(connectionKeyCiphertext),
      connectionId,
      keyVersion: connectionKeyVersion,
      nonce: encodeBase64(connectionKeyNonce),
      personalAccountId: row.personal_account_id,
      version: 1,
    },
    displayName: {
      ciphertext: displayNameCiphertext,
      fallback: displayNameFallback,
    },
    numberSuffix,
    publicId,
    state: state as WhatsAppConnectionState,
    stateChangedAt,
  };
};

const lifecycleClaim = (
  row: LifecycleClaimRow | undefined,
  connection: WhatsAppConnectionRecord | null,
): WhatsAppConnectionLifecycleClaim | null => {
  if (row === undefined) return null;
  if (connection === null) {
    throw new Error("invalid WhatsApp Connection lifecycle claim");
  }
  if (row.outcome === "complete" || row.outcome === "in_progress") {
    return { connection, outcome: row.outcome };
  }
  if (
    row.outcome !== "claimed" ||
    (row.lifecycle_action !== "disconnect" &&
      row.lifecycle_action !== "reconnect") ||
    typeof row.setup_marker !== "string" ||
    !/^cst_[A-Za-z0-9_-]{21}$/u.test(row.setup_marker)
  ) {
    throw new Error("invalid WhatsApp Connection lifecycle claim");
  }
  return {
    action: row.lifecycle_action,
    connection,
    outcome: "claimed",
    setupMarker: row.setup_marker,
  };
};

const authorizeUser = async (
  db: Database,
  clerkUserId: string,
): Promise<string | null> => {
  const rows = await db.execute<{ personal_account_id: unknown }>(
    sql`SELECT public.load_whatsapp_connection_account(${clerkUserId}) AS personal_account_id`,
  );
  const personalAccountId = rows[0]?.personal_account_id;
  if (typeof personalAccountId !== "string") return null;
  await enterPersonalAccountContext(db, personalAccountId);
  return personalAccountId;
};

const protectedConnectionSql = sql`
  SELECT
    account_keys.ciphertext AS account_key_ciphertext,
    account_keys.key_version AS account_key_version,
    account_keys.kms_key_id AS account_kms_key_id,
    connections.id AS connection_id,
    connection_keys.account_key_version AS connection_key_account_version,
    connection_keys.ciphertext AS connection_key_ciphertext,
    connection_keys.nonce AS connection_key_nonce,
    connection_keys.key_version AS connection_key_version,
    connections.display_name_ciphertext,
    connections.display_name_ciphertext_version,
    connections.display_name_fallback,
    connections.display_name_key_version,
    connections.display_name_nonce,
    connections.number_suffix,
    connections.personal_account_id,
    connections.public_id,
    connections.state,
    connections.state_changed_at
  FROM public.whatsapp_connections AS connections
  JOIN public.personal_account_key_envelopes AS account_keys
    ON account_keys.personal_account_id = connections.personal_account_id
   AND account_keys.unavailable_at IS NULL
   AND account_keys.ciphertext IS NOT NULL
  JOIN public.whatsapp_connection_key_envelopes AS connection_keys
    ON connection_keys.personal_account_id = connections.personal_account_id
   AND connection_keys.whatsapp_connection_id = connections.id
   AND connection_keys.unavailable_at IS NULL
   AND connection_keys.ciphertext IS NOT NULL`;

const loadConnection = async (
  db: Database,
  personalAccountId: string,
  publicId: string,
): Promise<WhatsAppConnectionRecord | null> => {
  const rows = await db.execute<ConnectionRow>(sql`${protectedConnectionSql}
    WHERE connections.personal_account_id = ${personalAccountId}
      AND connections.public_id = ${publicId}
      AND connections.state <> 'deleting'`);
  return connectionRecord(rows[0]);
};

interface ActivationRow extends ConnectionRow {
  readonly account_key_ciphertext: unknown;
  readonly account_key_version: unknown;
  readonly account_kms_key_id: unknown;
  readonly number_ciphertext: unknown;
  readonly number_ciphertext_version: unknown;
  readonly number_key_version: unknown;
  readonly number_nonce: unknown;
  readonly outcome: unknown;
  readonly personal_account_id: unknown;
  readonly setup_key_account_version: unknown;
  readonly setup_key_ciphertext: unknown;
  readonly setup_key_nonce: unknown;
  readonly setup_key_version: unknown;
  readonly webhook_ingress_id?: unknown;
}

const versionedCiphertext = (
  versionValue: unknown,
  keyVersionValue: unknown,
  nonceValue: unknown,
  ciphertextValue: unknown,
): VersionedCiphertext | null => {
  const version = positiveInteger(versionValue);
  const keyVersion = positiveInteger(keyVersionValue);
  const nonce = bytes(nonceValue);
  const ciphertext = bytes(ciphertextValue);
  return version === 1 &&
    keyVersion !== null &&
    nonce !== null &&
    ciphertext !== null
    ? {
        ciphertext: encodeBase64(ciphertext),
        keyVersion,
        nonce: encodeBase64(nonce),
        version: 1,
      }
    : null;
};

const activation = (
  setupId: string,
  row: ActivationRow | undefined,
): ConnectionSetupActivation | null => {
  if (row === undefined) return null;
  if (row.outcome === "pending" || row.outcome === "provisioning_quarantined") {
    return { outcome: row.outcome };
  }
  if (row.outcome === "provisioning_failed") {
    throw new Error("Connection Setup failure code was not loaded");
  }
  if (row.outcome === "activated") {
    const connection = connectionRecord(row, "connection_");
    if (connection === null) {
      throw new Error("invalid activated WhatsApp Connection");
    }
    return { connection, outcome: "activated" };
  }

  const accountKeyCiphertext = bytes(row.account_key_ciphertext);
  const accountKeyVersion = positiveInteger(row.account_key_version);
  const setupKeyAccountVersion = positiveInteger(row.setup_key_account_version);
  const setupKeyVersion = positiveInteger(row.setup_key_version);
  const setupKeyNonce = bytes(row.setup_key_nonce);
  const setupKeyCiphertext = bytes(row.setup_key_ciphertext);
  const numberCiphertext = versionedCiphertext(
    row.number_ciphertext_version,
    row.number_key_version,
    row.number_nonce,
    row.number_ciphertext,
  );
  const displayNameCiphertext = versionedCiphertext(
    row.display_name_ciphertext_version,
    row.display_name_key_version,
    row.display_name_nonce,
    row.display_name_ciphertext,
  );
  const displayNameFallback =
    typeof row.display_name_fallback === "string"
      ? row.display_name_fallback
      : null;
  if (
    row.outcome !== "provisioned" ||
    typeof row.personal_account_id !== "string" ||
    typeof row.account_kms_key_id !== "string" ||
    accountKeyCiphertext === null ||
    accountKeyVersion === null ||
    setupKeyAccountVersion === null ||
    setupKeyVersion === null ||
    setupKeyNonce === null ||
    setupKeyCiphertext === null ||
    numberCiphertext === null ||
    (displayNameCiphertext === null) === (displayNameFallback === null) ||
    typeof row.webhook_ingress_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      row.webhook_ingress_id,
    )
  ) {
    throw new Error("invalid Connection Setup activation material");
  }
  return {
    outcome: "provisioned",
    setup: {
      accountKey: {
        ciphertext: encodeBase64(accountKeyCiphertext),
        keyVersion: accountKeyVersion,
        kmsKeyId: row.account_kms_key_id,
        personalAccountId: row.personal_account_id,
        version: 1,
      },
      displayName: {
        ciphertext: displayNameCiphertext,
        fallback: displayNameFallback,
      },
      numberCiphertext,
      personalAccountId: row.personal_account_id,
      setupId,
      setupKey: {
        accountKeyVersion: setupKeyAccountVersion,
        ciphertext: encodeBase64(setupKeyCiphertext),
        connectionId: setupId,
        keyVersion: setupKeyVersion,
        nonce: encodeBase64(setupKeyNonce),
        personalAccountId: row.personal_account_id,
        version: 1,
      },
      webhookIngressId: row.webhook_ingress_id,
    },
  };
};

export const makeWhatsAppConnectionRepository = (
  provider: WhatsAppConnectionConnectionProvider,
): WhatsAppConnectionRepository => ({
  activate: (input) =>
    provider.withConnection((connection) => {
      const db = makeDatabase(connection);
      return withTransaction(connection, async () => {
        await enterPersonalAccountContext(db, input.personalAccountId);
        const rows = await db.execute<ConnectionRow>(
          sql`SELECT * FROM public.activate_connection_setup(
            ${input.personalAccountId}, ${input.setupId}, ${input.connectionId},
            ${input.publicId}, ${input.webhookIngressId}, ${input.numberSuffix},
            ${input.connectedAt}, ${input.accountKeyVersion},
            ${input.connectionKeyVersion}, ${input.connectionKeyNonce},
            ${input.connectionKeyCiphertext}, ${input.locatorCiphertextVersion},
            ${input.locatorKeyVersion}, ${input.locatorNonce},
            ${input.locatorCiphertext}, ${input.authorityCiphertextVersion},
            ${input.authorityKeyVersion}, ${input.authorityNonce},
            ${input.authorityCiphertext}, ${input.webhookSecretCiphertextVersion},
            ${input.webhookSecretKeyVersion}, ${input.webhookSecretNonce},
            ${input.webhookSecretCiphertext}
          )`,
        );
        if (rows.length === 0) {
          throw new Error("WhatsApp Connection activation unavailable");
        }
        await db
          .update(whatsappConnectionsInApp)
          .set({
            displayNameCiphertext: input.displayNameCiphertext,
            displayNameCiphertextVersion: input.displayNameCiphertextVersion,
            displayNameFallback: null,
            displayNameKeyVersion: input.displayNameKeyVersion,
            displayNameNonce: input.displayNameNonce,
          })
          .where(
            and(
              eq(
                whatsappConnectionsInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(whatsappConnectionsInApp.id, input.connectionId),
              eq(whatsappConnectionsInApp.connectionSetupId, input.setupId),
            ),
          );
        await db.execute(sql`
          WITH installed AS (
            UPDATE public.whatsapp_connection_secrets
            SET message_search_key_ciphertext_version = ${input.messageSearchKeyCiphertextVersion},
                message_search_key_version = ${input.messageSearchKeyVersion},
                message_search_key_nonce = ${input.messageSearchKeyNonce},
                message_search_key_ciphertext = ${input.messageSearchKeyCiphertext},
                updated_at = ${input.connectedAt}
            WHERE personal_account_id = ${input.personalAccountId}
              AND whatsapp_connection_id = ${input.connectionId}
              AND message_search_key_ciphertext IS NULL
            RETURNING personal_account_id, whatsapp_connection_id
          ), covered AS (
            INSERT INTO public.message_search_backfill_coverage (
              personal_account_id, whatsapp_connection_id, index_version,
              state, searchable_from, updated_at
            ) SELECT
              personal_account_id, whatsapp_connection_id, 1,
              'complete', ${input.connectedAt}, ${input.connectedAt}
            FROM installed ON CONFLICT DO NOTHING
          )
          SELECT 1
        `);
        const winnerPublicId = rows[0]?.public_id;
        if (typeof winnerPublicId !== "string") {
          throw new Error("WhatsApp Connection activation unavailable");
        }
        const record = await loadConnection(
          db,
          input.personalAccountId,
          winnerPublicId,
        );
        if (record === null) {
          throw new Error("WhatsApp Connection activation unavailable");
        }
        await db.execute(sql`
          INSERT INTO public.message_search_backfill_coverage (
            personal_account_id,
            whatsapp_connection_id,
            index_version,
            state,
            searchable_from,
            updated_at
          ) VALUES (
            ${input.personalAccountId},
            ${record.connectionId},
            1,
            'complete',
            ${record.stateChangedAt},
            ${record.stateChangedAt}
          )
          ON CONFLICT (personal_account_id, whatsapp_connection_id, index_version)
          DO NOTHING
        `);
        return record;
      });
    }),
  claimLifecycle: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        const rows = await db.execute<LifecycleClaimRow>(
          sql`SELECT * FROM public.claim_whatsapp_connection_lifecycle(
          ${input.clerkUserId}, ${input.publicId}, ${input.action},
          ${input.claimId}, ${input.requestedAt}
        )`,
        );
        const row = rows[0];
        if (row === undefined) return null;
        const personalAccountId = await authorizeUser(db, input.clerkUserId);
        const protectedConnection =
          personalAccountId === null
            ? null
            : await loadConnection(db, personalAccountId, input.publicId);
        return lifecycleClaim(row, protectedConnection);
      }),
    ),
  finishLifecycle: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        const rows = await db.execute<ConnectionRow>(
          sql`SELECT * FROM public.finish_whatsapp_connection_lifecycle(
          ${input.clerkUserId}, ${input.publicId}, ${input.claimId},
          ${input.state}, ${input.observedAt}
        )`,
        );
        const row = rows[0];
        if (row === undefined) return null;
        const personalAccountId = await authorizeUser(db, input.clerkUserId);
        return personalAccountId === null
          ? null
          : loadConnection(db, personalAccountId, input.publicId);
      }),
    ),
  prepareDeletion: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<DeletionRow>(
        sql`SELECT * FROM public.prepare_whatsapp_connection_deletion(
          ${input.clerkUserId}, ${input.publicId}
        )`,
      );
      return deletionPreparation(rows[0]);
    }),
  finishDeletion: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<DeletionRow>(
        sql`SELECT * FROM public.finish_whatsapp_connection_deletion(
          ${input.clerkUserId}, ${input.publicId}, ${input.deletionMarkerId},
          ${input.requestedAt}
        )`,
      );
      return deletionReceipt(rows[0]);
    }),
  finishDeletionCleanup: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{
        complete: unknown;
      }>(
        sql`SELECT public.finish_whatsapp_connection_cleanup(
          ${input.deletionMarkerId}, ${input.providerAbsenceConfirmedAt}
        ) AS complete`,
      );
      if (typeof rows[0]?.complete !== "boolean") {
        throw new Error("invalid Connection Deletion cleanup result");
      }
      return rows[0].complete;
    }),
  confirmProviderAbsence: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{
        confirmed: unknown;
      }>(
        sql`SELECT public.confirm_whatsapp_connection_provider_absence(
          ${input.deletionMarkerId}, ${input.confirmedAt}
        ) AS confirmed`,
      );
      if (typeof rows[0]?.confirmed !== "boolean") {
        throw new Error("invalid provider absence confirmation");
      }
      return rows[0].confirmed;
    }),
  listDeletionCandidates: (input) =>
    provider.withConnection(async (connection) => {
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 1000
      ) {
        throw new Error("invalid Connection Deletion candidate limit");
      }
      const rows = await makeDatabase(connection).execute<DeletionCandidateRow>(
        sql`SELECT * FROM public.list_whatsapp_connection_deletion_candidates(
          ${input.observedAt}, ${input.limit}
        )`,
      );
      return rows.map(deletionCandidate);
    }),
  listDeletionPurgeCandidates: (input) =>
    provider.withConnection(async (connection) => {
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 1000
      ) {
        throw new Error("invalid Connection Deletion purge limit");
      }
      const rows = await makeDatabase(connection).execute<DeletionCandidateRow>(
        sql`SELECT * FROM public.list_whatsapp_connection_active_purge_candidates(
          ${input.observedAt}, ${input.limit}
        )`,
      );
      return rows.map(deletionCandidate);
    }),
  prepareDeletionCleanup: (input) =>
    provider.withConnection(async (connection) => {
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 1000
      ) {
        throw new Error("invalid Connection Deletion object limit");
      }
      const rows = await makeDatabase(connection).execute<DeletionObjectsRow>(
        sql`SELECT * FROM public.prepare_whatsapp_connection_cleanup(
          ${input.deletionMarkerId}, ${input.requestedAt}, ${input.limit}
        )`,
      );
      const row = rows[0];
      if (row === undefined) return null;
      const storedMediaObjectKeys = stringArray(row.stored_media_object_keys);
      const webhookSourceObjectKeys = stringArray(
        row.webhook_source_object_keys,
      );
      if (
        typeof row.personal_account_id !== "string" ||
        storedMediaObjectKeys === null ||
        webhookSourceObjectKeys === null
      ) {
        throw new Error("invalid Connection Deletion objects");
      }
      return {
        personalAccountId: row.personal_account_id,
        storedMediaObjectKeys,
        webhookSourceObjectKeys,
      };
    }),
  finishWebhookSourceDeletion: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{
        complete: unknown;
      }>(
        sql`SELECT public.finish_whatsapp_connection_webhook_source_deletion(
          ${input.deletionMarkerId}, ${input.objectKey}
        ) AS complete`,
      );
      if (typeof rows[0]?.complete !== "boolean") {
        throw new Error("invalid Webhook Event source deletion result");
      }
      return rows[0].complete;
    }),
  listForUser: (clerkUserId) =>
    provider.withConnection((connection) => {
      const db = makeDatabase(connection);
      return withTransaction(connection, async () => {
        const personalAccountId = await authorizeUser(db, clerkUserId);
        if (personalAccountId === null) return [];
        const result =
          await db.execute<ConnectionRow>(sql`${protectedConnectionSql}
          WHERE connections.number_suffix IS NOT NULL
            AND connections.state <> 'deleting'
          ORDER BY connections.created_at, connections.public_id`);
        return result.map((row) => {
          const record = connectionRecord(row);
          if (record === null) {
            throw new Error("invalid persisted WhatsApp Connection");
          }
          return record;
        });
      });
    }),
  loadForUser: (input) =>
    provider.withConnection((connection) => {
      const db = makeDatabase(connection);
      return withTransaction(connection, async () => {
        const personalAccountId = await authorizeUser(db, input.clerkUserId);
        return personalAccountId === null
          ? null
          : loadConnection(db, personalAccountId, input.publicId);
      });
    }),
  rename: (input) =>
    provider.withConnection((connection) => {
      const db = makeDatabase(connection);
      return withTransaction(connection, async () => {
        const loaded = await db.execute<{ personal_account_id: unknown }>(
          sql`SELECT public.load_whatsapp_connection_account(${input.clerkUserId})
              AS personal_account_id`,
        );
        const personalAccountId = loaded[0]?.personal_account_id;
        if (typeof personalAccountId !== "string") return null;
        await enterPersonalAccountContext(db, personalAccountId);
        const rows = await db
          .update(whatsappConnectionsInApp)
          .set({
            displayNameCiphertext: input.displayNameCiphertext,
            displayNameCiphertextVersion: input.displayNameCiphertextVersion,
            displayNameFallback: null,
            displayNameKeyVersion: input.displayNameKeyVersion,
            displayNameNonce: input.displayNameNonce,
            updatedAt: sql`transaction_timestamp()`,
          })
          .where(
            and(
              eq(whatsappConnectionsInApp.publicId, input.publicId),
              ne(whatsappConnectionsInApp.state, "deleting"),
            ),
          )
          .returning({ publicId: whatsappConnectionsInApp.publicId });
        return rows.length === 1
          ? loadConnection(db, personalAccountId, input.publicId)
          : null;
      });
    }),
  loadSetupForActivation: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        const rows = await db.execute<ActivationRow>(
          sql`SELECT * FROM public.load_connection_setup_for_activation(
          ${input.clerkUserId}, ${input.setupId}, ${input.observedAt}
        )`,
        );
        let row = rows[0];
        if (row?.outcome === "provisioning_failed") {
          const failures = await db.execute<{ failure_code: unknown }>(
            sql`SELECT public.load_connection_setup_failure_code_for_user(
            ${input.clerkUserId}, ${input.setupId}
          ) AS failure_code`,
          );
          const failureCode = failures[0]?.failure_code;
          if (
            typeof failureCode !== "string" ||
            !/^[a-z][a-z0-9_]{0,63}$/u.test(failureCode)
          ) {
            throw new Error("invalid Connection Setup failure code");
          }
          return { failureCode, outcome: "provisioning_failed" };
        }
        if (row?.outcome === "provisioned") {
          await authorizeUser(db, input.clerkUserId);
          const ingress = await db.execute<{ webhook_ingress_id: unknown }>(
            sql`SELECT public.load_connection_setup_webhook_ingress_for_user(
            ${input.clerkUserId}, ${input.setupId}
          ) AS webhook_ingress_id`,
          );
          row = {
            ...row,
            webhook_ingress_id: ingress[0]?.webhook_ingress_id,
          };
          const names = await db
            .select({
              display_name_ciphertext:
                connectionSetupsInApp.displayNameCiphertext,
              display_name_ciphertext_version:
                connectionSetupsInApp.displayNameCiphertextVersion,
              display_name_fallback: connectionSetupsInApp.displayNameFallback,
              display_name_key_version:
                connectionSetupsInApp.displayNameKeyVersion,
              display_name_nonce: connectionSetupsInApp.displayNameNonce,
            })
            .from(connectionSetupsInApp)
            .where(eq(connectionSetupsInApp.id, input.setupId));
          row = { ...row, ...names[0] };
        }
        if (row?.outcome === "activated") {
          const personalAccountId = await authorizeUser(db, input.clerkUserId);
          if (
            personalAccountId === null ||
            typeof row.connection_public_id !== "string"
          )
            return null;
          const connection = await loadConnection(
            db,
            personalAccountId,
            row.connection_public_id,
          );
          if (connection === null)
            throw new Error("invalid activated WhatsApp Connection");
          return { connection, outcome: "activated" };
        }
        return activation(input.setupId, row);
      }),
    ),
  failSetupActivation: (input) =>
    provider.withConnection((connection) => {
      const db = makeDatabase(connection);
      return withTransaction(connection, async () => {
        await enterPersonalAccountContext(db, input.personalAccountId);
        const rows = await db.execute<{ failed: unknown }>(
          sql`SELECT public.fail_connection_setup_activation(
            ${input.personalAccountId}, ${input.setupId}, ${input.failureCode},
            ${input.observedAt}
          ) AS failed`,
        );
        if (typeof rows[0]?.failed !== "boolean") {
          throw new Error("invalid Connection Setup activation failure");
        }
        return rows[0].failed;
      });
    }),
});

const makePgConnectionProvider = (
  connectionString: string,
): WhatsAppConnectionConnectionProvider => ({
  withConnection: (use) => withPgQueryConnection(connectionString, use),
});

export const makePgWhatsAppConnectionRepository = (
  connectionString: string,
): WhatsAppConnectionRepository =>
  makeWhatsAppConnectionRepository(makePgConnectionProvider(connectionString));
