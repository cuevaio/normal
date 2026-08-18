import {
  type CallToolResult,
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import {
  type CursorBoundary,
  type CursorContext,
  type InvalidCursorError,
  signCursor,
  verifyCursor,
} from "@whatsapp-mcp/contracts/cursor";
import { makeExecutionErrorResult } from "@whatsapp-mcp/contracts/mcp-error";
import { makeSuccessResultBuilder } from "@whatsapp-mcp/contracts/mcp-result";
import {
  type GetSendStatusOutput,
  GetSendStatusOutputContract,
  type ListChatsOutput,
  ListChatsOutputContract,
  type ListConnectionsOutput,
  ListConnectionsOutputContract,
  type ListContactsOutput,
  ListContactsOutputContract,
  type ListGroupsOutput,
  ListGroupsOutputContract,
  type ReadMessagesOutput,
  ReadMessagesOutputContract,
  type SearchMessagesOutput,
  SearchMessagesOutputContract,
  type SendTextMessageOutput,
  SendTextMessageOutputContract,
} from "@whatsapp-mcp/contracts/mcp-schema";
import {
  makeStoredMediaUri,
  parseStoredMediaUri,
} from "@whatsapp-mcp/contracts/stored-media-uri";
import {
  type BeginProtectedOperationResult,
  type McpAccessAuthorization,
  type McpToolChatPage,
  type McpToolConnectionRecord,
  type McpToolContactReadMaterial,
  type McpToolEncryptedContactPage,
  type McpToolGroupPage,
  type McpToolGroupSearchMaterial,
  type McpToolMessagePage,
  type McpToolMessageSearchPage,
  type McpToolName,
  type McpToolSendStatusRecord,
  mcpSendGrant,
  type RejectProtectedOperationResult,
  type SendGrantIdentity,
} from "@whatsapp-mcp/db/mcp-tool";
import { normalizeWhatsAppConnectionName } from "@whatsapp-mcp/domain/whatsapp-connection";
import { createMcpHandler } from "agents/mcp/server";
import { Context, Data, Effect, type Layer, Option } from "effect";
import { z } from "zod";
import { encodeBase64 } from "./base64-url";
import {
  contactSearchIndex,
  decryptDirectoryString,
  importDirectoryIndexKey,
  normalizeContactDisplayName,
} from "./directory-privacy";
import {
  type EncryptionContext,
  EncryptionError,
  type EnvelopeEncryption,
  EnvelopeEncryptionService,
  type VersionedCiphertext,
} from "./encryption/envelope";
import {
  type StoredMediaContainer,
  StoredMediaContainerService,
} from "./encryption/stored-media-container";
import {
  groupSearchIndex,
  importGroupDirectoryIndexKey,
  normalizeGroupDisplayName,
} from "./group-privacy";
import {
  importMessageSearchIndexKey,
  messageSearchIndexesForQuery,
  messageSearchQueryDigest,
  validateMessageSearchQuery,
  verifyMessageSearchCandidate,
} from "./message-search-privacy";
import {
  type McpToolCallCompletedEvent,
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

export class McpToolPersistenceError extends Data.TaggedError(
  "McpToolPersistenceError",
) {}

export interface McpToolPersistenceService {
  readonly failStoredMediaRead: (input: {
    readonly auditLogId: string;
    readonly completedAt: Date;
    readonly errorCode: string;
  }) => Effect.Effect<void, McpToolPersistenceError>;
  readonly reserveStoredMediaRead: (
    input: McpAccessAuthorization & {
      readonly auditLogId: string;
      readonly connectionPublicId: string;
      readonly dailyByteLimit: number;
      readonly mediaPublicId: string;
      readonly messagePublicId: string;
      readonly observedAt: Date;
    },
  ) => Effect.Effect<
    McpStoredMediaReadMaterial | null,
    McpToolPersistenceError
  >;
  readonly beginProtectedOperation: (
    input: McpAccessAuthorization & {
      readonly auditLogId: string;
      readonly connectionPublicId?: string;
      readonly hourLimit: number;
      readonly minuteLimit: number;
      readonly observedAt: Date;
      readonly sendPublicId?: string;
      readonly operationName: McpToolName;
    },
  ) => Effect.Effect<BeginProtectedOperationResult, McpToolPersistenceError>;
  readonly completeProtectedOperation: (input: {
    readonly auditLogId: string;
    readonly completedAt: Date;
    readonly errorCode: string | null;
    readonly outcome: "authorization_denied" | "execution_error" | "success";
    readonly resultCount: number | null;
  }) => Effect.Effect<void, McpToolPersistenceError>;
  readonly inspectAuthorization: (
    input: McpAccessAuthorization & { readonly observedAt: Date },
  ) => Effect.Effect<
    {
      readonly scopes: ReadonlyArray<
        | "connections:read"
        | "directory:read"
        | "messages:read"
        | "messages:send"
      >;
    } | null,
    McpToolPersistenceError
  >;
  readonly listConnections: (
    input: McpAccessAuthorization & {
      readonly authorizationContextEstablished?: true;
      readonly observedAt: Date;
    },
  ) => Effect.Effect<
    ReadonlyArray<McpToolConnectionRecord> | null,
    McpToolPersistenceError
  >;
  readonly getSendStatus?: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly observedAt: Date;
      readonly sendPublicId: string;
    },
  ) => Effect.Effect<McpToolSendStatusRecord | null, McpToolPersistenceError>;
  readonly listGroups: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly observedAt: Date;
      readonly searchIndex: string | null;
    },
  ) => Effect.Effect<McpToolGroupPage | null, McpToolPersistenceError>;
  readonly listChats?: (
    input: McpAccessAuthorization & {
      readonly authorizationContextEstablished?: true;
      readonly connectionPublicId: string;
      readonly cursorActivityAt: string | null;
      readonly cursorPublicId: string | null;
      readonly kind: "all" | "direct" | "group";
      readonly limit: number;
      readonly observedAt: Date;
    },
  ) => Effect.Effect<McpToolChatPage | null, McpToolPersistenceError>;
  readonly readMessages?: (
    input: McpAccessAuthorization & {
      readonly auditLogId: string;
      readonly authorizationContextEstablished?: true;
      readonly connectionPublicId: string;
      readonly conversationPublicId: string;
      readonly cursorSentAt: string | null;
      readonly cursorPublicId: string | null;
      readonly dailyRecordLimit: number;
      readonly limit: number;
      readonly observedAt: Date;
    },
  ) => Effect.Effect<
    | { readonly outcome: "success"; readonly page: McpToolMessagePage }
    | { readonly outcome: "record_quota_exhausted"; readonly resetsAt: Date }
    | null,
    McpToolPersistenceError
  >;
  readonly searchMessages?: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly conversationPublicId: string | null;
      readonly cursorSentAt: string | null;
      readonly cursorPublicId: string | null;
      readonly direction: "all" | "inbound" | "outbound";
      readonly after: string | null;
      readonly before: string | null;
      readonly limit: number;
      readonly observedAt: Date;
      readonly searchTokens: ReadonlyArray<string> | null;
    },
  ) => Effect.Effect<McpToolMessageSearchPage | null, McpToolPersistenceError>;
  readonly completeMessageRecordRead: (
    input: McpAccessAuthorization & {
      readonly auditLogId: string;
      readonly authorizationContextEstablished?: true;
      readonly dailyRecordLimit: number;
      readonly observedAt: Date;
      readonly resultCount: number;
    },
  ) => Effect.Effect<
    | { readonly outcome: "success" }
    | { readonly outcome: "record_quota_exhausted"; readonly resetsAt: Date },
    McpToolPersistenceError
  >;
  readonly loadGroupSearchMaterial: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly observedAt: Date;
    },
  ) => Effect.Effect<
    McpToolGroupSearchMaterial | null,
    McpToolPersistenceError
  >;
  readonly loadContactReadMaterial: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly observedAt: Date;
    },
  ) => Effect.Effect<
    McpToolContactReadMaterial | null,
    McpToolPersistenceError
  >;
  readonly listEncryptedContacts: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly cursorDisplayNameSort: string | null;
      readonly cursorPublicId: string | null;
      readonly limit: number;
      readonly observedAt: Date;
      readonly searchIndex: string | null;
      readonly searchKind: "name" | "phone" | null;
    },
  ) => Effect.Effect<
    McpToolEncryptedContactPage | null,
    McpToolPersistenceError
  >;
  readonly rejectProtectedOperation: (
    input: McpAccessAuthorization & {
      readonly auditLogId: string;
      readonly connectionPublicId?: string;
      readonly errorCode: string;
      readonly observedAt: Date;
      readonly sendPublicId?: string;
      readonly operationName:
        | "list_connections"
        | "list_contacts"
        | "search_messages";
    },
  ) => Effect.Effect<RejectProtectedOperationResult, McpToolPersistenceError>;
}

export interface McpStoredMediaReadMaterial {
  readonly accountKey: McpToolMessagePage["accountKey"];
  readonly connectionKey: McpToolMessagePage["connectionKey"];
  readonly mediaId: string;
  readonly metadata: NonNullable<
    NonNullable<McpToolMessagePage["messages"][number]["media"]>["metadata"]
  >;
  readonly objectKey: string;
  readonly plaintextSizeBytes: number;
}

export const McpToolPersistence = Context.GenericTag<McpToolPersistenceService>(
  "@whatsapp-mcp/api/McpToolPersistence",
);

export type SendTextMessageResult =
  | { readonly outcome: "receipt"; readonly receipt: SendTextMessageOutput }
  | {
      readonly outcome:
        | "authorization_denied"
        | "audit_unavailable"
        | "connection_unavailable"
        | "idempotency_conflict"
        | "recipient_not_found"
        | "service_unavailable";
    }
  | {
      readonly outcome: "rate_limited";
      readonly resetsAt: Date;
      readonly retryAfterSeconds: number;
    };

export interface SendTextMessageService {
  readonly send: (
    input: {
      readonly connectionId: string;
      readonly grant: SendGrantIdentity;
      readonly idempotencyKey: string;
      readonly recipientId: string;
      readonly text: string;
    },
    deferProviderAttempt?: (attempt: Promise<void>) => void,
  ) => Effect.Effect<SendTextMessageResult, never>;
}

export const SendTextMessage = Context.GenericTag<SendTextMessageService>(
  "@whatsapp-mcp/api/SendTextMessage",
);

export interface McpToolClockService {
  readonly now: Effect.Effect<Date>;
}

export const McpToolClock = Context.GenericTag<McpToolClockService>(
  "@whatsapp-mcp/api/McpToolClock",
);

export interface McpToolIdentifiersService {
  readonly nextAuditLogId: Effect.Effect<string>;
}

export const McpToolIdentifiers = Context.GenericTag<McpToolIdentifiersService>(
  "@whatsapp-mcp/api/McpToolIdentifiers",
);

export interface McpCursorSigningService {
  readonly key: CryptoKey;
}

export const McpCursorSigning = Context.GenericTag<McpCursorSigningService>(
  "@whatsapp-mcp/api/McpCursorSigning",
);

export interface McpCursorCodecService {
  readonly decode: (input: {
    readonly context: CursorContext;
    readonly cursor: string;
    readonly nowEpochSeconds: number;
  }) => Effect.Effect<CursorBoundary, InvalidCursorError>;
  readonly encode: (input: {
    readonly boundary: CursorBoundary;
    readonly context: CursorContext;
    readonly expiresAtEpochSeconds: number;
  }) => Effect.Effect<string, McpToolPersistenceError>;
}

export const McpCursorCodec = Context.GenericTag<McpCursorCodecService>(
  "@whatsapp-mcp/api/McpCursorCodec",
);

export const makeMcpCursorCodec = (key: CryptoKey): McpCursorCodecService => ({
  decode: ({ context, cursor, nowEpochSeconds }) =>
    verifyCursor(key, cursor, context, nowEpochSeconds),
  encode: ({ boundary, context, expiresAtEpochSeconds }) =>
    signCursor(key, { boundary, context, expiresAtEpochSeconds }).pipe(
      Effect.mapError(() => new McpToolPersistenceError()),
    ),
});

export type McpToolRequirements =
  | EnvelopeEncryption
  | McpCursorCodecService
  | McpToolClockService
  | McpToolIdentifiersService
  | McpToolPersistenceService
  | SendTextMessageService
  | SafeTelemetryService
  | StoredMediaContainer
  | EnvelopeEncryption
  | McpCursorSigningService;

const ListConnectionsInput = z.object({}).strict();
const ListChatsInput = z
  .object({
    connection_id: z.string().regex(/^con_[A-Za-z0-9_-]{21}$/u),
    kind: z.enum(["all", "direct", "group"]).default("all"),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .strict();
const ListChatsOutputSchema = z
  .object({
    chats: z
      .array(
        z
          .object({
            conversation_id: z.string().regex(/^cvs_[A-Za-z0-9_-]{21}$/u),
            kind: z.enum(["direct", "group"]),
            recipient_id: z.string().regex(/^(ctc|grp)_[A-Za-z0-9_-]{21}$/u),
            display_name: z.string().min(1).max(64).nullable(),
            phone: z
              .string()
              .regex(/^\+[1-9][0-9]{6,14}$/u)
              .nullable(),
            phone_last_four: z
              .string()
              .regex(/^\d{4}$/u)
              .nullable(),
            last_activity_at: z.iso.datetime(),
            last_activity_direction: z.enum(["inbound", "outbound"]),
          })
          .strict(),
      )
      .max(50),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
    as_of: z.iso.datetime(),
    stale: z.boolean(),
    partial: z.boolean(),
  })
  .strict();
const ReadMessagesInput = z
  .object({
    connection_id: z.string().regex(/^con_[A-Za-z0-9_-]{21}$/u),
    conversation_id: z.string().regex(/^cvs_[A-Za-z0-9_-]{21}$/u),
    limit: z.number().int().min(1).max(50).default(20),
    older_cursor: z.string().min(1).max(4096).optional(),
  })
  .strict();
const ReadMessagesOutputSchema = z
  .object({
    conversation_id: z.string().regex(/^cvs_[A-Za-z0-9_-]{21}$/u),
    kind: z.enum(["direct", "group"]),
    recipient_id: z.string().regex(/^(ctc|grp)_[A-Za-z0-9_-]{21}$/u),
    messages: z
      .array(
        z
          .object({
            message_id: z.string().regex(/^msg_[A-Za-z0-9_-]{21}$/u),
            sent_at: z.iso.datetime(),
            direction: z.enum(["inbound", "outbound"]),
            sender: z
              .object({
                kind: z.enum(["self", "contact", "group_participant"]),
                display_name: z.string().nullable(),
                phone_last_four: z
                  .string()
                  .regex(/^\d{4}$/u)
                  .nullable(),
              })
              .strict(),
            content_type: z.enum([
              "text",
              "image",
              "audio",
              "video",
              "document",
              "sticker",
              "unknown",
            ]),
            text: z.string().nullable(),
            text_truncated: z.boolean(),
            text_total_utf8_bytes: z.number().int().nonnegative().nullable(),
            edited_at: z.iso.datetime().nullable(),
            deleted: z.boolean(),
            media: z
              .object({
                media_id: z.string().regex(/^med_[A-Za-z0-9_-]{21}$/u),
                type: z.enum([
                  "image",
                  "audio",
                  "video",
                  "document",
                  "sticker",
                ]),
                state: z.enum(["pending", "ready", "rejected", "failed"]),
                size_bytes: z.number().int().nonnegative().nullable(),
                mime_type: z.string().nullable(),
                file_name: z.string().nullable(),
                resource_uri: z.string().nullable(),
                resource_unavailable_reason: z
                  .enum([
                    "media_pending",
                    "media_rejected",
                    "media_failed",
                    "too_large_for_mcp",
                  ])
                  .nullable(),
                resource_size_limit_bytes: z.literal(16_777_216),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .max(50),
    size_limited: z.boolean(),
    has_older: z.boolean(),
    older_cursor: z.string().nullable(),
    history_starts_at: z.iso.datetime(),
    history_start_reason: z.enum(["connection_started", "retention_policy"]),
    gaps: z.array(
      z
        .object({
          starts_at: z.iso.datetime(),
          ends_at: z.iso.datetime().nullable(),
          cause: z.enum([
            "connection_unavailable",
            "webhook_configuration",
            "health_check_failure",
            "ingress_failure",
            "processing_failure",
            "restore_loss",
          ]),
        })
        .strict(),
    ),
  })
  .strict();
const ListConnectionsOutputSchema = z
  .object({
    connections: z
      .array(
        z
          .object({
            connection_id: z.string().regex(/^con_[A-Za-z0-9_-]{21}$/u),
            display_name: z.string().nullable(),
            number_last_four: z
              .string()
              .regex(/^[0-9]{4}$/u)
              .nullable(),
            state: z.enum([
              "connected",
              "connecting",
              "disconnected",
              "reconnect_required",
              "degraded",
            ]),
            state_changed_at: z.iso.datetime(),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();

const codePointLength = (value: string): number => Array.from(value).length;
const listGroupsDescription =
  "List currently joined WhatsApp Recipients in one selected WhatsApp Connection without roster or provider metadata. Returns group_id handles for directory lookup and sending; group_id cannot be used as read_messages.conversation_id. Use list_chats to find observed group conversations.";
const listChatsDescription =
  "List recent WhatsApp Conversations with observed Stored Message activity. Use this to browse recent or unnamed conversations. Do not page through this tool when the User names a contact; call list_contacts with its search input instead. Pass a returned conversation_id to read_messages or recipient_id to send_text_message.";
const readMessagesDescription =
  "Read a chronological page of one observed WhatsApp Conversation. Get conversation_id from list_contacts when the User names a person, or from list_chats when browsing recent conversations. The returned recipient_id can be passed directly to send_text_message without another contact lookup.";
const listContactsDescription =
  "Find active contacts in one selected WhatsApp Connection. When the User names a person, call this tool with its search input; do not use search_messages to locate a person. contact_id can be passed to send_text_message. conversation_id can be passed to read_messages when messages:read is granted and retained activity exists; otherwise it is null.";
const sendTextMessageDescription =
  "Send exact text once to a current WhatsApp Recipient after Client Confirmation. Use recipient_id already returned by list_contacts, list_groups, list_chats, or read_messages; do not look up the same recipient again. Generate a fresh idempotency_key of exactly 21 characters matching [A-Za-z0-9_-]{21}; reuse that exact key only to retry the same connection, recipient, and text.";
const searchMessagesDescription =
  "Search exact normalized words in retained Stored Message text and captions within one selected WhatsApp Connection. Results are newest first, not relevance ranked.";
const ListGroupsInput = z
  .object({
    connection_id: z.string().regex(/^con_[A-Za-z0-9_-]{21}$/u),
    search: z
      .string()
      .refine((value) => {
        const length = codePointLength(normalizeGroupDisplayName(value));
        return length >= 3 && length <= 64;
      }, "search must contain 3 to 64 characters")
      .optional(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().max(4_096).optional(),
  })
  .strict();
const ListGroupsOutputSchema = z
  .object({
    groups: z
      .array(
        z
          .object({
            group_id: z.string().regex(/^grp_[A-Za-z0-9_-]{21}$/u),
            display_name: z.string().nullable(),
          })
          .strict(),
      )
      .max(50),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
    as_of: z.iso.datetime(),
    stale: z.boolean(),
    partial: z.boolean(),
  })
  .strict();

const ListContactsInput = z
  .object({
    connection_id: z.string().regex(/^con_[A-Za-z0-9_-]{21}$/u),
    cursor: z.string().min(1).max(4_096).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    search: z
      .string()
      .refine((value) => {
        if (value.startsWith("+")) return /^\+[1-9]\d{6,14}$/u.test(value);
        const length = Array.from(normalizeContactDisplayName(value)).length;
        return length >= 3 && length <= 64;
      })
      .optional(),
  })
  .strict();

const ListContactsOutputSchema = z
  .object({
    as_of: z.iso.datetime(),
    contacts: z
      .array(
        z
          .object({
            contact_id: z.string().regex(/^ctc_[A-Za-z0-9_-]{21}$/u),
            conversation_id: z
              .string()
              .regex(/^cvs_[A-Za-z0-9_-]{21}$/u)
              .nullable(),
            display_name: z.string().nullable(),
            phone_last_four: z
              .string()
              .regex(/^[0-9]{4}$/u)
              .nullable(),
          })
          .strict(),
      )
      .max(50),
    has_more: z.boolean(),
    next_cursor: z.string().min(1).nullable(),
    partial: z.boolean(),
    stale: z.boolean(),
  })
  .strict();

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
const SendTextMessageInput = z
  .object({
    connection_id: z.string().regex(/^con_[A-Za-z0-9_-]{21}$/u),
    recipient_id: z.string().regex(/^(?:ctc|grp)_[A-Za-z0-9_-]{21}$/u),
    text: z
      .string()
      .min(1)
      .refine((value) => {
        const length = Array.from(value).length;
        return (
          length >= 1 &&
          length <= 4_096 &&
          !hasUnpairedSurrogate(value) &&
          !isOnlyUnicodeWhiteSpace(value)
        );
      }, "text must contain 1 to 4096 Unicode scalar values and non-whitespace"),
    idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{21}$/u),
  })
  .strict();
const SendTextMessageOutputSchema = z
  .object({
    send_id: z.string().regex(/^snd_[A-Za-z0-9_-]{21}$/u),
    status: z.enum([
      "processing",
      "accepted",
      "sent",
      "delivered",
      "read",
      "failed",
      "unknown",
    ]),
    created_at: z.iso.datetime(),
    status_changed_at: z.iso.datetime(),
    idempotent_replay: z.boolean(),
  })
  .strict();
const GetSendStatusInput = z
  .object({
    connection_id: z.string().regex(/^con_[A-Za-z0-9_-]{21}$/u),
    send_id: z.string().regex(/^snd_[A-Za-z0-9_-]{21}$/u),
  })
  .strict();
const GetSendStatusOutputSchema = SendTextMessageOutputSchema.omit({
  idempotent_replay: true,
});
const SearchMessagesInput = z
  .object({
    connection_id: z.string().regex(/^con_[A-Za-z0-9_-]{21}$/u),
    query: z.string().refine((value) => {
      try {
        validateMessageSearchQuery(value);
        return true;
      } catch {
        return false;
      }
    }, "query must contain 1 to 256 Unicode scalar values and 1 to 8 normalized terms"),
    conversation_id: z
      .string()
      .regex(/^cvs_[A-Za-z0-9_-]{21}$/u)
      .optional(),
    direction: z.enum(["all", "inbound", "outbound"]).default("all"),
    after: z.iso.datetime().optional(),
    before: z.iso.datetime().optional(),
    limit: z.number().int().min(1).max(20).default(20),
    cursor: z.string().min(1).max(4_096).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.after === undefined ||
      value.before === undefined ||
      new Date(value.after) < new Date(value.before),
    {
      message: "after must be earlier than before",
    },
  );
const ingestionGapSchema = z
  .object({
    starts_at: z.iso.datetime(),
    ends_at: z.iso.datetime().nullable(),
    cause: z.enum([
      "connection_unavailable",
      "webhook_configuration",
      "health_check_failure",
      "ingress_failure",
      "processing_failure",
      "restore_loss",
    ]),
  })
  .strict();
const SearchMessagesOutputSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            message_id: z.string().regex(/^msg_[A-Za-z0-9_-]{21}$/u),
            conversation_id: z.string().regex(/^cvs_[A-Za-z0-9_-]{21}$/u),
            sent_at: z.iso.datetime(),
            direction: z.enum(["inbound", "outbound"]),
            content_type: z.enum([
              "text",
              "image",
              "audio",
              "video",
              "document",
              "sticker",
              "unknown",
            ]),
            text: z.string().nullable(),
            text_truncated: z.boolean(),
            text_total_utf8_bytes: z.number().int().nonnegative().nullable(),
            edited_at: z.iso.datetime().nullable(),
          })
          .strict(),
      )
      .max(20),
    size_limited: z.boolean(),
    has_more: z.boolean(),
    next_cursor: z.string().min(1).nullable(),
    coverage: z
      .object({
        history_starts_at: z.iso.datetime(),
        history_start_reason: z.enum([
          "connection_started",
          "retention_policy",
        ]),
        searchable_history_starts_at: z.iso.datetime().nullable(),
        index_version: z.literal("v1"),
        backfill_complete: z.boolean(),
        partial: z.boolean(),
        partial_reasons: z
          .array(z.enum(["index_backfill", "ingestion_gap"]))
          .max(2),
        gaps: z.array(ingestionGapSchema),
      })
      .strict(),
  })
  .strict();

const buildListConnectionsResult = makeSuccessResultBuilder(
  ListConnectionsOutputContract,
);
const buildListGroupsResult = makeSuccessResultBuilder(
  ListGroupsOutputContract,
);

const buildListContactsResult = makeSuccessResultBuilder(
  ListContactsOutputContract,
);
const buildSendTextMessageResult = makeSuccessResultBuilder(
  SendTextMessageOutputContract,
);
const buildGetSendStatusResult = makeSuccessResultBuilder(
  GetSendStatusOutputContract,
);
const buildListChatsResult = makeSuccessResultBuilder(ListChatsOutputContract);
const buildReadMessagesResult = makeSuccessResultBuilder(
  ReadMessagesOutputContract,
);
const buildSearchMessagesResult = makeSuccessResultBuilder(
  SearchMessagesOutputContract,
);

const auditUnavailable = () =>
  makeExecutionErrorResult({
    error_code: "audit_unavailable",
    message: "Tool audit is temporarily unavailable.",
    retryable: true,
  });

const authorizationDenied = () =>
  makeExecutionErrorResult({
    error_code: "authorization_denied",
    message: "The MCP Authorization does not permit this tool.",
    retryable: false,
  });

const serviceUnavailable = () =>
  makeExecutionErrorResult({
    error_code: "service_unavailable",
    message: "The service is temporarily unavailable.",
    retryable: true,
  });

const invalidCursor = () =>
  makeExecutionErrorResult({
    error_code: "invalid_cursor",
    message: "The pagination cursor is invalid or expired.",
    retryable: false,
  });

const sendError = (
  error_code:
    | "connection_unavailable"
    | "idempotency_conflict"
    | "recipient_not_found",
) =>
  makeExecutionErrorResult({
    error_code,
    message:
      error_code === "connection_unavailable"
        ? "The WhatsApp Connection is unavailable for new sends."
        : error_code === "idempotency_conflict"
          ? "The idempotency key is already bound to different exact inputs."
          : "The WhatsApp Recipient was not found.",
    retryable: error_code === "connection_unavailable",
  });

const rateLimited = (retryAfterSeconds: number, resetsAt: Date) =>
  makeExecutionErrorResult({
    error_code: "rate_limited",
    message: "The request quota is exhausted.",
    resets_at: resetsAt.toISOString(),
    retry_after_seconds: retryAfterSeconds,
    retryable: true,
  });

type McpToolOutcome =
  | "audit_unavailable"
  | "authorization_denied"
  | "execution_error"
  | "invalid_cursor"
  | "rate_limited"
  | "service_unavailable"
  | "success";

type McpToolFailureStage = NonNullable<
  McpToolCallCompletedEvent["failureStage"]
>;

const emitToolCompletion = (
  tool: McpToolName,
  outcome: McpToolOutcome,
  resultCount?: number,
  failureStage?: McpToolFailureStage,
): Effect.Effect<void, never, SafeTelemetryService> =>
  Effect.gen(function* () {
    const telemetry = yield* SafeTelemetry;
    yield* telemetry.emit({
      event: "mcp.tool_call.completed",
      ...(failureStage === undefined ? {} : { failureStage }),
      outcome,
      ...(resultCount === undefined ? {} : { resultCount }),
      service: "api",
      tool,
    });
  });

const listConnections = (
  authorization: McpAccessAuthorization,
  hourLimit: number,
  minuteLimit: number,
): Effect.Effect<
  | ReturnType<typeof buildListConnectionsResult>
  | ReturnType<typeof auditUnavailable>,
  never,
  McpToolRequirements
> =>
  Effect.gen(function* () {
    const clock = yield* McpToolClock;
    const identifiers = yield* McpToolIdentifiers;
    const persistence = yield* McpToolPersistence;
    const auditLogId = yield* identifiers.nextAuditLogId;
    const startedAt = yield* clock.now;
    const started = yield* persistence
      .beginProtectedOperation({
        ...authorization,
        auditLogId,
        hourLimit,
        minuteLimit,
        observedAt: startedAt,
        operationName: "list_connections",
      })
      .pipe(Effect.either);

    if (started._tag === "Left") {
      yield* emitToolCompletion("list_connections", "audit_unavailable");
      return auditUnavailable();
    }
    if (started.right.outcome === "authorization_denied") {
      yield* emitToolCompletion("list_connections", "authorization_denied");
      return authorizationDenied();
    }
    if (started.right.outcome === "rate_limited") {
      yield* emitToolCompletion("list_connections", "rate_limited");
      return rateLimited(
        started.right.retryAfterSeconds,
        started.right.resetsAt,
      );
    }

    const readAt = yield* clock.now;
    const loaded = yield* persistence
      .listConnections({
        ...authorization,
        authorizationContextEstablished: true,
        observedAt: readAt,
      })
      .pipe(Effect.either);
    if (loaded._tag === "Left") {
      const completedAt = yield* clock.now;
      const completed = yield* persistence
        .completeProtectedOperation({
          auditLogId,
          completedAt,
          errorCode: "service_unavailable",
          outcome: "execution_error",
          resultCount: null,
        })
        .pipe(Effect.either);
      const outcome =
        completed._tag === "Left"
          ? ("audit_unavailable" as const)
          : ("service_unavailable" as const);
      yield* emitToolCompletion("list_connections", outcome);
      return completed._tag === "Left"
        ? auditUnavailable()
        : serviceUnavailable();
    }
    if (loaded.right === null) {
      const completedAt = yield* clock.now;
      const completed = yield* persistence
        .completeProtectedOperation({
          auditLogId,
          completedAt,
          errorCode: "authorization_denied",
          outcome: "authorization_denied",
          resultCount: null,
        })
        .pipe(Effect.either);
      const outcome =
        completed._tag === "Left"
          ? ("audit_unavailable" as const)
          : ("authorization_denied" as const);
      yield* emitToolCompletion("list_connections", outcome);
      return completed._tag === "Left"
        ? auditUnavailable()
        : authorizationDenied();
    }

    const encryption = yield* EnvelopeEncryptionService;
    const revealed = yield* Effect.forEach(
      loaded.right,
      (connection) =>
        connection.displayNameFallback !== null
          ? Effect.succeed({
              connection,
              displayName: connection.displayNameFallback,
            })
          : connection.accountKey === null ||
              connection.connectionKey === null ||
              connection.displayName === null
            ? Effect.fail(
                new EncryptionError({
                  operation: "decrypt",
                  stage: "ciphertext",
                }),
              )
            : encryption
                .decrypt({
                  accountKey: connection.accountKey,
                  ciphertext: connection.displayName,
                  connectionKey: connection.connectionKey,
                  context: {
                    accountId: connection.accountKey.personalAccountId,
                    connectionId: connection.connectionId,
                    entity: "whatsapp-connection",
                    fieldOrObjectPurpose: "display-name",
                    recordId: connection.connectionId,
                  },
                })
                .pipe(
                  Effect.map((bytes) => ({
                    connection,
                    displayName: new TextDecoder("utf-8", {
                      fatal: true,
                      ignoreBOM: false,
                    }).decode(bytes),
                  })),
                ),
      { concurrency: 3 },
    ).pipe(Effect.either);
    if (
      revealed._tag === "Left" ||
      revealed.right.some(
        ({ displayName }) =>
          normalizeWhatsAppConnectionName(displayName) !== displayName,
      )
    ) {
      const completedAt = yield* clock.now;
      const completed = yield* persistence
        .completeProtectedOperation({
          auditLogId,
          completedAt,
          errorCode: "service_unavailable",
          outcome: "execution_error",
          resultCount: null,
        })
        .pipe(Effect.either);
      yield* emitToolCompletion(
        "list_connections",
        completed._tag === "Left" ? "audit_unavailable" : "service_unavailable",
        undefined,
        "decryption",
      );
      return completed._tag === "Left"
        ? auditUnavailable()
        : serviceUnavailable();
    }

    const output: ListConnectionsOutput =
      ListConnectionsOutputContract.decodeUnknown({
        connections: revealed.right.map(({ connection, displayName }) => ({
          connection_id: connection.publicId,
          display_name: displayName,
          number_last_four: connection.numberLastFour,
          state: connection.state,
          state_changed_at: connection.stateChangedAt,
        })),
      });
    const result = buildListConnectionsResult(output);
    const completedAt = yield* clock.now;
    const completed = yield* persistence
      .completeProtectedOperation({
        auditLogId,
        completedAt,
        errorCode: null,
        outcome: "success",
        resultCount: output.connections.length,
      })
      .pipe(Effect.either);
    yield* emitToolCompletion(
      "list_connections",
      completed._tag === "Left" ? "audit_unavailable" : "success",
      completed._tag === "Left" ? undefined : output.connections.length,
    );
    return completed._tag === "Left" ? auditUnavailable() : result;
  }).pipe(Effect.catchAll(() => Effect.succeed(auditUnavailable())));

const sendTextMessage = (
  authorization: McpAccessAuthorization,
  input: z.infer<typeof SendTextMessageInput>,
  deferProviderAttempt?: (attempt: Promise<void>) => void,
) =>
  Effect.gen(function* () {
    const service = yield* SendTextMessage;
    const result = yield* service.send(
      {
        connectionId: input.connection_id,
        grant: mcpSendGrant(authorization),
        idempotencyKey: input.idempotency_key,
        recipientId: input.recipient_id,
        text: input.text,
      },
      deferProviderAttempt,
    );
    if (result.outcome === "receipt") {
      yield* emitToolCompletion("send_text_message", "success", 1);
      return buildSendTextMessageResult(result.receipt);
    }
    if (result.outcome === "rate_limited") {
      yield* emitToolCompletion("send_text_message", "rate_limited");
      return rateLimited(result.retryAfterSeconds, result.resetsAt);
    }
    if (result.outcome === "authorization_denied") {
      yield* emitToolCompletion("send_text_message", "authorization_denied");
      return authorizationDenied();
    }
    if (result.outcome === "audit_unavailable") {
      yield* emitToolCompletion("send_text_message", "audit_unavailable");
      return auditUnavailable();
    }
    if (result.outcome === "service_unavailable") {
      yield* emitToolCompletion("send_text_message", "service_unavailable");
      return serviceUnavailable();
    }
    yield* emitToolCompletion("send_text_message", "execution_error");
    return sendError(result.outcome);
  }).pipe(Effect.catchAll(() => Effect.succeed(auditUnavailable())));

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const getSendStatus = (
  authorization: McpAccessAuthorization,
  input: z.infer<typeof GetSendStatusInput>,
  hourLimit: number,
  minuteLimit: number,
) =>
  Effect.gen(function* () {
    const clock = yield* McpToolClock;
    const identifiers = yield* McpToolIdentifiers;
    const persistence = yield* McpToolPersistence;
    const auditLogId = yield* identifiers.nextAuditLogId;
    const observedAt = yield* clock.now;
    const started = yield* persistence
      .beginProtectedOperation({
        ...authorization,
        auditLogId,
        connectionPublicId: input.connection_id,
        hourLimit,
        minuteLimit,
        observedAt,
        sendPublicId: input.send_id,
        operationName: "get_send_status",
      })
      .pipe(Effect.either);
    if (started._tag === "Left") return auditUnavailable();
    if (started.right.outcome === "authorization_denied") {
      yield* emitToolCompletion("get_send_status", "authorization_denied");
      return authorizationDenied();
    }
    if (started.right.outcome === "rate_limited") {
      yield* emitToolCompletion("get_send_status", "rate_limited");
      return rateLimited(
        started.right.retryAfterSeconds,
        started.right.resetsAt,
      );
    }
    if (persistence.getSendStatus === undefined) return serviceUnavailable();
    const loaded = yield* persistence
      .getSendStatus({
        ...authorization,
        connectionPublicId: input.connection_id,
        observedAt,
        sendPublicId: input.send_id,
      })
      .pipe(Effect.either);
    const completedAt = yield* clock.now;
    if (loaded._tag === "Left") {
      yield* persistence.completeProtectedOperation({
        auditLogId,
        completedAt,
        errorCode: "service_unavailable",
        outcome: "execution_error",
        resultCount: null,
      });
      yield* emitToolCompletion("get_send_status", "service_unavailable");
      return serviceUnavailable();
    }
    if (loaded.right === null) {
      yield* persistence.completeProtectedOperation({
        auditLogId,
        completedAt,
        errorCode: "send_not_found",
        outcome: "execution_error",
        resultCount: null,
      });
      yield* emitToolCompletion("get_send_status", "execution_error");
      return makeExecutionErrorResult({
        error_code: "send_not_found",
        message: "The Send Operation was not found.",
        retryable: false,
      });
    }
    const output: GetSendStatusOutput =
      GetSendStatusOutputContract.decodeUnknown({
        created_at: loaded.right.createdAt,
        send_id: loaded.right.publicId,
        status: loaded.right.status,
        status_changed_at: loaded.right.statusChangedAt,
      });
    yield* persistence.completeProtectedOperation({
      auditLogId,
      completedAt,
      errorCode: null,
      outcome: "success",
      resultCount: 1,
    });
    yield* emitToolCompletion("get_send_status", "success", 1);
    return buildGetSendStatusResult(output);
  }).pipe(Effect.catchAll(() => Effect.succeed(auditUnavailable())));

const listGroups = (
  authorization: McpAccessAuthorization,
  input: z.infer<typeof ListGroupsInput>,
  hourLimit: number,
  minuteLimit: number,
) =>
  Effect.gen(function* () {
    const clock = yield* McpToolClock;
    const identifiers = yield* McpToolIdentifiers;
    const persistence = yield* McpToolPersistence;
    const cursorSigning = yield* McpCursorSigning;
    const encryption = yield* EnvelopeEncryptionService;
    const startedAt = yield* clock.now;

    const normalizedSearch =
      input.search === undefined
        ? null
        : normalizeGroupDisplayName(input.search);
    const cursorContext: CursorContext = {
      authorizationId: authorization.authorizationId,
      connectionId: input.connection_id as CursorContext["connectionId"],
      filters: { search: normalizedSearch },
      pageSize: input.limit,
      sortVersion: "groups-normalized-name-v1",
      tool: "list_groups",
    };
    let boundary: CursorBoundary | null = null;
    if (input.cursor !== undefined) {
      const verified = yield* verifyCursor(
        cursorSigning.key,
        input.cursor,
        cursorContext,
        Math.floor(startedAt.valueOf() / 1_000),
      ).pipe(Effect.either);
      if (verified._tag === "Left") {
        return invalidCursor();
      }
      boundary = verified.right;
      if (
        boundary.length !== 2 ||
        typeof boundary[0] !== "string" ||
        typeof boundary[1] !== "string"
      ) {
        return invalidCursor();
      }
    }

    const auditLogId = yield* identifiers.nextAuditLogId;
    const started = yield* persistence
      .beginProtectedOperation({
        ...authorization,
        auditLogId,
        connectionPublicId: input.connection_id,
        hourLimit,
        minuteLimit,
        observedAt: startedAt,
        operationName: "list_groups",
      })
      .pipe(Effect.either);
    if (started._tag === "Left") {
      yield* emitToolCompletion("list_groups", "audit_unavailable");
      return auditUnavailable();
    }
    if (started.right.outcome === "authorization_denied") {
      yield* emitToolCompletion("list_groups", "authorization_denied");
      return authorizationDenied();
    }
    if (started.right.outcome === "rate_limited") {
      yield* emitToolCompletion("list_groups", "rate_limited");
      return rateLimited(
        started.right.retryAfterSeconds,
        started.right.resetsAt,
      );
    }

    const failAfterAudit = (
      errorCode: "authorization_denied" | "service_unavailable",
    ) =>
      Effect.gen(function* () {
        const denied = errorCode === "authorization_denied";
        const completed = yield* persistence
          .completeProtectedOperation({
            auditLogId,
            completedAt: yield* clock.now,
            errorCode,
            outcome: denied ? "authorization_denied" : "execution_error",
            resultCount: null,
          })
          .pipe(Effect.either);
        const outcome =
          completed._tag === "Left"
            ? "audit_unavailable"
            : denied
              ? "authorization_denied"
              : "service_unavailable";
        yield* emitToolCompletion("list_groups", outcome);
        return completed._tag === "Left"
          ? auditUnavailable()
          : denied
            ? authorizationDenied()
            : serviceUnavailable();
      });

    let searchIndex: string | null = null;
    if (normalizedSearch !== null) {
      const material = yield* persistence
        .loadGroupSearchMaterial({
          ...authorization,
          connectionPublicId: input.connection_id,
          observedAt: yield* clock.now,
        })
        .pipe(Effect.either);
      if (material._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
      if (material.right === null) {
        return yield* failAfterAudit("authorization_denied");
      }
      const searchMaterial = material.right;
      const identityKey = yield* encryption
        .decrypt({
          accountKey: searchMaterial.accountKey,
          ciphertext: searchMaterial.identityKey,
          connectionKey: searchMaterial.connectionKey,
          context: {
            accountId: searchMaterial.accountKey.personalAccountId,
            connectionId: searchMaterial.connectionKey.connectionId,
            entity: "whatsapp-connection",
            fieldOrObjectPurpose: "webhook-identity-key",
            recordId: searchMaterial.connectionKey.connectionId,
          },
        })
        .pipe(Effect.either);
      if (identityKey._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
      const indexed = yield* Effect.acquireUseRelease(
        Effect.succeed(identityKey.right),
        (bytes) =>
          importGroupDirectoryIndexKey(bytes).pipe(
            Effect.flatMap((key) =>
              groupSearchIndex(
                key,
                searchMaterial.connectionKey.connectionId,
                normalizedSearch,
              ),
            ),
          ),
        (bytes) => Effect.sync(() => bytes.fill(0)),
      ).pipe(Effect.either);
      if (indexed._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
      searchIndex = indexed.right;
    }

    const readAt = yield* clock.now;
    const loaded = yield* persistence
      .listGroups({
        ...authorization,
        connectionPublicId: input.connection_id,
        observedAt: readAt,
        searchIndex,
      })
      .pipe(Effect.either);
    if (loaded._tag === "Left" || loaded.right === null) {
      return yield* failAfterAudit(
        loaded._tag === "Right"
          ? "authorization_denied"
          : "service_unavailable",
      );
    }

    const page = loaded.right;
    const decrypted = yield* Effect.forEach(page.groups, (group) =>
      group.displayName === null
        ? Effect.succeed({
            displayName: null as string | null,
            normalizedName: "",
            publicId: group.publicId,
          })
        : encryption
            .decrypt({
              accountKey: page.accountKey,
              ciphertext: group.displayName,
              connectionKey: page.connectionKey,
              context: {
                accountId: page.accountKey.personalAccountId,
                connectionId: page.connectionKey.connectionId,
                entity: "whatsapp-group",
                fieldOrObjectPurpose: "display-name",
                recordId: group.id,
              },
            })
            .pipe(
              Effect.flatMap((bytes) =>
                Effect.acquireUseRelease(
                  Effect.succeed(bytes),
                  (value) =>
                    Effect.try({
                      try: () =>
                        new TextDecoder("utf-8", {
                          fatal: true,
                          ignoreBOM: false,
                        }).decode(value),
                      catch: () => new McpToolPersistenceError(),
                    }),
                  (value) => Effect.sync(() => value.fill(0)),
                ),
              ),
              Effect.map((displayName) => ({
                displayName,
                normalizedName: normalizeGroupDisplayName(displayName),
                publicId: group.publicId,
              })),
            ),
    ).pipe(Effect.either);
    if (decrypted._tag === "Left") {
      const completed = yield* persistence
        .completeProtectedOperation({
          auditLogId,
          completedAt: yield* clock.now,
          errorCode: "service_unavailable",
          outcome: "execution_error",
          resultCount: null,
        })
        .pipe(Effect.either);
      yield* emitToolCompletion(
        "list_groups",
        completed._tag === "Left" ? "audit_unavailable" : "service_unavailable",
      );
      return completed._tag === "Left"
        ? auditUnavailable()
        : serviceUnavailable();
    }

    const ordered = decrypted.right
      .filter(
        (group) =>
          normalizedSearch === null ||
          group.normalizedName.startsWith(normalizedSearch),
      )
      .sort(
        (left, right) =>
          compareText(left.normalizedName, right.normalizedName) ||
          compareText(left.publicId, right.publicId),
      )
      .filter((group) => {
        if (boundary === null) return true;
        const [name, publicId] = boundary as readonly [string, string];
        return (
          compareText(group.normalizedName, name) > 0 ||
          (group.normalizedName === name &&
            compareText(group.publicId, publicId) > 0)
        );
      });
    const selected = ordered.slice(0, input.limit);
    const hasMore = ordered.length > input.limit;
    let nextCursor: string | null = null;
    if (hasMore) {
      const last = selected.at(-1);
      if (last === undefined) return serviceUnavailable();
      nextCursor = yield* signCursor(cursorSigning.key, {
        boundary: [last.normalizedName, last.publicId],
        context: cursorContext,
        expiresAtEpochSeconds: Math.floor(startedAt.valueOf() / 1_000) + 900,
      });
    }
    const asOf = new Date(page.asOf);
    const output: ListGroupsOutput = ListGroupsOutputContract.decodeUnknown({
      groups: selected.map((group) => ({
        display_name: group.displayName,
        group_id: group.publicId,
      })),
      has_more: hasMore,
      next_cursor: nextCursor,
      as_of: page.asOf,
      stale: page.stale || readAt.valueOf() - asOf.valueOf() > 10 * 60 * 1_000,
      partial: page.partial,
    });
    const result = buildListGroupsResult(output);
    const completed = yield* persistence
      .completeProtectedOperation({
        auditLogId,
        completedAt: yield* clock.now,
        errorCode: null,
        outcome: "success",
        resultCount: output.groups.length,
      })
      .pipe(Effect.either);
    yield* emitToolCompletion(
      "list_groups",
      completed._tag === "Left" ? "audit_unavailable" : "success",
      completed._tag === "Left" ? undefined : output.groups.length,
    );
    return completed._tag === "Left" ? auditUnavailable() : result;
  }).pipe(Effect.catchAll(() => Effect.succeed(auditUnavailable())));

interface OpenContact {
  readonly conversationPublicId: string | null;
  readonly displayName: string | null;
  readonly normalizedDisplayName: string;
  readonly phoneLastFour: string | null;
  readonly publicId: string;
}

interface OpenContactPage {
  readonly asOf: string;
  readonly contacts: ReadonlyArray<OpenContact>;
  readonly partial: boolean;
  readonly snapshotObservedAt: string | null;
  readonly stale: boolean;
}

const listContacts = (
  authorization: McpAccessAuthorization,
  input: z.infer<typeof ListContactsInput>,
  hourLimit: number,
  minuteLimit: number,
) =>
  Effect.gen(function* () {
    const clock = yield* McpToolClock;
    const cursors = yield* McpCursorCodec;
    const persistence = yield* McpToolPersistence;
    const identifiers = yield* McpToolIdentifiers;
    const encryption = yield* EnvelopeEncryptionService;
    const startedAt = yield* clock.now;
    const normalizedSearch =
      input.search === undefined
        ? null
        : /^\+/u.test(input.search)
          ? input.search
          : normalizeContactDisplayName(input.search);
    const cursorContext: CursorContext = {
      authorizationId: authorization.authorizationId,
      connectionId: input.connection_id as CursorContext["connectionId"],
      filters: { search: normalizedSearch },
      pageSize: input.limit,
      sortVersion: "contacts-v1",
      tool: "list_contacts",
    };
    let boundary: readonly [string, string] | null = null;
    if (input.cursor !== undefined) {
      const decoded = yield* cursors
        .decode({
          context: cursorContext,
          cursor: input.cursor,
          nowEpochSeconds: Math.floor(startedAt.valueOf() / 1_000),
        })
        .pipe(Effect.either);
      if (
        decoded._tag === "Left" ||
        decoded.right.length !== 2 ||
        typeof decoded.right[0] !== "string" ||
        typeof decoded.right[1] !== "string" ||
        !/^ctc_[A-Za-z0-9_-]{21}$/u.test(decoded.right[1])
      ) {
        const auditLogId = yield* identifiers.nextAuditLogId;
        const rejected = yield* persistence
          .rejectProtectedOperation({
            ...authorization,
            auditLogId,
            connectionPublicId: input.connection_id,
            errorCode: "invalid_cursor",
            observedAt: startedAt,
            operationName: "list_contacts",
          })
          .pipe(Effect.either);
        const outcome =
          rejected._tag === "Left"
            ? ("audit_unavailable" as const)
            : rejected.right === "authorization_denied"
              ? ("authorization_denied" as const)
              : ("invalid_cursor" as const);
        yield* emitToolCompletion("list_contacts", outcome);
        return rejected._tag === "Left"
          ? auditUnavailable()
          : rejected.right === "authorization_denied"
            ? authorizationDenied()
            : invalidCursor();
      }
      boundary = [decoded.right[0], decoded.right[1]];
    }

    const auditLogId = yield* identifiers.nextAuditLogId;
    const started = yield* persistence
      .beginProtectedOperation({
        ...authorization,
        auditLogId,
        connectionPublicId: input.connection_id,
        hourLimit,
        minuteLimit,
        observedAt: startedAt,
        operationName: "list_contacts",
      })
      .pipe(Effect.either);
    if (started._tag === "Left") {
      yield* emitToolCompletion("list_contacts", "audit_unavailable");
      return auditUnavailable();
    }
    if (started.right.outcome === "authorization_denied") {
      yield* emitToolCompletion("list_contacts", "authorization_denied");
      return authorizationDenied();
    }
    if (started.right.outcome === "rate_limited") {
      yield* emitToolCompletion("list_contacts", "rate_limited");
      return rateLimited(
        started.right.retryAfterSeconds,
        started.right.resetsAt,
      );
    }

    const failAfterAudit = (errorCode: string, denied = false) =>
      Effect.gen(function* () {
        const completed = yield* persistence
          .completeProtectedOperation({
            auditLogId,
            completedAt: yield* clock.now,
            errorCode,
            outcome: denied ? "authorization_denied" : "execution_error",
            resultCount: null,
          })
          .pipe(Effect.either);
        const outcome =
          completed._tag === "Left"
            ? ("audit_unavailable" as const)
            : denied
              ? ("authorization_denied" as const)
              : ("service_unavailable" as const);
        yield* emitToolCompletion("list_contacts", outcome);
        return completed._tag === "Left"
          ? auditUnavailable()
          : denied
            ? authorizationDenied()
            : serviceUnavailable();
      });

    const materialResult = yield* persistence
      .loadContactReadMaterial({
        ...authorization,
        connectionPublicId: input.connection_id,
        observedAt: yield* clock.now,
      })
      .pipe(Effect.either);
    if (materialResult._tag === "Left") {
      return yield* failAfterAudit("service_unavailable");
    }
    const material = materialResult.right;
    if (material === null) {
      return yield* failAfterAudit("authorization_denied", true);
    }
    const identityBytesResult = yield* encryption
      .decrypt({
        accountKey: material.accountKey,
        ciphertext: material.identityKey,
        connectionKey: material.connectionKey,
        context: {
          accountId: material.personalAccountId,
          connectionId: material.whatsappConnectionId,
          entity: "whatsapp-connection",
          fieldOrObjectPurpose: "webhook-identity-key",
          recordId: material.whatsappConnectionId,
        },
      })
      .pipe(Effect.either);
    if (identityBytesResult._tag === "Left") {
      return yield* failAfterAudit("service_unavailable");
    }

    const openedResult = yield* Effect.acquireUseRelease(
      Effect.succeed(identityBytesResult.right),
      (identityBytes) =>
        Effect.gen(function* () {
          const indexKey = yield* importDirectoryIndexKey(identityBytes);
          const search =
            normalizedSearch === null
              ? null
              : yield* contactSearchIndex(
                  indexKey,
                  material.whatsappConnectionId,
                  normalizedSearch,
                );
          const encryptedPage = yield* persistence.listEncryptedContacts({
            ...authorization,
            connectionPublicId: input.connection_id,
            cursorDisplayNameSort: boundary?.[0] ?? null,
            cursorPublicId: boundary?.[1] ?? null,
            limit: input.limit + 1,
            observedAt: yield* clock.now,
            searchIndex: search?.index ?? null,
            searchKind: search?.kind ?? null,
          });
          if (encryptedPage === null) {
            return null;
          }
          const contacts = yield* Effect.forEach(
            encryptedPage.contacts,
            (contact) =>
              Effect.gen(function* () {
                const common = {
                  accountKey: material.accountKey,
                  connectionKey: material.connectionKey,
                  encryption,
                  providerIdentityIndex: contact.providerIdentityIndex,
                } as const;
                const [displayName, phoneNumber] = yield* Effect.all(
                  [
                    decryptDirectoryString({
                      ...common,
                      ciphertext: contact.displayNameCiphertext,
                      field: "display-name",
                    }),
                    decryptDirectoryString({
                      ...common,
                      ciphertext: contact.phoneCiphertext,
                      field: "phone-number",
                    }),
                  ],
                  { concurrency: "unbounded" },
                );
                if (
                  (displayName === null
                    ? ""
                    : normalizeContactDisplayName(displayName)) !==
                    contact.displayNameSort ||
                  (phoneNumber !== null &&
                    !/^\+[1-9]\d{6,14}$/u.test(phoneNumber))
                ) {
                  return yield* Effect.fail(new McpToolPersistenceError());
                }
                return {
                  conversationPublicId: contact.conversationPublicId,
                  displayName,
                  normalizedDisplayName: contact.displayNameSort,
                  phoneLastFour:
                    phoneNumber === null ? null : phoneNumber.slice(-4),
                  publicId: contact.publicId,
                } satisfies OpenContact;
              }),
            { concurrency: 16 },
          );
          return {
            asOf: encryptedPage.asOf,
            contacts,
            partial: encryptedPage.partial,
            snapshotObservedAt: encryptedPage.snapshotObservedAt,
            stale: encryptedPage.stale,
          } satisfies OpenContactPage;
        }),
      (identityBytes) =>
        Effect.sync(() => {
          identityBytes.fill(0);
        }),
    ).pipe(Effect.either);
    if (openedResult._tag === "Left") {
      return yield* failAfterAudit("service_unavailable");
    }
    if (openedResult.right === null) {
      return yield* failAfterAudit("authorization_denied", true);
    }
    const openedPage = openedResult.right;

    const hasMore = openedPage.contacts.length > input.limit;
    const page = openedPage.contacts.slice(0, input.limit);
    const last = page.at(-1);
    const nextCursorResult =
      hasMore && last !== undefined
        ? yield* cursors
            .encode({
              boundary: [last.normalizedDisplayName, last.publicId],
              context: cursorContext,
              expiresAtEpochSeconds:
                Math.floor(startedAt.valueOf() / 1_000) + 900,
            })
            .pipe(
              Effect.map((cursor) => cursor as string | null),
              Effect.either,
            )
        : ({ _tag: "Right", right: null } as const);
    if (nextCursorResult._tag === "Left") {
      return yield* failAfterAudit("service_unavailable");
    }
    const snapshotObservedAt =
      openedPage.snapshotObservedAt === null
        ? null
        : new Date(openedPage.snapshotObservedAt);
    const outputResult = Effect.try({
      try: () =>
        ListContactsOutputContract.decodeUnknown({
          as_of: openedPage.asOf,
          contacts: page.map((contact) => ({
            contact_id: contact.publicId,
            conversation_id: contact.conversationPublicId,
            display_name: contact.displayName,
            phone_last_four: contact.phoneLastFour,
          })),
          has_more: hasMore,
          next_cursor: nextCursorResult.right,
          partial: openedPage.partial,
          stale:
            openedPage.stale ||
            snapshotObservedAt === null ||
            !Number.isFinite(snapshotObservedAt.valueOf()) ||
            startedAt.valueOf() - snapshotObservedAt.valueOf() >
              10 * 60 * 1_000,
        }),
      catch: () => new McpToolPersistenceError(),
    });
    const decodedOutput = yield* outputResult.pipe(Effect.either);
    if (decodedOutput._tag === "Left") {
      return yield* failAfterAudit("service_unavailable");
    }
    const output: ListContactsOutput = decodedOutput.right;
    const completed = yield* persistence
      .completeProtectedOperation({
        auditLogId,
        completedAt: yield* clock.now,
        errorCode: null,
        outcome: "success",
        resultCount: output.contacts.length,
      })
      .pipe(Effect.either);
    yield* emitToolCompletion(
      "list_contacts",
      completed._tag === "Left" ? "audit_unavailable" : "success",
      completed._tag === "Left" ? undefined : output.contacts.length,
    );
    return completed._tag === "Left"
      ? auditUnavailable()
      : buildListContactsResult(output);
  }).pipe(Effect.catchAll(() => Effect.succeed(auditUnavailable())));

const noStore = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

const unavailable = (): Response =>
  new Response(JSON.stringify({ error: "service_unavailable" }), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status: 503,
  });

export interface McpRequestHandlerOptions {
  readonly browserOrigin: string;
  readonly hourLimit: number;
  readonly layer: Layer.Layer<McpToolRequirements, unknown>;
  readonly minuteLimit: number;
  readonly readMessageDailyRecordLimit?: number;
  readonly storedMediaDailyByteLimit?: number;
  readonly resourceUrl: string;
}

const isToolsListPayload = (payload: unknown): boolean => {
  const messages = Array.isArray(payload) ? payload : [payload];
  return messages.some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "method" in message &&
      message.method === "tools/list",
  );
};

const hasMethod = (payload: unknown, method: string): boolean => {
  const messages = Array.isArray(payload) ? payload : [payload];
  return messages.some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "method" in message &&
      message.method === method,
  );
};

const sanitizeAttachmentFilename = (value: string): string | null => {
  const leaf = value.split(/[\\/]/u).at(-1) ?? "";
  const sanitized = Array.from(leaf)
    .map((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 0x1f || point === 0x7f ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 255);
  return sanitized.length === 0 || sanitized === "." || sanitized === ".."
    ? null
    : sanitized;
};

const streamToBase64 = async (
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number,
): Promise<string> => {
  const bytes = new Uint8Array(expectedBytes);
  const reader = stream.getReader();
  let offset = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    if (offset + next.value.byteLength > expectedBytes)
      throw new Error("Stored Media exceeded verified size");
    bytes.set(next.value, offset);
    offset += next.value.byteLength;
  }
  if (offset !== expectedBytes)
    throw new Error("Stored Media did not match verified size");
  const encoded = encodeBase64(bytes);
  bytes.fill(0);
  return encoded;
};

const listChats = (
  authorization: McpAccessAuthorization,
  input: z.infer<typeof ListChatsInput>,
  hourLimit: number,
  minuteLimit: number,
) =>
  Effect.gen(function* () {
    const clock = yield* McpToolClock;
    const identifiers = yield* McpToolIdentifiers;
    const persistence = yield* McpToolPersistence;
    const encryption = yield* EnvelopeEncryptionService;
    const codec = yield* McpCursorCodec;
    const startedAt = yield* clock.now;
    const context: CursorContext = {
      authorizationId: authorization.authorizationId,
      connectionId: input.connection_id as CursorContext["connectionId"],
      filters: { kind: input.kind },
      pageSize: input.limit,
      sortVersion: "chats-activity-v1",
      tool: "list_chats",
    };
    let activity: string | null = null;
    let publicId: string | null = null;
    if (input.cursor !== undefined) {
      const decoded = yield* codec
        .decode({
          context,
          cursor: input.cursor,
          nowEpochSeconds: Math.floor(startedAt.valueOf() / 1000),
        })
        .pipe(Effect.either);
      if (
        decoded._tag === "Left" ||
        decoded.right.length !== 2 ||
        typeof decoded.right[0] !== "string" ||
        typeof decoded.right[1] !== "string"
      )
        return invalidCursor();
      activity = decoded.right[0];
      publicId = decoded.right[1];
    }
    const auditLogId = yield* identifiers.nextAuditLogId;
    const begun = yield* persistence
      .beginProtectedOperation({
        ...authorization,
        auditLogId,
        connectionPublicId: input.connection_id,
        hourLimit,
        minuteLimit,
        observedAt: startedAt,
        operationName: "list_chats",
      })
      .pipe(Effect.either);
    if (begun._tag === "Left") {
      yield* emitToolCompletion("list_chats", "audit_unavailable");
      return auditUnavailable();
    }
    if (begun.right.outcome === "authorization_denied") {
      yield* emitToolCompletion("list_chats", "authorization_denied");
      return authorizationDenied();
    }
    if (begun.right.outcome === "rate_limited") {
      yield* emitToolCompletion("list_chats", "rate_limited");
      return rateLimited(begun.right.retryAfterSeconds, begun.right.resetsAt);
    }
    if (persistence.listChats === undefined) {
      const completed = yield* persistence
        .completeProtectedOperation({
          auditLogId,
          completedAt: yield* clock.now,
          errorCode: "service_unavailable",
          outcome: "execution_error",
          resultCount: null,
        })
        .pipe(Effect.either);
      const outcome =
        completed._tag === "Left"
          ? ("audit_unavailable" as const)
          : ("service_unavailable" as const);
      yield* emitToolCompletion(
        "list_chats",
        outcome,
        undefined,
        "configuration",
      );
      return completed._tag === "Left"
        ? auditUnavailable()
        : serviceUnavailable();
    }
    const loaded = yield* persistence
      .listChats({
        ...authorization,
        connectionPublicId: input.connection_id,
        cursorActivityAt: activity,
        cursorPublicId: publicId,
        kind: input.kind,
        limit: input.limit + 1,
        observedAt: yield* clock.now,
      })
      .pipe(Effect.either);
    const fail = (
      code: "authorization_denied" | "service_unavailable",
      failureStage?: McpToolFailureStage,
    ) =>
      Effect.gen(function* () {
        const complete = yield* persistence
          .completeProtectedOperation({
            auditLogId,
            completedAt: yield* clock.now,
            errorCode: code,
            outcome:
              code === "authorization_denied"
                ? "authorization_denied"
                : "execution_error",
            resultCount: null,
          })
          .pipe(Effect.either);
        const outcome =
          complete._tag === "Left"
            ? ("audit_unavailable" as const)
            : code === "authorization_denied"
              ? ("authorization_denied" as const)
              : ("service_unavailable" as const);
        yield* emitToolCompletion(
          "list_chats",
          outcome,
          undefined,
          complete._tag === "Left" ? "audit_completion" : failureStage,
        );
        return complete._tag === "Left"
          ? auditUnavailable()
          : code === "authorization_denied"
            ? authorizationDenied()
            : serviceUnavailable();
      });
    if (loaded._tag === "Left")
      return yield* fail("service_unavailable", "query");
    if (loaded.right === null) return yield* fail("authorization_denied");
    const page = loaded.right;
    const selected = page.chats.slice(0, input.limit);
    const hasMore = page.chats.length > input.limit;
    if (
      selected.length > 0 &&
      (page.accountKey === null || page.connectionKey === null)
    ) {
      return yield* fail("service_unavailable", "query");
    }
    const accountKey = page.accountKey;
    const connectionKey = page.connectionKey;
    const encryptedMetadata: Array<{
      readonly ciphertext: VersionedCiphertext;
      readonly context: EncryptionContext;
    }> = [];
    const metadataIndexes = selected.map((chat) => {
      const add = (
        ciphertext: VersionedCiphertext | null,
        entity: string,
        purpose: string,
      ): number | null => {
        if (ciphertext === null) return null;
        if (accountKey === null || connectionKey === null)
          throw new Error("missing chat key material");
        encryptedMetadata.push({
          ciphertext,
          context: {
            accountId: accountKey.personalAccountId,
            connectionId: connectionKey.connectionId,
            entity,
            fieldOrObjectPurpose: purpose,
            recordId: chat.displayNameRecordId,
          },
        });
        return encryptedMetadata.length - 1;
      };
      return {
        displayName: add(
          chat.displayName,
          chat.displayNameEntity,
          "display-name",
        ),
        phone: add(chat.phone, "directory-contact", "phone-number"),
      };
    });
    let metadataDecryption: Effect.Effect<
      ReadonlyArray<Uint8Array>,
      EncryptionError | McpToolPersistenceError
    >;
    if (encryptedMetadata.length === 0) {
      metadataDecryption = Effect.succeed([]);
    } else if (accountKey === null || connectionKey === null) {
      metadataDecryption = Effect.fail(new McpToolPersistenceError());
    } else {
      metadataDecryption = encryption.decryptMany({
        accountKey,
        connectionKey,
        items: encryptedMetadata,
      });
    }
    const decryptedMetadata = yield* metadataDecryption.pipe(
      Effect.flatMap((values) =>
        Effect.acquireUseRelease(
          Effect.succeed(values),
          (plaintexts) =>
            Effect.try({
              try: () => {
                const decoder = new TextDecoder("utf-8", {
                  fatal: true,
                  ignoreBOM: false,
                });
                return plaintexts.map((value) => decoder.decode(value));
              },
              catch: () => new McpToolPersistenceError(),
            }),
          (plaintexts) =>
            Effect.sync(() => {
              for (const value of plaintexts) value.fill(0);
            }),
        ),
      ),
      Effect.either,
    );
    const chats =
      decryptedMetadata._tag === "Left"
        ? decryptedMetadata
        : {
            _tag: "Right" as const,
            right: selected.map((chat, index) => {
              const indexes = metadataIndexes[index];
              if (indexes === undefined)
                throw new Error("missing chat metadata indexes");
              return {
                ...chat,
                displayName:
                  indexes.displayName === null
                    ? null
                    : (decryptedMetadata.right[indexes.displayName] ?? null),
                phone:
                  indexes.phone === null
                    ? null
                    : (decryptedMetadata.right[indexes.phone] ?? null),
              };
            }),
          };
    if (chats._tag === "Left") {
      const failureStage =
        chats.left instanceof EncryptionError
          ? chats.left.stage === "account-key"
            ? "decryption_account_key"
            : chats.left.stage === "connection-key"
              ? "decryption_connection_key"
              : chats.left.stage === "ciphertext"
                ? "decryption_ciphertext"
                : "decryption"
          : "decryption";
      return yield* fail("service_unavailable", failureStage);
    }
    let nextCursor: string | null = null;
    if (hasMore) {
      const last = selected.at(-1);
      if (last === undefined)
        return yield* fail("service_unavailable", "output");
      nextCursor = yield* codec.encode({
        boundary: [last.lastActivityAt, last.conversationId],
        context,
        expiresAtEpochSeconds: Math.floor(startedAt.valueOf() / 1000) + 900,
      });
    }
    const output: ListChatsOutput = ListChatsOutputContract.decodeUnknown({
      chats: chats.right.map((chat) => ({
        conversation_id: chat.conversationId,
        kind: chat.kind,
        recipient_id: chat.recipientId,
        display_name: chat.displayName,
        phone: chat.kind === "direct" ? chat.phone : null,
        phone_last_four:
          chat.kind === "direct" && chat.phone !== null
            ? chat.phone.replace(/\D/gu, "").slice(-4) || null
            : null,
        last_activity_at: chat.lastActivityAt,
        last_activity_direction: chat.lastActivityDirection,
      })),
      has_more: hasMore,
      next_cursor: nextCursor,
      as_of: page.asOf,
      stale: page.stale,
      partial: page.partial,
    });
    const complete = yield* persistence
      .completeProtectedOperation({
        auditLogId,
        completedAt: yield* clock.now,
        errorCode: null,
        outcome: "success",
        resultCount: output.chats.length,
      })
      .pipe(Effect.either);
    yield* emitToolCompletion(
      "list_chats",
      complete._tag === "Left" ? "audit_unavailable" : "success",
      complete._tag === "Left" ? undefined : output.chats.length,
      complete._tag === "Left" ? "audit_completion" : undefined,
    );
    return complete._tag === "Left"
      ? auditUnavailable()
      : buildListChatsResult(output);
  }).pipe(Effect.catchAll(() => Effect.succeed(auditUnavailable())));

const readMessages = (
  authorization: McpAccessAuthorization,
  input: z.infer<typeof ReadMessagesInput>,
  hourLimit: number,
  minuteLimit: number,
  dailyRecordLimit: number,
) =>
  Effect.gen(function* () {
    const clock = yield* McpToolClock;
    const identifiers = yield* McpToolIdentifiers;
    const persistence = yield* McpToolPersistence;
    const encryption = yield* EnvelopeEncryptionService;
    const codec = yield* McpCursorCodec;
    const startedAt = yield* clock.now;
    const context: CursorContext = {
      authorizationId: authorization.authorizationId,
      connectionId: input.connection_id as CursorContext["connectionId"],
      filters: { conversation_id: input.conversation_id },
      pageSize: input.limit,
      sortVersion: "messages-sent-v1",
      tool: "read_messages",
    };
    let sentAt: string | null = null;
    let publicId: string | null = null;
    if (input.older_cursor !== undefined) {
      const decoded = yield* codec
        .decode({
          context,
          cursor: input.older_cursor,
          nowEpochSeconds: Math.floor(startedAt.valueOf() / 1000),
        })
        .pipe(Effect.either);
      if (
        decoded._tag === "Left" ||
        decoded.right.length !== 2 ||
        typeof decoded.right[0] !== "string" ||
        typeof decoded.right[1] !== "string"
      )
        return invalidCursor();
      sentAt = decoded.right[0];
      publicId = decoded.right[1];
    }
    const auditLogId = yield* identifiers.nextAuditLogId;
    const begun = yield* persistence
      .beginProtectedOperation({
        ...authorization,
        auditLogId,
        connectionPublicId: input.connection_id,
        hourLimit,
        minuteLimit,
        observedAt: startedAt,
        operationName: "read_messages",
      })
      .pipe(Effect.either);
    if (begun._tag === "Left") {
      yield* emitToolCompletion(
        "read_messages",
        "audit_unavailable",
        undefined,
        "query",
      );
      return auditUnavailable();
    }
    if (begun.right.outcome === "authorization_denied") {
      yield* emitToolCompletion("read_messages", "authorization_denied");
      return authorizationDenied();
    }
    if (begun.right.outcome === "rate_limited") {
      yield* emitToolCompletion("read_messages", "rate_limited");
      return rateLimited(begun.right.retryAfterSeconds, begun.right.resetsAt);
    }
    const fail = (
      code: "authorization_denied" | "rate_limited" | "service_unavailable",
      quotaResetsAt?: Date,
      failureStage?: McpToolFailureStage,
    ) =>
      Effect.gen(function* () {
        const completed = yield* persistence
          .completeProtectedOperation({
            auditLogId,
            completedAt: yield* clock.now,
            errorCode: code,
            outcome:
              code === "authorization_denied"
                ? "authorization_denied"
                : "execution_error",
            resultCount: null,
          })
          .pipe(Effect.either);
        const outcome =
          completed._tag === "Left"
            ? ("audit_unavailable" as const)
            : code === "authorization_denied"
              ? ("authorization_denied" as const)
              : code === "rate_limited"
                ? ("rate_limited" as const)
                : ("service_unavailable" as const);
        yield* emitToolCompletion(
          "read_messages",
          outcome,
          undefined,
          completed._tag === "Left" ? "audit_completion" : failureStage,
        );
        if (completed._tag === "Left") return auditUnavailable();
        return code === "authorization_denied"
          ? authorizationDenied()
          : code === "rate_limited"
            ? rateLimited(
                Math.max(
                  0,
                  Math.ceil(
                    ((
                      quotaResetsAt ??
                      new Date(
                        Date.UTC(
                          startedAt.getUTCFullYear(),
                          startedAt.getUTCMonth(),
                          startedAt.getUTCDate() + 1,
                        ),
                      )
                    ).valueOf() -
                      startedAt.valueOf()) /
                      1000,
                  ),
                ),
                quotaResetsAt ??
                  new Date(
                    Date.UTC(
                      startedAt.getUTCFullYear(),
                      startedAt.getUTCMonth(),
                      startedAt.getUTCDate() + 1,
                    ),
                  ),
              )
            : serviceUnavailable();
      });
    if (persistence.readMessages === undefined)
      return yield* fail("service_unavailable", undefined, "configuration");
    const loaded = yield* persistence
      .readMessages({
        ...authorization,
        auditLogId,
        connectionPublicId: input.connection_id,
        conversationPublicId: input.conversation_id,
        cursorSentAt: sentAt,
        cursorPublicId: publicId,
        dailyRecordLimit,
        limit: input.limit,
        observedAt: startedAt,
      })
      .pipe(Effect.either);
    if (loaded._tag === "Left")
      return yield* fail("service_unavailable", undefined, "query");
    if (loaded.right === null) return yield* fail("authorization_denied");
    if (loaded.right.outcome === "record_quota_exhausted")
      return yield* fail("rate_limited", loaded.right.resetsAt);
    const page = loaded.right.page;
    const encryptedContent: Array<{
      readonly ciphertext: VersionedCiphertext;
      readonly context: EncryptionContext;
    }> = [];
    const contentIndexes = page.messages.map((message) => {
      const add = (
        ciphertext: VersionedCiphertext | null | undefined,
        entity: string,
        purpose: string,
        recordId: string,
      ): number | null => {
        if (ciphertext == null) return null;
        encryptedContent.push({
          ciphertext,
          context: {
            accountId: page.accountKey.personalAccountId,
            connectionId: page.connectionKey.connectionId,
            entity,
            fieldOrObjectPurpose: purpose,
            recordId,
          },
        });
        return encryptedContent.length - 1;
      };
      return {
        content: add(
          message.content,
          "stored-message",
          "content",
          message.messageIdentity,
        ),
        mediaMetadata: add(
          message.media?.metadata,
          "stored-media",
          "metadata",
          message.media?.id ?? "",
        ),
        senderDisplayName: add(
          message.sender?.displayName,
          "directory-contact",
          "display-name",
          message.sender?.recordId ?? "",
        ),
        senderPhone: add(
          message.sender?.phone,
          "directory-contact",
          "phone-number",
          message.sender?.recordId ?? "",
        ),
      };
    });
    const decrypted = yield* encryption
      .decryptMany({
        accountKey: page.accountKey,
        connectionKey: page.connectionKey,
        items: encryptedContent,
      })
      .pipe(
        Effect.flatMap((plaintexts) =>
          Effect.acquireUseRelease(
            Effect.succeed(plaintexts),
            (values) =>
              Effect.try({
                try: () => {
                  const decoder = new TextDecoder("utf-8", {
                    fatal: true,
                    ignoreBOM: false,
                  });
                  return page.messages.map((message, index) => {
                    const indexes = contentIndexes[index];
                    if (indexes === undefined)
                      throw new Error("missing message content indexes");
                    let text: string | null = null;
                    if (indexes.content !== null) {
                      const plaintext = values[indexes.content];
                      if (plaintext === undefined)
                        throw new Error("missing message content");
                      const content = JSON.parse(
                        decoder.decode(plaintext),
                      ) as unknown;
                      if (
                        typeof content !== "object" ||
                        content === null ||
                        !("text" in content) ||
                        ((content as { text: unknown }).text !== null &&
                          typeof (content as { text: unknown }).text !==
                            "string")
                      )
                        throw new Error("invalid message content");
                      text = (content as { text: string | null }).text;
                    }
                    let mediaMetadata: {
                      readonly fileName: string | null;
                      readonly mimeType: string;
                    } | null = null;
                    if (indexes.mediaMetadata !== null) {
                      const plaintext = values[indexes.mediaMetadata];
                      if (plaintext === undefined)
                        throw new Error("missing media metadata");
                      const metadata = JSON.parse(
                        decoder.decode(plaintext),
                      ) as {
                        fileName?: unknown;
                        mimeType?: unknown;
                      };
                      if (
                        (metadata.fileName !== null &&
                          typeof metadata.fileName !== "string") ||
                        typeof metadata.mimeType !== "string"
                      )
                        throw new Error("invalid media metadata");
                      mediaMetadata = {
                        fileName: metadata.fileName as string | null,
                        mimeType: metadata.mimeType,
                      };
                    }
                    const decodeString = (valueIndex: number | null) => {
                      if (valueIndex === null) return null;
                      const plaintext = values[valueIndex];
                      if (plaintext === undefined)
                        throw new Error("missing sender metadata");
                      return decoder.decode(plaintext);
                    };
                    return {
                      mediaMetadata,
                      message,
                      senderDisplayName: decodeString(
                        indexes.senderDisplayName,
                      ),
                      senderPhone: decodeString(indexes.senderPhone),
                      text,
                    };
                  });
                },
                catch: () => new McpToolPersistenceError(),
              }),
            (values) =>
              Effect.sync(() => {
                for (const value of values) value.fill(0);
              }),
          ),
        ),
        Effect.either,
      );
    if (decrypted._tag === "Left")
      return yield* fail("service_unavailable", undefined, "decryption");
    const encoder = new TextEncoder();
    const normalized = decrypted.right.map(
      ({ message, text, mediaMetadata, senderDisplayName, senderPhone }) => ({
        message_id: message.publicId,
        sent_at: message.sentAt,
        direction: message.direction,
        sender: {
          kind:
            message.direction === "outbound"
              ? "self"
              : message.conversationKind === "group"
                ? "group_participant"
                : "contact",
          display_name:
            message.direction === "inbound" ? senderDisplayName : null,
          phone_last_four:
            message.direction === "inbound" && senderPhone !== null
              ? senderPhone.replace(/\D/gu, "").slice(-4) || null
              : null,
        },
        content_type: message.contentType,
        text,
        text_truncated: false,
        text_total_utf8_bytes:
          text === null ? null : encoder.encode(text).byteLength,
        edited_at: message.editedAt ?? null,
        deleted: message.deleted ?? false,
        media:
          message.media == null
            ? null
            : {
                media_id: message.media.publicId,
                type: message.contentType as
                  | "image"
                  | "audio"
                  | "video"
                  | "document"
                  | "sticker",
                state: message.media.state,
                size_bytes: message.media.plaintextSizeBytes,
                mime_type: mediaMetadata?.mimeType ?? null,
                file_name: mediaMetadata?.fileName ?? null,
                resource_unavailable_reason:
                  message.media.state === "pending"
                    ? ("media_pending" as const)
                    : message.media.state === "rejected"
                      ? ("media_rejected" as const)
                      : message.media.state === "failed"
                        ? ("media_failed" as const)
                        : (message.media.plaintextSizeBytes ??
                              Number.POSITIVE_INFINITY) > 16_777_216
                          ? ("too_large_for_mcp" as const)
                          : null,
                resource_size_limit_bytes: 16_777_216 as const,
                resource_uri:
                  message.media.state === "ready" &&
                  (message.media.plaintextSizeBytes ??
                    Number.POSITIVE_INFINITY) <= 16_777_216
                    ? makeStoredMediaUri({
                        connectionId: input.connection_id as never,
                        messageId: message.publicId as never,
                        mediaId: message.media.publicId as never,
                      })
                    : null,
              },
      }),
    );
    const makeOutput = (
      selectedNewestFirst: typeof normalized,
      olderCursor: string | null,
      sizeLimited: boolean,
    ): ReadMessagesOutput =>
      ReadMessagesOutputContract.decodeUnknown({
        conversation_id: page.conversation.publicId,
        kind: page.conversation.kind,
        recipient_id: page.conversation.recipientId,
        messages: [...selectedNewestFirst].reverse(),
        size_limited: sizeLimited,
        has_older:
          page.hasOlder || selectedNewestFirst.length < normalized.length,
        older_cursor: olderCursor,
        history_starts_at: page.historyStartsAt,
        history_start_reason: page.historyStartReason,
        gaps: page.gaps.map((gap) => ({
          starts_at: gap.startsAt,
          ends_at: gap.endsAt,
          cause: gap.cause,
        })),
      });
    const cursorFor = (selectedNewestFirst: typeof normalized) =>
      Effect.gen(function* () {
        const oldest = selectedNewestFirst.at(-1);
        if (
          oldest === undefined ||
          (!page.hasOlder && selectedNewestFirst.length === normalized.length)
        )
          return null;
        return yield* codec.encode({
          boundary: [oldest.sent_at, oldest.message_id],
          context,
          expiresAtEpochSeconds: Math.floor(startedAt.valueOf() / 1000) + 900,
        });
      });
    const jsonBytes = (value: ReadMessagesOutput) =>
      encoder.encode(JSON.stringify(value)).byteLength;
    let selected = normalized;
    let output: ReadMessagesOutput | null = null;
    while (selected.length > 0) {
      const olderCursor = yield* cursorFor(selected).pipe(Effect.either);
      if (olderCursor._tag === "Left")
        return yield* fail("service_unavailable", undefined, "output");
      const candidate = makeOutput(
        selected,
        olderCursor.right,
        page.sizeLimited || selected.length < normalized.length,
      );
      if (jsonBytes(candidate) <= 32_768 || selected.length === 1) {
        output = candidate;
        break;
      }
      selected = selected.slice(0, -1);
    }
    if (output === null) {
      output = makeOutput([], null, page.sizeLimited);
    } else if (jsonBytes(output) > 65_536) {
      const only = selected[0];
      if (only?.text === null || only?.text === undefined)
        return yield* fail("service_unavailable", undefined, "output");
      const scalars = Array.from(only.text);
      let low = 0;
      let high = scalars.length;
      let fitted: ReadMessagesOutput | null = null;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const truncated = [
          {
            ...only,
            text: scalars.slice(0, middle).join(""),
            text_truncated: middle < scalars.length,
          },
        ];
        const candidate = makeOutput(truncated, output.older_cursor, true);
        if (jsonBytes(candidate) <= 65_536) {
          fitted = candidate;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (fitted === null)
        return yield* fail("service_unavailable", undefined, "output");
      output = fitted;
    }
    const completion = yield* persistence
      .completeMessageRecordRead({
        ...authorization,
        auditLogId,
        dailyRecordLimit,
        observedAt: yield* clock.now,
        resultCount: output.messages.length,
      })
      .pipe(Effect.either);
    if (completion._tag === "Left") {
      yield* emitToolCompletion(
        "read_messages",
        "audit_unavailable",
        undefined,
        "audit_completion",
      );
      return auditUnavailable();
    }
    if (completion.right.outcome === "record_quota_exhausted")
      return yield* fail("rate_limited", completion.right.resetsAt);
    yield* emitToolCompletion(
      "read_messages",
      "success",
      output.messages.length,
    );
    return buildReadMessagesResult(
      output,
      output.messages.flatMap((message) =>
        message.media?.resource_uri == null
          ? []
          : [
              {
                type: "resource_link" as const,
                name: message.media.file_name ?? "Stored Media attachment",
                uri: message.media.resource_uri,
              },
            ],
      ),
    );
  }).pipe(Effect.catchAll(() => Effect.succeed(auditUnavailable())));

const searchMessages = (
  authorization: McpAccessAuthorization,
  input: z.infer<typeof SearchMessagesInput>,
  hourLimit: number,
  minuteLimit: number,
  dailyRecordLimit: number,
) =>
  Effect.gen(function* () {
    const clock = yield* McpToolClock;
    const identifiers = yield* McpToolIdentifiers;
    const persistence = yield* McpToolPersistence;
    const encryption = yield* EnvelopeEncryptionService;
    const codec = yield* McpCursorCodec;
    const signing = yield* McpCursorSigning;
    const startedAt = yield* clock.now;
    const query = validateMessageSearchQuery(input.query);
    const queryDigest = yield* messageSearchQueryDigest(
      signing.key,
      query.terms,
    );
    const context: CursorContext = {
      authorizationId: authorization.authorizationId,
      connectionId: input.connection_id as CursorContext["connectionId"],
      filters: {
        query_digest: queryDigest,
        conversation_id: input.conversation_id ?? null,
        direction: input.direction,
        after: input.after ?? null,
        before: input.before ?? null,
        index_version: "v1",
      },
      pageSize: input.limit,
      sortVersion: "message-search-sent-v1",
      tool: "search_messages",
    };
    let cursorSentAt: string | null = null;
    let cursorPublicId: string | null = null;
    if (input.cursor !== undefined) {
      const decoded = yield* codec
        .decode({
          context,
          cursor: input.cursor,
          nowEpochSeconds: Math.floor(startedAt.valueOf() / 1000),
        })
        .pipe(Effect.either);
      if (
        decoded._tag === "Left" ||
        decoded.right.length !== 2 ||
        typeof decoded.right[0] !== "string" ||
        typeof decoded.right[1] !== "string"
      ) {
        const rejected = yield* persistence
          .rejectProtectedOperation({
            ...authorization,
            auditLogId: yield* identifiers.nextAuditLogId,
            connectionPublicId: input.connection_id,
            errorCode: "invalid_cursor",
            observedAt: startedAt,
            operationName: "search_messages",
          })
          .pipe(Effect.either);
        if (rejected._tag === "Left") {
          yield* emitToolCompletion(
            "search_messages",
            "audit_unavailable",
            undefined,
            "audit_completion",
          );
          return auditUnavailable();
        }
        if (rejected.right === "authorization_denied") {
          yield* emitToolCompletion("search_messages", "authorization_denied");
          return authorizationDenied();
        }
        yield* emitToolCompletion("search_messages", "invalid_cursor");
        return invalidCursor();
      }
      cursorSentAt = decoded.right[0];
      cursorPublicId = decoded.right[1];
    }
    const auditLogId = yield* identifiers.nextAuditLogId;
    const begun = yield* persistence
      .beginProtectedOperation({
        ...authorization,
        auditLogId,
        connectionPublicId: input.connection_id,
        hourLimit,
        minuteLimit,
        observedAt: startedAt,
        operationName: "search_messages",
      })
      .pipe(Effect.either);
    if (begun._tag === "Left") {
      yield* emitToolCompletion(
        "search_messages",
        "audit_unavailable",
        undefined,
        "query",
      );
      return auditUnavailable();
    }
    if (begun.right.outcome === "authorization_denied") {
      yield* emitToolCompletion("search_messages", "authorization_denied");
      return authorizationDenied();
    }
    if (begun.right.outcome === "rate_limited") {
      yield* emitToolCompletion("search_messages", "rate_limited");
      return rateLimited(begun.right.retryAfterSeconds, begun.right.resetsAt);
    }
    const fail = (
      code: "authorization_denied" | "rate_limited" | "service_unavailable",
      resetsAt?: Date,
      stage?: McpToolFailureStage,
    ) =>
      Effect.gen(function* () {
        const completed = yield* persistence
          .completeProtectedOperation({
            auditLogId,
            completedAt: yield* clock.now,
            errorCode: code,
            outcome:
              code === "authorization_denied"
                ? "authorization_denied"
                : "execution_error",
            resultCount: null,
          })
          .pipe(Effect.either);
        if (completed._tag === "Left") {
          yield* emitToolCompletion(
            "search_messages",
            "audit_unavailable",
            undefined,
            "audit_completion",
          );
          return auditUnavailable();
        }
        yield* emitToolCompletion(
          "search_messages",
          code === "authorization_denied"
            ? "authorization_denied"
            : code === "rate_limited"
              ? "rate_limited"
              : "service_unavailable",
          undefined,
          stage,
        );
        if (code === "authorization_denied") return authorizationDenied();
        if (code === "rate_limited") {
          const reset =
            resetsAt ??
            new Date(
              Date.UTC(
                startedAt.getUTCFullYear(),
                startedAt.getUTCMonth(),
                startedAt.getUTCDate() + 1,
              ),
            );
          return rateLimited(
            Math.max(
              0,
              Math.ceil((reset.valueOf() - startedAt.valueOf()) / 1000),
            ),
            reset,
          );
        }
        return serviceUnavailable();
      });
    if (persistence.searchMessages === undefined)
      return yield* fail("service_unavailable", undefined, "configuration");

    // Key use starts only after the durable Activity Log reservation above.
    const searchInput = {
      ...authorization,
      connectionPublicId: input.connection_id,
      conversationPublicId: input.conversation_id ?? null,
      cursorSentAt,
      cursorPublicId,
      direction: input.direction,
      after: input.after ?? null,
      before: input.before ?? null,
      limit: input.limit,
      observedAt: startedAt,
    } as const;
    const material = yield* persistence
      .searchMessages({ ...searchInput, searchTokens: null })
      .pipe(Effect.either);
    if (material._tag === "Left")
      return yield* fail("service_unavailable", undefined, "query");
    if (material.right === null) return yield* fail("authorization_denied");
    const internalConnectionId = material.right.connectionKey.connectionId;
    const keyBytes = yield* encryption
      .decrypt({
        accountKey: material.right.accountKey,
        connectionKey: material.right.connectionKey,
        ciphertext: material.right.messageSearchKey,
        context: {
          accountId: material.right.accountKey.personalAccountId,
          connectionId: material.right.connectionKey.connectionId,
          entity: "whatsapp-connection",
          fieldOrObjectPurpose: "message-search-key",
          recordId: material.right.connectionKey.connectionId,
        },
      })
      .pipe(Effect.either);
    if (keyBytes._tag === "Left")
      return yield* fail("service_unavailable", undefined, "decryption");
    const tokens = yield* Effect.acquireUseRelease(
      Effect.succeed(keyBytes.right),
      (bytes) =>
        importMessageSearchIndexKey(bytes).pipe(
          Effect.flatMap((key) =>
            messageSearchIndexesForQuery(key, internalConnectionId, query),
          ),
        ),
      (bytes) => Effect.sync(() => bytes.fill(0)),
    ).pipe(Effect.either);
    if (tokens._tag === "Left")
      return yield* fail("service_unavailable", undefined, "decryption");
    const loaded = yield* persistence
      .searchMessages({ ...searchInput, searchTokens: tokens.right })
      .pipe(Effect.either);
    if (loaded._tag === "Left")
      return yield* fail("service_unavailable", undefined, "query");
    if (loaded.right === null) return yield* fail("authorization_denied");
    const page = loaded.right;
    const plaintexts = yield* encryption
      .decryptMany({
        accountKey: page.accountKey,
        connectionKey: page.connectionKey,
        items: page.messages.map((message) => ({
          ciphertext: message.content,
          context: {
            accountId: page.accountKey.personalAccountId,
            connectionId: page.connectionKey.connectionId,
            entity: "stored-message",
            fieldOrObjectPurpose: "content",
            recordId: message.messageIdentity,
          },
        })),
      })
      .pipe(Effect.either);
    if (plaintexts._tag === "Left")
      return yield* fail("service_unavailable", undefined, "decryption");
    const decoded = yield* Effect.acquireUseRelease(
      Effect.succeed(plaintexts.right),
      (values) =>
        Effect.try({
          try: () => {
            const decoder = new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: false,
            });
            return page.messages.map((message, index) => {
              const value = values[index];
              if (value === undefined) throw new Error("missing candidate");
              const content = JSON.parse(decoder.decode(value)) as {
                readonly text?: unknown;
              };
              if (
                content === null ||
                (content.text !== null && typeof content.text !== "string")
              )
                throw new Error("invalid candidate");
              const text = content.text as string | null;
              if (text === null || !verifyMessageSearchCandidate(text, query))
                throw new Error("inconsistent candidate");
              return {
                message_id: message.publicId,
                conversation_id: message.conversationPublicId,
                sent_at: message.sentAt,
                direction: message.direction,
                content_type: message.contentType,
                text,
                text_truncated: false,
                text_total_utf8_bytes: new TextEncoder().encode(text)
                  .byteLength,
                edited_at: message.editedAt ?? null,
              };
            });
          },
          catch: () => new McpToolPersistenceError(),
        }),
      (values) =>
        Effect.sync(() => {
          for (const value of values) value.fill(0);
        }),
    ).pipe(Effect.either);
    if (decoded._tag === "Left")
      return yield* fail("service_unavailable", undefined, "decryption");
    const gaps = page.coverage.gaps.map((gap) => ({
      starts_at: gap.startsAt,
      ends_at: gap.endsAt,
      cause: gap.cause,
    }));
    const makeOutput = (
      messages: typeof decoded.right,
      nextCursor: string | null,
      sizeLimited: boolean,
    ): SearchMessagesOutput => {
      const reasons: Array<"index_backfill" | "ingestion_gap"> = [];
      if (!page.coverage.backfillComplete) reasons.push("index_backfill");
      if (gaps.length > 0) reasons.push("ingestion_gap");
      return SearchMessagesOutputContract.decodeUnknown({
        messages,
        size_limited: sizeLimited,
        has_more: page.hasMore || messages.length < decoded.right.length,
        next_cursor: nextCursor,
        coverage: {
          history_starts_at: page.coverage.historyStartsAt,
          history_start_reason: page.coverage.historyStartReason,
          searchable_history_starts_at: page.coverage.searchableHistoryStartsAt,
          index_version: "v1",
          backfill_complete: page.coverage.backfillComplete,
          partial: reasons.length > 0,
          partial_reasons: reasons,
          gaps,
        },
      });
    };
    const encoder = new TextEncoder();
    const cursorFor = (messages: typeof decoded.right) =>
      Effect.gen(function* () {
        const oldest = messages.at(-1);
        if (
          oldest === undefined ||
          (!page.hasMore && messages.length === decoded.right.length)
        )
          return null;
        return yield* codec.encode({
          boundary: [oldest.sent_at, oldest.message_id],
          context,
          expiresAtEpochSeconds: Math.floor(startedAt.valueOf() / 1000) + 900,
        });
      });
    let selected = decoded.right;
    let output: SearchMessagesOutput | null = null;
    while (selected.length > 0) {
      const cursor = yield* cursorFor(selected).pipe(Effect.either);
      if (cursor._tag === "Left")
        return yield* fail("service_unavailable", undefined, "output");
      const candidate = makeOutput(
        selected,
        cursor.right,
        page.sizeLimited || selected.length < decoded.right.length,
      );
      if (
        encoder.encode(JSON.stringify(candidate)).byteLength <= 32_768 ||
        selected.length === 1
      ) {
        output = candidate;
        break;
      }
      selected = selected.slice(0, -1);
    }
    output ??= makeOutput([], null, page.sizeLimited);
    if (encoder.encode(JSON.stringify(output)).byteLength > 65_536) {
      const only = selected[0];
      if (only === undefined || only.text === null)
        return yield* fail("service_unavailable", undefined, "output");
      const scalars = Array.from(only.text);
      let low = 0;
      let high = scalars.length;
      let fitted: SearchMessagesOutput | null = null;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = makeOutput(
          [
            {
              ...only,
              text: scalars.slice(0, middle).join(""),
              text_truncated: middle < scalars.length,
            },
          ],
          output.next_cursor,
          true,
        );
        if (encoder.encode(JSON.stringify(candidate)).byteLength <= 65_536) {
          fitted = candidate;
          low = middle + 1;
        } else high = middle - 1;
      }
      if (fitted === null)
        return yield* fail("service_unavailable", undefined, "output");
      output = fitted;
    }
    const completion = yield* persistence
      .completeMessageRecordRead({
        ...authorization,
        auditLogId,
        dailyRecordLimit,
        observedAt: yield* clock.now,
        resultCount: output.messages.length,
      })
      .pipe(Effect.either);
    if (completion._tag === "Left") {
      yield* emitToolCompletion(
        "search_messages",
        "audit_unavailable",
        undefined,
        "audit_completion",
      );
      return auditUnavailable();
    }
    if (completion.right.outcome === "record_quota_exhausted")
      return yield* fail("rate_limited", completion.right.resetsAt);
    yield* emitToolCompletion(
      "search_messages",
      "success",
      output.messages.length,
    );
    return buildSearchMessagesResult(output);
  }).pipe(Effect.catchAll(() => Effect.succeed(auditUnavailable())));

export const createMcpRequestHandler =
  (options: McpRequestHandlerOptions) =>
  async (
    request: Request,
    environment: unknown,
    context: ExecutionContext,
    authorization: McpAccessAuthorization,
  ): Promise<Response> => {
    const payload = await request
      .clone()
      .json()
      .catch(() => null);
    const isToolsListRequest = isToolsListPayload(payload);
    const isResourceDiscoveryRequest = hasMethod(
      payload,
      "resources/templates/list",
    );
    if (hasMethod(payload, "resources/read")) {
      const message = Array.isArray(payload) ? payload[0] : payload;
      const candidate =
        typeof message === "object" &&
        message !== null &&
        "params" in message &&
        typeof message.params === "object" &&
        message.params !== null &&
        "uri" in message.params &&
        typeof message.params.uri === "string"
          ? message.params.uri
          : null;
      if (candidate === null || Option.isNone(parseStoredMediaUri(candidate))) {
        const id =
          typeof message === "object" && message !== null && "id" in message
            ? message.id
            : null;
        return noStore(
          new Response(
            JSON.stringify({
              error: { code: -32602, message: "Resource not found" },
              id,
              jsonrpc: "2.0",
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      }
    }
    let hasConnectionsRead = true;
    let hasDirectoryRead = true;
    let hasMessagesSend = true;
    let hasMessagesRead = true;
    if (isToolsListRequest || isResourceDiscoveryRequest) {
      try {
        const inspected = await Effect.runPromise(
          Effect.gen(function* () {
            const clock = yield* McpToolClock;
            const persistence = yield* McpToolPersistence;
            return yield* persistence.inspectAuthorization({
              ...authorization,
              observedAt: yield* clock.now,
            });
          }).pipe(Effect.provide(options.layer)),
        );
        hasConnectionsRead =
          inspected?.scopes.includes("connections:read") === true;
        hasDirectoryRead =
          inspected?.scopes.includes("directory:read") === true;
        hasMessagesSend = inspected?.scopes.includes("messages:send") === true;
        hasMessagesRead = inspected?.scopes.includes("messages:read") === true;
      } catch {
        return unavailable();
      }
    }

    const factory = () => {
      const server = new McpServer({
        name: "Normal",
        version: "0.1.0",
      });
      if (hasMessagesRead) {
        server.registerResource(
          "stored-media",
          new ResourceTemplate(
            "whatsapp-media://connections/{connection_id}/messages/{message_id}/media/{media_id}",
            { list: undefined },
          ),
          {
            cacheHint: { cacheScope: "private", ttlMs: 0 },
            description: "Authorization-checked Stored Media attachment.",
            title: "WhatsApp Stored Media",
          },
          async (uri) => {
            const notFound = (): never => {
              throw new ResourceNotFoundError(uri.href, "Resource not found");
            };
            const parsed = Option.getOrUndefined(parseStoredMediaUri(uri.href));
            if (parsed === undefined) return notFound();
            let reservedAuditLogId: string | null = null;
            try {
              const result = await Effect.runPromise(
                Effect.gen(function* () {
                  const clock = yield* McpToolClock;
                  const identifiers = yield* McpToolIdentifiers;
                  const persistence = yield* McpToolPersistence;
                  const encryption = yield* EnvelopeEncryptionService;
                  const container = yield* StoredMediaContainerService;
                  const auditLogId = yield* identifiers.nextAuditLogId;
                  const material = yield* persistence.reserveStoredMediaRead({
                    ...authorization,
                    auditLogId,
                    connectionPublicId: parsed.connectionId,
                    dailyByteLimit:
                      options.storedMediaDailyByteLimit ?? 268_435_456,
                    mediaPublicId: parsed.mediaId,
                    messagePublicId: parsed.messageId,
                    observedAt: yield* clock.now,
                  });
                  if (material === null) return null;
                  reservedAuditLogId = auditLogId;
                  const metadataBytes = yield* encryption.decrypt({
                    accountKey: material.accountKey,
                    connectionKey: material.connectionKey,
                    ciphertext: material.metadata,
                    context: {
                      accountId: material.accountKey.personalAccountId,
                      connectionId: material.connectionKey.connectionId,
                      entity: "stored-media",
                      fieldOrObjectPurpose: "metadata",
                      recordId: material.mediaId,
                    },
                  });
                  let metadata: { fileName: string | null; mimeType: string };
                  try {
                    const decoded = JSON.parse(
                      new TextDecoder("utf-8", {
                        fatal: true,
                        ignoreBOM: false,
                      }).decode(metadataBytes),
                    ) as unknown;
                    if (
                      typeof decoded !== "object" ||
                      decoded === null ||
                      !("mimeType" in decoded) ||
                      typeof decoded.mimeType !== "string" ||
                      !("fileName" in decoded) ||
                      (decoded.fileName !== null &&
                        typeof decoded.fileName !== "string")
                    )
                      throw new Error("Stored Media metadata was invalid");
                    metadata = decoded as typeof metadata;
                  } finally {
                    metadataBytes.fill(0);
                  }
                  const stream = yield* container.read({
                    accountKey: material.accountKey,
                    connectionKey: material.connectionKey,
                    context: {
                      connectionId: material.connectionKey.connectionId,
                      mediaObjectId: material.mediaId,
                      personalAccountId: material.accountKey.personalAccountId,
                    },
                    objectKey: material.objectKey,
                  });
                  const blob = yield* Effect.tryPromise(() =>
                    streamToBase64(stream, material.plaintextSizeBytes),
                  );
                  const filename =
                    metadata.fileName === null
                      ? null
                      : sanitizeAttachmentFilename(metadata.fileName);
                  yield* persistence.completeProtectedOperation({
                    auditLogId,
                    completedAt: yield* clock.now,
                    errorCode: null,
                    outcome: "success",
                    resultCount: 1,
                  });
                  return {
                    blob,
                    filename,
                    mimeType: metadata.mimeType,
                  };
                }).pipe(Effect.provide(options.layer)),
              );
              if (result === null) return notFound();
              return {
                contents: [
                  {
                    _meta:
                      result.filename === null
                        ? undefined
                        : { filename: result.filename },
                    blob: result.blob,
                    mimeType: result.mimeType,
                    uri: uri.href,
                  },
                ],
              };
            } catch {
              if (reservedAuditLogId !== null) {
                const auditLogId = reservedAuditLogId;
                await Effect.runPromise(
                  Effect.gen(function* () {
                    const clock = yield* McpToolClock;
                    const persistence = yield* McpToolPersistence;
                    yield* persistence.failStoredMediaRead({
                      auditLogId,
                      completedAt: yield* clock.now,
                      errorCode: "resource_unavailable",
                    });
                  }).pipe(
                    Effect.provide(options.layer),
                    Effect.catchAll(() => Effect.void),
                  ),
                );
              }
              return notFound();
            }
          },
        );
      }
      server.registerTool(
        "send_text_message",
        {
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
          description: sendTextMessageDescription,
          inputSchema: SendTextMessageInput,
          outputSchema: SendTextMessageOutputSchema,
          title: "Send WhatsApp Text Message",
          _meta: { "anthropic/requiresUserInteraction": true },
        },
        async (input) => {
          const operation = Effect.runPromise(
            sendTextMessage(authorization, input, (attempt) =>
              context.waitUntil(attempt),
            ).pipe(Effect.provide(options.layer)),
          );
          context.waitUntil(operation.then(() => undefined));
          const result = await operation;
          return {
            ...result,
            content: result.content.map((block) => ({ ...block })),
          } as CallToolResult;
        },
      );
      server.registerTool(
        "get_send_status",
        {
          annotations: { readOnlyHint: true },
          description:
            "Read the latest locally converged Send Status without contacting the provider.",
          inputSchema: GetSendStatusInput,
          outputSchema: GetSendStatusOutputSchema,
          title: "Get WhatsApp Send Status",
        },
        async (input) => {
          const result = await Effect.runPromise(
            getSendStatus(
              authorization,
              input,
              options.hourLimit,
              options.minuteLimit,
            ).pipe(Effect.provide(options.layer)),
          );
          return {
            ...result,
            content: result.content.map((block) => ({ ...block })),
          } as CallToolResult;
        },
      );
      server.registerTool(
        "list_connections",
        {
          description:
            "List every non-deleted WhatsApp Connection selected by the current MCP Authorization.",
          inputSchema: ListConnectionsInput,
          outputSchema: ListConnectionsOutputSchema,
          title: "List WhatsApp Connections",
        },
        async () => {
          const result = await Effect.runPromise(
            listConnections(
              authorization,
              options.hourLimit,
              options.minuteLimit,
            ).pipe(Effect.provide(options.layer)),
          );
          return {
            ...result,
            content: result.content.map((block) => ({ ...block })),
          } as CallToolResult;
        },
      );
      server.registerTool(
        "list_chats",
        {
          description: listChatsDescription,
          inputSchema: ListChatsInput,
          outputSchema: ListChatsOutputSchema,
          title: "List WhatsApp Chats",
        },
        async (input) => {
          const result = await Effect.runPromise(
            listChats(
              authorization,
              input,
              options.hourLimit,
              options.minuteLimit,
            ).pipe(Effect.provide(options.layer)),
          );
          return {
            ...result,
            content: result.content.map((block) => ({ ...block })),
          } as CallToolResult;
        },
      );
      server.registerTool(
        "read_messages",
        {
          description: readMessagesDescription,
          inputSchema: ReadMessagesInput,
          outputSchema: ReadMessagesOutputSchema,
          title: "Read WhatsApp Messages",
        },
        async (input) => {
          const result = await Effect.runPromise(
            readMessages(
              authorization,
              input,
              options.hourLimit,
              options.minuteLimit,
              options.readMessageDailyRecordLimit ?? 10_000,
            ).pipe(Effect.provide(options.layer)),
          );
          return {
            ...result,
            content: result.content.map((block) => ({ ...block })),
          } as CallToolResult;
        },
      );
      server.registerTool(
        "search_messages",
        {
          annotations: { readOnlyHint: true },
          description: searchMessagesDescription,
          inputSchema: SearchMessagesInput,
          outputSchema: SearchMessagesOutputSchema,
          title: "Search WhatsApp Messages",
        },
        async (input) => {
          const result = await Effect.runPromise(
            searchMessages(
              authorization,
              input,
              options.hourLimit,
              options.minuteLimit,
              options.readMessageDailyRecordLimit ?? 10_000,
            ).pipe(Effect.provide(options.layer)),
          );
          return {
            ...result,
            content: result.content.map((block) => ({ ...block })),
          } as CallToolResult;
        },
      );
      server.registerTool(
        "list_groups",
        {
          description: listGroupsDescription,
          inputSchema: ListGroupsInput,
          outputSchema: ListGroupsOutputSchema,
          title: "List WhatsApp Groups",
        },
        async (input) => {
          const result = await Effect.runPromise(
            listGroups(
              authorization,
              input,
              options.hourLimit,
              options.minuteLimit,
            ).pipe(Effect.provide(options.layer)),
          );
          return {
            ...result,
            content: result.content.map((block) => ({ ...block })),
          } as CallToolResult;
        },
      );
      server.registerTool(
        "list_contacts",
        {
          description: listContactsDescription,
          inputSchema: ListContactsInput,
          outputSchema: ListContactsOutputSchema,
          title: "List WhatsApp Contacts",
        },
        async (input) => {
          const result = await Effect.runPromise(
            listContacts(
              authorization,
              input,
              options.hourLimit,
              options.minuteLimit,
            ).pipe(Effect.provide(options.layer)),
          );
          return {
            ...result,
            content: result.content.map((block) => ({ ...block })),
          } as CallToolResult;
        },
      );
      if (
        !hasConnectionsRead ||
        !hasDirectoryRead ||
        !hasMessagesRead ||
        !hasMessagesSend
      ) {
        const tools: Array<Record<string, unknown>> = [];
        if (hasConnectionsRead) {
          tools.push({
            description:
              "List every non-deleted WhatsApp Connection selected by the current MCP Authorization.",
            inputSchema: z.toJSONSchema(ListConnectionsInput, {
              target: "draft-2020-12",
            }),
            name: "list_connections",
            outputSchema: z.toJSONSchema(ListConnectionsOutputSchema, {
              target: "draft-2020-12",
            }),
            title: "List WhatsApp Connections",
          });
        }
        if (hasDirectoryRead) {
          tools.push({
            description: listGroupsDescription,
            inputSchema: z.toJSONSchema(ListGroupsInput, {
              target: "draft-2020-12",
            }),
            name: "list_groups",
            outputSchema: z.toJSONSchema(ListGroupsOutputSchema, {
              target: "draft-2020-12",
            }),
            title: "List WhatsApp Groups",
          });
          tools.push({
            description: listContactsDescription,
            inputSchema: z.toJSONSchema(ListContactsInput, {
              target: "draft-2020-12",
            }),
            name: "list_contacts",
            outputSchema: z.toJSONSchema(ListContactsOutputSchema, {
              target: "draft-2020-12",
            }),
            title: "List WhatsApp Contacts",
          });
        }
        if (hasMessagesSend) {
          tools.push({
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true,
            },
            description: sendTextMessageDescription,
            inputSchema: z.toJSONSchema(SendTextMessageInput, {
              target: "draft-2020-12",
            }),
            name: "send_text_message",
            outputSchema: z.toJSONSchema(SendTextMessageOutputSchema, {
              target: "draft-2020-12",
            }),
            title: "Send WhatsApp Text Message",
            _meta: { "anthropic/requiresUserInteraction": true },
          });
          tools.push({
            annotations: { readOnlyHint: true },
            description:
              "Read the latest locally converged Send Status without contacting the provider.",
            inputSchema: z.toJSONSchema(GetSendStatusInput, {
              target: "draft-2020-12",
            }),
            name: "get_send_status",
            outputSchema: z.toJSONSchema(GetSendStatusOutputSchema, {
              target: "draft-2020-12",
            }),
            title: "Get WhatsApp Send Status",
          });
        }
        if (hasMessagesRead) {
          tools.push({
            description: listChatsDescription,
            inputSchema: z.toJSONSchema(ListChatsInput, {
              target: "draft-2020-12",
            }),
            name: "list_chats",
            outputSchema: z.toJSONSchema(ListChatsOutputSchema, {
              target: "draft-2020-12",
            }),
            title: "List WhatsApp Chats",
          });
          tools.push({
            description: readMessagesDescription,
            inputSchema: z.toJSONSchema(ReadMessagesInput, {
              target: "draft-2020-12",
            }),
            name: "read_messages",
            outputSchema: z.toJSONSchema(ReadMessagesOutputSchema, {
              target: "draft-2020-12",
            }),
            title: "Read WhatsApp Messages",
          });
          tools.push({
            annotations: { readOnlyHint: true },
            description: searchMessagesDescription,
            inputSchema: z.toJSONSchema(SearchMessagesInput, {
              target: "draft-2020-12",
            }),
            name: "search_messages",
            outputSchema: z.toJSONSchema(SearchMessagesOutputSchema, {
              target: "draft-2020-12",
            }),
            title: "Search WhatsApp Messages",
          });
        }
        server.server.setRequestHandler("tools/list", () => ({
          tools: tools as never,
        }));
      }
      return server;
    };

    const resource = new URL(options.resourceUrl);
    const browser = new URL(options.browserOrigin);
    const handler = createMcpHandler(factory, {
      allowedHostnames: [resource.hostname],
      allowedOriginHostnames: [browser.hostname],
      authContext: { props: { ...authorization } },
      corsOptions: {
        origin: options.browserOrigin,
      },
      legacy: "stateless",
      responseMode: "json",
      route: resource.pathname,
    });
    return noStore(await handler(request, environment, context));
  };
