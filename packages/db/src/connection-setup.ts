import { and, eq, sql } from "drizzle-orm";
import { type Database, makeDatabase, withPgQueryConnection } from "./database";
import {
  connectionSetupKeyEnvelopesInApp,
  connectionSetupsInApp,
  personalAccountsInApp,
  whatsappNumberReservationsInApp,
} from "./schema";
import { withTransaction } from "./transaction";

export interface ConnectionSetupConnection {
  readonly query: <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    text: string,
    values?: Array<unknown>,
  ) => Promise<{ readonly rows: Array<Row> }>;
}

export interface ConnectionSetupConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: ConnectionSetupConnection) => Promise<Value>,
  ) => Promise<Value>;
}

export interface ConnectionSetupRecord {
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly setupId: string;
  readonly state:
    | "cancelled"
    | "expired"
    | "provisioned"
    | "activated"
    | "provisioning_failed"
    | "provisioning_pending"
    | "provisioning_quarantined";
}

export interface PersistedConnectionName {
  readonly ciphertext: Uint8Array | null;
  readonly fallback: string | null;
  readonly keyVersion: number | null;
  readonly nonce: Uint8Array | null;
  readonly version: 1 | null;
}

export interface ConnectionSetupNameMaterial {
  readonly accountKey: PreparedConnectionSetupAccountKey;
  readonly name: PersistedConnectionName;
  readonly setupKey: ConnectionSetupKey;
}

interface PreparedConnectionSetupAccountKey {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly kmsKeyId: string;
  readonly personalAccountId: string;
  readonly version: 1;
}

interface ConnectionSetupKey {
  readonly accountKeyVersion: number;
  readonly ciphertext: string;
  readonly connectionId: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly personalAccountId: string;
  readonly version: 1;
}

export type PreparedConnectionSetup =
  | {
      readonly accountKey: PreparedConnectionSetupAccountKey;
      readonly outcome: "unbound";
      readonly whatsappConnectionLimit: number;
    }
  | {
      readonly outcome: "replay";
      readonly nameMaterial: ConnectionSetupNameMaterial;
      readonly setup: ConnectionSetupRecord;
    }
  | { readonly outcome: "idempotency_conflict" }
  | { readonly outcome: "onboarding_profile_required" };

export interface PrepareConnectionSetupInput {
  readonly clerkUserId: string;
  readonly idempotencyKey: string;
  readonly numberToken: Uint8Array;
}

export interface StartConnectionSetupInput {
  readonly accountKey: PreparedConnectionSetupAccountKey;
  readonly connectionKeyCiphertext: Uint8Array;
  readonly connectionKeyNonce: Uint8Array;
  readonly connectionKeyVersion: number;
  readonly createdAt: string;
  readonly displayNameCiphertext: Uint8Array;
  readonly displayNameCiphertextNonce: Uint8Array;
  readonly displayNameCiphertextVersion: number;
  readonly displayNameKeyVersion: number;
  readonly idempotencyKey: string;
  readonly numberCiphertext: Uint8Array;
  readonly numberCiphertextNonce: Uint8Array;
  readonly numberCiphertextVersion: number;
  readonly numberKeyVersion: number;
  readonly numberToken: Uint8Array;
  readonly personalAccountId: string;
  readonly setupId: string;
}

export type StartedConnectionSetup =
  | {
      readonly outcome: "created";
      readonly setup: ConnectionSetupRecord;
    }
  | {
      readonly nameMaterial: ConnectionSetupNameMaterial;
      readonly outcome: "replay";
      readonly setup: ConnectionSetupRecord;
    }
  | {
      readonly outcome:
        | "connection_limit_reached"
        | "idempotency_conflict"
        | "number_unavailable";
    };

export interface ConnectionSetupProvisioningClaimInput {
  readonly claimedAt: string;
  readonly setupId: string;
  readonly workerId: string;
}

export type ConnectionSetupProvisioningClaim =
  | {
      readonly outcome: "claimed";
      readonly setup: {
        readonly accountKey: {
          readonly ciphertext: string;
          readonly keyVersion: number;
          readonly kmsKeyId: string;
          readonly personalAccountId: string;
          readonly version: 1;
        };
        readonly connectionKey: {
          readonly accountKeyVersion: number;
          readonly ciphertext: string;
          readonly connectionId: string;
          readonly keyVersion: number;
          readonly nonce: string;
          readonly personalAccountId: string;
          readonly version: 1;
        };
        readonly createdAt: string;
        readonly firstClaim: boolean;
        readonly numberCiphertext: {
          readonly ciphertext: string;
          readonly keyVersion: number;
          readonly nonce: string;
          readonly version: 1;
        };
        readonly personalAccountId: string;
        readonly provisioningStartedAt: string | null;
        readonly setupId: string;
        readonly webhookIngressId: string;
      };
    }
  | {
      readonly outcome: "expired" | "leased" | "not_found" | "not_pending";
    };

export interface EncryptedConnectionSetupProviderSession {
  readonly authorityCiphertext: Uint8Array;
  readonly authorityCiphertextVersion: number;
  readonly authorityKeyVersion: number;
  readonly authorityNonce: Uint8Array;
  readonly locatorCiphertext: Uint8Array;
  readonly locatorCiphertextVersion: number;
  readonly locatorKeyVersion: number;
  readonly locatorNonce: Uint8Array;
  readonly ordinal: number;
}

export interface FinishConnectionSetupProvisioningInput {
  readonly observedAt: string;
  readonly outcome: "provisioned" | "quarantined";
  readonly sessions: ReadonlyArray<EncryptedConnectionSetupProviderSession>;
  readonly setupId: string;
  readonly workerId: string;
}

export interface RenewConnectionSetupProvisioningLeaseInput {
  readonly observedAt: string;
  readonly setupId: string;
  readonly workerId: string;
}

export interface ReleaseConnectionSetupProvisioningLeaseInput
  extends RenewConnectionSetupProvisioningLeaseInput {
  readonly failureCode: string;
}

export interface ListConnectionSetupProvisioningCandidatesInput {
  readonly limit: number;
  readonly observedAt: string;
}

export interface CancelConnectionSetupInput {
  readonly cancelledAt: string;
  readonly clerkUserId: string;
  readonly setupId: string;
}

export interface CancelledConnectionSetup {
  readonly cleanupState: "complete" | "pending" | "retrying";
  readonly outcome: "cancelled" | "replay";
  readonly setupId: string;
  readonly state: "cancelled" | "expired";
}

export interface ConnectionSetupCleanupClaimInput {
  readonly claimedAt: string;
  readonly setupId: string;
  readonly workerId: string;
}

export type ConnectionSetupCleanupClaim = {
  readonly outcome:
    | "claimed"
    | "complete"
    | "leased"
    | "not_found"
    | "not_terminal";
};

export interface ConnectionSetupCleanupLeaseInput {
  readonly observedAt: string;
  readonly setupId: string;
  readonly workerId: string;
}

export interface ReleaseConnectionSetupCleanupLeaseInput
  extends ConnectionSetupCleanupLeaseInput {
  readonly failureCode: string;
}

export interface ListConnectionSetupCleanupCandidatesInput {
  readonly limit: number;
  readonly observedAt: string;
}

export interface ConnectionSetupRepository {
  readonly cancel: (
    input: CancelConnectionSetupInput,
  ) => Promise<CancelledConnectionSetup | null>;
  readonly claimCleanup: (
    input: ConnectionSetupCleanupClaimInput,
  ) => Promise<ConnectionSetupCleanupClaim>;
  readonly claimProvisioning: (
    input: ConnectionSetupProvisioningClaimInput,
  ) => Promise<ConnectionSetupProvisioningClaim>;
  readonly finishProvisioning: (
    input: FinishConnectionSetupProvisioningInput,
  ) => Promise<boolean>;
  readonly finishCleanup: (
    input: ConnectionSetupCleanupLeaseInput,
  ) => Promise<boolean>;
  readonly failProvisioning: (
    input: ReleaseConnectionSetupProvisioningLeaseInput,
  ) => Promise<boolean>;
  readonly listProvisioningCandidates: (
    input: ListConnectionSetupProvisioningCandidatesInput,
  ) => Promise<ReadonlyArray<string>>;
  readonly listCleanupCandidates: (
    input: ListConnectionSetupCleanupCandidatesInput,
  ) => Promise<ReadonlyArray<string>>;
  readonly prepare: (
    input: PrepareConnectionSetupInput,
  ) => Promise<PreparedConnectionSetup | null>;
  readonly releaseProvisioningLease: (
    input: ReleaseConnectionSetupProvisioningLeaseInput,
  ) => Promise<boolean>;
  readonly releaseCleanupLease: (
    input: ReleaseConnectionSetupCleanupLeaseInput,
  ) => Promise<boolean>;
  readonly renewProvisioningLease: (
    input: RenewConnectionSetupProvisioningLeaseInput,
  ) => Promise<boolean>;
  readonly renewCleanupLease: (
    input: ConnectionSetupCleanupLeaseInput,
  ) => Promise<boolean>;
  readonly expire: (
    input: ListConnectionSetupCleanupCandidatesInput,
  ) => Promise<ReadonlyArray<string>>;
  readonly start: (
    input: StartConnectionSetupInput,
  ) => Promise<StartedConnectionSetup>;
}

const enterPersonalAccountContext = async (
  db: Database,
  personalAccountId: string,
): Promise<boolean> => {
  await db.execute(
    sql`SELECT set_config('public.personal_account_id', ${personalAccountId}, true)`,
  );
  const visible = await db
    .select({ id: personalAccountsInApp.id })
    .from(personalAccountsInApp)
    .where(
      and(
        eq(personalAccountsInApp.id, personalAccountId),
        eq(personalAccountsInApp.state, "active"),
      ),
    );
  return visible.length === 1;
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

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength &&
  left.every((value, index) => value === right[index]);

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

interface SetupRow extends Record<string, unknown> {
  readonly created_at: unknown;
  readonly expires_at: unknown;
  readonly id: unknown;
  readonly display_name?: unknown;
  readonly number_token?: unknown;
  readonly setup_created_at?: unknown;
  readonly setup_expires_at?: unknown;
  readonly setup_id?: unknown;
  readonly setup_state?: unknown;
  readonly state: unknown;
}

const setupRecord = (
  row: SetupRow | undefined,
  prefix = "",
): ConnectionSetupRecord | null => {
  const setupId = row?.[`${prefix}id`];
  const state = row?.[`${prefix}state`];
  const createdAt = timestamp(row?.[`${prefix}created_at`]);
  const expiresAt = timestamp(row?.[`${prefix}expires_at`]);
  if (
    typeof setupId !== "string" ||
    (state !== "cancelled" &&
      state !== "expired" &&
      state !== "activated" &&
      state !== "provisioned" &&
      state !== "provisioning_failed" &&
      state !== "provisioning_pending" &&
      state !== "provisioning_quarantined") ||
    createdAt === null ||
    expiresAt === null
  ) {
    return null;
  }
  return { createdAt, expiresAt, setupId, state };
};

const fallbackNamePattern =
  /^(Bright|Calm|Clever|Kind|Lucky|Quiet|Swift|Warm) (Badger|Falcon|Fox|Otter|Panda|Robin|Tiger|Turtle)$/u;

const loadNameMaterial = async (
  db: Database,
  accountKey: PreparedConnectionSetupAccountKey,
  setupId: string,
): Promise<ConnectionSetupNameMaterial> => {
  const rows = await db
    .select({
      ciphertext: connectionSetupsInApp.displayNameCiphertext,
      fallback: connectionSetupsInApp.displayNameFallback,
      keyVersion: connectionSetupsInApp.displayNameKeyVersion,
      nonce: connectionSetupsInApp.displayNameNonce,
      version: connectionSetupsInApp.displayNameCiphertextVersion,
      setupKeyAccountVersion:
        connectionSetupKeyEnvelopesInApp.accountKeyVersion,
      setupKeyCiphertext: connectionSetupKeyEnvelopesInApp.ciphertext,
      setupKeyNonce: connectionSetupKeyEnvelopesInApp.nonce,
      setupKeyVersion: connectionSetupKeyEnvelopesInApp.keyVersion,
    })
    .from(connectionSetupsInApp)
    .innerJoin(
      connectionSetupKeyEnvelopesInApp,
      and(
        eq(
          connectionSetupKeyEnvelopesInApp.personalAccountId,
          connectionSetupsInApp.personalAccountId,
        ),
        eq(
          connectionSetupKeyEnvelopesInApp.connectionSetupId,
          connectionSetupsInApp.id,
        ),
      ),
    )
    .where(
      and(
        eq(
          connectionSetupsInApp.personalAccountId,
          accountKey.personalAccountId,
        ),
        eq(connectionSetupsInApp.id, setupId),
      ),
    );
  const row = rows[0];
  const ciphertext = bytes(row?.ciphertext);
  const nonce = bytes(row?.nonce);
  const keyVersion = positiveInteger(row?.keyVersion);
  const setupKeyAccountVersion = positiveInteger(row?.setupKeyAccountVersion);
  const setupKeyCiphertext = bytes(row?.setupKeyCiphertext);
  const setupKeyNonce = bytes(row?.setupKeyNonce);
  const setupKeyVersion = positiveInteger(row?.setupKeyVersion);
  const fallback = typeof row?.fallback === "string" ? row.fallback : null;
  const encrypted =
    row?.version === 1 &&
    ciphertext !== null &&
    nonce !== null &&
    keyVersion !== null;
  if (
    setupKeyAccountVersion === null ||
    setupKeyCiphertext === null ||
    setupKeyNonce === null ||
    setupKeyVersion === null ||
    encrypted === (fallback !== null) ||
    (fallback !== null && !fallbackNamePattern.test(fallback))
  ) {
    throw new Error("invalid persisted Connection Setup name");
  }
  return {
    accountKey,
    name: encrypted
      ? { ciphertext, fallback: null, keyVersion, nonce, version: 1 }
      : {
          ciphertext: null,
          fallback,
          keyVersion: null,
          nonce: null,
          version: null,
        },
    setupKey: {
      accountKeyVersion: setupKeyAccountVersion,
      ciphertext: encodeBase64(setupKeyCiphertext),
      connectionId: setupId,
      keyVersion: setupKeyVersion,
      nonce: encodeBase64(setupKeyNonce),
      personalAccountId: accountKey.personalAccountId,
      version: 1,
    },
  };
};

interface AccountRow extends Record<string, unknown> {
  readonly account_key_ciphertext: unknown;
  readonly account_key_version: unknown;
  readonly kms_key_id: unknown;
  readonly personal_account_id: unknown;
  readonly webhook_ingress_id?: unknown;
  readonly whatsapp_connection_limit: unknown;
}

interface StartRow extends SetupRow {
  readonly outcome: unknown;
}

interface ProvisioningClaimRow extends Record<string, unknown> {
  readonly account_key_ciphertext: unknown;
  readonly account_key_version: unknown;
  readonly account_kms_key_id: unknown;
  readonly connection_key_account_version: unknown;
  readonly connection_key_ciphertext: unknown;
  readonly connection_key_nonce: unknown;
  readonly connection_key_version: unknown;
  readonly created_at?: unknown;
  readonly first_claim?: unknown;
  readonly number_ciphertext: unknown;
  readonly number_ciphertext_version: unknown;
  readonly number_key_version: unknown;
  readonly number_nonce: unknown;
  readonly outcome: unknown;
  readonly personal_account_id: unknown;
  readonly provisioning_started_at?: unknown;
}

interface CancelConnectionSetupRow extends Record<string, unknown> {
  readonly outcome: unknown;
  readonly setup_cleanup_state: unknown;
  readonly setup_id: unknown;
  readonly setup_state: unknown;
}

const cancelledConnectionSetup = (
  row: CancelConnectionSetupRow | undefined,
): CancelledConnectionSetup | null => {
  if (row === undefined) return null;
  if (
    (row.outcome !== "cancelled" && row.outcome !== "replay") ||
    typeof row.setup_id !== "string" ||
    (row.setup_state !== "cancelled" && row.setup_state !== "expired") ||
    (row.setup_cleanup_state !== "pending" &&
      row.setup_cleanup_state !== "retrying" &&
      row.setup_cleanup_state !== "complete")
  ) {
    throw new Error("invalid Connection Setup cancellation");
  }
  return {
    cleanupState: row.setup_cleanup_state,
    outcome: row.outcome,
    setupId: row.setup_id,
    state: row.setup_state,
  };
};

const cleanupClaimOutcomes = new Set<ConnectionSetupCleanupClaim["outcome"]>([
  "claimed",
  "complete",
  "leased",
  "not_found",
  "not_terminal",
]);

const setupIds = (
  rows: ReadonlyArray<{ readonly setup_id: unknown }>,
  message: string,
): ReadonlyArray<string> =>
  rows.map((row) => {
    if (typeof row.setup_id !== "string") throw new Error(message);
    return row.setup_id;
  });

const provisioningClaim = (
  setupId: string,
  row: ProvisioningClaimRow | undefined,
): ConnectionSetupProvisioningClaim => {
  if (
    row?.outcome === "expired" ||
    row?.outcome === "leased" ||
    row?.outcome === "not_found" ||
    row?.outcome === "not_pending"
  ) {
    return { outcome: row.outcome };
  }
  const accountKeyCiphertext = bytes(row?.account_key_ciphertext);
  const accountKeyVersion = positiveInteger(row?.account_key_version);
  const connectionKeyAccountVersion = positiveInteger(
    row?.connection_key_account_version,
  );
  const connectionKeyCiphertext = bytes(row?.connection_key_ciphertext);
  const connectionKeyNonce = bytes(row?.connection_key_nonce);
  const connectionKeyVersion = positiveInteger(row?.connection_key_version);
  const createdAt = timestamp(row?.created_at);
  const numberCiphertext = bytes(row?.number_ciphertext);
  const numberCiphertextVersion = positiveInteger(
    row?.number_ciphertext_version,
  );
  const numberKeyVersion = positiveInteger(row?.number_key_version);
  const numberNonce = bytes(row?.number_nonce);
  const provisioningStartedAt = timestamp(row?.provisioning_started_at);
  if (
    row?.outcome !== "claimed" ||
    typeof row.personal_account_id !== "string" ||
    typeof row.account_kms_key_id !== "string" ||
    accountKeyCiphertext === null ||
    accountKeyVersion === null ||
    connectionKeyAccountVersion === null ||
    connectionKeyCiphertext === null ||
    connectionKeyNonce === null ||
    connectionKeyVersion === null ||
    createdAt === null ||
    typeof row.first_claim !== "boolean" ||
    numberCiphertext === null ||
    numberCiphertextVersion !== 1 ||
    numberKeyVersion === null ||
    numberNonce === null ||
    typeof row.webhook_ingress_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      row.webhook_ingress_id,
    )
  ) {
    throw new Error("invalid Connection Setup provisioning claim");
  }
  return {
    outcome: "claimed",
    setup: {
      accountKey: {
        ciphertext: encodeBase64(accountKeyCiphertext),
        keyVersion: accountKeyVersion,
        kmsKeyId: row.account_kms_key_id,
        personalAccountId: row.personal_account_id,
        version: 1,
      },
      connectionKey: {
        accountKeyVersion: connectionKeyAccountVersion,
        ciphertext: encodeBase64(connectionKeyCiphertext),
        connectionId: setupId,
        keyVersion: connectionKeyVersion,
        nonce: encodeBase64(connectionKeyNonce),
        personalAccountId: row.personal_account_id,
        version: 1,
      },
      createdAt,
      firstClaim: row.first_claim,
      numberCiphertext: {
        ciphertext: encodeBase64(numberCiphertext),
        keyVersion: numberKeyVersion,
        nonce: encodeBase64(numberNonce),
        version: numberCiphertextVersion,
      },
      personalAccountId: row.personal_account_id,
      provisioningStartedAt,
      setupId,
      webhookIngressId: row.webhook_ingress_id,
    },
  };
};

const serializedProviderSessions = (
  sessions: ReadonlyArray<EncryptedConnectionSetupProviderSession>,
) =>
  JSON.stringify(
    sessions.map((session) => ({
      authorityCiphertext: encodeBase64(session.authorityCiphertext),
      authorityCiphertextVersion: session.authorityCiphertextVersion,
      authorityKeyVersion: session.authorityKeyVersion,
      authorityNonce: encodeBase64(session.authorityNonce),
      locatorCiphertext: encodeBase64(session.locatorCiphertext),
      locatorCiphertextVersion: session.locatorCiphertextVersion,
      locatorKeyVersion: session.locatorKeyVersion,
      locatorNonce: encodeBase64(session.locatorNonce),
      ordinal: session.ordinal,
    })),
  );

export const makeConnectionSetupRepository = (
  provider: ConnectionSetupConnectionProvider,
): ConnectionSetupRepository => ({
  cancel: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(
        connection,
      ).execute<CancelConnectionSetupRow>(
        sql`SELECT * FROM public.cancel_connection_setup(
          ${input.clerkUserId}, ${input.setupId}, ${input.cancelledAt}
        )`,
      );
      return cancelledConnectionSetup(rows[0]);
    }),
  claimCleanup: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{ outcome: unknown }>(
        sql`SELECT public.claim_connection_setup_cleanup(
          ${input.setupId}, ${input.workerId}, ${input.claimedAt}
        ) AS outcome`,
      );
      const outcome = rows[0]?.outcome;
      if (
        typeof outcome !== "string" ||
        !cleanupClaimOutcomes.has(
          outcome as ConnectionSetupCleanupClaim["outcome"],
        )
      ) {
        throw new Error("invalid Connection Setup cleanup claim");
      }
      return { outcome: outcome as ConnectionSetupCleanupClaim["outcome"] };
    }),
  claimProvisioning: (input) =>
    provider.withConnection(async (connection) => {
      const db = makeDatabase(connection);
      const rows = await db.execute<ProvisioningClaimRow>(
        sql`SELECT * FROM public.claim_connection_setup_provisioning(
          ${input.setupId}, ${input.workerId}, ${input.claimedAt}
        )`,
      );
      let row = rows[0];
      if (row?.outcome === "claimed") {
        const ingress = await db.execute<{ webhook_ingress_id: unknown }>(
          sql`SELECT public.load_connection_setup_webhook_ingress_for_worker(
            ${input.setupId}, ${input.workerId}
          ) AS webhook_ingress_id`,
        );
        row = {
          ...row,
          webhook_ingress_id: ingress[0]?.webhook_ingress_id,
        };
      }
      return provisioningClaim(input.setupId, row);
    }),
  expire: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{
        setup_id: unknown;
      }>(
        sql`SELECT setup_id FROM public.expire_connection_setups(
          ${input.observedAt}, ${input.limit}
        )`,
      );
      return setupIds(rows, "invalid expired Connection Setup");
    }),
  finishCleanup: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{
        finished: unknown;
      }>(
        sql`SELECT public.finish_connection_setup_cleanup(
          ${input.setupId}, ${input.workerId}, ${input.observedAt}
        ) AS finished`,
      );
      if (typeof rows[0]?.finished !== "boolean") {
        throw new Error("invalid Connection Setup cleanup result");
      }
      return rows[0].finished;
    }),
  finishProvisioning: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{
        finished: unknown;
      }>(
        sql`SELECT public.finish_connection_setup_provisioning(
          ${input.setupId}, ${input.workerId}, ${input.observedAt},
          ${input.outcome}, ${serializedProviderSessions(input.sessions)}::jsonb
        ) AS finished`,
      );
      if (typeof rows[0]?.finished !== "boolean") {
        throw new Error("invalid Connection Setup provisioning result");
      }
      return rows[0].finished;
    }),
  failProvisioning: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{ failed: unknown }>(
        sql`SELECT public.fail_connection_setup_provisioning(
          ${input.setupId}, ${input.workerId}, ${input.observedAt},
          ${input.failureCode}
        ) AS failed`,
      );
      if (typeof rows[0]?.failed !== "boolean") {
        throw new Error("invalid Connection Setup provisioning failure");
      }
      return rows[0].failed;
    }),
  listProvisioningCandidates: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{
        setup_id: unknown;
      }>(
        sql`SELECT setup_id
            FROM public.list_connection_setup_provisioning_candidates(
              ${input.observedAt}, ${input.limit}
            )`,
      );
      return setupIds(rows, "invalid Connection Setup provisioning candidate");
    }),
  listCleanupCandidates: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{
        setup_id: unknown;
      }>(
        sql`SELECT setup_id
            FROM public.list_connection_setup_cleanup_candidates(
              ${input.observedAt}, ${input.limit}
            )`,
      );
      return setupIds(rows, "invalid Connection Setup cleanup candidate");
    }),
  prepare: (input) =>
    provider.withConnection((connection) => {
      const db = makeDatabase(connection);
      return withTransaction(connection, async () => {
        const loaded = await db.execute<AccountRow>(
          sql`SELECT * FROM public.load_connection_setup_account(${input.clerkUserId})`,
        );
        const row = loaded[0];
        const accountKeyCiphertext = bytes(row?.account_key_ciphertext);
        const accountKeyVersion = positiveInteger(row?.account_key_version);
        const whatsappConnectionLimit = positiveInteger(
          row?.whatsapp_connection_limit,
        );
        if (
          typeof row?.personal_account_id !== "string" ||
          typeof row.kms_key_id !== "string" ||
          accountKeyCiphertext === null ||
          accountKeyVersion === null ||
          whatsappConnectionLimit === null ||
          !(await enterPersonalAccountContext(db, row.personal_account_id))
        ) {
          return null;
        }

        const eligibility = await db.execute<{ eligible: unknown }>(
          sql`SELECT public.first_connection_setup_eligible(${input.clerkUserId}) AS eligible`,
        );
        if (eligibility[0]?.eligible !== true) {
          return { outcome: "onboarding_profile_required" as const };
        }

        const binding = await db
          .select({
            created_at: connectionSetupsInApp.createdAt,
            expires_at: connectionSetupsInApp.expiresAt,
            id: connectionSetupsInApp.id,
            number_token: whatsappNumberReservationsInApp.numberToken,
            state: connectionSetupsInApp.state,
          })
          .from(connectionSetupsInApp)
          .innerJoin(
            whatsappNumberReservationsInApp,
            and(
              eq(
                whatsappNumberReservationsInApp.personalAccountId,
                connectionSetupsInApp.personalAccountId,
              ),
              eq(
                whatsappNumberReservationsInApp.connectionSetupId,
                connectionSetupsInApp.id,
              ),
            ),
          )
          .where(
            and(
              eq(
                connectionSetupsInApp.personalAccountId,
                row.personal_account_id,
              ),
              eq(connectionSetupsInApp.idempotencyKey, input.idempotencyKey),
            ),
          );
        const existing = binding[0];
        if (existing !== undefined) {
          const existingToken = bytes(existing.number_token);
          const setup = setupRecord(existing);
          if (existingToken === null || setup === null) {
            throw new Error("invalid persisted Connection Setup");
          }
          if (!sameBytes(existingToken, input.numberToken)) {
            return { outcome: "idempotency_conflict" as const };
          }
          const accountKey = {
            ciphertext: encodeBase64(accountKeyCiphertext),
            keyVersion: accountKeyVersion,
            kmsKeyId: row.kms_key_id,
            personalAccountId: row.personal_account_id,
            version: 1 as const,
          };
          return {
            nameMaterial: await loadNameMaterial(db, accountKey, setup.setupId),
            outcome: "replay" as const,
            setup,
          };
        }

        return {
          accountKey: {
            ciphertext: encodeBase64(accountKeyCiphertext),
            keyVersion: accountKeyVersion,
            kmsKeyId: row.kms_key_id,
            personalAccountId: row.personal_account_id,
            version: 1 as const,
          },
          outcome: "unbound" as const,
          whatsappConnectionLimit,
        };
      });
    }),
  releaseProvisioningLease: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{
        released: unknown;
      }>(
        sql`SELECT public.release_connection_setup_provisioning_lease(
          ${input.setupId}, ${input.workerId}, ${input.observedAt},
          ${input.failureCode}
        ) AS released`,
      );
      if (typeof rows[0]?.released !== "boolean") {
        throw new Error("invalid Connection Setup provisioning release");
      }
      return rows[0].released;
    }),
  releaseCleanupLease: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{
        released: unknown;
      }>(
        sql`SELECT public.release_connection_setup_cleanup_lease(
          ${input.setupId}, ${input.workerId}, ${input.observedAt},
          ${input.failureCode}
        ) AS released`,
      );
      if (typeof rows[0]?.released !== "boolean") {
        throw new Error("invalid Connection Setup cleanup release");
      }
      return rows[0].released;
    }),
  renewProvisioningLease: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{ renewed: unknown }>(
        sql`SELECT public.renew_connection_setup_provisioning_lease(
          ${input.setupId}, ${input.workerId}, ${input.observedAt}
        ) AS renewed`,
      );
      if (typeof rows[0]?.renewed !== "boolean") {
        throw new Error("invalid Connection Setup provisioning renewal");
      }
      return rows[0].renewed;
    }),
  renewCleanupLease: (input) =>
    provider.withConnection(async (connection) => {
      const rows = await makeDatabase(connection).execute<{ renewed: unknown }>(
        sql`SELECT public.renew_connection_setup_cleanup_lease(
          ${input.setupId}, ${input.workerId}, ${input.observedAt}
        ) AS renewed`,
      );
      if (typeof rows[0]?.renewed !== "boolean") {
        throw new Error("invalid Connection Setup cleanup renewal");
      }
      return rows[0].renewed;
    }),
  start: (input) =>
    provider.withConnection((connection) => {
      const db = makeDatabase(connection);
      return withTransaction(connection, async () => {
        if (!(await enterPersonalAccountContext(db, input.personalAccountId))) {
          throw new Error("Personal Account unavailable");
        }
        const rows = await db.execute<StartRow>(
          sql`SELECT * FROM public.start_connection_setup(
            ${input.personalAccountId}, ${input.setupId}, ${input.idempotencyKey},
            ${input.numberToken}, ${input.numberCiphertextVersion},
            ${input.numberKeyVersion}, ${input.numberCiphertextNonce},
            ${input.numberCiphertext}, ${input.accountKey.keyVersion},
            ${input.connectionKeyVersion}, ${input.connectionKeyNonce},
            ${input.connectionKeyCiphertext}, ${input.createdAt}
          )`,
        );
        const row = rows[0];
        if (
          row?.outcome === "connection_limit_reached" ||
          row?.outcome === "idempotency_conflict" ||
          row?.outcome === "number_unavailable"
        ) {
          return { outcome: row.outcome };
        }
        if (row?.outcome === "created" || row?.outcome === "replay") {
          if (row.outcome === "created") {
            const named = await db
              .update(connectionSetupsInApp)
              .set({
                displayNameCiphertext: input.displayNameCiphertext,
                displayNameCiphertextVersion:
                  input.displayNameCiphertextVersion,
                displayNameFallback: null,
                displayNameKeyVersion: input.displayNameKeyVersion,
                displayNameNonce: input.displayNameCiphertextNonce,
              })
              .where(
                and(
                  eq(
                    connectionSetupsInApp.personalAccountId,
                    input.personalAccountId,
                  ),
                  eq(connectionSetupsInApp.id, input.setupId),
                ),
              )
              .returning({ id: connectionSetupsInApp.id });
            if (named.length !== 1) {
              throw new Error("Connection Setup name unavailable");
            }
          } else {
            const persistedSetupId = row.setup_id;
            if (typeof persistedSetupId !== "string") {
              throw new Error("invalid replayed Connection Setup");
            }
            const setup = setupRecord(row, "setup_");
            if (setup === null)
              throw new Error("invalid Connection Setup result");
            return {
              nameMaterial: await loadNameMaterial(
                db,
                input.accountKey,
                persistedSetupId,
              ),
              outcome: "replay" as const,
              setup,
            };
          }
          const setup = setupRecord(row, "setup_");
          if (setup !== null) {
            return { outcome: row.outcome, setup };
          }
        }
        throw new Error("invalid Connection Setup result");
      });
    }),
});

const makePgConnectionProvider = (
  connectionString: string,
): ConnectionSetupConnectionProvider => ({
  withConnection: (use) => withPgQueryConnection(connectionString, use),
});

export const makePgConnectionSetupRepository = (
  connectionString: string,
): ConnectionSetupRepository =>
  makeConnectionSetupRepository(makePgConnectionProvider(connectionString));
