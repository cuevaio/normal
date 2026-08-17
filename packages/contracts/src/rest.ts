import { Schema } from "effect";
import { ConnectionId, ContactId, ConversationId, GroupId } from "./handles";
import { makePublicObjectContract, UtcTimestamp } from "./mcp-schema";

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

export const decodeProblemDetails = Schema.decodeUnknownSync(
  ProblemDetailsContract.schema,
  { onExcessProperty: "error" },
);
