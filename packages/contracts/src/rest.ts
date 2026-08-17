import { Schema } from "effect";
import {
  ConnectionId,
  ContactId,
  ConversationId,
  GroupId,
  SendId,
} from "./handles";
import {
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

export const RestCreateSendOperationContract = makePublicObjectContract({
  recipient_id: Schema.Union(ContactId, GroupId),
  text: SendText,
});
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

export const decodeRestConversationList = Schema.decodeUnknownSync(
  RestConversationListContract.schema,
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
