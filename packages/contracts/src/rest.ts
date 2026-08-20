import { Schema } from "effect";
import {
  ConnectionId,
  ContactId,
  ConversationId,
  GroupId,
  MediaId,
  MessageId,
  SendId,
} from "./handles";
import {
  makePublicContract,
  makePublicObjectContract,
  SendStatus,
  UtcTimestamp,
} from "./mcp-schema";

const unicodeWhiteSpace = new Set([
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
  0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

const isOnlyUnicodeWhiteSpace = (value: string): boolean =>
  Array.from(value).every((character) =>
    unicodeWhiteSpace.has(character.codePointAt(0) ?? -1),
  );

const hasUnpairedSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
};

export const SendText = Schema.String.pipe(
  Schema.filter((value) => {
    const length = Array.from(value).length;
    return (
      length >= 1 &&
      length <= 4_096 &&
      !hasUnpairedSurrogate(value) &&
      !isOnlyUnicodeWhiteSpace(value)
    );
  }),
);
export type SendText = typeof SendText.Type;

export const SendPhone = Schema.String.pipe(
  Schema.pattern(/^\+[1-9][0-9]{1,14}$/),
);
export type SendPhone = typeof SendPhone.Type;

export const SendUsername = Schema.String.pipe(
  Schema.pattern(/^@[A-Za-z0-9._-]{1,64}$/),
);
export type SendUsername = typeof SendUsername.Type;

export const RestConnectionState = Schema.Literal(
  "connected",
  "connecting",
  "disconnected",
  "reconnect_required",
  "degraded",
);

export const RestConnection = Schema.Struct({
  connection_id: ConnectionId,
  display_name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  number_last_four: Schema.NullOr(
    Schema.String.pipe(Schema.pattern(/^[0-9]{4}$/)),
  ),
  state: RestConnectionState,
  state_changed_at: UtcTimestamp,
});
export type RestConnection = typeof RestConnection.Type;

export const RestPagination = Schema.Struct({
  has_more: Schema.Boolean,
  next_cursor: Schema.NullOr(Schema.String),
});
export type RestPagination = typeof RestPagination.Type;

export const RestConnectionListContract = makePublicObjectContract({
  data: Schema.Array(RestConnection).pipe(Schema.maxItems(3)),
  pagination: RestPagination,
});
export type RestConnectionList = typeof RestConnectionListContract.schema.Type;

export const RestContact = Schema.Struct({
  contact_id: ContactId,
  conversation_id: Schema.NullOr(ConversationId),
  display_name: Schema.NullOr(Schema.String),
  phone_last_four: Schema.NullOr(
    Schema.String.pipe(Schema.pattern(/^[0-9]{4}$/)),
  ),
});
export type RestContact = typeof RestContact.Type;

export const RestDirectoryMeta = Schema.Struct({
  as_of: UtcTimestamp,
  partial: Schema.Boolean,
  stale: Schema.Boolean,
});
export type RestDirectoryMeta = typeof RestDirectoryMeta.Type;

export const RestContactListContract = makePublicObjectContract({
  data: Schema.Array(RestContact).pipe(Schema.maxItems(50)),
  meta: RestDirectoryMeta,
  pagination: RestPagination,
});
export type RestContactList = typeof RestContactListContract.schema.Type;

export const RestGroup = Schema.Struct({
  group_id: GroupId,
  display_name: Schema.NullOr(Schema.String),
});
export type RestGroup = typeof RestGroup.Type;

export const RestGroupListContract = makePublicObjectContract({
  data: Schema.Array(RestGroup).pipe(Schema.maxItems(50)),
  meta: RestDirectoryMeta,
  pagination: RestPagination,
});
export type RestGroupList = typeof RestGroupListContract.schema.Type;

export const RestConversationKind = Schema.Literal("direct", "group");
export type RestConversationKind = typeof RestConversationKind.Type;

export const RestConversation = Schema.Struct({
  conversation_id: ConversationId,
  display_name: Schema.NullOr(Schema.String),
  kind: RestConversationKind,
  last_activity_at: UtcTimestamp,
  last_activity_direction: Schema.Literal("inbound", "outbound"),
  phone_last_four: Schema.NullOr(
    Schema.String.pipe(Schema.pattern(/^[0-9]{4}$/)),
  ),
  recipient_id: Schema.Union(ContactId, GroupId),
});
export type RestConversation = typeof RestConversation.Type;

export const RestConversationListContract = makePublicObjectContract({
  data: Schema.Array(RestConversation).pipe(Schema.maxItems(50)),
  meta: RestDirectoryMeta,
  pagination: RestPagination,
});
export type RestConversationList =
  typeof RestConversationListContract.schema.Type;

const restStoredMediaPathPattern =
  /^\/v1\/connections\/(con_[A-Za-z0-9_-]{21})\/messages\/(msg_[A-Za-z0-9_-]{21})\/media\/(med_[A-Za-z0-9_-]{21})$/;

export const RestStoredMediaPath = Schema.String.pipe(
  Schema.pattern(restStoredMediaPathPattern),
);
export type RestStoredMediaPath = typeof RestStoredMediaPath.Type;

export const restStoredMediaPath = (input: {
  readonly connectionId: ConnectionId | string;
  readonly mediaId: MediaId | string;
  readonly messageId: MessageId | string;
}): RestStoredMediaPath =>
  `/v1/connections/${input.connectionId}/messages/${input.messageId}/media/${input.mediaId}` as RestStoredMediaPath;

export const parseRestStoredMediaPath = (
  input: string,
): {
  readonly connectionId: string;
  readonly mediaId: string;
  readonly messageId: string;
} | null => {
  const match = restStoredMediaPathPattern.exec(input);
  if (
    match === null ||
    match[0] !== input ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return null;
  }
  return {
    connectionId: match[1],
    messageId: match[2],
    mediaId: match[3],
  };
};

export const RestMessageSender = Schema.Struct({
  display_name: Schema.NullOr(Schema.String),
  kind: Schema.Literal("self", "contact", "group_participant"),
  phone_last_four: Schema.NullOr(
    Schema.String.pipe(Schema.pattern(/^[0-9]{4}$/)),
  ),
});
export type RestMessageSender = typeof RestMessageSender.Type;

export const RestMessageMediaUnavailableReason = Schema.Literal(
  "media_pending",
  "media_rejected",
  "media_failed",
  "too_large",
);
export type RestMessageMediaUnavailableReason =
  typeof RestMessageMediaUnavailableReason.Type;

export const RestMessageMedia = Schema.Struct({
  file_name: Schema.NullOr(Schema.String),
  media_id: MediaId,
  mime_type: Schema.NullOr(Schema.String),
  path: Schema.NullOr(RestStoredMediaPath),
  size_bytes: Schema.NullOr(
    Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  ),
  state: Schema.Literal("pending", "ready", "rejected", "failed"),
  type: Schema.Literal("image", "audio", "video", "document", "sticker"),
  unavailable_reason: Schema.NullOr(RestMessageMediaUnavailableReason),
});
export type RestMessageMedia = typeof RestMessageMedia.Type;

export const RestMessage = Schema.Struct({
  content_type: Schema.Literal(
    "text",
    "image",
    "audio",
    "video",
    "document",
    "sticker",
    "unknown",
  ),
  deleted: Schema.Boolean,
  direction: Schema.Literal("inbound", "outbound"),
  edited_at: Schema.NullOr(UtcTimestamp),
  media: Schema.NullOr(RestMessageMedia),
  message_id: MessageId,
  sender: RestMessageSender,
  sent_at: UtcTimestamp,
  text: Schema.NullOr(Schema.String),
});
export type RestMessage = typeof RestMessage.Type;

export const RestIngestionGap = Schema.Struct({
  cause: Schema.Literal(
    "connection_unavailable",
    "webhook_configuration",
    "health_check_failure",
    "ingress_failure",
    "processing_failure",
    "restore_loss",
  ),
  ends_at: Schema.NullOr(UtcTimestamp),
  starts_at: UtcTimestamp,
});
export type RestIngestionGap = typeof RestIngestionGap.Type;

export const RestMessageListMeta = Schema.Struct({
  conversation_id: ConversationId,
  gaps: Schema.Array(RestIngestionGap),
  history_start_reason: Schema.Literal(
    "connection_started",
    "retention_policy",
  ),
  history_starts_at: UtcTimestamp,
  kind: RestConversationKind,
  recipient_id: Schema.Union(ContactId, GroupId),
  size_limited: Schema.Boolean,
});
export type RestMessageListMeta = typeof RestMessageListMeta.Type;

export const RestMessageListContract = makePublicObjectContract({
  data: Schema.Array(RestMessage).pipe(Schema.maxItems(50)),
  meta: RestMessageListMeta,
  pagination: RestPagination,
});
export type RestMessageList = typeof RestMessageListContract.schema.Type;

export const RestSearchMessagesRequestContract = makePublicObjectContract({
  after: Schema.optional(UtcTimestamp),
  before: Schema.optional(UtcTimestamp),
  conversation_id: Schema.optional(ConversationId),
  cursor: Schema.optional(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4_096)),
  ),
  direction: Schema.optional(Schema.Literal("all", "inbound", "outbound")),
  limit: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.between(1, 20)),
  ),
  query: Schema.String.pipe(
    Schema.filter((value) => {
      const length = Array.from(value).length;
      return length >= 1 && length <= 256 && !hasUnpairedSurrogate(value);
    }),
  ),
});
export type RestSearchMessagesRequest =
  typeof RestSearchMessagesRequestContract.schema.Type;

export const RestSearchMessage = Schema.Struct({
  content_type: Schema.Literal(
    "text",
    "image",
    "audio",
    "video",
    "document",
    "sticker",
    "unknown",
  ),
  conversation_id: ConversationId,
  direction: Schema.Literal("inbound", "outbound"),
  edited_at: Schema.NullOr(UtcTimestamp),
  message_id: MessageId,
  sent_at: UtcTimestamp,
  text: Schema.NullOr(Schema.String),
});
export type RestSearchMessage = typeof RestSearchMessage.Type;

export const RestSearchMessagesMeta = Schema.Struct({
  backfill_complete: Schema.Boolean,
  gaps: Schema.Array(RestIngestionGap),
  history_start_reason: Schema.Literal(
    "connection_started",
    "retention_policy",
  ),
  history_starts_at: UtcTimestamp,
  index_version: Schema.Literal("v1"),
  partial: Schema.Boolean,
  partial_reasons: Schema.Array(
    Schema.Literal("index_backfill", "ingestion_gap"),
  ).pipe(Schema.maxItems(2)),
  searchable_history_starts_at: Schema.NullOr(UtcTimestamp),
  size_limited: Schema.Boolean,
});
export type RestSearchMessagesMeta = typeof RestSearchMessagesMeta.Type;

export const RestSearchMessagesListContract = makePublicObjectContract({
  data: Schema.Array(RestSearchMessage).pipe(Schema.maxItems(20)),
  meta: RestSearchMessagesMeta,
  pagination: RestPagination,
});
export type RestSearchMessagesList =
  typeof RestSearchMessagesListContract.schema.Type;

export const ProblemStatus = Schema.Literal(400, 401, 403, 404, 409, 429, 503);

export const ProblemCode = Schema.Literal(
  "invalid_credentials",
  "insufficient_permission",
  "invalid_cursor",
  "invalid_request",
  "not_found",
  "idempotency_conflict",
  "connection_unavailable",
  "rate_limited",
  "unavailable",
);
export type ProblemCode = typeof ProblemCode.Type;

export const problemTitles = {
  connection_unavailable: "Connection unavailable",
  idempotency_conflict: "Idempotency conflict",
  insufficient_permission: "Insufficient permission",
  invalid_credentials: "Invalid credentials",
  invalid_cursor: "Invalid cursor",
  invalid_request: "Invalid request",
  not_found: "Not found",
  rate_limited: "Rate limited",
  unavailable: "Unavailable",
} as const satisfies Record<ProblemCode, string>;

export const problemDetails = {
  connection_unavailable:
    "The WhatsApp Connection is not connected for a new Send Operation.",
  idempotency_conflict:
    "This Idempotency-Key is already bound to a different Send Operation.",
  insufficient_permission:
    "The API Key does not include the required permission.",
  invalid_credentials:
    "The API Key is missing, malformed, expired, or revoked.",
  invalid_cursor:
    "The cursor is expired, tampered, or bound to another grant or query.",
  invalid_request: "The request body, headers, or parameters are invalid.",
  not_found: "The requested resource was not found.",
  rate_limited: "The request quota is exhausted.",
  unavailable: "The service is temporarily unavailable.",
} as const satisfies Record<ProblemCode, string>;

export const problemStatuses = {
  connection_unavailable: 409,
  idempotency_conflict: 409,
  insufficient_permission: 403,
  invalid_credentials: 401,
  invalid_cursor: 400,
  invalid_request: 400,
  not_found: 404,
  rate_limited: 429,
  unavailable: 503,
} as const satisfies Record<ProblemCode, (typeof ProblemStatus)["Type"]>;

export const ProblemDetailsContract = makePublicObjectContract({
  code: ProblemCode,
  detail: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  retry_after_seconds: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  ),
  retryable: Schema.optional(Schema.Boolean),
  resets_at: Schema.optional(UtcTimestamp),
  status: ProblemStatus,
  title: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80)),
  type: Schema.String.pipe(
    Schema.pattern(/^https:\/\/docs\.normal\.fast\/problems\/[a-z_]+$/),
  ),
});
export type ProblemDetails = typeof ProblemDetailsContract.schema.Type;

export const problemType = (code: ProblemCode): ProblemDetails["type"] =>
  `https://docs.normal.fast/problems/${code}` as ProblemDetails["type"];

export const RestCreateSendOperationContract = makePublicContract(
  Schema.Union(
    Schema.Struct({
      recipient_id: Schema.Union(ContactId, GroupId),
      text: SendText,
    }),
    Schema.Struct({ phone: SendPhone, text: SendText }),
    Schema.Struct({ username: SendUsername, text: SendText }),
  ),
);
export type RestCreateSendOperation =
  typeof RestCreateSendOperationContract.schema.Type;

export const RestSendOperationContract = makePublicObjectContract({
  send_id: SendId,
  status: SendStatus,
  created_at: UtcTimestamp,
  status_changed_at: UtcTimestamp,
  idempotent_replay: Schema.Boolean,
});
export type RestSendOperation = typeof RestSendOperationContract.schema.Type;

export const decodeRestConnectionList = Schema.decodeUnknownSync(
  RestConnectionListContract.schema,
  { onExcessProperty: "error" },
);

export const decodeRestContactList = Schema.decodeUnknownSync(
  RestContactListContract.schema,
  { onExcessProperty: "error" },
);

export const decodeRestGroupList = Schema.decodeUnknownSync(
  RestGroupListContract.schema,
  { onExcessProperty: "error" },
);

export const decodeRestConversationList = Schema.decodeUnknownSync(
  RestConversationListContract.schema,
  { onExcessProperty: "error" },
);

export const decodeRestMessageList = Schema.decodeUnknownSync(
  RestMessageListContract.schema,
  { onExcessProperty: "error" },
);

export const decodeRestSearchMessagesRequest = Schema.decodeUnknownSync(
  RestSearchMessagesRequestContract.schema,
  { onExcessProperty: "error" },
);

export const decodeRestSearchMessagesList = Schema.decodeUnknownSync(
  RestSearchMessagesListContract.schema,
  { onExcessProperty: "error" },
);

export const decodeRestCreateSendOperation = Schema.decodeUnknownSync(
  RestCreateSendOperationContract.schema,
  { onExcessProperty: "error" },
);

export const decodeRestSendOperation = Schema.decodeUnknownSync(
  RestSendOperationContract.schema,
  { onExcessProperty: "error" },
);

export const decodeProblemDetails = Schema.decodeUnknownSync(
  ProblemDetailsContract.schema,
  { onExcessProperty: "error" },
);
