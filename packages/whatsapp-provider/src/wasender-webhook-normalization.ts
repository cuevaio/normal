import { Data, Effect, Either, Encoding, Layer, Redacted } from "effect";
import type { ProviderNeutralFailure, UtcTimestamp } from "./common";
import type { LifecycleConnectionState } from "./control";
import { makeEncryptedMediaSource } from "./media-source";
import {
  deriveIdentityRecipientRouteKeys,
  sealIdentityRecipientRoute,
} from "./recipient-route";
import type {
  ContactLocator,
  GroupLocator,
  IdentityBearingSendStatus,
  RecipientLocator,
  StableMessageIdentity,
} from "./session";
import {
  type ConvergenceEvidence,
  type ConvergenceVersion,
  type ConvergenceVersionComparison,
  type MalformedWebhookItem,
  type NormalizedContentType,
  type NormalizedMessageContent,
  type NormalizedWebhookDelivery,
  type NormalizedWebhookItem,
  type WebhookItemIdentity,
  WebhookNormalization,
  webhookNormalizationPolicy,
} from "./webhook";

type JsonRecord = Record<string, unknown>;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: false,
});

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): JsonRecord | null =>
  isRecord(value) ? value : null;

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const asIdentity = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.trim() === value
    ? value
    : null;

const firstString = (...values: ReadonlyArray<unknown>): string | null => {
  for (const value of values) {
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
};

const canonicalJson = (value: unknown): string => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Cannot canonicalize a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Cannot canonicalize this value");
};

const providerFailure = (
  code: ProviderNeutralFailure["code"],
  retryDecision: Extract<
    ProviderNeutralFailure,
    { readonly operation: "webhook-normalization" }
  >["retryDecision"],
): ProviderNeutralFailure => ({
  _tag: "ProviderNeutralFailure",
  code,
  operation: "webhook-normalization",
  retryAfterMs: null,
  retryDecision,
});

export class WebhookIdentityKeyError extends Data.TaggedError(
  "WebhookIdentityKeyError",
)<{
  readonly cause: unknown;
}> {}

export const importWebhookIdentityKey = (
  secret: Uint8Array,
): Effect.Effect<CryptoKey, WebhookIdentityKeyError> => {
  if (secret.byteLength < 32) {
    return Effect.fail(
      new WebhookIdentityKeyError({
        cause: new Error(
          "Webhook identity keys must contain at least 32 bytes",
        ),
      }),
    );
  }

  return Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        "raw",
        secret,
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["sign", "verify"],
      ),
    catch: (cause) => new WebhookIdentityKeyError({ cause }),
  });
};

const sign = async (key: CryptoKey, namespace: string, value: unknown) =>
  new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      textEncoder.encode(`${namespace}\0${canonicalJson(value)}`),
    ),
  );

const makeIdentity = async (
  key: CryptoKey,
  namespace: string,
  value: unknown,
): Promise<string> =>
  `wi1_${Encoding.encodeBase64Url(await sign(key, namespace, value))}`;

const makeSenderRecipientRoute = async (
  key: CryptoKey,
  providerIdentifier: string,
): Promise<ContactLocator> =>
  (await sealIdentityRecipientRoute(
    await deriveIdentityRecipientRouteKeys(key),
    "contact",
    providerIdentifier,
  )) as ContactLocator;

interface ParsedTimestamp {
  readonly epochMilliseconds: number;
  readonly timestamp: UtcTimestamp;
}

const parseTimestamp = (value: unknown): ParsedTimestamp | null => {
  let epochMilliseconds: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) {
    epochMilliseconds =
      Math.abs(value) < 100_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      epochMilliseconds =
        Math.abs(numeric) < 100_000_000_000 ? numeric * 1_000 : numeric;
    } else {
      const parsed = Date.parse(value);
      epochMilliseconds = Number.isFinite(parsed) ? parsed : null;
    }
  }

  if (
    epochMilliseconds === null ||
    !Number.isSafeInteger(epochMilliseconds) ||
    epochMilliseconds < 0
  ) {
    return null;
  }

  const date = new Date(epochMilliseconds);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  return {
    epochMilliseconds,
    timestamp: date.toISOString(),
  };
};

const firstTimestamp = (...values: ReadonlyArray<unknown>) => {
  for (const value of values) {
    const parsed = parseTimestamp(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
};

const makeVersion = async (
  key: CryptoKey,
  epochMilliseconds: number,
): Promise<ConvergenceVersion> => {
  const payload = canonicalJson({ epochMilliseconds, version: 1 });
  const signature = await sign(key, "convergence-version", payload);
  return `wv1.${Encoding.encodeBase64Url(payload)}.${Encoding.encodeBase64Url(
    signature,
  )}` as ConvergenceVersion;
};

const parseVersion = (
  value: string,
): {
  readonly epochMilliseconds: number;
  readonly payload: string;
  readonly signature: Uint8Array;
} | null => {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "wv1" || !parts[1] || !parts[2]) {
    return null;
  }
  try {
    const payload = Either.getOrThrow(Encoding.decodeBase64UrlString(parts[1]));
    const decoded = JSON.parse(payload) as unknown;
    if (
      !isRecord(decoded) ||
      decoded.version !== 1 ||
      !Number.isSafeInteger(decoded.epochMilliseconds) ||
      (decoded.epochMilliseconds as number) < 0 ||
      canonicalJson(decoded) !== payload
    ) {
      return null;
    }
    const signature = Either.getOrThrow(Encoding.decodeBase64Url(parts[2]));
    if (Encoding.encodeBase64Url(signature) !== parts[2]) {
      return null;
    }
    return {
      epochMilliseconds: decoded.epochMilliseconds as number,
      payload,
      signature,
    };
  } catch {
    return null;
  }
};

const compareVersions = async (
  key: CryptoKey,
  leftValue: ConvergenceVersion,
  rightValue: ConvergenceVersion,
): Promise<ConvergenceVersionComparison> => {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  if (left === null || right === null) {
    return "incomparable";
  }
  const [leftValid, rightValid] = await Promise.all(
    [left, right].map((version) =>
      crypto.subtle.verify(
        "HMAC",
        key,
        version.signature,
        textEncoder.encode(
          `convergence-version\0${canonicalJson(version.payload)}`,
        ),
      ),
    ),
  );
  if (!leftValid || !rightValid) {
    return "incomparable";
  }
  if (left.epochMilliseconds === right.epochMilliseconds) {
    return "equal";
  }
  return left.epochMilliseconds < right.epochMilliseconds ? "before" : "after";
};

const makeEvidence = async (
  key: CryptoKey,
  occurrence: ParsedTimestamp | null,
): Promise<ConvergenceEvidence> => ({
  occurredAt: occurrence?.timestamp ?? null,
  version:
    occurrence === null
      ? null
      : await makeVersion(key, occurrence.epochMilliseconds),
});

const malformed = (
  itemIndex: number | null,
  classification: MalformedWebhookItem["classification"] = "invalid_item_shape",
): MalformedWebhookItem => ({ classification, itemIndex, kind: "malformed" });

const unsupported = (itemIndex: number): NormalizedWebhookItem => ({
  classification: "unsupported_item_kind",
  itemIndex,
  kind: "unsupported",
});

const logicalItems = (value: unknown): ReadonlyArray<unknown> | null =>
  Array.isArray(value) ? value : isRecord(value) ? [value] : null;

const isGroup = (jid: string): boolean => jid.endsWith("@g.us");

const phoneNumberDigits = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^\+?([1-9]\d{6,14})(?:@s\.whatsapp\.net)?$/.exec(value);
  return match?.[1] ?? null;
};

const isSupportedConversation = (jid: string): boolean =>
  phoneNumberDigits(jid) !== null ||
  /^[^\s@]+@g\.us$/.test(jid) ||
  /^\d+@lid$/.test(jid);

const phoneNumberFrom = (...values: ReadonlyArray<unknown>): string | null => {
  for (const value of values) {
    const digits = phoneNumberDigits(value);
    if (digits !== null) {
      return `+${digits}`;
    }
  }
  return null;
};

const contactPhoneNumber = (contact: JsonRecord, jid: string): string | null =>
  phoneNumberFrom(
    contact.phoneNumber,
    jid.includes("@") && !jid.endsWith("@s.whatsapp.net") ? null : jid,
  );

const canonicalContactIdentity = (raw: string): string => {
  const digits = phoneNumberDigits(raw);
  return digits === null ? raw : `pn:${digits}`;
};

const makeRecipient = async (
  key: CryptoKey,
  raw: string,
): Promise<RecipientLocator> =>
  (await makeIdentity(
    key,
    isGroup(raw) ? "group-recipient" : "contact-recipient",
    isGroup(raw) ? raw : canonicalContactIdentity(raw),
  )) as RecipientLocator;

const makeContact = async (
  key: CryptoKey,
  raw: string,
): Promise<ContactLocator> =>
  (await makeIdentity(
    key,
    "contact-recipient",
    canonicalContactIdentity(raw),
  )) as ContactLocator;

const senderPhoneNumber = (raw: string): string | null => {
  const digits = phoneNumberDigits(raw);
  return digits !== null && /^[1-9]\d{6,14}$/u.test(digits)
    ? `+${digits}`
    : null;
};

const senderDisplayName = (record: JsonRecord): string | null => {
  const value = firstString(record.pushName, record.notify);
  if (value === null) return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 4_096
    ? normalized
    : null;
};

const makeGroup = async (key: CryptoKey, raw: string): Promise<GroupLocator> =>
  (await makeIdentity(key, "group-recipient", raw)) as GroupLocator;

const makeMessageIdentity = async (
  key: CryptoKey,
  rawId: string,
): Promise<StableMessageIdentity> =>
  (await makeIdentity(key, "message-identity", rawId)) as StableMessageIdentity;

const messageContainer = (record: JsonRecord): JsonRecord | null =>
  asRecord(record.message);

const extractContent = (
  rawMessage: unknown,
  messageBody: unknown = null,
  mediaMessageEnvelope: unknown = null,
): NormalizedMessageContent | null => {
  const message = asRecord(rawMessage) ?? {};
  const mediaKinds: ReadonlyArray<readonly [string, NormalizedContentType]> = [
    ["imageMessage", "image"],
    ["audioMessage", "audio"],
    ["videoMessage", "video"],
    ["documentMessage", "document"],
    ["stickerMessage", "sticker"],
  ];
  for (const [field, type] of mediaKinds) {
    const media = asRecord(message[field]);
    if (media !== null) {
      try {
        canonicalJson(media);
        return {
          mediaSource:
            mediaMessageEnvelope === null
              ? null
              : makeEncryptedMediaSource(mediaMessageEnvelope),
          text: firstString(messageBody, media.caption),
          type,
        };
      } catch {
        return null;
      }
    }
  }

  const text = firstString(
    messageBody,
    message.conversation,
    asRecord(message.extendedTextMessage)?.text,
  );
  return {
    mediaSource: null,
    text,
    type: text === null ? "unknown" : "text",
  };
};

const normalizeMessage = async (
  key: CryptoKey,
  value: unknown,
  itemIndex: number,
  envelopeOccurrence: ParsedTimestamp | null,
  receivedAt: UtcTimestamp,
): Promise<NormalizedWebhookItem> => {
  const record = asRecord(value);
  if (record === null) {
    return malformed(itemIndex);
  }
  const keyRecord = asRecord(record.key);
  const remoteJid = asIdentity(keyRecord?.remoteJid);
  const message = messageContainer(record);
  const protocol = asRecord(message?.protocolMessage);

  if (protocol?.type === 14 || isRecord(protocol?.editedMessage)) {
    const targetKey = asRecord(protocol?.key);
    const targetId = asIdentity(targetKey?.id);
    if (targetId === null) {
      return malformed(itemIndex, "missing_required_identity");
    }
    const targetRemoteJid = asIdentity(
      firstString(targetKey?.remoteJid, remoteJid),
    );
    if (targetRemoteJid !== null && !isSupportedConversation(targetRemoteJid)) {
      return unsupported(itemIndex);
    }
    const editedMessage = asRecord(protocol.editedMessage);
    if (editedMessage === null) {
      return malformed(itemIndex);
    }
    const occurrence = firstTimestamp(
      protocol.timestampMs,
      record.messageTimestamp,
      envelopeOccurrence?.epochMilliseconds,
    );
    const editedAt = occurrence?.timestamp ?? receivedAt;
    const content = extractContent(editedMessage, null, {
      key: targetKey,
      message: editedMessage,
    });
    if (
      content === null ||
      (content.text === null && content.mediaSource === null)
    ) {
      return malformed(itemIndex);
    }
    return {
      content,
      editedAt,
      evidence: await makeEvidence(key, occurrence),
      itemIdentity: (await makeIdentity(key, "item:message-edit", [
        targetId,
        occurrence?.epochMilliseconds ?? null,
        content.type,
        content.text,
        content.mediaSource === null
          ? null
          : Redacted.value(content.mediaSource),
      ])) as WebhookItemIdentity,
      itemIndex,
      kind: "message_edit",
      messageIdentity: await makeMessageIdentity(key, targetId),
    };
  }

  const rawId = asIdentity(keyRecord?.id);
  if (rawId === null || remoteJid === null) {
    return malformed(itemIndex, "missing_required_identity");
  }
  if (typeof keyRecord?.fromMe !== "boolean") {
    return malformed(itemIndex);
  }
  if (!isSupportedConversation(remoteJid)) {
    return unsupported(itemIndex);
  }
  const occurrence = firstTimestamp(
    record.messageTimestamp,
    envelopeOccurrence?.epochMilliseconds,
  );
  const sentAt = occurrence?.timestamp ?? receivedAt;
  const direction = keyRecord?.fromMe === true ? "outbound" : "inbound";
  const senderRaw =
    direction === "inbound"
      ? isGroup(remoteJid)
        ? firstString(
            keyRecord?.cleanedParticipantPn,
            keyRecord?.participantPn,
            keyRecord?.participant,
            keyRecord?.participantLid,
          )
        : firstString(
            keyRecord?.cleanedSenderPn,
            keyRecord?.senderPn,
            keyRecord?.senderLid,
            remoteJid,
          )
      : null;
  const content = extractContent(record.message, record.messageBody, {
    key: keyRecord,
    message: record.message,
  });
  if (content === null) {
    return malformed(itemIndex);
  }
  if (content.type === "unknown") {
    return unsupported(itemIndex);
  }
  const sender = senderRaw === null ? null : await makeContact(key, senderRaw);
  const senderName = senderDisplayName(record);
  const senderPhone = senderRaw === null ? null : senderPhoneNumber(senderRaw);
  const recipient = await makeRecipient(
    key,
    direction === "inbound" && !isGroup(remoteJid) && senderRaw !== null
      ? senderRaw
      : remoteJid,
  );
  return {
    content,
    direction,
    evidence: await makeEvidence(key, occurrence),
    itemIdentity: (await makeIdentity(
      key,
      "item:message-upsert",
      rawId,
    )) as WebhookItemIdentity,
    itemIndex,
    kind: "message_upsert",
    messageIdentity: await makeMessageIdentity(key, rawId),
    recipient,
    recipientKind: isGroup(remoteJid) ? "group" : "direct",
    sender,
    senderContact:
      senderRaw === null || sender === null
        ? null
        : {
            displayName: senderName === null ? null : Redacted.make(senderName),
            identity: sender,
            itemIdentity: (await makeIdentity(
              key,
              "item:message-sender-contact",
              rawId,
            )) as WebhookItemIdentity,
            phoneNumber:
              senderPhone === null ? null : Redacted.make(senderPhone),
            recipient: await makeSenderRecipientRoute(key, senderRaw),
          },
    sentAt,
  };
};

const normalizeMessages = async (
  key: CryptoKey,
  data: unknown,
  envelopeOccurrence: ParsedTimestamp | null,
  receivedAt: UtcTimestamp,
): Promise<ReadonlyArray<NormalizedWebhookItem>> => {
  const dataRecord = asRecord(data);
  const values = logicalItems(dataRecord?.messages);
  if (values === null) {
    return [malformed(null)];
  }
  return Promise.all(
    values.map((value, index) =>
      normalizeMessage(key, value, index, envelopeOccurrence, receivedAt),
    ),
  );
};

const normalizeDeletions = async (
  key: CryptoKey,
  data: unknown,
  occurrence: ParsedTimestamp | null,
  receivedAt: UtcTimestamp,
): Promise<ReadonlyArray<NormalizedWebhookItem>> => {
  const values = logicalItems(asRecord(data)?.keys);
  if (values === null) {
    return [malformed(null)];
  }
  return Promise.all(
    values.map(async (value, itemIndex) => {
      const record = asRecord(value);
      const rawId = asIdentity(record?.id);
      if (record === null || rawId === null) {
        return malformed(itemIndex, "missing_required_identity");
      }
      const remoteJid = asIdentity(record.remoteJid);
      if (remoteJid !== null && !isSupportedConversation(remoteJid)) {
        return unsupported(itemIndex);
      }
      const deletedAt = occurrence?.timestamp ?? receivedAt;
      return {
        deletedAt,
        ...(typeof record.fromMe === "boolean"
          ? {
              direction: record.fromMe
                ? ("outbound" as const)
                : ("inbound" as const),
            }
          : {}),
        evidence: await makeEvidence(key, occurrence),
        itemIdentity: (await makeIdentity(
          key,
          "item:message-delete",
          rawId,
        )) as WebhookItemIdentity,
        itemIndex,
        kind: "message_delete" as const,
        messageIdentity: await makeMessageIdentity(key, rawId),
        ...(remoteJid === null
          ? {}
          : {
              recipient: await makeRecipient(key, remoteJid),
              recipientKind: isGroup(remoteJid)
                ? ("group" as const)
                : ("direct" as const),
              sentAt: deletedAt,
            }),
      };
    }),
  );
};

const normalizeStatus = (
  value: unknown,
): IdentityBearingSendStatus | "failed" | null => {
  switch (value) {
    case 0:
    case "error":
    case "failed":
      return "failed";
    case 1:
    case "pending":
    case "accepted":
      return "accepted";
    case 2:
    case "sent":
      return "sent";
    case 3:
    case "delivered":
      return "delivered";
    case 4:
    case 5:
    case "played":
    case "read":
      return "read";
    default:
      return null;
  }
};

const makeSendEvidence = async (
  key: CryptoKey,
  keyRecord: JsonRecord | null,
  status: IdentityBearingSendStatus | "failed" | null,
  occurrence: ParsedTimestamp | null,
  itemIndex: number,
): Promise<NormalizedWebhookItem> => {
  const rawId = asIdentity(keyRecord?.id);
  if (rawId === null) {
    return malformed(itemIndex, "missing_required_identity");
  }
  if (keyRecord?.fromMe === false) {
    return unsupported(itemIndex);
  }
  if (keyRecord?.fromMe !== true) {
    return malformed(itemIndex);
  }
  if (status === null) {
    return malformed(itemIndex);
  }
  const remoteJid = asIdentity(keyRecord?.remoteJid);
  if (remoteJid !== null && !isSupportedConversation(remoteJid)) {
    return unsupported(itemIndex);
  }
  return {
    direction: "outbound",
    evidence: await makeEvidence(key, occurrence),
    itemIdentity: (await makeIdentity(key, "item:send-evidence", [
      rawId,
      status,
      occurrence?.epochMilliseconds ?? null,
    ])) as WebhookItemIdentity,
    itemIndex,
    kind: "send_evidence",
    messageIdentity: await makeMessageIdentity(key, rawId),
    status,
  };
};

const normalizeStatuses = async (
  key: CryptoKey,
  data: unknown,
  envelopeOccurrence: ParsedTimestamp | null,
): Promise<ReadonlyArray<NormalizedWebhookItem>> => {
  const values = logicalItems(data);
  if (values === null) {
    return [malformed(null)];
  }
  return Promise.all(
    values.map((value, itemIndex) => {
      const record = asRecord(value);
      const update = asRecord(record?.update);
      if (record === null || update === null) {
        return Promise.resolve(malformed(itemIndex));
      }
      return makeSendEvidence(
        key,
        asRecord(record.key),
        normalizeStatus(update.status),
        firstTimestamp(update.timestamp, envelopeOccurrence?.epochMilliseconds),
        itemIndex,
      );
    }),
  );
};

const normalizeSentMessage = async (
  key: CryptoKey,
  data: unknown,
  occurrence: ParsedTimestamp | null,
  receivedAt: UtcTimestamp,
): Promise<ReadonlyArray<NormalizedWebhookItem>> => {
  const message = asRecord(data);
  if (message === null || typeof message.success !== "boolean") {
    return [malformed(0)];
  }
  if (message.success) {
    return [await normalizeMessage(key, message, 0, occurrence, receivedAt)];
  }
  return [
    await makeSendEvidence(key, asRecord(message.key), "failed", occurrence, 0),
  ];
};

const normalizeReceipts = async (
  key: CryptoKey,
  data: unknown,
  envelopeOccurrence: ParsedTimestamp | null,
): Promise<ReadonlyArray<NormalizedWebhookItem>> => {
  const messages = logicalItems(asRecord(data)?.message);
  if (messages === null) {
    return [malformed(null)];
  }
  return Promise.all(
    messages.map((value, itemIndex) => {
      const message = asRecord(value);
      const receipt = asRecord(message?.receipt);
      const status =
        receipt === null
          ? null
          : (normalizeStatus(receipt.status) ??
            (parseTimestamp(receipt.readTimestamp) !== null
              ? "read"
              : parseTimestamp(receipt.receiptTimestamp) !== null
                ? "delivered"
                : null));
      const occurrence = firstTimestamp(
        receipt?.readTimestamp,
        receipt?.receiptTimestamp,
        envelopeOccurrence?.epochMilliseconds,
      );
      return makeSendEvidence(
        key,
        asRecord(message?.key),
        status,
        occurrence,
        itemIndex,
      );
    }),
  );
};

const contactUpdateFields = [
  "name",
  "notify",
  "verifiedName",
  "phoneNumber",
  "active",
] as const;

const normalizeContacts = async (
  key: CryptoKey,
  data: unknown,
  occurrence: ParsedTimestamp | null,
  partialUpdate: boolean,
): Promise<ReadonlyArray<NormalizedWebhookItem>> => {
  const values = logicalItems(data);
  if (values === null) {
    return [malformed(null)];
  }
  return Promise.all(
    values.map(async (value, itemIndex) => {
      const contact = asRecord(value);
      const jid = asIdentity(firstString(contact?.jid, contact?.id));
      if (contact === null || jid === null) {
        return malformed(itemIndex, "missing_required_identity");
      }
      if (
        partialUpdate &&
        !contactUpdateFields.some((field) => field in contact)
      ) {
        return unsupported(itemIndex);
      }
      const displayName = firstString(
        contact.name,
        contact.notify,
        contact.verifiedName,
      );
      const active = contact.active !== false;
      const phoneNumber = contactPhoneNumber(contact, jid);
      const recipient = await makeContact(key, jid);
      return {
        contact: {
          active,
          displayName,
          identity: recipient,
          phoneNumber,
          recipient,
        },
        evidence: await makeEvidence(key, occurrence),
        itemIdentity: (await makeIdentity(key, "item:directory-contact", [
          jid,
          active,
          displayName,
          phoneNumber,
          occurrence?.epochMilliseconds ?? null,
        ])) as WebhookItemIdentity,
        itemIndex,
        kind: "directory_contact" as const,
      };
    }),
  );
};

const groupUpdateFields = ["subject", "name", "joined"] as const;

const normalizeGroups = async (
  key: CryptoKey,
  data: unknown,
  occurrence: ParsedTimestamp | null,
  partialUpdate: boolean,
): Promise<ReadonlyArray<NormalizedWebhookItem>> => {
  const values = logicalItems(data);
  if (values === null) {
    return [malformed(null)];
  }
  return Promise.all(
    values.map(async (value, itemIndex) => {
      const group = asRecord(value);
      const jid = asIdentity(firstString(group?.jid, group?.id));
      if (group === null || jid === null) {
        return malformed(itemIndex, "missing_required_identity");
      }
      if (partialUpdate && !groupUpdateFields.some((field) => field in group)) {
        return unsupported(itemIndex);
      }
      const displayName = firstString(group.subject, group.name);
      const joined = group.joined !== false;
      const recipient = await makeGroup(key, jid);
      return {
        evidence: await makeEvidence(key, occurrence),
        group: {
          displayName,
          identity: recipient,
          joined,
          recipient,
        },
        itemIdentity: (await makeIdentity(key, "item:directory-group", [
          jid,
          joined,
          displayName,
          occurrence?.epochMilliseconds ?? null,
        ])) as WebhookItemIdentity,
        itemIndex,
        kind: "directory_group" as const,
      };
    }),
  );
};

const normalizeConnectionState = (
  value: unknown,
): LifecycleConnectionState | null => {
  switch (value) {
    case "connected":
      return "connected";
    case "connecting":
      return "connecting";
    case "disconnected":
      return "disconnected";
    case "expired":
    case "logged_out":
    case "need_passkey":
    case "need_scan":
      return "reconnect_required";
    case "degraded":
    case "error":
    case "failed":
      return "degraded";
    default:
      return null;
  }
};

const normalizeConnection = async (
  key: CryptoKey,
  data: unknown,
  occurrence: ParsedTimestamp | null,
): Promise<ReadonlyArray<NormalizedWebhookItem>> => {
  const state = normalizeConnectionState(asRecord(data)?.status);
  if (state === null) {
    return [malformed(0)];
  }
  return [
    {
      evidence: await makeEvidence(key, occurrence),
      itemIdentity: (await makeIdentity(key, "item:connection-state", [
        state,
        occurrence?.epochMilliseconds ?? null,
      ])) as WebhookItemIdentity,
      itemIndex: 0,
      kind: "connection_state",
      state,
    },
  ];
};

const normalizeEnvelope = async (
  key: CryptoKey,
  payload: Uint8Array,
  receivedAt: UtcTimestamp,
): Promise<NormalizedWebhookDelivery> => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(textDecoder.decode(payload));
  } catch {
    return { items: [malformed(null, "invalid_top_level_shape")] };
  }
  const envelope = asRecord(decoded);
  const event = asString(envelope?.event);
  if (envelope === null || event === null) {
    return { items: [malformed(null, "invalid_top_level_shape")] };
  }
  const occurrence = firstTimestamp(envelope.timestamp);

  let items: ReadonlyArray<NormalizedWebhookItem>;
  switch (event) {
    case "messages.upsert":
    case "messages.received":
    case "messages-personal.received":
    case "messages-group.received":
      items = await normalizeMessages(
        key,
        envelope.data,
        occurrence,
        receivedAt,
      );
      break;
    case "messages.delete":
      items = await normalizeDeletions(
        key,
        envelope.data,
        occurrence,
        receivedAt,
      );
      break;
    case "messages.update":
      items = await normalizeStatuses(key, envelope.data, occurrence);
      break;
    case "message.sent":
      items = await normalizeSentMessage(
        key,
        envelope.data,
        occurrence,
        receivedAt,
      );
      break;
    case "message-receipt.update":
      items = await normalizeReceipts(key, envelope.data, occurrence);
      break;
    case "contacts.upsert":
      items = await normalizeContacts(key, envelope.data, occurrence, false);
      break;
    case "contacts.update":
      items = await normalizeContacts(key, envelope.data, occurrence, true);
      break;
    case "groups.upsert":
      items = await normalizeGroups(key, envelope.data, occurrence, false);
      break;
    case "groups.update":
      items = await normalizeGroups(key, envelope.data, occurrence, true);
      break;
    case "session.status":
      items = await normalizeConnection(key, envelope.data, occurrence);
      break;
    default:
      items = [
        {
          classification: "unsupported_item_kind",
          itemIndex: 0,
          kind: "unsupported",
        },
      ];
  }
  return { items };
};

export const makeWasenderWebhookNormalization = (
  identityKey: CryptoKey,
): WebhookNormalization => ({
  compareVersions: ({ left, right }) =>
    Effect.tryPromise({
      try: () => compareVersions(identityKey, left, right),
      catch: () => providerFailure("unavailable", "defer_to_ingestion_retry"),
    }),
  normalize: ({ payload, receivedAt }) => {
    if (payload.byteLength > webhookNormalizationPolicy.maximumPayloadBytes) {
      return Effect.fail(providerFailure("response_too_large", "do_not_retry"));
    }
    return Effect.tryPromise({
      try: () => normalizeEnvelope(identityKey, payload, receivedAt),
      catch: () => providerFailure("unavailable", "defer_to_ingestion_retry"),
    });
  },
});

export const makeWasenderWebhookNormalizationLayer = (
  identityKey: CryptoKey,
): Layer.Layer<WebhookNormalization> =>
  Layer.succeed(
    WebhookNormalization,
    makeWasenderWebhookNormalization(identityKey),
  );
