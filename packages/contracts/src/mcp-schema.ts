import { JSONSchema, Schema } from "effect";
import {
  ConnectionId,
  ContactId,
  ConversationId,
  GroupId,
  MediaId,
  MessageId,
  SendId,
} from "./handles";

const utcTimestampPattern =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z(?![\s\S])/;

const isRealUtcTimestamp = (value: string): boolean => {
  const parsed = new Date(value);

  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 19) === value.slice(0, 19)
  );
};

export const UtcTimestamp = Schema.String.pipe(
  Schema.pattern(utcTimestampPattern),
  Schema.filter(isRealUtcTimestamp, {
    jsonSchema: {
      format: "date-time",
    },
  }),
  Schema.brand("UtcTimestamp"),
);
export type UtcTimestamp = typeof UtcTimestamp.Type;

export const makePublicObjectContract = <
  const Fields extends Schema.Struct.Fields,
>(
  fields: Fields &
    ([Schema.Struct.Context<Fields>] extends [never] ? unknown : never),
) => {
  const schema = Schema.Struct(fields);
  return makePublicContract(
    schema as unknown as Schema.Schema<
      typeof schema.Type,
      typeof schema.Encoded,
      never
    >,
  );
};

export const makePublicContract = <Type, Encoded>(
  schema: Schema.Schema<Type, Encoded, never>,
) => ({
  schema,
  jsonSchema: JSONSchema.make(schema, {
    target: "jsonSchema2020-12",
  }),
  decodeUnknown: Schema.decodeUnknownSync(schema, {
    onExcessProperty: "error",
  }),
});

export type PublicObjectContract<A> = {
  readonly decodeUnknown: (input: unknown) => A;
};

export const ListConnectionsOutputContract = makePublicObjectContract({
  connections: Schema.Array(
    Schema.Struct({
      connection_id: ConnectionId,
      display_name: Schema.String.pipe(
        Schema.minLength(1),
        Schema.maxLength(64),
      ),
      number_last_four: Schema.NullOr(
        Schema.String.pipe(Schema.pattern(/^[0-9]{4}$/)),
      ),
      state: Schema.Literal(
        "connected",
        "connecting",
        "disconnected",
        "reconnect_required",
        "degraded",
      ),
      state_changed_at: UtcTimestamp,
    }),
  ).pipe(Schema.maxItems(3)),
});
export type ListConnectionsOutput =
  typeof ListConnectionsOutputContract.schema.Type;

export const ListGroupsOutputContract = makePublicObjectContract({
  groups: Schema.Array(
    Schema.Struct({
      group_id: GroupId,
      display_name: Schema.NullOr(Schema.String),
    }),
  ).pipe(Schema.maxItems(50)),
  has_more: Schema.Boolean,
  next_cursor: Schema.NullOr(Schema.String),
  as_of: UtcTimestamp,
  stale: Schema.Boolean,
  partial: Schema.Boolean,
});
export type ListGroupsOutput = typeof ListGroupsOutputContract.schema.Type;

export const ListContactsOutputContract = makePublicObjectContract({
  contacts: Schema.Array(
    Schema.Struct({
      contact_id: ContactId,
      conversation_id: Schema.NullOr(ConversationId),
      display_name: Schema.NullOr(Schema.String),
      phone_last_four: Schema.NullOr(
        Schema.String.pipe(Schema.pattern(/^[0-9]{4}$/)),
      ),
    }),
  ).pipe(Schema.maxItems(50)),
  has_more: Schema.Boolean,
  next_cursor: Schema.NullOr(Schema.String.pipe(Schema.minLength(1))),
  as_of: UtcTimestamp,
  stale: Schema.Boolean,
  partial: Schema.Boolean,
});
export type ListContactsOutput = typeof ListContactsOutputContract.schema.Type;

export const SendStatus = Schema.Literal(
  "processing",
  "accepted",
  "sent",
  "delivered",
  "read",
  "failed",
  "unknown",
);
export type SendStatus = typeof SendStatus.Type;

export const SendTextMessageOutputContract = makePublicObjectContract({
  send_id: SendId,
  status: SendStatus,
  created_at: UtcTimestamp,
  status_changed_at: UtcTimestamp,
  idempotent_replay: Schema.Boolean,
});
export type SendTextMessageOutput =
  typeof SendTextMessageOutputContract.schema.Type;

export const GetSendStatusOutputContract = makePublicObjectContract({
  send_id: SendId,
  status: SendStatus,
  created_at: UtcTimestamp,
  status_changed_at: UtcTimestamp,
});
export type GetSendStatusOutput =
  typeof GetSendStatusOutputContract.schema.Type;

export const ListChatsOutputContract = makePublicObjectContract({
  chats: Schema.Array(
    Schema.Struct({
      conversation_id: ConversationId,
      kind: Schema.Literal("direct", "group"),
      recipient_id: Schema.Union(ContactId, GroupId),
      display_name: Schema.NullOr(Schema.String),
      phone: Schema.NullOr(
        Schema.String.pipe(Schema.pattern(/^\+[1-9][0-9]{6,14}$/)),
      ),
      phone_last_four: Schema.NullOr(
        Schema.String.pipe(Schema.pattern(/^[0-9]{4}$/)),
      ),
      last_activity_at: UtcTimestamp,
      last_activity_direction: Schema.Literal("inbound", "outbound"),
    }),
  ).pipe(Schema.maxItems(50)),
  has_more: Schema.Boolean,
  next_cursor: Schema.NullOr(Schema.String.pipe(Schema.minLength(1))),
  as_of: UtcTimestamp,
  stale: Schema.Boolean,
  partial: Schema.Boolean,
});
export type ListChatsOutput = typeof ListChatsOutputContract.schema.Type;

export const ReadMessagesOutputContract = makePublicObjectContract({
  conversation_id: ConversationId,
  kind: Schema.Literal("direct", "group"),
  recipient_id: Schema.Union(ContactId, GroupId),
  messages: Schema.Array(
    Schema.Struct({
      message_id: MessageId,
      sent_at: UtcTimestamp,
      direction: Schema.Literal("inbound", "outbound"),
      sender: Schema.Struct({
        kind: Schema.Literal("self", "contact", "group_participant"),
        display_name: Schema.NullOr(Schema.String),
        phone_last_four: Schema.NullOr(
          Schema.String.pipe(Schema.pattern(/^[0-9]{4}$/)),
        ),
      }),
      content_type: Schema.Literal(
        "text",
        "image",
        "audio",
        "video",
        "document",
        "sticker",
        "unknown",
      ),
      text: Schema.NullOr(Schema.String),
      text_truncated: Schema.Boolean,
      text_total_utf8_bytes: Schema.NullOr(
        Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
      ),
      edited_at: Schema.NullOr(UtcTimestamp),
      deleted: Schema.Boolean,
      media: Schema.NullOr(
        Schema.Struct({
          media_id: MediaId,
          type: Schema.Literal(
            "image",
            "audio",
            "video",
            "document",
            "sticker",
          ),
          state: Schema.Literal("pending", "ready", "rejected", "failed"),
          size_bytes: Schema.NullOr(
            Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
          ),
          mime_type: Schema.NullOr(Schema.String),
          file_name: Schema.NullOr(Schema.String),
          resource_uri: Schema.NullOr(Schema.String),
          resource_unavailable_reason: Schema.NullOr(
            Schema.Literal(
              "media_pending",
              "media_rejected",
              "media_failed",
              "too_large_for_mcp",
            ),
          ),
          resource_size_limit_bytes: Schema.Literal(16_777_216),
        }),
      ),
    }),
  ).pipe(Schema.maxItems(50)),
  size_limited: Schema.Boolean,
  has_older: Schema.Boolean,
  older_cursor: Schema.NullOr(Schema.String.pipe(Schema.minLength(1))),
  history_starts_at: UtcTimestamp,
  history_start_reason: Schema.Literal(
    "connection_started",
    "retention_policy",
  ),
  gaps: Schema.Array(
    Schema.Struct({
      starts_at: UtcTimestamp,
      ends_at: Schema.NullOr(UtcTimestamp),
      cause: Schema.Literal(
        "connection_unavailable",
        "webhook_configuration",
        "health_check_failure",
        "ingress_failure",
        "processing_failure",
        "restore_loss",
      ),
    }),
  ),
});
export type ReadMessagesOutput = typeof ReadMessagesOutputContract.schema.Type;

const IngestionGap = Schema.Struct({
  starts_at: UtcTimestamp,
  ends_at: Schema.NullOr(UtcTimestamp),
  cause: Schema.Literal(
    "connection_unavailable",
    "webhook_configuration",
    "health_check_failure",
    "ingress_failure",
    "processing_failure",
    "restore_loss",
  ),
});

export const SearchMessagesOutputContract = makePublicObjectContract({
  messages: Schema.Array(
    Schema.Struct({
      message_id: MessageId,
      conversation_id: ConversationId,
      sent_at: UtcTimestamp,
      direction: Schema.Literal("inbound", "outbound"),
      content_type: Schema.Literal(
        "text",
        "image",
        "audio",
        "video",
        "document",
        "sticker",
        "unknown",
      ),
      text: Schema.NullOr(Schema.String),
      text_truncated: Schema.Boolean,
      text_total_utf8_bytes: Schema.NullOr(
        Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
      ),
      edited_at: Schema.NullOr(UtcTimestamp),
    }),
  ).pipe(Schema.maxItems(20)),
  size_limited: Schema.Boolean,
  has_more: Schema.Boolean,
  next_cursor: Schema.NullOr(Schema.String.pipe(Schema.minLength(1))),
  coverage: Schema.Struct({
    history_starts_at: UtcTimestamp,
    history_start_reason: Schema.Literal(
      "connection_started",
      "retention_policy",
    ),
    searchable_history_starts_at: Schema.NullOr(UtcTimestamp),
    index_version: Schema.Literal("v1"),
    backfill_complete: Schema.Boolean,
    partial: Schema.Boolean,
    partial_reasons: Schema.Array(
      Schema.Literal("index_backfill", "ingestion_gap"),
    ).pipe(Schema.maxItems(2)),
    gaps: Schema.Array(IngestionGap),
  }),
});
export type SearchMessagesOutput =
  typeof SearchMessagesOutputContract.schema.Type;
