import type { WhatsAppConnectionState } from "@whatsapp-mcp/domain/whatsapp-connection";
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { type Database, makeDatabase, withPgQueryConnection } from "./database";
import type { ProtectedGroupFields } from "./group";
import {
  directoryContactProjectionsInApp,
  directoryContactsInApp,
  pendingSendContentsInApp,
  personalAccountsInApp,
  sendOperationsInApp,
  storedMediaInApp,
  storedMessagesInApp,
  webhookDeadLetterIncidentsInApp,
  webhookEventsInApp,
  webhookItemQuarantinesInApp,
  webhookItemsInApp,
  whatsappConnectionsInApp,
  whatsappConversationsInApp,
  whatsappGroupDirectoryStatesInApp,
  whatsappGroupsInApp,
} from "./schema";
import { withTransaction } from "./transaction";

export interface WebhookEventConnection {
  readonly query: <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    text: string,
    values?: Array<unknown>,
  ) => Promise<{ readonly rows: Array<Row> }>;
}

export interface WebhookEventConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: WebhookEventConnection) => Promise<Value>,
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

export interface PersistedDirectoryCiphertext extends VersionedCiphertext {}

export interface WebhookEventProcessingMaterial {
  readonly accountKey: AccountKeyEnvelope;
  readonly connectionKey: ConnectionKeyEnvelope;
  readonly identityKey: VersionedCiphertext;
  // Preparation intentionally returns no material for pre-0005 Connections
  // until bounded backfill has installed this independent key.
  readonly messageSearchKey: VersionedCiphertext;
}

export interface PrepareWebhookEventInput {
  readonly ciphertextSha256: string;
  readonly eventId: string;
  readonly payloadBytes: number;
  readonly personalAccountId: string;
  readonly receivedAt: string;
  readonly whatsappConnectionId: string;
}

export interface DeadLetterWebhookEventInput extends PrepareWebhookEventInput {
  readonly deadLetteredAt: string;
}

export type DeadLetterWebhookEventOutcome =
  | "already_completed"
  | "gap_recorded"
  | "source_unavailable";

export interface DeadLetterWebhookEventResult {
  readonly incidentReference: string | null;
  readonly outcome: DeadLetterWebhookEventOutcome;
}

export type WebhookItemQuarantineClassification =
  | "invalid_item_shape"
  | "invalid_top_level_shape"
  | "missing_required_identity"
  | "unsupported_item_kind"
  | "unsupported_projection";

export type WebhookItemProjectionOutcome =
  | "applied"
  | "duplicate"
  | "suppressed"
  | "superseded";

export type WebhookVersionComparison =
  | "after"
  | "before"
  | "equal"
  | "incomparable";

interface WebhookItemBase {
  readonly eventId: string;
  readonly itemIndex: number;
  readonly personalAccountId: string;
  readonly receivedAt: string;
  readonly whatsappConnectionId: string;
}

interface EvidenceOrderedProjectionInput extends WebhookItemBase {
  readonly evidence: {
    readonly occurredAt: string | null;
    readonly version: string | null;
  };
  readonly itemIdentity: string;
}

export interface ProjectConnectionStateInput
  extends EvidenceOrderedProjectionInput {
  readonly state: Exclude<WhatsAppConnectionState, "deleting">;
}

export interface ProjectGroupInput extends WebhookItemBase {
  readonly displayName: string | null;
  readonly evidence: {
    readonly occurredAt: string | null;
    readonly version: string | null;
  };
  readonly groupId: string;
  readonly itemIdentity: string;
  readonly joined: boolean;
  readonly locator: string;
  readonly namePrefixIndexes: ReadonlyArray<string>;
  readonly providerIdentity: string;
  readonly publicId: string;
}

export interface ProjectDirectoryContactInput
  extends EvidenceOrderedProjectionInput {
  readonly active: boolean;
  readonly displayNameCiphertext: PersistedDirectoryCiphertext | null;
  readonly displayNameSort: string;
  readonly namePrefixIndexes: ReadonlyArray<string>;
  readonly phoneCiphertext: PersistedDirectoryCiphertext | null;
  readonly phoneIndex: string | null;
  readonly providerIdentityCiphertext: PersistedDirectoryCiphertext;
  readonly providerIdentityIndex: string;
  readonly publicId: string;
  readonly insertOnly?: boolean;
}

export interface ProjectStoredMessageInput
  extends EvidenceOrderedProjectionInput {
  readonly content: PersistedDirectoryCiphertext;
  readonly contentType:
    | "audio"
    | "document"
    | "image"
    | "sticker"
    | "text"
    | "unknown"
    | "video";
  readonly conversationId: string;
  readonly conversationPublicId: string;
  readonly direction: "inbound" | "outbound";
  readonly messageIdentity: string;
  readonly messageId: string;
  readonly messagePublicId: string;
  readonly messageSearch: MessageSearchIndex;
  readonly media?: {
    readonly id: string;
    readonly publicId: string;
    readonly source: PersistedDirectoryCiphertext;
  } | null;
  readonly recipientLocator: string;
  readonly recipientKind: "direct" | "group";
  readonly recipientPublicId: string;
  readonly sentAt: string;
}

export interface ProjectSendEvidenceInput
  extends EvidenceOrderedProjectionInput {
  readonly messageIdentity: string;
  readonly status: "accepted" | "sent" | "delivered" | "read" | "failed";
}

export interface PendingSendProjection {
  readonly ciphertext: Uint8Array;
  readonly keyVersion: number;
  readonly nonce: Uint8Array;
  readonly sendId: string;
}

export interface MaterializedPendingSend {
  readonly content: PersistedDirectoryCiphertext;
  readonly conversationId: string;
  readonly conversationPublicId: string;
  readonly messageId: string;
  readonly messagePublicId: string;
  readonly messageSearch: MessageSearchIndex;
}

export interface MessageSearchIndex {
  readonly indexVersion: 1;
  readonly tokens: ReadonlyArray<string>;
}

export interface ProjectStoredMessageEditInput
  extends EvidenceOrderedProjectionInput {
  readonly content: PersistedDirectoryCiphertext;
  readonly contentType: ProjectStoredMessageInput["contentType"];
  readonly editedAt: string;
  readonly messageIdentity: string;
  readonly messageSearch: MessageSearchIndex;
}

export interface ProjectStoredMessageDeletionInput
  extends EvidenceOrderedProjectionInput {
  readonly conversationId: string;
  readonly conversationPublicId: string;
  readonly deletedAt: string;
  readonly direction: "inbound" | "outbound";
  readonly messageId: string;
  readonly messageIdentity: string;
  readonly messagePublicId: string;
  readonly recipientKind: "direct" | "group";
  readonly recipientLocator: string;
  readonly recipientPublicId: string;
  readonly sentAt: string;
}

export interface QuarantineWebhookItemInput extends WebhookItemBase {
  readonly classification: WebhookItemQuarantineClassification;
  readonly itemIdentity: string | null;
  readonly itemKind: string;
}

export interface WebhookEventRepository {
  readonly complete: (input: {
    readonly completedAt: string;
    readonly eventId: string;
    readonly personalAccountId: string;
    readonly whatsappConnectionId: string;
  }) => Promise<void>;
  readonly deadLetter: (
    input: DeadLetterWebhookEventInput,
  ) => Promise<DeadLetterWebhookEventResult>;
  readonly filterUnclaimed: <Input extends PrepareWebhookEventInput>(
    inputs: ReadonlyArray<Input>,
  ) => Promise<ReadonlyArray<Input>>;
  readonly prepare: (
    input: PrepareWebhookEventInput,
  ) => Promise<WebhookEventProcessingMaterial | null>;
  readonly projectConnectionState: (
    input: ProjectConnectionStateInput,
    compareVersions: (
      left: string,
      right: string,
    ) => Promise<WebhookVersionComparison>,
  ) => Promise<WebhookItemProjectionOutcome>;
  readonly projectGroup: (
    input: ProjectGroupInput,
    protect: (recordId: string) => Promise<ProtectedGroupFields>,
    compareVersions: (
      left: string,
      right: string,
    ) => Promise<WebhookVersionComparison>,
  ) => Promise<WebhookItemProjectionOutcome>;
  readonly projectDirectoryContact: (
    input: ProjectDirectoryContactInput,
    compareVersions: (
      left: string,
      right: string,
    ) => Promise<WebhookVersionComparison>,
  ) => Promise<WebhookItemProjectionOutcome>;
  readonly projectStoredMessage: (
    input: ProjectStoredMessageInput,
    compareVersions: (
      left: string,
      right: string,
    ) => Promise<WebhookVersionComparison>,
  ) => Promise<WebhookItemProjectionOutcome>;
  readonly projectSendEvidence: (
    input: ProjectSendEvidenceInput,
    materialize?: (
      pending: PendingSendProjection,
    ) => Promise<MaterializedPendingSend>,
  ) => Promise<WebhookItemProjectionOutcome>;
  readonly projectStoredMessageEdit: (
    input: ProjectStoredMessageEditInput,
    compareVersions: (
      left: string,
      right: string,
    ) => Promise<WebhookVersionComparison>,
  ) => Promise<WebhookItemProjectionOutcome>;
  readonly projectStoredMessageDeletion: (
    input: ProjectStoredMessageDeletionInput,
  ) => Promise<WebhookItemProjectionOutcome>;
  readonly quarantine: (input: QuarantineWebhookItemInput) => Promise<void>;
}

const enterPersonalAccountContext = async (
  db: Database,
  personalAccountId: string,
): Promise<void> => {
  await db.execute(
    sql`select set_config('public.personal_account_id', ${personalAccountId}, true)`,
  );
};

// The WhatsApp Connection row is the shared serialization point with a
// WhatsApp Recipient Exclusion transition. Every projection that can create or
// restore readable content takes it before checking suppression, so an
// exclusion cannot commit its purge between the check and the write.
const lockConnection = async (
  db: Database,
  input: WebhookItemBase,
): Promise<void> => {
  const locked = await db
    .select({ id: whatsappConnectionsInApp.id })
    .from(whatsappConnectionsInApp)
    .where(
      and(
        eq(whatsappConnectionsInApp.personalAccountId, input.personalAccountId),
        eq(whatsappConnectionsInApp.id, input.whatsappConnectionId),
      ),
    )
    .for("update");
  if (locked.length !== 1) {
    throw new Error("Webhook Item projection target unavailable");
  }
};

// A WhatsApp Recipient Exclusion is checked after the Webhook Item claims its
// deduplication identity, so a suppressed item still cannot be reprocessed.
const isObservationSuppressed = async (
  db: Database,
  input: WebhookItemBase & { readonly itemIdentity: string },
  recipientKind: "contact" | "direct" | "group",
  recipientLocator: string,
): Promise<boolean> => {
  const result = await db.execute<{ suppressed: unknown }>(sql`
    SELECT public.whatsapp_recipient_observation_suppressed(
      ${input.personalAccountId}, ${input.whatsappConnectionId},
      ${recipientKind === "group" ? "group" : "contact"}, ${recipientLocator},
      ${input.receivedAt}
    ) AS suppressed
  `);
  if (result[0]?.suppressed !== true) return false;
  // The claimed Webhook Item keeps durable evidence that this delivery was
  // seen and deliberately not projected.
  await db
    .update(webhookItemsInApp)
    .set({ outcome: "suppressed" })
    .where(
      and(
        eq(webhookItemsInApp.personalAccountId, input.personalAccountId),
        eq(webhookItemsInApp.whatsappConnectionId, input.whatsappConnectionId),
        eq(webhookItemsInApp.deduplicationIdentity, input.itemIdentity),
      ),
    );
  return true;
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

const scalar = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`invalid ${key}`);
  return value;
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

interface MaterialRow extends Record<string, unknown> {
  readonly account_key_ciphertext: unknown;
  readonly account_key_version: unknown;
  readonly account_kms_key_id: unknown;
  readonly connection_key_account_version: unknown;
  readonly connection_key_ciphertext: unknown;
  readonly connection_key_nonce: unknown;
  readonly connection_key_version: unknown;
  readonly identity_ciphertext: unknown;
  readonly identity_ciphertext_version: unknown;
  readonly identity_key_version: unknown;
  readonly identity_nonce: unknown;
  readonly message_search_key_ciphertext: unknown;
  readonly message_search_key_ciphertext_version: unknown;
  readonly message_search_key_nonce: unknown;
  readonly message_search_key_version: unknown;
}

const processingMaterial = (
  input: Pick<
    PrepareWebhookEventInput,
    "personalAccountId" | "whatsappConnectionId"
  >,
  row: MaterialRow | undefined,
): WebhookEventProcessingMaterial | null => {
  if (row === undefined) return null;
  const accountKeyCiphertext = bytes(row.account_key_ciphertext);
  const accountKeyVersion = positiveInteger(row.account_key_version);
  const connectionKeyAccountVersion = positiveInteger(
    row.connection_key_account_version,
  );
  const connectionKeyCiphertext = bytes(row.connection_key_ciphertext);
  const connectionKeyNonce = bytes(row.connection_key_nonce);
  const connectionKeyVersion = positiveInteger(row.connection_key_version);
  const identityCiphertext = bytes(row.identity_ciphertext);
  const identityCiphertextVersion = positiveInteger(
    row.identity_ciphertext_version,
  );
  const identityKeyVersion = positiveInteger(row.identity_key_version);
  const identityNonce = bytes(row.identity_nonce);
  const messageSearchKeyCiphertext = bytes(row.message_search_key_ciphertext);
  const messageSearchKeyCiphertextVersion = positiveInteger(
    row.message_search_key_ciphertext_version,
  );
  const messageSearchKeyNonce = bytes(row.message_search_key_nonce);
  const messageSearchKeyVersion = positiveInteger(
    row.message_search_key_version,
  );
  if (
    typeof row.account_kms_key_id !== "string" ||
    row.account_kms_key_id.length === 0 ||
    accountKeyCiphertext === null ||
    accountKeyVersion === null ||
    connectionKeyAccountVersion === null ||
    connectionKeyCiphertext === null ||
    connectionKeyNonce === null ||
    connectionKeyVersion === null ||
    identityCiphertextVersion !== 1 ||
    identityKeyVersion === null ||
    identityNonce === null ||
    identityCiphertext === null ||
    messageSearchKeyCiphertextVersion !== 1 ||
    messageSearchKeyVersion === null ||
    messageSearchKeyNonce === null ||
    messageSearchKeyCiphertext === null
  ) {
    throw new Error("invalid Webhook Event processing material");
  }
  return {
    accountKey: {
      ciphertext: encodeBase64(accountKeyCiphertext),
      keyVersion: accountKeyVersion,
      kmsKeyId: row.account_kms_key_id,
      personalAccountId: input.personalAccountId,
      version: 1,
    },
    connectionKey: {
      accountKeyVersion: connectionKeyAccountVersion,
      ciphertext: encodeBase64(connectionKeyCiphertext),
      connectionId: input.whatsappConnectionId,
      keyVersion: connectionKeyVersion,
      nonce: encodeBase64(connectionKeyNonce),
      personalAccountId: input.personalAccountId,
      version: 1,
    },
    identityKey: {
      ciphertext: encodeBase64(identityCiphertext),
      keyVersion: identityKeyVersion,
      nonce: encodeBase64(identityNonce),
      version: 1,
    },
    messageSearchKey: {
      ciphertext: encodeBase64(messageSearchKeyCiphertext),
      keyVersion: messageSearchKeyVersion,
      nonce: encodeBase64(messageSearchKeyNonce),
      version: 1,
    },
  };
};

const messageSearchValues = (value: MessageSearchIndex) => {
  if (
    value.indexVersion !== 1 ||
    value.tokens.some((token) => !/^msi1_[A-Za-z0-9_-]{43}$/u.test(token)) ||
    new Set(value.tokens).size !== value.tokens.length
  ) {
    throw new Error("invalid Stored Message search index");
  }
  return {
    messageSearchIndexVersion: 1,
    messageSearchTokens: [...value.tokens],
  };
};

interface EventRow extends Record<string, unknown> {
  readonly ciphertext_sha256: unknown;
  readonly payload_bytes: unknown;
  readonly received_at: unknown;
}

interface RecoveryCandidateRow extends Record<string, unknown> {
  readonly candidate_index: unknown;
  readonly status: unknown;
}

const sameEvent = (
  input: PrepareWebhookEventInput,
  row: EventRow | undefined,
): boolean =>
  row !== undefined &&
  row.ciphertext_sha256 === input.ciphertextSha256 &&
  positiveInteger(row.payload_bytes) === input.payloadBytes &&
  timestamp(row.received_at) === input.receivedAt;

interface StateRow extends Record<string, unknown> {
  readonly state_provider_occurred_at: unknown;
  readonly state_provider_version: unknown;
  readonly state_received_at: unknown;
  readonly state_snapshot_observed_at: unknown;
  readonly state_webhook_event_id: unknown;
}

interface ContactOrderRow extends Record<string, unknown> {
  readonly provider_occurred_at: unknown;
  readonly provider_version: unknown;
  readonly received_at: unknown;
  readonly snapshot_observed_at: unknown;
  readonly webhook_event_id: unknown;
}

const shouldApplyContact = async (
  input: ProjectDirectoryContactInput,
  current: ContactOrderRow,
  compareVersions: (
    left: string,
    right: string,
  ) => Promise<WebhookVersionComparison>,
): Promise<boolean> =>
  shouldApply(
    input,
    {
      state_provider_occurred_at: current.provider_occurred_at,
      state_provider_version: current.provider_version,
      state_received_at: current.received_at,
      state_snapshot_observed_at: current.snapshot_observed_at,
      state_webhook_event_id: current.webhook_event_id,
    },
    compareVersions,
  );

const decodeCiphertext = (value: PersistedDirectoryCiphertext): Uint8Array => {
  const ciphertext = Buffer.from(value.ciphertext, "base64");
  const nonce = Buffer.from(value.nonce, "base64");
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.keyVersion) ||
    value.keyVersion < 1 ||
    ciphertext.byteLength <= 16 ||
    nonce.byteLength !== 12
  ) {
    throw new Error("invalid Directory ciphertext");
  }
  return new Uint8Array(ciphertext);
};

const decodeNonce = (value: PersistedDirectoryCiphertext): Uint8Array =>
  new Uint8Array(Buffer.from(value.nonce, "base64"));

const shouldApply = async (
  input: EvidenceOrderedProjectionInput,
  current: StateRow,
  compareVersions: (
    left: string,
    right: string,
  ) => Promise<WebhookVersionComparison>,
): Promise<boolean> => {
  const snapshotObservedAt = timestamp(current.state_snapshot_observed_at);
  const incomingOccurredAt =
    input.evidence.occurredAt === null
      ? null
      : timestamp(input.evidence.occurredAt);
  const incomingReceivedAt = timestamp(input.receivedAt);
  if (
    (input.evidence.occurredAt !== null && incomingOccurredAt === null) ||
    incomingReceivedAt === null
  ) {
    throw new Error("invalid incoming connection-state evidence order");
  }
  if (
    snapshotObservedAt !== null &&
    (incomingOccurredAt ?? incomingReceivedAt) <= snapshotObservedAt
  ) {
    return false;
  }

  const currentVersion = current.state_provider_version;
  if (currentVersion !== null && typeof currentVersion !== "string") {
    throw new Error("invalid current connection-state evidence");
  }
  const incomingVersion = input.evidence.version;
  if (incomingVersion !== null && currentVersion !== null) {
    const comparison = await compareVersions(incomingVersion, currentVersion);
    if (comparison === "after") return true;
    if (comparison === "before") return false;
    if (comparison === "incomparable") {
      throw new Error("incomparable connection-state evidence");
    }
  }

  const currentOccurredAt = timestamp(current.state_provider_occurred_at);
  if (
    incomingOccurredAt !== null &&
    currentOccurredAt !== null &&
    incomingOccurredAt !== currentOccurredAt
  ) {
    return incomingOccurredAt > currentOccurredAt;
  }

  const incomingHasProviderEvidence =
    incomingVersion !== null || incomingOccurredAt !== null;
  const currentHasProviderEvidence =
    currentVersion !== null || currentOccurredAt !== null;
  if (incomingHasProviderEvidence !== currentHasProviderEvidence) {
    return incomingHasProviderEvidence;
  }

  const currentReceivedAt = timestamp(current.state_received_at);
  if (currentReceivedAt === null) {
    throw new Error("invalid current connection-state receive order");
  }
  if (incomingReceivedAt !== currentReceivedAt) {
    return incomingReceivedAt > currentReceivedAt;
  }
  const currentEventId = current.state_webhook_event_id;
  return typeof currentEventId !== "string" || input.eventId > currentEventId;
};

interface GroupEvidenceRow extends Record<string, unknown> {
  readonly id: unknown;
  readonly last_observed_at: unknown;
  readonly provider_occurred_at: unknown;
  readonly provider_version: unknown;
  readonly received_at: unknown;
}

const shouldApplyGroup = async (
  input: ProjectGroupInput,
  current: GroupEvidenceRow | undefined,
  compareVersions: (
    left: string,
    right: string,
  ) => Promise<WebhookVersionComparison>,
): Promise<boolean> => {
  if (current === undefined) return true;
  const lastObservedAt = timestamp(current.last_observed_at);
  const receivedAt = timestamp(input.receivedAt);
  const occurredAt =
    input.evidence.occurredAt === null
      ? null
      : timestamp(input.evidence.occurredAt);
  if (
    receivedAt === null ||
    (input.evidence.occurredAt !== null && occurredAt === null) ||
    lastObservedAt === null
  ) {
    throw new Error("invalid group projection evidence");
  }
  const currentVersion = current.provider_version;
  if (currentVersion !== null && typeof currentVersion !== "string") {
    throw new Error("invalid group provider version");
  }
  if (input.evidence.version !== null && currentVersion !== null) {
    const comparison = await compareVersions(
      input.evidence.version,
      currentVersion,
    );
    if (comparison === "after") return true;
    if (comparison === "before" || comparison === "equal") return false;
    throw new Error("incomparable group provider version");
  }
  const effective = occurredAt ?? receivedAt;
  return effective > lastObservedAt;
};

const protectedGroupValues = (value: ProtectedGroupFields) => {
  const valid = (field: NonNullable<ProtectedGroupFields["displayName"]>) =>
    field.version === 1 &&
    Number.isSafeInteger(field.keyVersion) &&
    field.keyVersion > 0 &&
    field.nonce.byteLength === 12 &&
    field.ciphertext.byteLength > 16;
  if (
    !valid(value.providerIdentity) ||
    (value.displayName !== null && !valid(value.displayName))
  ) {
    throw new Error("invalid protected group projection");
  }
  return [
    value.displayName?.version ?? null,
    value.displayName?.keyVersion ?? null,
    value.displayName?.nonce ?? null,
    value.displayName?.ciphertext ?? null,
    value.providerIdentity.version,
    value.providerIdentity.keyVersion,
    value.providerIdentity.nonce,
    value.providerIdentity.ciphertext,
  ] as const;
};

const claimWebhookItem = async (
  db: Database,
  input: WebhookItemBase & {
    readonly itemIdentity: string;
    readonly evidence?: {
      readonly occurredAt: string | null;
      readonly version: string | null;
    };
  },
  itemKind: string,
  outcome = "superseded",
): Promise<boolean> => {
  const claimed = await db
    .insert(webhookItemsInApp)
    .values({
      personalAccountId: input.personalAccountId,
      whatsappConnectionId: input.whatsappConnectionId,
      deduplicationIdentity: input.itemIdentity,
      firstWebhookEventId: input.eventId,
      itemIndex: input.itemIndex,
      itemKind,
      outcome,
      providerOccurredAt: input.evidence?.occurredAt,
      providerVersion: input.evidence?.version,
      receivedAt: input.receivedAt,
    })
    .onConflictDoNothing({
      target: [
        webhookItemsInApp.personalAccountId,
        webhookItemsInApp.whatsappConnectionId,
        webhookItemsInApp.deduplicationIdentity,
      ],
    })
    .returning({
      deduplicationIdentity: webhookItemsInApp.deduplicationIdentity,
    });
  return claimed.length === 1;
};

const markWebhookItemApplied = (
  db: Database,
  input: Pick<
    EvidenceOrderedProjectionInput,
    "personalAccountId" | "whatsappConnectionId" | "itemIdentity"
  >,
) =>
  db
    .update(webhookItemsInApp)
    .set({ outcome: "applied" })
    .where(
      and(
        eq(webhookItemsInApp.personalAccountId, input.personalAccountId),
        eq(webhookItemsInApp.whatsappConnectionId, input.whatsappConnectionId),
        eq(webhookItemsInApp.deduplicationIdentity, input.itemIdentity),
      ),
    );

export const makeWebhookEventRepository = (
  provider: WebhookEventConnectionProvider,
): WebhookEventRepository => ({
  complete: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async (db) => {
        await enterPersonalAccountContext(db, input.personalAccountId);
        const result = await db
          .update(webhookEventsInApp)
          .set({
            processingCompletedAt: sql`coalesce(${webhookEventsInApp.processingCompletedAt}, ${input.completedAt}::timestamptz)`,
            updatedAt: sql`greatest(${webhookEventsInApp.updatedAt}, ${input.completedAt}::timestamptz)`,
          })
          .where(
            and(
              eq(webhookEventsInApp.personalAccountId, input.personalAccountId),
              eq(
                webhookEventsInApp.whatsappConnectionId,
                input.whatsappConnectionId,
              ),
              eq(webhookEventsInApp.id, input.eventId),
            ),
          )
          .returning({ id: webhookEventsInApp.id });
        if (result.length !== 1) {
          throw new Error("Webhook Event completion target unavailable");
        }
        const resolved = await db.execute<{ resolved: unknown }>(
          sql`select public.resolve_webhook_processing_gap(
            ${input.personalAccountId}, ${input.whatsappConnectionId}, ${input.eventId}
          ) as resolved`,
        );
        if (resolved[0]?.resolved !== true) {
          throw new Error("failed to resolve Webhook Event processing gap");
        }
      }),
    ),

  deadLetter: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async (db) => {
        await enterPersonalAccountContext(db, input.personalAccountId);
        const active = await db
          .select({ id: whatsappConnectionsInApp.id })
          .from(whatsappConnectionsInApp)
          .innerJoin(
            personalAccountsInApp,
            eq(
              personalAccountsInApp.id,
              whatsappConnectionsInApp.personalAccountId,
            ),
          )
          .where(
            and(
              eq(
                whatsappConnectionsInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(whatsappConnectionsInApp.id, input.whatsappConnectionId),
              ne(whatsappConnectionsInApp.state, "deleting"),
              eq(personalAccountsInApp.state, "active"),
            ),
          );
        if (active.length === 0) {
          return {
            incidentReference: null,
            outcome: "source_unavailable" as const,
          };
        }

        await db
          .insert(webhookEventsInApp)
          .values({
            personalAccountId: input.personalAccountId,
            whatsappConnectionId: input.whatsappConnectionId,
            id: input.eventId,
            ciphertextSha256: input.ciphertextSha256,
            payloadBytes: input.payloadBytes,
            receivedAt: input.receivedAt,
            sourceExpiresAt: sql`${input.receivedAt}::timestamptz + interval '7 days'`,
          })
          .onConflictDoNothing({
            target: [
              webhookEventsInApp.personalAccountId,
              webhookEventsInApp.whatsappConnectionId,
              webhookEventsInApp.id,
            ],
          });
        const persisted = await db
          .select({
            ciphertext_sha256: webhookEventsInApp.ciphertextSha256,
            payload_bytes: webhookEventsInApp.payloadBytes,
            processing_completed_at: webhookEventsInApp.processingCompletedAt,
            received_at: webhookEventsInApp.receivedAt,
            source_expires_at: webhookEventsInApp.sourceExpiresAt,
          })
          .from(webhookEventsInApp)
          .where(
            and(
              eq(webhookEventsInApp.personalAccountId, input.personalAccountId),
              eq(
                webhookEventsInApp.whatsappConnectionId,
                input.whatsappConnectionId,
              ),
              eq(webhookEventsInApp.id, input.eventId),
            ),
          )
          .for("update");
        const event = persisted[0];
        if (!sameEvent(input, event)) {
          throw new Error("conflicting dead-letter Webhook Event");
        }
        if (event?.processing_completed_at !== null) {
          return {
            incidentReference: null,
            outcome: "already_completed" as const,
          };
        }

        await db
          .update(webhookEventsInApp)
          .set({
            deadLetteredAt: sql`coalesce(${webhookEventsInApp.deadLetteredAt}, ${input.deadLetteredAt}::timestamptz)`,
            updatedAt: sql`greatest(${webhookEventsInApp.updatedAt}, ${input.deadLetteredAt}::timestamptz)`,
          })
          .where(
            and(
              eq(webhookEventsInApp.personalAccountId, input.personalAccountId),
              eq(
                webhookEventsInApp.whatsappConnectionId,
                input.whatsappConnectionId,
              ),
              eq(webhookEventsInApp.id, input.eventId),
            ),
          );
        const recorded = await db.execute<{ recorded: unknown }>(
          sql`select public.record_webhook_dead_letter_gap(
            ${input.personalAccountId}, ${input.whatsappConnectionId},
            ${input.eventId}, ${input.deadLetteredAt}
          ) as recorded`,
        );
        if (recorded[0]?.recorded !== true) {
          throw new Error("failed to record dead-letter Ingestion Gap");
        }
        const source = persisted[0];
        const incident =
          source === undefined
            ? []
            : await db
                .insert(webhookDeadLetterIncidentsInApp)
                .values({
                  personalAccountId: input.personalAccountId,
                  whatsappConnectionId: input.whatsappConnectionId,
                  webhookEventId: input.eventId,
                  detectedAt: input.deadLetteredAt,
                  sourceExpiresAt: source.source_expires_at,
                })
                .onConflictDoNothing({
                  target: webhookDeadLetterIncidentsInApp.webhookEventId,
                })
                .returning({
                  incident_reference: webhookDeadLetterIncidentsInApp.id,
                });
        const existingIncident =
          incident[0] ??
          (
            await db
              .select({
                incident_reference: webhookDeadLetterIncidentsInApp.id,
              })
              .from(webhookDeadLetterIncidentsInApp)
              .where(
                and(
                  eq(
                    webhookDeadLetterIncidentsInApp.personalAccountId,
                    input.personalAccountId,
                  ),
                  eq(
                    webhookDeadLetterIncidentsInApp.whatsappConnectionId,
                    input.whatsappConnectionId,
                  ),
                  eq(
                    webhookDeadLetterIncidentsInApp.webhookEventId,
                    input.eventId,
                  ),
                ),
              )
          )[0];
        const incidentReference = existingIncident?.incident_reference;
        if (typeof incidentReference !== "string") {
          throw new Error("failed to create Webhook Event incident reference");
        }
        return {
          incidentReference,
          outcome: "gap_recorded" as const,
        };
      }),
    ),

  projectSendEvidence: (input, materialize) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async (db) => {
        await enterPersonalAccountContext(db, input.personalAccountId);
        await lockConnection(db, input);
        const claimed = await db
          .insert(webhookItemsInApp)
          .values({
            personalAccountId: input.personalAccountId,
            whatsappConnectionId: input.whatsappConnectionId,
            deduplicationIdentity: input.itemIdentity,
            firstWebhookEventId: input.eventId,
            itemIndex: input.itemIndex,
            itemKind: "send_evidence",
            outcome: "superseded",
            receivedAt: input.receivedAt,
          })
          .onConflictDoNothing({
            target: [
              webhookItemsInApp.personalAccountId,
              webhookItemsInApp.whatsappConnectionId,
              webhookItemsInApp.deduplicationIdentity,
            ],
          })
          .returning({
            deduplicationIdentity: webhookItemsInApp.deduplicationIdentity,
          });
        if (claimed.length === 0) return "duplicate" as const;
        const changedAt = input.evidence.occurredAt ?? input.receivedAt;
        const correlated = await db.execute<Record<string, unknown>>(
          sql`select operations.id,operations.recipient_type,operations.recipient_public_id,
             pending.key_version,pending.nonce,pending.ciphertext,
             case operations.recipient_type when 'contact' then contacts.provider_identity_index
               else groups.provider_locator end as recipient_locator
           from public.send_operations operations
           left join public.pending_send_contents pending on pending.send_operation_id=operations.id
             and pending.expires_at>${input.receivedAt}
           left join public.directory_contacts contacts on operations.recipient_type='contact'
             AND contacts.personal_account_id=operations.personal_account_id
             AND contacts.whatsapp_connection_id=operations.whatsapp_connection_id
             AND contacts.public_id=operations.recipient_public_id
           left join public.whatsapp_groups groups on operations.recipient_type='group'
             AND groups.personal_account_id=operations.personal_account_id
             AND groups.whatsapp_connection_id=operations.whatsapp_connection_id
             AND groups.public_id=operations.recipient_public_id
           where operations.personal_account_id=${input.personalAccountId}
             and operations.whatsapp_connection_id=${input.whatsappConnectionId}
             and operations.message_identity=${input.messageIdentity}
             and operations.expires_at>${input.receivedAt} for update of operations`,
        );
        const updated = await db.execute<{ id: unknown }>(
          sql`update public.send_operations set status=${input.status},status_changed_at=${changedAt}
           where personal_account_id=${input.personalAccountId}
             and whatsapp_connection_id=${input.whatsappConnectionId}
             and message_identity=${input.messageIdentity} and expires_at>${input.receivedAt}
             and (
               status='unknown'
               or (${input.status}='failed' and status in ('processing','accepted','sent'))
               or (${input.status}<>'failed' and (
                 status='failed'
                 or case ${input.status} when 'accepted' then 1 when 'sent' then 2
                    WHEN 'delivered' THEN 3 WHEN 'read' THEN 4 END >
                    CASE status WHEN 'processing' THEN 0 WHEN 'accepted' THEN 1
                    WHEN 'sent' THEN 2 WHEN 'delivered' THEN 3 WHEN 'read' THEN 4
                    ELSE 0 END
               ))
             ) returning id`,
        );
        const operation = correlated[0];
        // Send Status converges from trusted evidence even while excluded, but
        // the evidence must not materialize a Stored Message.
        if (
          operation !== undefined &&
          typeof operation.recipient_locator === "string" &&
          (await isObservationSuppressed(
            db,
            input,
            scalar(operation, "recipient_type") === "group"
              ? "group"
              : "contact",
            operation.recipient_locator,
          ))
        ) {
          return "suppressed" as const;
        }
        if (
          operation !== undefined &&
          materialize !== undefined &&
          ["sent", "delivered", "read"].includes(input.status) &&
          operation.ciphertext != null &&
          typeof operation.recipient_locator === "string" &&
          typeof operation.recipient_public_id === "string"
        ) {
          const projected = await materialize({
            ciphertext: bytes(operation.ciphertext) ?? new Uint8Array(),
            keyVersion: positiveInteger(operation.key_version) ?? 0,
            nonce: bytes(operation.nonce) ?? new Uint8Array(),
            sendId: scalar(operation, "id"),
          });
          const recipientLocator = scalar(operation, "recipient_locator");
          const recipientType = scalar(operation, "recipient_type");
          const recipientPublicId = scalar(operation, "recipient_public_id");
          await db
            .insert(whatsappConversationsInApp)
            .values({
              id: projected.conversationId,
              personalAccountId: input.personalAccountId,
              whatsappConnectionId: input.whatsappConnectionId,
              publicId: projected.conversationPublicId,
              kind: recipientType === "contact" ? "direct" : "group",
              recipientLocator,
              recipientPublicId,
              lastActivityAt: changedAt,
              lastActivityDirection: "outbound",
            })
            .onConflictDoNothing({
              target: [
                whatsappConversationsInApp.personalAccountId,
                whatsappConversationsInApp.whatsappConnectionId,
                whatsappConversationsInApp.recipientLocator,
              ],
            });
          const conversation = await db
            .select({ id: whatsappConversationsInApp.id })
            .from(whatsappConversationsInApp)
            .where(
              and(
                eq(
                  whatsappConversationsInApp.personalAccountId,
                  input.personalAccountId,
                ),
                eq(
                  whatsappConversationsInApp.whatsappConnectionId,
                  input.whatsappConnectionId,
                ),
                eq(
                  whatsappConversationsInApp.recipientLocator,
                  recipientLocator,
                ),
              ),
            );
          const conversationId = conversation[0]?.id;
          if (conversationId === undefined)
            throw new Error("invalid WhatsApp Conversation");
          await db
            .insert(storedMessagesInApp)
            .values({
              id: projected.messageId,
              personalAccountId: input.personalAccountId,
              whatsappConnectionId: input.whatsappConnectionId,
              conversationId,
              publicId: projected.messagePublicId,
              messageIdentity: input.messageIdentity,
              direction: "outbound",
              sentAt: changedAt,
              contentType: "text",
              contentCiphertextVersion: projected.content.version,
              contentKeyVersion: projected.content.keyVersion,
              contentNonce: decodeNonce(projected.content),
              contentCiphertext: decodeCiphertext(projected.content),
              ...messageSearchValues(projected.messageSearch),
              receivedAt: input.receivedAt,
              webhookItemIdentity: null,
            })
            .onConflictDoNothing({
              target: [
                storedMessagesInApp.personalAccountId,
                storedMessagesInApp.whatsappConnectionId,
                storedMessagesInApp.messageIdentity,
              ],
            });
          await db.execute(sql`with latest as (
               SELECT messages.conversation_id,messages.sent_at,messages.direction
               FROM public.stored_messages messages
               JOIN public.whatsapp_conversations conversations
                 ON conversations.id=messages.conversation_id
               WHERE messages.personal_account_id=${input.personalAccountId}
                 AND messages.whatsapp_connection_id=${input.whatsappConnectionId}
                 AND conversations.recipient_locator=${recipientLocator}
                 AND messages.content_expired_at IS NULL
               ORDER BY messages.sent_at DESC,messages.public_id DESC LIMIT 1
             )
             UPDATE public.whatsapp_conversations conversations SET
               last_activity_at=latest.sent_at,last_activity_direction=latest.direction,
               updated_at=transaction_timestamp()
             FROM latest WHERE conversations.id=latest.conversation_id`);
          await db
            .delete(pendingSendContentsInApp)
            .where(
              and(
                eq(
                  pendingSendContentsInApp.personalAccountId,
                  input.personalAccountId,
                ),
                eq(
                  pendingSendContentsInApp.sendOperationId,
                  scalar(operation, "id"),
                ),
              ),
            );
        }
        const outcome = updated.length === 1 ? "applied" : "superseded";
        await db
          .update(webhookItemsInApp)
          .set({ outcome })
          .where(
            and(
              eq(webhookItemsInApp.personalAccountId, input.personalAccountId),
              eq(
                webhookItemsInApp.whatsappConnectionId,
                input.whatsappConnectionId,
              ),
              eq(webhookItemsInApp.deduplicationIdentity, input.itemIdentity),
            ),
          );
        return outcome;
      }),
    ),

  filterUnclaimed: <Input extends PrepareWebhookEventInput>(
    inputs: ReadonlyArray<Input>,
  ) =>
    provider.withConnection(async (connection) => {
      if (inputs.length === 0) return [];
      const candidates = inputs.map((input, candidateIndex) => ({
        candidate_index: candidateIndex + 1,
        ciphertext_sha256: input.ciphertextSha256,
        event_id: input.eventId,
        payload_bytes: input.payloadBytes,
        personal_account_id: input.personalAccountId,
        received_at: input.receivedAt,
        whatsapp_connection_id: input.whatsappConnectionId,
      }));
      const classified = await makeDatabase(
        connection,
      ).execute<RecoveryCandidateRow>(
        sql`select candidate_index, status
          from public.classify_webhook_recovery_candidates(
            ${JSON.stringify(candidates)}::jsonb
          )`,
      );
      if (classified.length !== inputs.length) {
        throw new Error("incomplete Webhook Event recovery classification");
      }
      const unclaimed: Input[] = [];
      for (const row of classified) {
        const candidateIndex = positiveInteger(row.candidate_index);
        const input =
          candidateIndex === null ? undefined : inputs[candidateIndex - 1];
        if (
          input === undefined ||
          (row.status !== "claimed" &&
            row.status !== "conflict" &&
            row.status !== "source_unavailable" &&
            row.status !== "unclaimed")
        ) {
          throw new Error("invalid Webhook Event recovery classification");
        }
        if (row.status === "conflict") {
          throw new Error("conflicting Webhook Event recovery candidate");
        }
        if (row.status === "unclaimed") unclaimed.push(input);
      }
      return unclaimed;
    }),

  prepare: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async (db) => {
        const loaded = await db.execute<MaterialRow>(
          sql`select * from public.load_webhook_event_processing_material(
            ${input.personalAccountId}, ${input.whatsappConnectionId}
          )`,
        );
        const material = processingMaterial(input, loaded[0]);
        if (material === null) return null;

        await enterPersonalAccountContext(db, input.personalAccountId);
        await db
          .insert(webhookEventsInApp)
          .values({
            personalAccountId: input.personalAccountId,
            whatsappConnectionId: input.whatsappConnectionId,
            id: input.eventId,
            ciphertextSha256: input.ciphertextSha256,
            payloadBytes: input.payloadBytes,
            receivedAt: input.receivedAt,
            sourceExpiresAt: sql`${input.receivedAt}::timestamptz + interval '7 days'`,
          })
          .onConflictDoNothing({
            target: [
              webhookEventsInApp.personalAccountId,
              webhookEventsInApp.whatsappConnectionId,
              webhookEventsInApp.id,
            ],
          });
        const persisted = await db
          .select({
            ciphertext_sha256: webhookEventsInApp.ciphertextSha256,
            payload_bytes: webhookEventsInApp.payloadBytes,
            received_at: webhookEventsInApp.receivedAt,
          })
          .from(webhookEventsInApp)
          .where(
            and(
              eq(webhookEventsInApp.personalAccountId, input.personalAccountId),
              eq(
                webhookEventsInApp.whatsappConnectionId,
                input.whatsappConnectionId,
              ),
              eq(webhookEventsInApp.id, input.eventId),
            ),
          );
        if (!sameEvent(input, persisted[0])) {
          throw new Error("conflicting Webhook Event replay");
        }
        return material;
      }),
    ),

  projectConnectionState: (input, compareVersions) => {
    return provider.withConnection((connection) =>
      withTransaction(connection, async (db) => {
        await enterPersonalAccountContext(db, input.personalAccountId);
        const currentResult = await db
          .select({
            state_provider_occurred_at:
              whatsappConnectionsInApp.stateProviderOccurredAt,
            state_provider_version:
              whatsappConnectionsInApp.stateProviderVersion,
            state_received_at: whatsappConnectionsInApp.stateReceivedAt,
            state_snapshot_observed_at:
              whatsappConnectionsInApp.stateSnapshotObservedAt,
            state_webhook_event_id:
              whatsappConnectionsInApp.stateWebhookEventId,
          })
          .from(whatsappConnectionsInApp)
          .where(
            and(
              eq(
                whatsappConnectionsInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(whatsappConnectionsInApp.id, input.whatsappConnectionId),
              ne(whatsappConnectionsInApp.state, "deleting"),
              sql`exists (select 1 from ${webhookEventsInApp} events where
            events.personal_account_id = ${input.personalAccountId}
            and events.whatsapp_connection_id = ${input.whatsappConnectionId}
            and events.id = ${input.eventId})`,
            ),
          )
          .for("update");
        const current = currentResult[0];
        if (current === undefined) {
          throw new Error("connection-state projection target unavailable");
        }
        if (!(await claimWebhookItem(db, input, "connection_state")))
          return "duplicate" as const;

        const apply = await shouldApply(input, current, compareVersions);
        if (!apply) return "superseded" as const;

        await db
          .update(whatsappConnectionsInApp)
          .set({
            state: input.state,
            stateChangedAt: sql`case when ${whatsappConnectionsInApp.state} = ${input.state}
            then ${whatsappConnectionsInApp.stateChangedAt}
            else coalesce(${input.evidence.occurredAt}::timestamptz, ${input.receivedAt}::timestamptz) end`,
            stateProviderOccurredAt: input.evidence.occurredAt,
            stateProviderVersion: input.evidence.version,
            stateReceivedAt: input.receivedAt,
            stateWebhookEventId: input.eventId,
            stateWebhookItemIdentity: input.itemIdentity,
            updatedAt: sql`greatest(${whatsappConnectionsInApp.updatedAt}, ${input.receivedAt}::timestamptz)`,
          })
          .where(
            and(
              eq(
                whatsappConnectionsInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(whatsappConnectionsInApp.id, input.whatsappConnectionId),
            ),
          );
        await markWebhookItemApplied(db, input);
        return "applied" as const;
      }),
    );
  },

  projectGroup: (input, protect, compareVersions) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async (db) => {
        if (
          input.namePrefixIndexes.length > 62 ||
          input.namePrefixIndexes.some(
            (index) => !/^gi1_[A-Za-z0-9_-]{43}$/u.test(index),
          ) ||
          new Set(input.namePrefixIndexes).size !==
            input.namePrefixIndexes.length ||
          (!input.joined && input.namePrefixIndexes.length > 0)
        ) {
          throw new Error("invalid group name prefix indexes");
        }
        await enterPersonalAccountContext(db, input.personalAccountId);
        const target = await db
          .select({ id: whatsappConnectionsInApp.id })
          .from(whatsappConnectionsInApp)
          .where(
            and(
              eq(
                whatsappConnectionsInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(whatsappConnectionsInApp.id, input.whatsappConnectionId),
              ne(whatsappConnectionsInApp.state, "deleting"),
              sql`exists (select 1 from ${webhookEventsInApp} events where
              events.personal_account_id=${input.personalAccountId}
              and events.whatsapp_connection_id=${input.whatsappConnectionId}
              and events.id=${input.eventId})`,
            ),
          )
          .for("update");
        if (target.length !== 1) {
          throw new Error("group projection target unavailable");
        }
        if (!(await claimWebhookItem(db, input, "directory_group")))
          return "duplicate" as const;

        const current = await db
          .select({
            id: whatsappGroupsInApp.id,
            last_observed_at: whatsappGroupsInApp.lastObservedAt,
            provider_occurred_at: whatsappGroupsInApp.providerOccurredAt,
            provider_version: whatsappGroupsInApp.providerVersion,
            received_at: whatsappGroupsInApp.receivedAt,
          })
          .from(whatsappGroupsInApp)
          .where(
            and(
              eq(
                whatsappGroupsInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(
                whatsappGroupsInApp.whatsappConnectionId,
                input.whatsappConnectionId,
              ),
              eq(whatsappGroupsInApp.providerLocator, input.locator),
            ),
          )
          .for("update");
        if (!(await shouldApplyGroup(input, current[0], compareVersions))) {
          return "superseded" as const;
        }
        const currentId = current[0]?.id;
        const recordId =
          typeof currentId === "string" ? currentId : input.groupId;
        const fields = protectedGroupValues(await protect(recordId));
        const effectiveObservedAt =
          input.evidence.occurredAt ?? input.receivedAt;
        const groupValues = {
          id: recordId,
          personalAccountId: input.personalAccountId,
          whatsappConnectionId: input.whatsappConnectionId,
          publicId: input.publicId,
          providerLocator: input.locator,
          namePrefixIndexes: [...input.namePrefixIndexes],
          displayNameCiphertextVersion: fields[0],
          displayNameKeyVersion: fields[1],
          displayNameNonce: fields[2],
          displayNameCiphertext: fields[3],
          providerIdentityCiphertextVersion: fields[4],
          providerIdentityKeyVersion: fields[5],
          providerIdentityNonce: fields[6],
          providerIdentityCiphertext: fields[7],
          joined: input.joined,
          lastObservedAt: effectiveObservedAt,
          providerOccurredAt: input.evidence.occurredAt,
          providerVersion: input.evidence.version,
          receivedAt: input.receivedAt,
          webhookEventId: input.eventId,
          webhookItemIdentity: input.itemIdentity,
          createdAt: input.receivedAt,
          updatedAt: input.receivedAt,
        };
        await db
          .insert(whatsappGroupsInApp)
          .values(groupValues)
          .onConflictDoUpdate({
            target: [
              whatsappGroupsInApp.personalAccountId,
              whatsappGroupsInApp.whatsappConnectionId,
              whatsappGroupsInApp.providerLocator,
            ],
            set: {
              namePrefixIndexes: groupValues.namePrefixIndexes,
              displayNameCiphertextVersion:
                groupValues.displayNameCiphertextVersion,
              displayNameKeyVersion: groupValues.displayNameKeyVersion,
              displayNameNonce: groupValues.displayNameNonce,
              displayNameCiphertext: groupValues.displayNameCiphertext,
              providerIdentityCiphertextVersion:
                groupValues.providerIdentityCiphertextVersion,
              providerIdentityKeyVersion:
                groupValues.providerIdentityKeyVersion,
              providerIdentityNonce: groupValues.providerIdentityNonce,
              providerIdentityCiphertext:
                groupValues.providerIdentityCiphertext,
              joined: groupValues.joined,
              lastObservedAt: groupValues.lastObservedAt,
              providerOccurredAt: groupValues.providerOccurredAt,
              providerVersion: groupValues.providerVersion,
              receivedAt: groupValues.receivedAt,
              webhookEventId: groupValues.webhookEventId,
              webhookItemIdentity: groupValues.webhookItemIdentity,
              updatedAt: groupValues.updatedAt,
            },
          });
        await db
          .insert(whatsappGroupDirectoryStatesInApp)
          .values({
            personalAccountId: input.personalAccountId,
            whatsappConnectionId: input.whatsappConnectionId,
            asOf: input.receivedAt,
            stale: false,
            partial: true,
            updatedAt: input.receivedAt,
          })
          .onConflictDoUpdate({
            target: [
              whatsappGroupDirectoryStatesInApp.personalAccountId,
              whatsappGroupDirectoryStatesInApp.whatsappConnectionId,
            ],
            set: {
              asOf: sql`greatest(${whatsappGroupDirectoryStatesInApp.asOf}, excluded.as_of)`,
              updatedAt: sql`greatest(${whatsappGroupDirectoryStatesInApp.updatedAt}, excluded.updated_at)`,
            },
          });
        await markWebhookItemApplied(db, input);
        return "applied" as const;
      }),
    ),

  projectDirectoryContact: (input, compareVersions) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async (db) => {
        if (
          !/^ctc_[A-Za-z0-9_-]{21}$/u.test(input.publicId) ||
          !/^di1_[A-Za-z0-9_-]{43}$/u.test(input.providerIdentityIndex) ||
          (input.phoneIndex !== null &&
            !/^di1_[A-Za-z0-9_-]{43}$/u.test(input.phoneIndex)) ||
          input.namePrefixIndexes.some(
            (value) => !/^di1_[A-Za-z0-9_-]{43}$/u.test(value),
          ) ||
          new TextEncoder().encode(input.displayNameSort).byteLength > 1_024 ||
          (!input.active &&
            (input.displayNameCiphertext !== null ||
              input.displayNameSort !== "" ||
              input.phoneCiphertext !== null ||
              input.phoneIndex !== null ||
              input.namePrefixIndexes.length !== 0))
        ) {
          throw new Error("invalid Directory contact projection");
        }
        const providerCiphertext = decodeCiphertext(
          input.providerIdentityCiphertext,
        );
        const providerNonce = decodeNonce(input.providerIdentityCiphertext);
        const displayNameCiphertext =
          input.displayNameCiphertext === null
            ? null
            : decodeCiphertext(input.displayNameCiphertext);
        const displayNameNonce =
          input.displayNameCiphertext === null
            ? null
            : decodeNonce(input.displayNameCiphertext);
        const phoneCiphertext =
          input.phoneCiphertext === null
            ? null
            : decodeCiphertext(input.phoneCiphertext);
        const phoneNonce =
          input.phoneCiphertext === null
            ? null
            : decodeNonce(input.phoneCiphertext);

        await enterPersonalAccountContext(db, input.personalAccountId);
        const lockedConnection = await db
          .select({ id: whatsappConnectionsInApp.id })
          .from(whatsappConnectionsInApp)
          .where(
            and(
              eq(
                whatsappConnectionsInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(whatsappConnectionsInApp.id, input.whatsappConnectionId),
            ),
          )
          .for("update");
        if (lockedConnection.length !== 1) {
          throw new Error("Directory contact projection target unavailable");
        }
        const currentResult = await db
          .select({
            provider_occurred_at: directoryContactsInApp.providerOccurredAt,
            provider_version: directoryContactsInApp.providerVersion,
            snapshot_observed_at: directoryContactsInApp.snapshotObservedAt,
            received_at: directoryContactsInApp.receivedAt,
            webhook_event_id: directoryContactsInApp.webhookEventId,
          })
          .from(directoryContactsInApp)
          .where(
            and(
              eq(
                directoryContactsInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(
                directoryContactsInApp.whatsappConnectionId,
                input.whatsappConnectionId,
              ),
              eq(
                directoryContactsInApp.providerIdentityIndex,
                input.providerIdentityIndex,
              ),
              sql`exists (select 1 from ${webhookEventsInApp} events where
                events.personal_account_id = ${input.personalAccountId}
                and events.whatsapp_connection_id = ${input.whatsappConnectionId}
                and events.id = ${input.eventId})`,
            ),
          )
          .for("update");
        const eventExists = await db
          .select({ id: webhookEventsInApp.id })
          .from(webhookEventsInApp)
          .where(
            and(
              eq(webhookEventsInApp.personalAccountId, input.personalAccountId),
              eq(
                webhookEventsInApp.whatsappConnectionId,
                input.whatsappConnectionId,
              ),
              eq(webhookEventsInApp.id, input.eventId),
            ),
          );
        if (eventExists.length !== 1) {
          throw new Error("Directory contact projection target unavailable");
        }
        if (!(await claimWebhookItem(db, input, "directory_contact")))
          return "duplicate" as const;
        const current = currentResult[0];
        if (
          current !== undefined &&
          !(await shouldApplyContact(input, current, compareVersions))
        ) {
          return "superseded" as const;
        }

        await db
          .insert(directoryContactProjectionsInApp)
          .values({
            personalAccountId: input.personalAccountId,
            whatsappConnectionId: input.whatsappConnectionId,
            asOf: input.receivedAt,
            stale: false,
            partial: true,
            updatedAt: input.receivedAt,
          })
          .onConflictDoUpdate({
            target: [
              directoryContactProjectionsInApp.personalAccountId,
              directoryContactProjectionsInApp.whatsappConnectionId,
            ],
            set: {
              asOf: sql`greatest(${directoryContactProjectionsInApp.asOf}, excluded.as_of)`,
              updatedAt: sql`greatest(${directoryContactProjectionsInApp.updatedAt}, excluded.updated_at)`,
            },
          });
        const contactValues = {
          personalAccountId: input.personalAccountId,
          whatsappConnectionId: input.whatsappConnectionId,
          publicId: input.publicId,
          providerIdentityIndex: input.providerIdentityIndex,
          providerIdentityCiphertextVersion:
            input.providerIdentityCiphertext.version,
          providerIdentityKeyVersion:
            input.providerIdentityCiphertext.keyVersion,
          providerIdentityNonce: providerNonce,
          providerIdentityCiphertext: providerCiphertext,
          displayNameCiphertextVersion:
            input.displayNameCiphertext?.version ?? null,
          displayNameKeyVersion:
            input.displayNameCiphertext?.keyVersion ?? null,
          displayNameNonce,
          displayNameCiphertext,
          displayNameSort: input.displayNameSort,
          phoneCiphertextVersion: input.phoneCiphertext?.version ?? null,
          phoneKeyVersion: input.phoneCiphertext?.keyVersion ?? null,
          phoneNonce,
          phoneCiphertext,
          namePrefixIndexes: [...input.namePrefixIndexes],
          phoneIndex: input.phoneIndex,
          active: input.active,
          providerOccurredAt: input.evidence.occurredAt,
          providerVersion: input.evidence.version,
          receivedAt: input.receivedAt,
          webhookEventId: input.eventId,
          webhookItemIdentity: input.itemIdentity,
          updatedAt: input.receivedAt,
        };
        const insertContact = db
          .insert(directoryContactsInApp)
          .values(contactValues);
        if (input.insertOnly === true) {
          await insertContact.onConflictDoNothing({
            target: [
              directoryContactsInApp.personalAccountId,
              directoryContactsInApp.whatsappConnectionId,
              directoryContactsInApp.providerIdentityIndex,
            ],
          });
        } else {
          await insertContact.onConflictDoUpdate({
            target: [
              directoryContactsInApp.personalAccountId,
              directoryContactsInApp.whatsappConnectionId,
              directoryContactsInApp.providerIdentityIndex,
            ],
            set: {
              providerIdentityCiphertextVersion:
                contactValues.providerIdentityCiphertextVersion,
              providerIdentityKeyVersion:
                contactValues.providerIdentityKeyVersion,
              providerIdentityNonce: contactValues.providerIdentityNonce,
              providerIdentityCiphertext:
                contactValues.providerIdentityCiphertext,
              displayNameCiphertextVersion:
                contactValues.displayNameCiphertextVersion,
              displayNameKeyVersion: contactValues.displayNameKeyVersion,
              displayNameNonce: contactValues.displayNameNonce,
              displayNameCiphertext: contactValues.displayNameCiphertext,
              displayNameSort: contactValues.displayNameSort,
              phoneCiphertextVersion: contactValues.phoneCiphertextVersion,
              phoneKeyVersion: contactValues.phoneKeyVersion,
              phoneNonce: contactValues.phoneNonce,
              phoneCiphertext: contactValues.phoneCiphertext,
              namePrefixIndexes: contactValues.namePrefixIndexes,
              phoneIndex: contactValues.phoneIndex,
              active: contactValues.active,
              providerOccurredAt: contactValues.providerOccurredAt,
              providerVersion: contactValues.providerVersion,
              receivedAt: contactValues.receivedAt,
              webhookEventId: contactValues.webhookEventId,
              webhookItemIdentity: contactValues.webhookItemIdentity,
              updatedAt: contactValues.updatedAt,
            },
          });
        }
        await markWebhookItemApplied(db, input);
        return "applied" as const;
      }),
    ),

  projectStoredMessage: (input, compareVersions) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async (db) => {
        if (
          !/^cvs_[A-Za-z0-9_-]{21}$/u.test(input.conversationPublicId) ||
          !/^msg_[A-Za-z0-9_-]{21}$/u.test(input.messagePublicId) ||
          !/^wi1_[A-Za-z0-9_-]{43}$/u.test(input.messageIdentity) ||
          (input.recipientKind === "direct"
            ? !/^ctc_[A-Za-z0-9_-]{21}$/u.test(input.recipientPublicId)
            : !/^grp_[A-Za-z0-9_-]{21}$/u.test(input.recipientPublicId))
        ) {
          throw new Error("invalid Stored Message projection");
        }
        const ciphertext = decodeCiphertext(input.content);
        const nonce = decodeNonce(input.content);
        await enterPersonalAccountContext(db, input.personalAccountId);
        const lockedConnection = await db
          .select({ id: whatsappConnectionsInApp.id })
          .from(whatsappConnectionsInApp)
          .where(
            and(
              eq(
                whatsappConnectionsInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(whatsappConnectionsInApp.id, input.whatsappConnectionId),
            ),
          )
          .for("update");
        if (lockedConnection.length !== 1) {
          throw new Error("Stored Message projection target unavailable");
        }
        const recipient =
          input.recipientKind === "group"
            ? await db
                .select({
                  id: whatsappGroupsInApp.id,
                  public_id: whatsappGroupsInApp.publicId,
                })
                .from(whatsappGroupsInApp)
                .where(
                  and(
                    eq(
                      whatsappGroupsInApp.personalAccountId,
                      input.personalAccountId,
                    ),
                    eq(
                      whatsappGroupsInApp.whatsappConnectionId,
                      input.whatsappConnectionId,
                    ),
                    eq(
                      whatsappGroupsInApp.providerLocator,
                      input.recipientLocator,
                    ),
                  ),
                )
            : await db
                .select({
                  id: directoryContactsInApp.id,
                  public_id: directoryContactsInApp.publicId,
                })
                .from(directoryContactsInApp)
                .where(
                  and(
                    eq(
                      directoryContactsInApp.personalAccountId,
                      input.personalAccountId,
                    ),
                    eq(
                      directoryContactsInApp.whatsappConnectionId,
                      input.whatsappConnectionId,
                    ),
                    eq(
                      directoryContactsInApp.providerIdentityIndex,
                      input.recipientLocator,
                    ),
                  ),
                );
        const recipientPublicId =
          typeof recipient[0]?.public_id === "string"
            ? recipient[0].public_id
            : input.recipientPublicId;
        if (!(await claimWebhookItem(db, input, "message_upsert")))
          return "duplicate" as const;
        if (
          await isObservationSuppressed(
            db,
            input,
            input.recipientKind,
            input.recipientLocator,
          )
        ) {
          return "suppressed" as const;
        }
        const current = await db
          .select({
            deleted_at: storedMessagesInApp.deletedAt,
            edited_at: storedMessagesInApp.editedAt,
            provider_occurred_at: storedMessagesInApp.providerOccurredAt,
            provider_version: storedMessagesInApp.providerVersion,
            received_at: storedMessagesInApp.receivedAt,
          })
          .from(storedMessagesInApp)
          .where(
            and(
              eq(
                storedMessagesInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(
                storedMessagesInApp.whatsappConnectionId,
                input.whatsappConnectionId,
              ),
              eq(storedMessagesInApp.messageIdentity, input.messageIdentity),
            ),
          )
          .for("update");
        const row = current[0];
        if (row !== undefined) {
          if (timestamp(row.deleted_at) !== null) return "superseded" as const;
          const oldOccurred = timestamp(row.provider_occurred_at);
          const newOccurred = timestamp(input.evidence.occurredAt);
          const editedAt = timestamp(row.edited_at);
          if (
            editedAt !== null &&
            (newOccurred === null || newOccurred <= editedAt)
          )
            return "superseded" as const;
          if (
            oldOccurred !== null &&
            newOccurred !== null &&
            newOccurred < oldOccurred
          )
            return "superseded" as const;
          if (
            oldOccurred?.valueOf() === newOccurred?.valueOf() &&
            typeof row.provider_version === "string" &&
            input.evidence.version !== null &&
            (await compareVersions(
              input.evidence.version,
              row.provider_version,
            )) === "before"
          )
            return "superseded" as const;
        }
        await db
          .insert(whatsappConversationsInApp)
          .values({
            id: input.conversationId,
            personalAccountId: input.personalAccountId,
            whatsappConnectionId: input.whatsappConnectionId,
            publicId: input.conversationPublicId,
            kind: input.recipientKind,
            recipientLocator: input.recipientLocator,
            recipientPublicId,
            lastActivityAt: input.sentAt,
            lastActivityDirection: input.direction,
          })
          .onConflictDoNothing({
            target: [
              whatsappConversationsInApp.personalAccountId,
              whatsappConversationsInApp.whatsappConnectionId,
              whatsappConversationsInApp.recipientLocator,
            ],
          });
        const conversation = await db
          .select({ id: whatsappConversationsInApp.id })
          .from(whatsappConversationsInApp)
          .where(
            and(
              eq(
                whatsappConversationsInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(
                whatsappConversationsInApp.whatsappConnectionId,
                input.whatsappConnectionId,
              ),
              eq(
                whatsappConversationsInApp.recipientLocator,
                input.recipientLocator,
              ),
            ),
          );
        const conversationId = conversation[0]?.id;
        if (typeof conversationId !== "string")
          throw new Error("invalid WhatsApp Conversation");
        await db.execute(sql`with removed as (
             DELETE FROM public.stored_media media USING public.stored_messages messages
             WHERE messages.personal_account_id=${input.personalAccountId}
               AND messages.whatsapp_connection_id=${input.whatsappConnectionId}
               AND messages.message_identity=${input.messageIdentity}
               AND media.personal_account_id=messages.personal_account_id
               AND media.whatsapp_connection_id=messages.whatsapp_connection_id AND media.stored_message_id=messages.id
             RETURNING media.object_key,media.plaintext_size_bytes,media.state
           ), queued AS (
             INSERT INTO public.stored_media_object_deletions(personal_account_id,object_key)
             SELECT ${input.personalAccountId},object_key FROM removed WHERE object_key IS NOT NULL ON CONFLICT DO NOTHING
           )
           UPDATE public.personal_accounts SET stored_media_used_bytes=stored_media_used_bytes-
             coalesce((SELECT sum(plaintext_size_bytes) FROM removed WHERE state='ready'),0)
           WHERE id=${input.personalAccountId}`);
        const messageValues = {
          id: input.messageId,
          personalAccountId: input.personalAccountId,
          whatsappConnectionId: input.whatsappConnectionId,
          conversationId,
          publicId: input.messagePublicId,
          messageIdentity: input.messageIdentity,
          direction: input.direction,
          sentAt: input.sentAt,
          contentType: input.contentType,
          contentCiphertextVersion: input.content.version,
          contentKeyVersion: input.content.keyVersion,
          contentNonce: nonce,
          contentCiphertext: ciphertext,
          ...messageSearchValues(input.messageSearch),
          providerOccurredAt: input.evidence.occurredAt,
          providerVersion: input.evidence.version,
          receivedAt: input.receivedAt,
          webhookEventId: input.eventId,
          webhookItemIdentity: input.itemIdentity,
        };
        await db
          .insert(storedMessagesInApp)
          .values(messageValues)
          .onConflictDoUpdate({
            target: [
              storedMessagesInApp.personalAccountId,
              storedMessagesInApp.whatsappConnectionId,
              storedMessagesInApp.messageIdentity,
            ],
            set: {
              direction: messageValues.direction,
              sentAt: messageValues.sentAt,
              contentType: messageValues.contentType,
              contentCiphertextVersion: messageValues.contentCiphertextVersion,
              contentKeyVersion: messageValues.contentKeyVersion,
              contentNonce: messageValues.contentNonce,
              contentCiphertext: messageValues.contentCiphertext,
              providerOccurredAt: messageValues.providerOccurredAt,
              providerVersion: messageValues.providerVersion,
              receivedAt: messageValues.receivedAt,
              webhookEventId: messageValues.webhookEventId,
              webhookItemIdentity: messageValues.webhookItemIdentity,
              updatedAt: sql`transaction_timestamp()`,
            },
          });
        if (input.media != null) {
          const storedMessage = await db
            .select({ id: storedMessagesInApp.id })
            .from(storedMessagesInApp)
            .where(
              and(
                eq(
                  storedMessagesInApp.personalAccountId,
                  input.personalAccountId,
                ),
                eq(
                  storedMessagesInApp.whatsappConnectionId,
                  input.whatsappConnectionId,
                ),
                eq(storedMessagesInApp.messageIdentity, input.messageIdentity),
              ),
            );
          const storedMessageId = storedMessage[0]?.id;
          if (typeof storedMessageId !== "string")
            throw new Error("invalid Stored Message for media");
          await db
            .insert(storedMediaInApp)
            .values({
              id: input.media.id,
              personalAccountId: input.personalAccountId,
              whatsappConnectionId: input.whatsappConnectionId,
              storedMessageId,
              publicId: input.media.publicId,
              state: "pending",
              mediaType: input.contentType,
              sourceCiphertextVersion: input.media.source.version,
              sourceKeyVersion: input.media.source.keyVersion,
              sourceNonce: decodeNonce(input.media.source),
              sourceCiphertext: decodeCiphertext(input.media.source),
            })
            .onConflictDoNothing({
              target: [
                storedMediaInApp.personalAccountId,
                storedMediaInApp.whatsappConnectionId,
                storedMediaInApp.storedMessageId,
              ],
            });
        }
        await db.execute(sql`update public.whatsapp_conversations as conversations set
             last_activity_at=latest.sent_at,last_activity_direction=latest.direction,updated_at=transaction_timestamp()
           FROM (SELECT sent_at,direction FROM public.stored_messages
             WHERE personal_account_id=${input.personalAccountId}
             AND whatsapp_connection_id=${input.whatsappConnectionId}
             AND conversation_id=${conversationId} AND content_expired_at IS NULL
             ORDER BY sent_at DESC, public_id DESC LIMIT 1) latest
           WHERE conversations.personal_account_id=${input.personalAccountId}
             AND conversations.whatsapp_connection_id=${input.whatsappConnectionId}
             AND conversations.id=${conversationId}`);
        if (input.direction === "outbound") {
          const correlated = await db
            .select({ id: sendOperationsInApp.id })
            .from(sendOperationsInApp)
            .where(
              and(
                eq(
                  sendOperationsInApp.personalAccountId,
                  input.personalAccountId,
                ),
                eq(
                  sendOperationsInApp.whatsappConnectionId,
                  input.whatsappConnectionId,
                ),
                eq(sendOperationsInApp.messageIdentity, input.messageIdentity),
                gt(sendOperationsInApp.expiresAt, input.receivedAt),
              ),
            )
            .for("update");
          const sendId = correlated[0]?.id;
          if (typeof sendId === "string") {
            await db
              .update(sendOperationsInApp)
              .set({ status: "sent", statusChangedAt: input.sentAt })
              .where(
                and(
                  eq(sendOperationsInApp.id, sendId),
                  inArray(sendOperationsInApp.status, [
                    "processing",
                    "accepted",
                    "failed",
                    "unknown",
                  ]),
                ),
              );
            await db
              .delete(pendingSendContentsInApp)
              .where(
                and(
                  eq(
                    pendingSendContentsInApp.personalAccountId,
                    input.personalAccountId,
                  ),
                  eq(pendingSendContentsInApp.sendOperationId, sendId),
                ),
              );
          }
        }
        await markWebhookItemApplied(db, input);
        return "applied" as const;
      }),
    ),

  projectStoredMessageEdit: (input, compareVersions) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async (db) => {
        const ciphertext = decodeCiphertext(input.content);
        const nonce = decodeNonce(input.content);
        await enterPersonalAccountContext(db, input.personalAccountId);
        await lockConnection(db, input);
        if (!(await claimWebhookItem(db, input, "message_edit")))
          return "duplicate" as const;
        const edited = await db.execute<{ recipient_locator: unknown }>(sql`
          SELECT conversations.recipient_locator
          FROM public.stored_messages messages
          JOIN public.whatsapp_conversations conversations
            ON conversations.personal_account_id = messages.personal_account_id
           AND conversations.whatsapp_connection_id = messages.whatsapp_connection_id
           AND conversations.id = messages.conversation_id
          WHERE messages.personal_account_id = ${input.personalAccountId}
            AND messages.whatsapp_connection_id = ${input.whatsappConnectionId}
            AND messages.message_identity = ${input.messageIdentity}
        `);
        const editedLocator = edited[0]?.recipient_locator;
        if (
          typeof editedLocator === "string" &&
          (await isObservationSuppressed(
            db,
            input,
            editedLocator.startsWith("wi1_") ? "group" : "contact",
            editedLocator,
          ))
        ) {
          return "suppressed" as const;
        }
        const current = await db
          .select({
            deleted_at: storedMessagesInApp.deletedAt,
            edited_at: storedMessagesInApp.editedAt,
            provider_occurred_at: storedMessagesInApp.providerOccurredAt,
            provider_version: storedMessagesInApp.providerVersion,
            received_at: storedMessagesInApp.receivedAt,
            webhook_event_id: storedMessagesInApp.webhookEventId,
          })
          .from(storedMessagesInApp)
          .where(
            and(
              eq(
                storedMessagesInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(
                storedMessagesInApp.whatsappConnectionId,
                input.whatsappConnectionId,
              ),
              eq(storedMessagesInApp.messageIdentity, input.messageIdentity),
            ),
          )
          .for("update");
        const row = current[0];
        if (row === undefined || timestamp(row.deleted_at) !== null)
          return "superseded" as const;
        if (
          !(await shouldApply(
            input,
            {
              state_provider_occurred_at: row.provider_occurred_at,
              state_provider_version: row.provider_version,
              state_received_at: row.received_at,
              state_snapshot_observed_at: null,
              state_webhook_event_id: row.webhook_event_id,
            },
            compareVersions,
          ))
        )
          return "superseded" as const;
        const oldEditedAt = timestamp(row.edited_at);
        const newEditedAt = timestamp(input.editedAt);
        if (newEditedAt === null) throw new Error("invalid edit timestamp");
        if (oldEditedAt !== null && newEditedAt < oldEditedAt)
          return "superseded" as const;
        await db
          .update(storedMessagesInApp)
          .set({
            contentType: input.contentType,
            contentCiphertextVersion: input.content.version,
            contentKeyVersion: input.content.keyVersion,
            contentNonce: nonce,
            contentCiphertext: ciphertext,
            ...messageSearchValues(input.messageSearch),
            editedAt: input.editedAt,
            providerOccurredAt: input.evidence.occurredAt,
            providerVersion: input.evidence.version,
            receivedAt: input.receivedAt,
            webhookEventId: input.eventId,
            webhookItemIdentity: input.itemIdentity,
            updatedAt: sql`transaction_timestamp()`,
          })
          .where(
            and(
              eq(
                storedMessagesInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(
                storedMessagesInApp.whatsappConnectionId,
                input.whatsappConnectionId,
              ),
              eq(storedMessagesInApp.messageIdentity, input.messageIdentity),
            ),
          );
        await markWebhookItemApplied(db, input);
        return "applied" as const;
      }),
    ),

  projectStoredMessageDeletion: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async (db) => {
        await enterPersonalAccountContext(db, input.personalAccountId);
        await lockConnection(db, input);
        if (!(await claimWebhookItem(db, input, "message_delete")))
          return "duplicate" as const;
        if (
          await isObservationSuppressed(
            db,
            input,
            input.recipientKind,
            input.recipientLocator,
          )
        ) {
          return "suppressed" as const;
        }
        await db
          .insert(whatsappConversationsInApp)
          .values({
            id: input.conversationId,
            personalAccountId: input.personalAccountId,
            whatsappConnectionId: input.whatsappConnectionId,
            publicId: input.conversationPublicId,
            kind: input.recipientKind,
            recipientLocator: input.recipientLocator,
            recipientPublicId: input.recipientPublicId,
            lastActivityAt: input.sentAt,
            lastActivityDirection: input.direction,
          })
          .onConflictDoNothing({
            target: [
              whatsappConversationsInApp.personalAccountId,
              whatsappConversationsInApp.whatsappConnectionId,
              whatsappConversationsInApp.recipientLocator,
            ],
          });
        const conversation = await db
          .select({ id: whatsappConversationsInApp.id })
          .from(whatsappConversationsInApp)
          .where(
            and(
              eq(
                whatsappConversationsInApp.personalAccountId,
                input.personalAccountId,
              ),
              eq(
                whatsappConversationsInApp.whatsappConnectionId,
                input.whatsappConnectionId,
              ),
              eq(
                whatsappConversationsInApp.recipientLocator,
                input.recipientLocator,
              ),
            ),
          );
        const conversationId = conversation[0]?.id;
        if (typeof conversationId !== "string")
          throw new Error("invalid WhatsApp Conversation");
        const deletionValues = {
          id: input.messageId,
          personalAccountId: input.personalAccountId,
          whatsappConnectionId: input.whatsappConnectionId,
          conversationId,
          publicId: input.messagePublicId,
          messageIdentity: input.messageIdentity,
          direction: input.direction,
          sentAt: input.sentAt,
          deletedAt: input.deletedAt,
          providerOccurredAt: input.evidence.occurredAt,
          providerVersion: input.evidence.version,
          receivedAt: input.receivedAt,
          webhookEventId: input.eventId,
          webhookItemIdentity: input.itemIdentity,
        };
        await db
          .insert(storedMessagesInApp)
          .values(deletionValues)
          .onConflictDoUpdate({
            target: [
              storedMessagesInApp.personalAccountId,
              storedMessagesInApp.whatsappConnectionId,
              storedMessagesInApp.messageIdentity,
            ],
            set: {
              contentType: null,
              contentCiphertextVersion: null,
              contentKeyVersion: null,
              contentNonce: null,
              contentCiphertext: null,
              messageSearchIndexVersion: null,
              messageSearchTokens: null,
              deletedAt: input.deletedAt,
              providerOccurredAt: input.evidence.occurredAt,
              providerVersion: input.evidence.version,
              receivedAt: input.receivedAt,
              webhookEventId: input.eventId,
              webhookItemIdentity: input.itemIdentity,
              updatedAt: sql`transaction_timestamp()`,
            },
          });
        await markWebhookItemApplied(db, input);
        return "applied" as const;
      }),
    ),

  quarantine: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async (db) => {
        await enterPersonalAccountContext(db, input.personalAccountId);
        let claimed = true;
        if (input.itemIdentity !== null) {
          claimed = await claimWebhookItem(
            db,
            { ...input, itemIdentity: input.itemIdentity },
            input.itemKind,
            "quarantined",
          );
        }
        if (!claimed) return;
        await db
          .insert(webhookItemQuarantinesInApp)
          .values({
            personalAccountId: input.personalAccountId,
            whatsappConnectionId: input.whatsappConnectionId,
            webhookEventId: input.eventId,
            itemIndex: input.itemIndex,
            itemIdentity: input.itemIdentity,
            itemKind: input.itemKind,
            classification: input.classification,
            receivedAt: input.receivedAt,
          })
          .onConflictDoNothing({
            target: [
              webhookItemQuarantinesInApp.personalAccountId,
              webhookItemQuarantinesInApp.whatsappConnectionId,
              webhookItemQuarantinesInApp.webhookEventId,
              webhookItemQuarantinesInApp.itemIndex,
            ],
          });
      }),
    ),
});

const makePgConnectionProvider = (
  connectionString: string,
): WebhookEventConnectionProvider => ({
  withConnection: (use) => withPgQueryConnection(connectionString, use),
});

export const makePgWebhookEventRepository = (
  connectionString: string,
): WebhookEventRepository =>
  makeWebhookEventRepository(makePgConnectionProvider(connectionString));
