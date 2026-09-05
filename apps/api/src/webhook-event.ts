import {
  makeContactId,
  makeConversationId,
  makeGroupId,
  makeMediaId,
  makeMessageId,
} from "@whatsapp-mcp/contracts/handles";
import type {
  DeadLetterWebhookEventResult,
  MaterializedPendingSend,
  PendingSendProjection,
  ProjectConnectionStateInput,
  ProjectDirectoryContactInput,
  ProjectGroupInput,
  ProjectSendEvidenceInput,
  ProjectStoredMessageDeletionInput,
  ProjectStoredMessageEditInput,
  ProjectStoredMessageInput,
  QuarantineWebhookItemInput,
  WebhookEventProcessingMaterial,
  WebhookItemProjectionOutcome,
  WebhookVersionComparison,
} from "@whatsapp-mcp/db/webhook-event";
import {
  type ConvergenceVersion,
  importWebhookIdentityKey,
  makeWasenderWebhookNormalization,
  type NormalizedWebhookItem,
  type WebhookNormalization,
} from "@whatsapp-mcp/whatsapp-provider/webhook";
import { Context, Data, Effect, Layer, Redacted } from "effect";
import { encodeBase64 } from "./base64-url";
import {
  contactProviderIdentityIndex,
  protectDirectoryContact,
} from "./directory-privacy";
import {
  type EnvelopeEncryption,
  EnvelopeEncryptionService,
} from "./encryption/envelope";
import {
  groupNamePrefixIndexes,
  importGroupDirectoryIndexKey,
} from "./group-privacy";
import {
  importMessageSearchIndexKey,
  messageSearchIndexesForText,
} from "./message-search-privacy";
import { hasExactKeys } from "./record";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";
import { isCanonicalTimestamp } from "./timestamp";
import type { WebhookIngressQueueMessage } from "./webhook-ingress";

export type WebhookEventQueueMessage = WebhookIngressQueueMessage;

export class WebhookEventPersistenceError extends Data.TaggedError(
  "WebhookEventPersistenceError",
) {}

export class WebhookEventObjectStoreError extends Data.TaggedError(
  "WebhookEventObjectStoreError",
) {}

export class WebhookEventNormalizationError extends Data.TaggedError(
  "WebhookEventNormalizationError",
) {}

export class WebhookEventPermanentValidationError extends Data.TaggedError(
  "WebhookEventPermanentValidationError",
) {}

export interface WebhookEventPersistenceService {
  readonly complete: (input: {
    readonly completedAt: string;
    readonly eventId: string;
    readonly personalAccountId: string;
    readonly whatsappConnectionId: string;
  }) => Effect.Effect<void, WebhookEventPersistenceError>;
  readonly deadLetter: (input: {
    readonly ciphertextSha256: string;
    readonly deadLetteredAt: string;
    readonly eventId: string;
    readonly payloadBytes: number;
    readonly personalAccountId: string;
    readonly receivedAt: string;
    readonly whatsappConnectionId: string;
  }) => Effect.Effect<
    DeadLetterWebhookEventResult,
    WebhookEventPersistenceError
  >;
  readonly prepare: (input: {
    readonly ciphertextSha256: string;
    readonly eventId: string;
    readonly payloadBytes: number;
    readonly personalAccountId: string;
    readonly receivedAt: string;
    readonly whatsappConnectionId: string;
  }) => Effect.Effect<
    WebhookEventProcessingMaterial | null,
    WebhookEventPersistenceError
  >;
  readonly projectConnectionState: (
    input: ProjectConnectionStateInput,
    compareVersions: (
      left: string,
      right: string,
    ) => Promise<WebhookVersionComparison>,
  ) => Effect.Effect<
    WebhookItemProjectionOutcome,
    WebhookEventPersistenceError
  >;
  readonly projectGroup: (
    input: ProjectGroupInput,
    protect: (
      recordId: string,
    ) => Promise<import("@whatsapp-mcp/db/group").ProtectedGroupFields>,
    compareVersions: (
      left: string,
      right: string,
    ) => Promise<WebhookVersionComparison>,
  ) => Effect.Effect<
    WebhookItemProjectionOutcome,
    WebhookEventPersistenceError
  >;
  readonly projectDirectoryContact: (
    input: ProjectDirectoryContactInput,
    compareVersions: (
      left: string,
      right: string,
    ) => Promise<WebhookVersionComparison>,
  ) => Effect.Effect<
    WebhookItemProjectionOutcome,
    WebhookEventPersistenceError
  >;
  readonly projectStoredMessage?: (
    input: ProjectStoredMessageInput,
    compareVersions: (
      left: string,
      right: string,
    ) => Promise<WebhookVersionComparison>,
  ) => Effect.Effect<
    WebhookItemProjectionOutcome,
    WebhookEventPersistenceError
  >;
  readonly projectSendEvidence?: (
    input: ProjectSendEvidenceInput,
    materialize?: (
      pending: PendingSendProjection,
    ) => Promise<MaterializedPendingSend>,
  ) => Effect.Effect<
    WebhookItemProjectionOutcome,
    WebhookEventPersistenceError
  >;
  readonly projectStoredMessageEdit?: (
    input: ProjectStoredMessageEditInput,
    compareVersions: (
      left: string,
      right: string,
    ) => Promise<WebhookVersionComparison>,
  ) => Effect.Effect<
    WebhookItemProjectionOutcome,
    WebhookEventPersistenceError
  >;
  readonly projectStoredMessageDeletion?: (
    input: ProjectStoredMessageDeletionInput,
  ) => Effect.Effect<
    WebhookItemProjectionOutcome,
    WebhookEventPersistenceError
  >;
  readonly quarantine: (
    input: QuarantineWebhookItemInput,
  ) => Effect.Effect<void, WebhookEventPersistenceError>;
}

export const WebhookEventPersistence =
  Context.GenericTag<WebhookEventPersistenceService>(
    "@whatsapp-mcp/api/WebhookEventPersistence",
  );

export interface WebhookEventStoredObject {
  readonly body: Uint8Array;
  readonly customMetadata: Readonly<Record<string, string>>;
}

export interface WebhookEventObjectStoreService {
  readonly load: (
    objectId: string,
  ) => Effect.Effect<
    WebhookEventStoredObject | null,
    WebhookEventObjectStoreError
  >;
}

export const WebhookEventObjectStore =
  Context.GenericTag<WebhookEventObjectStoreService>(
    "@whatsapp-mcp/api/WebhookEventObjectStore",
  );

export interface WebhookEventClockService {
  readonly now: Effect.Effect<string>;
}

export const WebhookEventClock = Context.GenericTag<WebhookEventClockService>(
  "@whatsapp-mcp/api/WebhookEventClock",
);

export interface WebhookEventIdentifiersService {
  readonly nextContactId: Effect.Effect<string>;
  readonly nextConversationId?: Effect.Effect<string>;
  readonly nextMessageId?: Effect.Effect<string>;
  readonly nextMediaId?: Effect.Effect<string>;
}

export const WebhookEventIdentifiers =
  Context.GenericTag<WebhookEventIdentifiersService>(
    "@whatsapp-mcp/api/WebhookEventIdentifiers",
  );

export interface WebhookEventRetryScheduleService {
  readonly delaySeconds: (attempt: number) => Effect.Effect<number>;
}

export const WebhookEventRetrySchedule =
  Context.GenericTag<WebhookEventRetryScheduleService>(
    "@whatsapp-mcp/api/WebhookEventRetrySchedule",
  );

export const jitteredWebhookRetryDelaySeconds = (random: number): number =>
  9_900 + Math.floor(Math.min(1, Math.max(0, random)) * 1_800);

export interface WebhookEventNormalizationService {
  readonly make: (
    identityKey: Uint8Array,
  ) => Effect.Effect<WebhookNormalization, WebhookEventNormalizationError>;
}

export const WebhookEventNormalization =
  Context.GenericTag<WebhookEventNormalizationService>(
    "@whatsapp-mcp/api/WebhookEventNormalization",
  );

export const wasenderWebhookEventNormalizationLayer = Layer.succeed(
  WebhookEventNormalization,
  {
    make: (identityKey) =>
      importWebhookIdentityKey(identityKey).pipe(
        Effect.map(makeWasenderWebhookNormalization),
        Effect.mapError(() => new WebhookEventNormalizationError()),
      ),
  },
);

export type WebhookEventRequirements =
  | EnvelopeEncryption
  | SafeTelemetryService
  | WebhookEventClockService
  | WebhookEventIdentifiersService
  | WebhookEventNormalizationService
  | WebhookEventObjectStoreService
  | WebhookEventPersistenceService
  | WebhookEventRetryScheduleService;

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isWebhookEventQueueMessage = (
  value: unknown,
): value is WebhookEventQueueMessage =>
  isRecord(value) &&
  value.version === 1 &&
  uuid(value.object_id) &&
  uuid(value.personal_account_id) &&
  uuid(value.whatsapp_connection_id) &&
  typeof value.ciphertext_sha256 === "string" &&
  /^[a-f0-9]{64}$/u.test(value.ciphertext_sha256) &&
  typeof value.payload_bytes === "number" &&
  Number.isSafeInteger(value.payload_bytes) &&
  value.payload_bytes >= 1 &&
  value.payload_bytes <= 1_048_576 &&
  isCanonicalTimestamp(value.received_at) &&
  hasExactKeys(value, [
    "ciphertext_sha256",
    "object_id",
    "payload_bytes",
    "personal_account_id",
    "received_at",
    "version",
    "whatsapp_connection_id",
  ]);

const sha256Hex = (value: Uint8Array): Effect.Effect<string> =>
  Effect.promise(async () =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  );

const decodeBase64 = (value: unknown): Uint8Array | null => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    return null;
  }
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
};

const parseCiphertext = (
  value: Uint8Array,
): {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly version: 1;
} | null => {
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(value),
    ) as unknown;
    if (
      !isRecord(parsed) ||
      !hasExactKeys(parsed, [
        "ciphertext",
        "key_version",
        "nonce",
        "version",
      ]) ||
      parsed.version !== 1 ||
      typeof parsed.key_version !== "number" ||
      !Number.isSafeInteger(parsed.key_version) ||
      parsed.key_version < 1 ||
      typeof parsed.ciphertext !== "string" ||
      typeof parsed.nonce !== "string" ||
      decodeBase64(parsed.ciphertext) === null ||
      decodeBase64(parsed.nonce)?.byteLength !== 12
    ) {
      return null;
    }
    return {
      ciphertext: parsed.ciphertext,
      keyVersion: parsed.key_version,
      nonce: parsed.nonce,
      version: 1,
    };
  } catch {
    return null;
  }
};

const withZeroedBytes = <Value, Error, Requirements>(
  bytes: Uint8Array,
  use: (value: Uint8Array) => Effect.Effect<Value, Error, Requirements>,
) =>
  Effect.acquireUseRelease(Effect.succeed(bytes), use, (value) =>
    Effect.sync(() => {
      value.fill(0);
    }),
  );

const validateSource = (
  message: WebhookEventQueueMessage,
  source: WebhookEventStoredObject,
) =>
  Effect.gen(function* () {
    const metadata = source.customMetadata;
    const sourceHash = yield* sha256Hex(source.body);
    if (
      metadata.ciphertextSha256 !== message.ciphertext_sha256 ||
      metadata.payloadBytes !== String(message.payload_bytes) ||
      metadata.personalAccountId !== message.personal_account_id ||
      metadata.receivedAt !== message.received_at ||
      metadata.version !== "1" ||
      metadata.whatsappConnectionId !== message.whatsapp_connection_id ||
      !hasExactKeys(metadata, [
        "ciphertextSha256",
        "payloadBytes",
        "personalAccountId",
        "receivedAt",
        "version",
        "whatsappConnectionId",
      ]) ||
      sourceHash !== message.ciphertext_sha256
    ) {
      return yield* Effect.fail(new WebhookEventPermanentValidationError());
    }
    const ciphertext = parseCiphertext(source.body);
    if (ciphertext === null) {
      return yield* Effect.fail(new WebhookEventPermanentValidationError());
    }
    return ciphertext;
  });

const quarantine = (
  message: WebhookEventQueueMessage,
  item: NormalizedWebhookItem,
  classification:
    | QuarantineWebhookItemInput["classification"]
    | "unsupported_projection",
) =>
  Effect.gen(function* () {
    const persistence = yield* WebhookEventPersistence;
    yield* persistence.quarantine({
      classification,
      eventId: message.object_id,
      itemIdentity:
        item.kind === "malformed" || item.kind === "unsupported"
          ? null
          : item.itemIdentity,
      itemIndex: item.itemIndex ?? -1,
      itemKind: item.kind,
      personalAccountId: message.personal_account_id,
      receivedAt: message.received_at,
      whatsappConnectionId: message.whatsapp_connection_id,
    });
  });

interface ProcessingCounts {
  readonly appliedCount: number;
  readonly duplicateCount: number;
  readonly quarantinedCount: number;
  readonly supersededCount: number;
  readonly suppressedCount: number;
}

const emptyCounts = (): ProcessingCounts => ({
  appliedCount: 0,
  duplicateCount: 0,
  quarantinedCount: 0,
  supersededCount: 0,
  suppressedCount: 0,
});

const increment = (
  counts: ProcessingCounts,
  field: keyof ProcessingCounts,
): ProcessingCounts => ({ ...counts, [field]: counts[field] + 1 });

const outcomeField = (
  outcome: WebhookItemProjectionOutcome,
): keyof ProcessingCounts =>
  outcome === "applied"
    ? "appliedCount"
    : outcome === "duplicate"
      ? "duplicateCount"
      : outcome === "suppressed"
        ? "suppressedCount"
        : "supersededCount";

const processItems = (
  message: WebhookEventQueueMessage,
  material: WebhookEventProcessingMaterial,
  normalizer: WebhookNormalization,
  items: ReadonlyArray<NormalizedWebhookItem>,
  indexKey: CryptoKey,
  messageSearchKey: CryptoKey,
) =>
  Effect.gen(function* () {
    const persistence = yield* WebhookEventPersistence;
    const encryption = yield* EnvelopeEncryptionService;
    const identifiers = yield* WebhookEventIdentifiers;
    let counts = emptyCounts();
    for (const item of items) {
      if (item.kind === "malformed" || item.kind === "unsupported") {
        yield* quarantine(message, item, item.classification);
        counts = increment(counts, "quarantinedCount");
        continue;
      }
      if (item.kind === "directory_group") {
        const namePrefixIndexes = item.group.joined
          ? yield* groupNamePrefixIndexes(
              indexKey,
              message.whatsapp_connection_id,
              item.group.displayName,
            )
          : [];
        const outcome = yield* persistence.projectGroup(
          {
            displayName: item.group.displayName,
            eventId: message.object_id,
            evidence: {
              occurredAt: item.evidence.occurredAt,
              version: item.evidence.version,
            },
            groupId: crypto.randomUUID(),
            itemIdentity: item.itemIdentity,
            itemIndex: item.itemIndex,
            joined: item.group.joined,
            locator: item.group.identity,
            namePrefixIndexes,
            personalAccountId: message.personal_account_id,
            providerIdentity: item.group.recipient,
            publicId: makeGroupId(),
            receivedAt: message.received_at,
            whatsappConnectionId: message.whatsapp_connection_id,
          },
          (recordId) =>
            Effect.runPromise(
              Effect.gen(function* () {
                const protect = (purpose: string, plaintext: string) =>
                  encryption.encrypt({
                    accountKey: material.accountKey,
                    connectionKey: material.connectionKey,
                    context: {
                      accountId: message.personal_account_id,
                      connectionId: message.whatsapp_connection_id,
                      entity: "whatsapp-group",
                      fieldOrObjectPurpose: purpose,
                      recordId,
                    },
                    plaintext: new TextEncoder().encode(plaintext),
                  });
                const displayName =
                  item.group.displayName === null
                    ? null
                    : yield* protect("display-name", item.group.displayName);
                const providerIdentity = yield* protect(
                  "provider-identity",
                  item.group.recipient,
                );
                return {
                  displayName:
                    displayName === null
                      ? null
                      : {
                          ciphertext: decodeBase64(
                            displayName.ciphertext,
                          ) as Uint8Array,
                          keyVersion: displayName.keyVersion,
                          nonce: decodeBase64(displayName.nonce) as Uint8Array,
                          version: displayName.version,
                        },
                  providerIdentity: {
                    ciphertext: decodeBase64(
                      providerIdentity.ciphertext,
                    ) as Uint8Array,
                    keyVersion: providerIdentity.keyVersion,
                    nonce: decodeBase64(providerIdentity.nonce) as Uint8Array,
                    version: providerIdentity.version,
                  },
                };
              }),
            ),
          (left, right) =>
            Effect.runPromise(
              normalizer.compareVersions({
                left: left as ConvergenceVersion,
                right: right as ConvergenceVersion,
              }),
            ),
        );
        counts = increment(counts, outcomeField(outcome));
        continue;
      }
      if (item.kind === "directory_contact") {
        const protectedContact = yield* protectDirectoryContact({
          accountKey: material.accountKey,
          connectionKey: material.connectionKey,
          contact: item.contact,
          encryption,
          indexKey,
        });
        const outcome = yield* persistence.projectDirectoryContact(
          {
            ...protectedContact,
            active: item.contact.active,
            eventId: message.object_id,
            evidence: {
              occurredAt: item.evidence.occurredAt,
              version: item.evidence.version,
            },
            itemIdentity: item.itemIdentity,
            itemIndex: item.itemIndex,
            personalAccountId: message.personal_account_id,
            publicId: yield* identifiers.nextContactId,
            receivedAt: message.received_at,
            whatsappConnectionId: message.whatsapp_connection_id,
          },
          (left, right) =>
            Effect.runPromise(
              normalizer.compareVersions({
                left: left as ConvergenceVersion,
                right: right as ConvergenceVersion,
              }),
            ),
        );
        counts = increment(counts, outcomeField(outcome));
        continue;
      }
      if (item.kind === "message_edit") {
        const messageSearchTokens = yield* messageSearchIndexesForText(
          messageSearchKey,
          message.whatsapp_connection_id,
          item.content.text ?? "",
        );
        const plaintext = new TextEncoder().encode(
          JSON.stringify({
            text: item.content.text,
            mediaSource:
              item.content.mediaSource === null
                ? null
                : Redacted.value(item.content.mediaSource),
          }),
        );
        const protectedContent = yield* Effect.acquireUseRelease(
          Effect.succeed(plaintext),
          (bytes) =>
            encryption.encrypt({
              accountKey: material.accountKey,
              connectionKey: material.connectionKey,
              context: {
                accountId: message.personal_account_id,
                connectionId: message.whatsapp_connection_id,
                entity: "stored-message",
                fieldOrObjectPurpose: "content",
                recordId: item.messageIdentity,
              },
              plaintext: bytes,
            }),
          (bytes) => Effect.sync(() => bytes.fill(0)),
        );
        if (persistence.projectStoredMessageEdit === undefined)
          return yield* Effect.fail(new WebhookEventPersistenceError());
        const outcome = yield* persistence.projectStoredMessageEdit(
          {
            content: protectedContent,
            contentType: item.content.type,
            editedAt: item.editedAt,
            eventId: message.object_id,
            evidence: {
              occurredAt: item.evidence.occurredAt,
              version: item.evidence.version,
            },
            itemIdentity: item.itemIdentity,
            itemIndex: item.itemIndex,
            messageIdentity: item.messageIdentity,
            messageSearch: { indexVersion: 1, tokens: messageSearchTokens },
            personalAccountId: message.personal_account_id,
            receivedAt: message.received_at,
            whatsappConnectionId: message.whatsapp_connection_id,
          },
          (left, right) =>
            Effect.runPromise(
              normalizer.compareVersions({
                left: left as ConvergenceVersion,
                right: right as ConvergenceVersion,
              }),
            ),
        );
        counts = increment(counts, outcomeField(outcome));
        continue;
      }
      if (item.kind === "message_delete") {
        if (
          item.recipient === undefined ||
          item.direction === undefined ||
          item.sentAt === undefined
        ) {
          yield* quarantine(message, item, "unsupported_projection");
          counts = increment(counts, "quarantinedCount");
          continue;
        }
        const recipientKind = item.recipientKind ?? "direct";
        const recipientLocator =
          recipientKind === "group"
            ? item.recipient
            : yield* contactProviderIdentityIndex(
                indexKey,
                message.whatsapp_connection_id,
                item.recipient,
              );
        if (persistence.projectStoredMessageDeletion === undefined)
          return yield* Effect.fail(new WebhookEventPersistenceError());
        const outcome = yield* persistence.projectStoredMessageDeletion({
          conversationId: crypto.randomUUID(),
          conversationPublicId: yield* identifiers.nextConversationId ??
            Effect.sync(() => makeConversationId()),
          deletedAt: item.deletedAt,
          direction: item.direction,
          eventId: message.object_id,
          evidence: {
            occurredAt: item.evidence.occurredAt,
            version: item.evidence.version,
          },
          itemIdentity: item.itemIdentity,
          itemIndex: item.itemIndex,
          messageId: crypto.randomUUID(),
          messageIdentity: item.messageIdentity,
          messagePublicId: yield* identifiers.nextMessageId ??
            Effect.sync(() => makeMessageId()),
          personalAccountId: message.personal_account_id,
          receivedAt: message.received_at,
          recipientKind,
          recipientLocator,
          recipientPublicId:
            recipientKind === "group" ? makeGroupId() : makeContactId(),
          sentAt: item.sentAt,
          whatsappConnectionId: message.whatsapp_connection_id,
        });
        counts = increment(counts, outcomeField(outcome));
        continue;
      }
      if (item.kind === "message_upsert") {
        const messageSearchTokens = yield* messageSearchIndexesForText(
          messageSearchKey,
          message.whatsapp_connection_id,
          item.content.text ?? "",
        );
        const recipientKind = item.recipientKind ?? "direct";
        const recipientLocator =
          recipientKind === "group"
            ? item.recipient
            : yield* contactProviderIdentityIndex(
                indexKey,
                message.whatsapp_connection_id,
                item.recipient,
              );
        const conversationPublicId = yield* identifiers.nextConversationId ??
          Effect.sync(() => makeConversationId());
        const messagePublicId = yield* identifiers.nextMessageId ??
          Effect.sync(() => makeMessageId());
        const mediaId =
          item.content.mediaSource === null ? null : crypto.randomUUID();
        const mediaPublicId =
          item.content.mediaSource === null
            ? null
            : yield* identifiers.nextMediaId ??
                Effect.sync(() => makeMediaId());
        const protectedMediaSource =
          item.content.mediaSource === null || mediaId === null
            ? null
            : yield* encryption.encrypt({
                accountKey: material.accountKey,
                connectionKey: material.connectionKey,
                context: {
                  accountId: message.personal_account_id,
                  connectionId: message.whatsapp_connection_id,
                  entity: "stored-media",
                  fieldOrObjectPurpose: "provider-source",
                  recordId: mediaId,
                },
                plaintext: new TextEncoder().encode(
                  Redacted.value(item.content.mediaSource),
                ),
              });
        const plaintext = new TextEncoder().encode(
          JSON.stringify({
            text: item.content.text,
            mediaSource:
              item.content.mediaSource === null
                ? null
                : Redacted.value(item.content.mediaSource),
          }),
        );
        const protectedContent = yield* Effect.acquireUseRelease(
          Effect.succeed(plaintext),
          (bytes) =>
            encryption.encrypt({
              accountKey: material.accountKey,
              connectionKey: material.connectionKey,
              context: {
                accountId: message.personal_account_id,
                connectionId: message.whatsapp_connection_id,
                entity: "stored-message",
                fieldOrObjectPurpose: "content",
                recordId: item.messageIdentity,
              },
              plaintext: bytes,
            }),
          (bytes) => Effect.sync(() => bytes.fill(0)),
        );
        const senderContact = item.senderContact;
        const protectedSenderContact =
          senderContact === null
            ? null
            : yield* protectDirectoryContact({
                accountKey: material.accountKey,
                connectionKey: material.connectionKey,
                contact: {
                  active: true,
                  displayName:
                    senderContact.displayName === null
                      ? null
                      : Redacted.value(senderContact.displayName),
                  identity: senderContact.identity,
                  phoneNumber:
                    senderContact.phoneNumber === null
                      ? null
                      : Redacted.value(senderContact.phoneNumber),
                  recipient: senderContact.recipient,
                },
                encryption,
                indexKey,
              });
        if (persistence.projectStoredMessage === undefined) {
          return yield* Effect.fail(new WebhookEventPersistenceError());
        }
        const outcome = yield* persistence.projectStoredMessage(
          {
            content: protectedContent,
            contentType: item.content.type,
            conversationId: crypto.randomUUID(),
            conversationPublicId,
            direction: item.direction,
            eventId: message.object_id,
            evidence: {
              occurredAt: item.evidence.occurredAt,
              version: item.evidence.version,
            },
            itemIdentity: item.itemIdentity,
            itemIndex: item.itemIndex,
            messageId: crypto.randomUUID(),
            messageIdentity: item.messageIdentity,
            messagePublicId,
            messageSearch: { indexVersion: 1, tokens: messageSearchTokens },
            media:
              mediaId === null ||
              mediaPublicId === null ||
              protectedMediaSource === null
                ? null
                : {
                    id: mediaId,
                    publicId: mediaPublicId,
                    source: protectedMediaSource,
                  },
            personalAccountId: message.personal_account_id,
            receivedAt: message.received_at,
            recipientKind,
            recipientLocator,
            recipientPublicId:
              recipientKind === "group" ? makeGroupId() : makeContactId(),
            sentAt: item.sentAt,
            whatsappConnectionId: message.whatsapp_connection_id,
          },
          (left, right) =>
            Effect.runPromise(
              normalizer.compareVersions({
                left: left as ConvergenceVersion,
                right: right as ConvergenceVersion,
              }),
            ),
        );
        if (protectedSenderContact !== null && senderContact !== null) {
          yield* persistence.projectDirectoryContact(
            {
              ...protectedSenderContact,
              active: true,
              eventId: message.object_id,
              evidence: {
                occurredAt: item.evidence.occurredAt,
                version: item.evidence.version,
              },
              insertOnly: true,
              itemIdentity: senderContact.itemIdentity,
              itemIndex: item.itemIndex,
              personalAccountId: message.personal_account_id,
              publicId: yield* identifiers.nextContactId,
              receivedAt: message.received_at,
              whatsappConnectionId: message.whatsapp_connection_id,
            },
            (left, right) =>
              Effect.runPromise(
                normalizer.compareVersions({
                  left: left as ConvergenceVersion,
                  right: right as ConvergenceVersion,
                }),
              ),
          );
        }
        counts = increment(counts, outcomeField(outcome));
        continue;
      }
      if (item.kind === "send_evidence") {
        if (persistence.projectSendEvidence === undefined)
          return yield* Effect.fail(new WebhookEventPersistenceError());
        const storedIdentifiers = {
          conversationId: crypto.randomUUID(),
          conversationPublicId: yield* identifiers.nextConversationId ??
            Effect.sync(() => makeConversationId()),
          messageId: crypto.randomUUID(),
          messagePublicId: yield* identifiers.nextMessageId ??
            Effect.sync(() => makeMessageId()),
        };
        const outcome = yield* persistence.projectSendEvidence(
          {
            eventId: message.object_id,
            evidence: item.evidence,
            itemIdentity: item.itemIdentity,
            itemIndex: item.itemIndex,
            messageIdentity: item.messageIdentity,
            personalAccountId: message.personal_account_id,
            receivedAt: message.received_at,
            status: item.status,
            whatsappConnectionId: message.whatsapp_connection_id,
          },
          async (pending) => {
            const plaintext = await Effect.runPromise(
              encryption.decrypt({
                accountKey: material.accountKey,
                connectionKey: material.connectionKey,
                ciphertext: {
                  ciphertext: encodeBase64(pending.ciphertext),
                  keyVersion: pending.keyVersion,
                  nonce: encodeBase64(pending.nonce),
                  version: 1,
                },
                context: {
                  accountId: message.personal_account_id,
                  connectionId: message.whatsapp_connection_id,
                  entity: "send-operation",
                  fieldOrObjectPurpose: "pending-send-content",
                  recordId: pending.sendId,
                },
              }),
            );
            try {
              const text = new TextDecoder("utf-8", {
                fatal: true,
                ignoreBOM: false,
              }).decode(plaintext);
              const messageSearchTokens = await Effect.runPromise(
                messageSearchIndexesForText(
                  messageSearchKey,
                  message.whatsapp_connection_id,
                  text,
                ),
              );
              const content = new TextEncoder().encode(
                JSON.stringify({ mediaSource: null, text }),
              );
              try {
                return {
                  ...storedIdentifiers,
                  messageSearch: {
                    indexVersion: 1 as const,
                    tokens: messageSearchTokens,
                  },
                  content: await Effect.runPromise(
                    encryption.encrypt({
                      accountKey: material.accountKey,
                      connectionKey: material.connectionKey,
                      context: {
                        accountId: message.personal_account_id,
                        connectionId: message.whatsapp_connection_id,
                        entity: "stored-message",
                        fieldOrObjectPurpose: "content",
                        recordId: item.messageIdentity,
                      },
                      plaintext: content,
                    }),
                  ),
                };
              } finally {
                content.fill(0);
              }
            } finally {
              plaintext.fill(0);
            }
          },
        );
        counts = increment(counts, outcomeField(outcome));
        continue;
      }
      if (item.kind !== "connection_state") {
        yield* quarantine(message, item, "unsupported_projection");
        counts = increment(counts, "quarantinedCount");
        continue;
      }
      const outcome = yield* persistence.projectConnectionState(
        {
          eventId: message.object_id,
          evidence: {
            occurredAt: item.evidence.occurredAt,
            version: item.evidence.version,
          },
          itemIdentity: item.itemIdentity,
          itemIndex: item.itemIndex,
          personalAccountId: message.personal_account_id,
          receivedAt: message.received_at,
          state: item.state,
          whatsappConnectionId: message.whatsapp_connection_id,
        },
        (left, right) =>
          Effect.runPromise(
            normalizer.compareVersions({
              left: left as ConvergenceVersion,
              right: right as ConvergenceVersion,
            }),
          ),
      );
      counts = increment(counts, outcomeField(outcome));
    }
    return counts;
  });

const processMessage = (message: WebhookEventQueueMessage) =>
  Effect.gen(function* () {
    const objects = yield* WebhookEventObjectStore;
    const source = yield* objects.load(message.object_id);
    if (source === null) {
      return yield* Effect.fail(new WebhookEventObjectStoreError());
    }
    const sourceCiphertext = yield* validateSource(message, source);
    const persistence = yield* WebhookEventPersistence;
    const material = yield* persistence.prepare({
      ciphertextSha256: message.ciphertext_sha256,
      eventId: message.object_id,
      payloadBytes: message.payload_bytes,
      personalAccountId: message.personal_account_id,
      receivedAt: message.received_at,
      whatsappConnectionId: message.whatsapp_connection_id,
    });
    if (material === null) {
      return yield* Effect.fail(new WebhookEventPersistenceError());
    }
    const encryption = yield* EnvelopeEncryptionService;
    const payload = yield* encryption.decrypt({
      accountKey: material.accountKey,
      ciphertext: sourceCiphertext,
      connectionKey: material.connectionKey,
      context: {
        accountId: message.personal_account_id,
        connectionId: message.whatsapp_connection_id,
        entity: "webhook-event",
        fieldOrObjectPurpose: "original-request",
        recordId: message.object_id,
      },
    });
    return yield* withZeroedBytes(payload, (payloadBytes) =>
      Effect.gen(function* () {
        if (payloadBytes.byteLength !== message.payload_bytes) {
          return yield* Effect.fail(new WebhookEventPermanentValidationError());
        }
        const identityKey = yield* encryption.decrypt({
          accountKey: material.accountKey,
          ciphertext: material.identityKey,
          connectionKey: material.connectionKey,
          context: {
            accountId: message.personal_account_id,
            connectionId: message.whatsapp_connection_id,
            entity: "whatsapp-connection",
            fieldOrObjectPurpose: "webhook-identity-key",
            recordId: message.whatsapp_connection_id,
          },
        });
        return yield* withZeroedBytes(identityKey, (identityKeyBytes) =>
          Effect.gen(function* () {
            const normalization = yield* WebhookEventNormalization;
            const normalizer = yield* normalization.make(identityKeyBytes);
            const indexKey =
              yield* importGroupDirectoryIndexKey(identityKeyBytes);
            const delivery = yield* normalizer.normalize({
              payload: payloadBytes,
              receivedAt: message.received_at,
            });
            const messageSearchKeyBytes = yield* encryption.decrypt({
              accountKey: material.accountKey,
              ciphertext: material.messageSearchKey,
              connectionKey: material.connectionKey,
              context: {
                accountId: message.personal_account_id,
                connectionId: message.whatsapp_connection_id,
                entity: "whatsapp-connection",
                fieldOrObjectPurpose: "message-search-key",
                recordId: message.whatsapp_connection_id,
              },
            });
            const counts = yield* withZeroedBytes(
              messageSearchKeyBytes,
              (searchKeyBytes) =>
                Effect.gen(function* () {
                  const messageSearchKey =
                    yield* importMessageSearchIndexKey(searchKeyBytes);
                  return yield* processItems(
                    message,
                    material,
                    normalizer,
                    delivery.items,
                    indexKey,
                    messageSearchKey,
                  );
                }),
            );
            const clock = yield* WebhookEventClock;
            yield* persistence.complete({
              completedAt: yield* clock.now,
              eventId: message.object_id,
              personalAccountId: message.personal_account_id,
              whatsappConnectionId: message.whatsapp_connection_id,
            });
            return counts;
          }),
        );
      }),
    );
  });

const emit = (
  counts: ProcessingCounts,
  outcome: "completed" | "invalid_message" | "retry",
) =>
  Effect.gen(function* () {
    const telemetry = yield* SafeTelemetry;
    yield* telemetry.emit({
      ...counts,
      event: "webhook_event.processing.completed",
      outcome,
      service: "api",
    });
  });

export const handleWebhookEventBatch = (
  batch: MessageBatch,
  layer: Layer.Layer<WebhookEventRequirements, unknown>,
): Promise<void> =>
  Effect.runPromise(
    Effect.forEach(
      batch.messages,
      (queued) => {
        const message = queued.body;
        if (!isWebhookEventQueueMessage(message)) {
          return emit(emptyCounts(), "invalid_message").pipe(
            Effect.tap(() => Effect.sync(() => queued.ack())),
          );
        }
        return processMessage(message).pipe(
          Effect.flatMap((counts) => emit(counts, "completed")),
          Effect.tap(() => Effect.sync(() => queued.ack())),
          Effect.catchTag("WebhookEventPermanentValidationError", () =>
            recordDeadLetter(message).pipe(
              Effect.flatMap(emitDeadLetter),
              Effect.tap(() => Effect.sync(() => queued.ack())),
            ),
          ),
          Effect.catchAll(() =>
            Effect.gen(function* () {
              const schedule = yield* WebhookEventRetrySchedule;
              const delaySeconds = yield* schedule.delaySeconds(
                queued.attempts,
              );
              yield* emit(emptyCounts(), "retry");
              yield* Effect.sync(() => queued.retry({ delaySeconds }));
            }),
          ),
        );
      },
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.provide(layer)),
  );

const emitDeadLetter = (
  result:
    | DeadLetterWebhookEventResult
    | { readonly outcome: "invalid_message" },
) =>
  Effect.gen(function* () {
    const telemetry = yield* SafeTelemetry;
    yield* telemetry.emit({
      event: "webhook_event.dead_letter.completed",
      incidentReference:
        "incidentReference" in result ? result.incidentReference : null,
      outcome: result.outcome,
      service: "api",
    });
  });

const recordDeadLetter = (message: WebhookEventQueueMessage) =>
  Effect.gen(function* () {
    const persistence = yield* WebhookEventPersistence;
    const clock = yield* WebhookEventClock;
    return yield* persistence.deadLetter({
      ciphertextSha256: message.ciphertext_sha256,
      deadLetteredAt: yield* clock.now,
      eventId: message.object_id,
      payloadBytes: message.payload_bytes,
      personalAccountId: message.personal_account_id,
      receivedAt: message.received_at,
      whatsappConnectionId: message.whatsapp_connection_id,
    });
  });

export const handleWebhookDeadLetterBatch = (
  batch: MessageBatch,
  layer: Layer.Layer<WebhookEventRequirements, unknown>,
): Promise<void> =>
  Effect.runPromise(
    Effect.forEach(
      batch.messages,
      (queued) => {
        const message = queued.body;
        const work = !isWebhookEventQueueMessage(message)
          ? emitDeadLetter({ outcome: "invalid_message" })
          : Effect.gen(function* () {
              const outcome = yield* recordDeadLetter(message);
              yield* emitDeadLetter(outcome);
            });
        return work.pipe(
          Effect.tap(() => Effect.sync(() => queued.ack())),
          Effect.catchAll(() =>
            Effect.sync(() => queued.retry({ delaySeconds: 300 })),
          ),
        );
      },
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.provide(layer)),
  );
