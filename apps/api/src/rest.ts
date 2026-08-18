import { parseApiKeyCredential } from "@whatsapp-mcp/contracts/api-key";
import {
  type CursorBoundary,
  type RestCursorContext,
  signRestCursor,
  verifyRestCursor,
} from "@whatsapp-mcp/contracts/cursor";
import {
  ConnectionId,
  ConversationId,
  IdempotencyKey,
} from "@whatsapp-mcp/contracts/handles";
import type { restRouteRegistry } from "@whatsapp-mcp/contracts/openapi";
import {
  decodeRestConnectionList,
  decodeRestContactList,
  decodeRestConversationList,
  decodeRestCreateSendOperation,
  decodeRestGroupList,
  decodeRestMessageList,
  decodeRestSearchMessagesList,
  decodeRestSearchMessagesRequest,
  decodeRestSendOperation,
  type ProblemCode,
  type ProblemDetails,
  parseRestStoredMediaPath,
  problemDetails,
  problemTitles,
  problemType,
  type RestConnectionList,
  type RestContactList,
  type RestConversationList,
  type RestGroupList,
  type RestMessageList,
  type RestSearchMessagesList,
  restStoredMediaPath,
} from "@whatsapp-mcp/contracts/rest";
import type {
  ApiKeyPermission,
  AuthenticatedApiKey,
} from "@whatsapp-mcp/db/api-key";
import type {
  BeginProtectedOperationInput,
  BeginProtectedOperationResult,
  McpToolChatPage,
  McpToolConnectionRecord,
  McpToolContactReadMaterial,
  McpToolEncryptedContactPage,
  McpToolGroupPage,
  McpToolGroupSearchMaterial,
  McpToolMessagePage,
  McpToolMessageSearchPage,
  RejectProtectedOperationResult,
  ReserveApiKeyStoredMediaReadResult,
} from "@whatsapp-mcp/db/mcp-tool";
import { apiSendGrant } from "@whatsapp-mcp/db/send";
import { normalizeWhatsAppConnectionName } from "@whatsapp-mcp/domain/whatsapp-connection";
import { Context, Data, Effect, type Layer, Schema } from "effect";
import {
  ApiKeyHmac,
  type ApiKeyHmacService,
  ApiKeyPersistence,
  type ApiKeyPersistenceService,
} from "./api-key";
import {
  contactSearchIndex,
  decryptDirectoryString,
  importDirectoryIndexKey,
  normalizeContactDisplayName,
} from "./directory-privacy";
import {
  EncryptionError,
  type EnvelopeEncryption,
  EnvelopeEncryptionService,
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
import { noStoreJsonResponse, noStoreResponse } from "./http-response";
import { SendTextMessage, type SendTextMessageService } from "./mcp";
import {
  importMessageSearchIndexKey,
  messageSearchIndexesForQuery,
  messageSearchQueryDigest,
  validateMessageSearchQuery,
  verifyMessageSearchCandidate,
} from "./message-search-privacy";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const CONNECTIONS_PATH = "/v1/connections";
const CONTACTS_PATH = /^\/v1\/connections\/(con_[A-Za-z0-9_-]{21})\/contacts$/u;
const GROUPS_PATH = /^\/v1\/connections\/(con_[A-Za-z0-9_-]{21})\/groups$/u;
const CONVERSATIONS_PATH =
  /^\/v1\/connections\/(con_[A-Za-z0-9_-]{21})\/conversations$/u;
const MESSAGES_PATH =
  /^\/v1\/connections\/(con_[A-Za-z0-9_-]{21})\/conversations\/(cvs_[A-Za-z0-9_-]{21})\/messages$/u;
const SEARCH_MESSAGES_PATH =
  /^\/v1\/connections\/(con_[A-Za-z0-9_-]{21})\/messages\/search$/u;
const SEND_OPERATIONS_PATH =
  /^\/v1\/connections\/(con_[A-Za-z0-9_-]{21})\/send-operations$/u;
const READ_STORED_MEDIA = "read_stored_media" as const;
const MAX_AUTHORIZATION_LENGTH = 128;
const MAX_SEND_BODY_BYTES = 32_768;
const SEND_OPERATION = "send_text_message" as const;
const decodeIdempotencyKey = Schema.decodeUnknownSync(IdempotencyKey);
const LIST_CONNECTIONS = "list_connections";
const LIST_CONTACTS = "list_contacts";
const LIST_GROUPS = "list_groups";
const LIST_CHATS = "list_chats";
const READ_MESSAGES = "read_messages";
const SEARCH_MESSAGES = "search_messages";
const restOperationId = (
  operationId: (typeof restRouteRegistry)[number]["operationId"],
) => operationId;
const LIST_CONTACTS_OPERATION_ID = restOperationId("listContacts");
const LIST_GROUPS_OPERATION_ID = restOperationId("listGroups");
const LIST_CONVERSATIONS_OPERATION_ID = restOperationId("listConversations");
const LIST_MESSAGES_OPERATION_ID = restOperationId("listMessages");
const SEARCH_MESSAGES_OPERATION_ID = restOperationId("searchMessages");
const CONTACT_SORT_VERSION = "contacts-v1";
const GROUP_SORT_VERSION = "groups-v1";
const CONVERSATION_SORT_VERSION = "conversations-v1";
const MESSAGE_SORT_VERSION = "messages-sent-v1";
const SEARCH_SORT_VERSION = "message-search-sent-v1";
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_SEARCH_PAGE_SIZE = 20;
const CURSOR_TTL_SECONDS = 900;
const REST_MESSAGE_PAGE_MAX_JSON_BYTES = 1_048_576;
const READY_MEDIA_BYTE_LIMIT = 16_777_216;
const DEFAULT_DAILY_MEDIA_BYTE_LIMIT = 268_435_456;

export class RestPersistenceError extends Data.TaggedError(
  "RestPersistenceError",
) {}

export interface RestPersistenceService {
  readonly beginProtectedOperation: (
    input: BeginProtectedOperationInput,
  ) => Effect.Effect<BeginProtectedOperationResult, RestPersistenceError>;
  readonly completeProtectedOperation: (input: {
    readonly auditLogId: string;
    readonly completedAt: Date;
    readonly errorCode: string | null;
    readonly outcome: "authorization_denied" | "execution_error" | "success";
    readonly resultCount: number | null;
  }) => Effect.Effect<void, RestPersistenceError>;
  readonly listConnections: (input: {
    readonly apiKeyGrantId: string;
    readonly observedAt: Date;
    readonly personalAccountId: string;
  }) => Effect.Effect<
    ReadonlyArray<McpToolConnectionRecord> | null,
    RestPersistenceError
  >;
  readonly loadContactReadMaterial: (input: {
    readonly apiKeyGrantId: string;
    readonly connectionPublicId: string;
    readonly observedAt: Date;
    readonly personalAccountId: string;
    readonly permissions: ReadonlyArray<string>;
  }) => Effect.Effect<McpToolContactReadMaterial | null, RestPersistenceError>;
  readonly listEncryptedContacts: (input: {
    readonly apiKeyGrantId: string;
    readonly connectionPublicId: string;
    readonly cursorDisplayNameSort: string | null;
    readonly cursorPublicId: string | null;
    readonly limit: number;
    readonly observedAt: Date;
    readonly permissions: ReadonlyArray<string>;
    readonly personalAccountId: string;
    readonly searchIndex: string | null;
    readonly searchKind: "name" | "phone" | null;
  }) => Effect.Effect<McpToolEncryptedContactPage | null, RestPersistenceError>;
  readonly loadGroupSearchMaterial: (input: {
    readonly apiKeyGrantId: string;
    readonly connectionPublicId: string;
    readonly observedAt: Date;
    readonly personalAccountId: string;
    readonly permissions: ReadonlyArray<string>;
  }) => Effect.Effect<McpToolGroupSearchMaterial | null, RestPersistenceError>;
  readonly listGroups: (input: {
    readonly apiKeyGrantId: string;
    readonly connectionPublicId: string;
    readonly observedAt: Date;
    readonly permissions: ReadonlyArray<string>;
    readonly personalAccountId: string;
    readonly searchIndex: string | null;
  }) => Effect.Effect<McpToolGroupPage | null, RestPersistenceError>;
  readonly listChats: (input: {
    readonly apiKeyGrantId: string;
    readonly connectionPublicId: string;
    readonly cursorActivityAt: string | null;
    readonly cursorPublicId: string | null;
    readonly kind: "all" | "direct" | "group";
    readonly limit: number;
    readonly observedAt: Date;
    readonly permissions: ReadonlyArray<string>;
    readonly personalAccountId: string;
  }) => Effect.Effect<McpToolChatPage | null, RestPersistenceError>;
  readonly readMessages: (input: {
    readonly apiKeyGrantId: string;
    readonly connectionPublicId: string;
    readonly conversationPublicId: string;
    readonly cursorPublicId: string | null;
    readonly cursorSentAt: string | null;
    readonly limit: number;
    readonly observedAt: Date;
    readonly permissions: ReadonlyArray<string>;
    readonly personalAccountId: string;
  }) => Effect.Effect<McpToolMessagePage | null, RestPersistenceError>;
  readonly searchMessages: (input: {
    readonly after: string | null;
    readonly apiKeyGrantId: string;
    readonly before: string | null;
    readonly connectionPublicId: string;
    readonly conversationPublicId: string | null;
    readonly cursorPublicId: string | null;
    readonly cursorSentAt: string | null;
    readonly direction: "all" | "inbound" | "outbound";
    readonly limit: number;
    readonly observedAt: Date;
    readonly permissions: ReadonlyArray<string>;
    readonly personalAccountId: string;
    readonly searchTokens: ReadonlyArray<string> | null;
  }) => Effect.Effect<McpToolMessageSearchPage | null, RestPersistenceError>;
  readonly completeMessageRecordRead: (input: {
    readonly apiKeyGrantId: string;
    readonly auditLogId: string;
    readonly dailyRecordLimit: number;
    readonly observedAt: Date;
    readonly personalAccountId: string;
    readonly resultCount: number;
  }) => Effect.Effect<
    | { readonly outcome: "success" }
    | { readonly outcome: "record_quota_exhausted"; readonly resetsAt: Date },
    RestPersistenceError
  >;
  readonly failStoredMediaRead: (input: {
    readonly auditLogId: string;
    readonly completedAt: Date;
    readonly errorCode: string;
  }) => Effect.Effect<void, RestPersistenceError>;
  readonly reserveStoredMediaRead: (input: {
    readonly apiKeyGrantId: string;
    readonly auditLogId: string;
    readonly connectionPublicId: string;
    readonly dailyByteLimit: number;
    readonly mediaPublicId: string;
    readonly messagePublicId: string;
    readonly observedAt: Date;
    readonly permissions: ReadonlyArray<string>;
    readonly personalAccountId: string;
  }) => Effect.Effect<ReserveApiKeyStoredMediaReadResult, RestPersistenceError>;
  readonly rejectProtectedOperation: (input: {
    readonly apiKey: {
      readonly grantId: string;
      readonly name: string;
      readonly publicId: string;
    };
    readonly auditLogId: string;
    readonly connectionPublicId?: string;
    readonly errorCode: string;
    readonly observedAt: Date;
    readonly operationName: string;
    readonly permissions: ReadonlyArray<string>;
    readonly personalAccountId: string;
    readonly requiredPermission: string;
  }) => Effect.Effect<RejectProtectedOperationResult, RestPersistenceError>;
}

export const RestPersistence = Context.GenericTag<RestPersistenceService>(
  "@whatsapp-mcp/api/RestPersistence",
);

export interface RestClockService {
  readonly now: Effect.Effect<Date>;
}

export const RestClock = Context.GenericTag<RestClockService>(
  "@whatsapp-mcp/api/RestClock",
);

export interface RestIdentifiersService {
  readonly nextAuditLogId: Effect.Effect<string>;
}

export const RestIdentifiers = Context.GenericTag<RestIdentifiersService>(
  "@whatsapp-mcp/api/RestIdentifiers",
);

export interface RestCursorCodecService {
  readonly decode: (input: {
    readonly context: RestCursorContext;
    readonly cursor: string;
    readonly nowEpochSeconds: number;
  }) => Effect.Effect<CursorBoundary, RestCursorError>;
  readonly digestSearchQuery: (
    terms: ReadonlyArray<string>,
  ) => Effect.Effect<string, RestCursorError>;
  readonly encode: (input: {
    readonly boundary: CursorBoundary;
    readonly context: RestCursorContext;
    readonly expiresAtEpochSeconds: number;
  }) => Effect.Effect<string, RestCursorError>;
}

export class RestCursorError extends Data.TaggedError("RestCursorError") {}

export const RestCursorCodec = Context.GenericTag<RestCursorCodecService>(
  "@whatsapp-mcp/api/RestCursorCodec",
);

export const makeRestCursorCodec = (
  key: CryptoKey,
): RestCursorCodecService => ({
  decode: ({ context, cursor, nowEpochSeconds }) =>
    verifyRestCursor(key, cursor, context, nowEpochSeconds).pipe(
      Effect.mapError(() => new RestCursorError()),
    ),
  digestSearchQuery: (terms) =>
    messageSearchQueryDigest(key, terms).pipe(
      Effect.mapError(() => new RestCursorError()),
    ),
  encode: ({ boundary, context, expiresAtEpochSeconds }) =>
    signRestCursor(key, {
      boundary,
      context,
      expiresAtEpochSeconds,
    }).pipe(Effect.mapError(() => new RestCursorError())),
});

type RestRequirements =
  | ApiKeyHmacService
  | ApiKeyPersistenceService
  | EnvelopeEncryption
  | RestClockService
  | RestCursorCodecService
  | RestIdentifiersService
  | RestPersistenceService
  | SafeTelemetryService
  | SendTextMessageService
  | StoredMediaContainer;

export interface RestHandlerOptions {
  readonly dailyMediaByteLimit?: number;
  readonly dailyRecordLimit: number;
  readonly hourLimit: number;
  readonly keyHourLimit: number;
  readonly keyMinuteLimit: number;
  readonly minuteLimit: number;
}

const problemResponse = (
  code: ProblemCode,
  status: ProblemDetails["status"],
  extras: {
    readonly retry_after_seconds?: number;
    readonly retryable?: boolean;
    readonly resets_at?: ProblemDetails["resets_at"];
  } = {},
): Response =>
  noStoreResponse(
    JSON.stringify({
      code,
      detail: problemDetails[code],
      ...extras,
      status,
      title: problemTitles[code],
      type: problemType(code),
    } satisfies ProblemDetails),
    status,
    {},
    "application/problem+json; charset=utf-8",
  );

const parseBearerCredential = (request: Request) => {
  let authorizationCount = 0;
  for (const [name] of request.headers) {
    if (name.toLowerCase() === "authorization") authorizationCount += 1;
  }
  const raw = request.headers.get("authorization");
  if (authorizationCount !== 1 || raw === null) return null;
  if (raw.length > MAX_AUTHORIZATION_LENGTH || raw.includes(",")) return null;
  if (!raw.startsWith("Bearer ")) return null;
  const token = raw.slice("Bearer ".length);
  if (token.includes(" ") || token.includes("\n") || token.includes("\r")) {
    return null;
  }
  return parseApiKeyCredential(token);
};

const revealDisplayName = (
  connection: McpToolConnectionRecord,
): Effect.Effect<string, EncryptionError, EnvelopeEncryption> =>
  connection.displayNameFallback !== null
    ? Effect.succeed(connection.displayNameFallback)
    : connection.accountKey === null ||
        connection.connectionKey === null ||
        connection.displayName === null
      ? Effect.fail(
          new EncryptionError({
            operation: "decrypt",
            stage: "ciphertext",
          }),
        )
      : Effect.gen(function* () {
          const encryption = yield* EnvelopeEncryptionService;
          const bytes = yield* encryption.decrypt({
            accountKey: connection.accountKey as NonNullable<
              McpToolConnectionRecord["accountKey"]
            >,
            ciphertext: connection.displayName as NonNullable<
              McpToolConnectionRecord["displayName"]
            >,
            connectionKey: connection.connectionKey as NonNullable<
              McpToolConnectionRecord["connectionKey"]
            >,
            context: {
              accountId: (
                connection.accountKey as NonNullable<
                  McpToolConnectionRecord["accountKey"]
                >
              ).personalAccountId,
              connectionId: connection.connectionId,
              entity: "whatsapp-connection",
              fieldOrObjectPurpose: "display-name",
              recordId: connection.connectionId,
            },
          });
          return new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: false,
          }).decode(bytes);
        });

const emitCompletion = (
  operation:
    | "list_connections"
    | "list_contacts"
    | "list_groups"
    | "list_chats"
    | "read_messages"
    | "read_stored_media"
    | "search_messages"
    | "send_text_message",
  outcome:
    | "audit_unavailable"
    | "authorization_denied"
    | "execution_error"
    | "invalid_cursor"
    | "rate_limited"
    | "success"
    | "unavailable",
  resultCount?: number,
): Effect.Effect<void, never, SafeTelemetryService> =>
  Effect.gen(function* () {
    const telemetry = yield* SafeTelemetry;
    yield* telemetry.emit({
      event: "rest.operation.completed",
      operation,
      outcome,
      ...(resultCount === undefined ? {} : { resultCount }),
      service: "api",
    });
  });

const authenticate = (
  request: Request,
): Effect.Effect<
  AuthenticatedApiKey,
  Response,
  ApiKeyHmacService | ApiKeyPersistenceService
> =>
  Effect.gen(function* () {
    const parsed = parseBearerCredential(request);
    if (parsed === null) {
      return yield* Effect.fail(problemResponse("invalid_credentials", 401));
    }
    const hmac = yield* ApiKeyHmac;
    const digest = yield* hmac
      .digest(parsed.credential)
      .pipe(Effect.mapError(() => problemResponse("unavailable", 503)));
    const persistence = yield* ApiKeyPersistence;
    const grant = yield* persistence
      .authenticate({
        digest,
        publicId: parsed.publicId,
      })
      .pipe(Effect.mapError(() => problemResponse("unavailable", 503)));
    if (grant === null) {
      return yield* Effect.fail(problemResponse("invalid_credentials", 401));
    }
    return grant;
  });

const listConnections = (
  request: Request,
  options: RestHandlerOptions,
  layer: Layer.Layer<RestRequirements, unknown>,
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const grant = yield* authenticate(request);
      const clock = yield* RestClock;
      const identifiers = yield* RestIdentifiers;
      const persistence = yield* RestPersistence;
      const startedAt = yield* clock.now;
      const auditLogId = yield* identifiers.nextAuditLogId;
      const started = yield* persistence
        .beginProtectedOperation({
          apiKey: {
            grantId: grant.grantId,
            name: grant.name,
            publicId: grant.id,
          },
          auditLogId,
          channel: "api",
          hourLimit: options.hourLimit,
          keyHourLimit: options.keyHourLimit,
          keyMinuteLimit: options.keyMinuteLimit,
          minuteLimit: options.minuteLimit,
          observedAt: startedAt,
          operationName: LIST_CONNECTIONS,
          permissions: grant.permissions,
          personalAccountId: grant.personalAccountId,
          requiredPermission: "connections:read" satisfies ApiKeyPermission,
        })
        .pipe(Effect.either);
      if (started._tag === "Left") {
        yield* emitCompletion(LIST_CONNECTIONS, "audit_unavailable");
        return problemResponse("unavailable", 503);
      }
      if (started.right.outcome === "authorization_denied") {
        yield* emitCompletion(LIST_CONNECTIONS, "authorization_denied");
        return grant.permissions.includes("connections:read")
          ? problemResponse("invalid_credentials", 401)
          : problemResponse("insufficient_permission", 403);
      }
      if (started.right.outcome === "rate_limited") {
        yield* emitCompletion(LIST_CONNECTIONS, "rate_limited");
        return problemResponse("rate_limited", 429, {
          retry_after_seconds: started.right.retryAfterSeconds,
          retryable: true,
          resets_at:
            started.right.resetsAt.toISOString() as ProblemDetails["resets_at"],
        });
      }

      const readAt = yield* clock.now;
      const loaded = yield* persistence
        .listConnections({
          apiKeyGrantId: grant.grantId,
          observedAt: readAt,
          personalAccountId: grant.personalAccountId,
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
        yield* emitCompletion(
          LIST_CONNECTIONS,
          completed._tag === "Left" ? "audit_unavailable" : "unavailable",
        );
        return problemResponse("unavailable", 503);
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
        yield* emitCompletion(
          LIST_CONNECTIONS,
          completed._tag === "Left"
            ? "audit_unavailable"
            : "authorization_denied",
        );
        return completed._tag === "Left"
          ? problemResponse("unavailable", 503)
          : problemResponse("invalid_credentials", 401);
      }

      const revealed = yield* Effect.forEach(
        loaded.right,
        (connection) =>
          revealDisplayName(connection).pipe(
            Effect.map((displayName) => ({ connection, displayName })),
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
        yield* emitCompletion(
          LIST_CONNECTIONS,
          completed._tag === "Left" ? "audit_unavailable" : "unavailable",
        );
        return problemResponse("unavailable", 503);
      }

      const body: RestConnectionList = decodeRestConnectionList({
        data: revealed.right.map(({ connection, displayName }) => ({
          connection_id: connection.publicId,
          display_name: displayName,
          number_last_four: connection.numberLastFour,
          state: connection.state,
          state_changed_at: connection.stateChangedAt,
        })),
        pagination: {
          has_more: false,
          next_cursor: null,
        },
      });
      const completedAt = yield* clock.now;
      const completed = yield* persistence
        .completeProtectedOperation({
          auditLogId,
          completedAt,
          errorCode: null,
          outcome: "success",
          resultCount: body.data.length,
        })
        .pipe(Effect.either);
      if (completed._tag === "Left") {
        yield* emitCompletion(LIST_CONNECTIONS, "audit_unavailable");
        return problemResponse("unavailable", 503);
      }
      yield* emitCompletion(LIST_CONNECTIONS, "success", body.data.length);
      return noStoreJsonResponse(body, 200);
    }).pipe(
      Effect.provide(layer),
      Effect.match({
        onFailure: (failure) =>
          failure instanceof Response
            ? failure
            : problemResponse("unavailable", 503),
        onSuccess: (response) => response,
      }),
    ),
  );

const parseContactSearch = (
  value: string | null,
): string | null | "invalid" => {
  if (value === null) return null;
  if (/^\+/u.test(value)) {
    return /^\+[1-9]\d{6,14}$/u.test(value) ? value : "invalid";
  }
  const normalized = normalizeContactDisplayName(value);
  const length = Array.from(normalized).length;
  return length >= 3 && length <= 64 ? normalized : "invalid";
};

const parseContactLimit = (value: string | null): number | "invalid" => {
  if (value === null) return DEFAULT_PAGE_SIZE;
  if (!/^[1-9][0-9]*$/u.test(value)) return "invalid";
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_PAGE_SIZE
    ? limit
    : "invalid";
};

const parseSearchLimit = (value: number | undefined): number | "invalid" => {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  return Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_SEARCH_PAGE_SIZE
    ? value
    : "invalid";
};

const parseConversationKind = (
  value: string | null,
): "all" | "direct" | "group" | "invalid" => {
  if (value === null) return "all";
  return value === "all" || value === "direct" || value === "group"
    ? value
    : "invalid";
};

const listContacts = (
  request: Request,
  connectionPublicId: string,
  options: RestHandlerOptions,
  layer: Layer.Layer<RestRequirements, unknown>,
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const url = new URL(request.url);
      const queryKeys = [...url.searchParams.keys()];
      if (
        queryKeys.some(
          (key) => key !== "cursor" && key !== "limit" && key !== "search",
        ) ||
        url.searchParams.getAll("cursor").length > 1 ||
        url.searchParams.getAll("limit").length > 1 ||
        url.searchParams.getAll("search").length > 1
      ) {
        return problemResponse("invalid_request", 400);
      }
      const search = parseContactSearch(url.searchParams.get("search"));
      const limit = parseContactLimit(url.searchParams.get("limit"));
      const cursor = url.searchParams.get("cursor");
      if (
        search === "invalid" ||
        limit === "invalid" ||
        (cursor !== null && (cursor.length < 1 || cursor.length > 4_096))
      ) {
        return problemResponse("invalid_request", 400);
      }

      const grant = yield* authenticate(request);
      const clock = yield* RestClock;
      const identifiers = yield* RestIdentifiers;
      const persistence = yield* RestPersistence;
      const cursors = yield* RestCursorCodec;
      const startedAt = yield* clock.now;
      const cursorContext: RestCursorContext = {
        connectionId:
          Schema.decodeUnknownSync(ConnectionId)(connectionPublicId),
        filters: { search },
        grantId: grant.grantId,
        operationId: LIST_CONTACTS_OPERATION_ID,
        pageSize: limit,
        sortVersion: CONTACT_SORT_VERSION,
      };
      let boundary: readonly [string, string] | null = null;
      if (cursor !== null) {
        const decoded = yield* cursors
          .decode({
            context: cursorContext,
            cursor,
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
              apiKey: {
                grantId: grant.grantId,
                name: grant.name,
                publicId: grant.id,
              },
              auditLogId,
              connectionPublicId,
              errorCode: "invalid_cursor",
              observedAt: startedAt,
              operationName: LIST_CONTACTS,
              permissions: grant.permissions,
              personalAccountId: grant.personalAccountId,
              requiredPermission: "directory:read",
            })
            .pipe(Effect.either);
          if (rejected._tag === "Left") {
            yield* emitCompletion(LIST_CONTACTS, "audit_unavailable");
            return problemResponse("unavailable", 503);
          }
          if (rejected.right === "authorization_denied") {
            yield* emitCompletion(LIST_CONTACTS, "authorization_denied");
            return grant.permissions.includes("directory:read")
              ? problemResponse("invalid_credentials", 401)
              : problemResponse("insufficient_permission", 403);
          }
          yield* emitCompletion(LIST_CONTACTS, "invalid_cursor");
          return problemResponse("invalid_cursor", 400);
        }
        boundary = [decoded.right[0], decoded.right[1]];
      }

      const auditLogId = yield* identifiers.nextAuditLogId;
      const started = yield* persistence
        .beginProtectedOperation({
          apiKey: {
            grantId: grant.grantId,
            name: grant.name,
            publicId: grant.id,
          },
          auditLogId,
          channel: "api",
          connectionPublicId,
          hourLimit: options.hourLimit,
          keyHourLimit: options.keyHourLimit,
          keyMinuteLimit: options.keyMinuteLimit,
          minuteLimit: options.minuteLimit,
          observedAt: startedAt,
          operationName: LIST_CONTACTS,
          permissions: grant.permissions,
          personalAccountId: grant.personalAccountId,
          requiredPermission: "directory:read" satisfies ApiKeyPermission,
        })
        .pipe(Effect.either);
      if (started._tag === "Left") {
        yield* emitCompletion(LIST_CONTACTS, "audit_unavailable");
        return problemResponse("unavailable", 503);
      }
      if (started.right.outcome === "authorization_denied") {
        yield* emitCompletion(LIST_CONTACTS, "authorization_denied");
        return grant.permissions.includes("directory:read")
          ? problemResponse("invalid_credentials", 401)
          : problemResponse("insufficient_permission", 403);
      }
      if (started.right.outcome === "rate_limited") {
        yield* emitCompletion(LIST_CONTACTS, "rate_limited");
        return problemResponse("rate_limited", 429, {
          retry_after_seconds: started.right.retryAfterSeconds,
          retryable: true,
          resets_at:
            started.right.resetsAt.toISOString() as ProblemDetails["resets_at"],
        });
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
          yield* emitCompletion(
            LIST_CONTACTS,
            completed._tag === "Left"
              ? "audit_unavailable"
              : denied
                ? "authorization_denied"
                : "unavailable",
          );
          return completed._tag === "Left"
            ? problemResponse("unavailable", 503)
            : denied
              ? problemResponse("not_found", 404)
              : problemResponse("unavailable", 503);
        });

      const materialResult = yield* persistence
        .loadContactReadMaterial({
          apiKeyGrantId: grant.grantId,
          connectionPublicId,
          observedAt: yield* clock.now,
          personalAccountId: grant.personalAccountId,
          permissions: grant.permissions,
        })
        .pipe(Effect.either);
      if (materialResult._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
      const material = materialResult.right;
      if (material === null) {
        return yield* failAfterAudit("authorization_denied", true);
      }

      const encryption = yield* EnvelopeEncryptionService;
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
            const indexedSearch =
              search === null
                ? null
                : yield* contactSearchIndex(
                    indexKey,
                    material.whatsappConnectionId,
                    search,
                  );
            const encryptedPage = yield* persistence.listEncryptedContacts({
              apiKeyGrantId: grant.grantId,
              connectionPublicId,
              cursorDisplayNameSort: boundary?.[0] ?? null,
              cursorPublicId: boundary?.[1] ?? null,
              limit: limit + 1,
              observedAt: yield* clock.now,
              permissions: grant.permissions,
              personalAccountId: grant.personalAccountId,
              searchIndex: indexedSearch?.index ?? null,
              searchKind: indexedSearch?.kind ?? null,
            });
            if (encryptedPage === null) return null;
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
                    return yield* Effect.fail(new RestPersistenceError());
                  }
                  return {
                    conversationPublicId: contact.conversationPublicId,
                    displayName,
                    normalizedDisplayName: contact.displayNameSort,
                    phoneLastFour:
                      phoneNumber === null ? null : phoneNumber.slice(-4),
                    publicId: contact.publicId,
                  };
                }),
              { concurrency: 16 },
            );
            return {
              asOf: encryptedPage.asOf,
              contacts,
              partial: encryptedPage.partial,
              snapshotObservedAt: encryptedPage.snapshotObservedAt,
              stale: encryptedPage.stale,
            };
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
      const hasMore = openedPage.contacts.length > limit;
      const page = openedPage.contacts.slice(0, limit);
      const last = page.at(-1);
      const nextCursorResult =
        hasMore && last !== undefined
          ? yield* cursors
              .encode({
                boundary: [last.normalizedDisplayName, last.publicId],
                context: cursorContext,
                expiresAtEpochSeconds:
                  Math.floor(startedAt.valueOf() / 1_000) + CURSOR_TTL_SECONDS,
              })
              .pipe(Effect.either)
          : { _tag: "Right" as const, right: null };
      if (nextCursorResult._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
      const snapshotObservedAt =
        openedPage.snapshotObservedAt === null
          ? null
          : new Date(openedPage.snapshotObservedAt);
      const body: RestContactList = decodeRestContactList({
        data: page.map((contact) => ({
          contact_id: contact.publicId,
          conversation_id: contact.conversationPublicId,
          display_name: contact.displayName,
          phone_last_four: contact.phoneLastFour,
        })),
        meta: {
          as_of: openedPage.asOf,
          partial: openedPage.partial,
          stale:
            openedPage.stale ||
            snapshotObservedAt === null ||
            !Number.isFinite(snapshotObservedAt.valueOf()) ||
            startedAt.valueOf() - snapshotObservedAt.valueOf() >
              10 * 60 * 1_000,
        },
        pagination: {
          has_more: hasMore,
          next_cursor: nextCursorResult.right,
        },
      });
      const completed = yield* persistence
        .completeProtectedOperation({
          auditLogId,
          completedAt: yield* clock.now,
          errorCode: null,
          outcome: "success",
          resultCount: body.data.length,
        })
        .pipe(Effect.either);
      if (completed._tag === "Left") {
        yield* emitCompletion(LIST_CONTACTS, "audit_unavailable");
        return problemResponse("unavailable", 503);
      }
      yield* emitCompletion(LIST_CONTACTS, "success", body.data.length);
      return noStoreJsonResponse(body, 200);
    }).pipe(
      Effect.provide(layer),
      Effect.match({
        onFailure: (failure) =>
          failure instanceof Response
            ? failure
            : problemResponse("unavailable", 503),
        onSuccess: (response) => response,
      }),
    ),
  );

const parseGroupSearch = (value: string | null): string | null | "invalid" => {
  if (value === null) return null;
  const normalized = normalizeGroupDisplayName(value);
  const length = Array.from(normalized).length;
  return length >= 3 && length <= 64 ? normalized : "invalid";
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const listGroups = (
  request: Request,
  connectionPublicId: string,
  options: RestHandlerOptions,
  layer: Layer.Layer<RestRequirements, unknown>,
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const url = new URL(request.url);
      const queryKeys = [...url.searchParams.keys()];
      if (
        queryKeys.some(
          (key) => key !== "cursor" && key !== "limit" && key !== "search",
        ) ||
        url.searchParams.getAll("cursor").length > 1 ||
        url.searchParams.getAll("limit").length > 1 ||
        url.searchParams.getAll("search").length > 1
      ) {
        return problemResponse("invalid_request", 400);
      }
      const search = parseGroupSearch(url.searchParams.get("search"));
      const limit = parseContactLimit(url.searchParams.get("limit"));
      const cursor = url.searchParams.get("cursor");
      if (
        search === "invalid" ||
        limit === "invalid" ||
        (cursor !== null && (cursor.length < 1 || cursor.length > 4_096))
      ) {
        return problemResponse("invalid_request", 400);
      }

      const grant = yield* authenticate(request);
      const clock = yield* RestClock;
      const identifiers = yield* RestIdentifiers;
      const persistence = yield* RestPersistence;
      const cursors = yield* RestCursorCodec;
      const startedAt = yield* clock.now;
      const cursorContext: RestCursorContext = {
        connectionId:
          Schema.decodeUnknownSync(ConnectionId)(connectionPublicId),
        filters: { search },
        grantId: grant.grantId,
        operationId: LIST_GROUPS_OPERATION_ID,
        pageSize: limit,
        sortVersion: GROUP_SORT_VERSION,
      };
      let boundary: readonly [string, string] | null = null;
      if (cursor !== null) {
        const decoded = yield* cursors
          .decode({
            context: cursorContext,
            cursor,
            nowEpochSeconds: Math.floor(startedAt.valueOf() / 1_000),
          })
          .pipe(Effect.either);
        if (
          decoded._tag === "Left" ||
          decoded.right.length !== 2 ||
          typeof decoded.right[0] !== "string" ||
          typeof decoded.right[1] !== "string" ||
          !/^grp_[A-Za-z0-9_-]{21}$/u.test(decoded.right[1])
        ) {
          const auditLogId = yield* identifiers.nextAuditLogId;
          const rejected = yield* persistence
            .rejectProtectedOperation({
              apiKey: {
                grantId: grant.grantId,
                name: grant.name,
                publicId: grant.id,
              },
              auditLogId,
              connectionPublicId,
              errorCode: "invalid_cursor",
              observedAt: startedAt,
              operationName: LIST_GROUPS,
              permissions: grant.permissions,
              personalAccountId: grant.personalAccountId,
              requiredPermission: "directory:read",
            })
            .pipe(Effect.either);
          if (rejected._tag === "Left") {
            yield* emitCompletion(LIST_GROUPS, "audit_unavailable");
            return problemResponse("unavailable", 503);
          }
          if (rejected.right === "authorization_denied") {
            yield* emitCompletion(LIST_GROUPS, "authorization_denied");
            return grant.permissions.includes("directory:read")
              ? problemResponse("invalid_credentials", 401)
              : problemResponse("insufficient_permission", 403);
          }
          yield* emitCompletion(LIST_GROUPS, "invalid_cursor");
          return problemResponse("invalid_cursor", 400);
        }
        boundary = [decoded.right[0], decoded.right[1]];
      }

      const auditLogId = yield* identifiers.nextAuditLogId;
      const started = yield* persistence
        .beginProtectedOperation({
          apiKey: {
            grantId: grant.grantId,
            name: grant.name,
            publicId: grant.id,
          },
          auditLogId,
          channel: "api",
          connectionPublicId,
          hourLimit: options.hourLimit,
          keyHourLimit: options.keyHourLimit,
          keyMinuteLimit: options.keyMinuteLimit,
          minuteLimit: options.minuteLimit,
          observedAt: startedAt,
          operationName: LIST_GROUPS,
          permissions: grant.permissions,
          personalAccountId: grant.personalAccountId,
          requiredPermission: "directory:read" satisfies ApiKeyPermission,
        })
        .pipe(Effect.either);
      if (started._tag === "Left") {
        yield* emitCompletion(LIST_GROUPS, "audit_unavailable");
        return problemResponse("unavailable", 503);
      }
      if (started.right.outcome === "authorization_denied") {
        yield* emitCompletion(LIST_GROUPS, "authorization_denied");
        return grant.permissions.includes("directory:read")
          ? problemResponse("invalid_credentials", 401)
          : problemResponse("insufficient_permission", 403);
      }
      if (started.right.outcome === "rate_limited") {
        yield* emitCompletion(LIST_GROUPS, "rate_limited");
        return problemResponse("rate_limited", 429, {
          retry_after_seconds: started.right.retryAfterSeconds,
          retryable: true,
          resets_at:
            started.right.resetsAt.toISOString() as ProblemDetails["resets_at"],
        });
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
          yield* emitCompletion(
            LIST_GROUPS,
            completed._tag === "Left"
              ? "audit_unavailable"
              : denied
                ? "authorization_denied"
                : "unavailable",
          );
          return completed._tag === "Left"
            ? problemResponse("unavailable", 503)
            : denied
              ? problemResponse("not_found", 404)
              : problemResponse("unavailable", 503);
        });

      let searchIndex: string | null = null;
      if (search !== null) {
        const materialResult = yield* persistence
          .loadGroupSearchMaterial({
            apiKeyGrantId: grant.grantId,
            connectionPublicId,
            observedAt: yield* clock.now,
            personalAccountId: grant.personalAccountId,
            permissions: grant.permissions,
          })
          .pipe(Effect.either);
        if (materialResult._tag === "Left") {
          return yield* failAfterAudit("service_unavailable");
        }
        const material = materialResult.right;
        if (material === null) {
          return yield* failAfterAudit("authorization_denied", true);
        }
        const encryption = yield* EnvelopeEncryptionService;
        const identityBytesResult = yield* encryption
          .decrypt({
            accountKey: material.accountKey,
            ciphertext: material.identityKey,
            connectionKey: material.connectionKey,
            context: {
              accountId: material.accountKey.personalAccountId,
              connectionId: material.connectionKey.connectionId,
              entity: "whatsapp-connection",
              fieldOrObjectPurpose: "webhook-identity-key",
              recordId: material.connectionKey.connectionId,
            },
          })
          .pipe(Effect.either);
        if (identityBytesResult._tag === "Left") {
          return yield* failAfterAudit("service_unavailable");
        }
        const indexed = yield* Effect.acquireUseRelease(
          Effect.succeed(identityBytesResult.right),
          (identityBytes) =>
            importGroupDirectoryIndexKey(identityBytes).pipe(
              Effect.flatMap((key) =>
                groupSearchIndex(
                  key,
                  material.connectionKey.connectionId,
                  search,
                ),
              ),
            ),
          (identityBytes) =>
            Effect.sync(() => {
              identityBytes.fill(0);
            }),
        ).pipe(Effect.either);
        if (indexed._tag === "Left") {
          return yield* failAfterAudit("service_unavailable");
        }
        searchIndex = indexed.right;
      }

      const readAt = yield* clock.now;
      const loaded = yield* persistence
        .listGroups({
          apiKeyGrantId: grant.grantId,
          connectionPublicId,
          observedAt: readAt,
          permissions: grant.permissions,
          personalAccountId: grant.personalAccountId,
          searchIndex,
        })
        .pipe(Effect.either);
      if (loaded._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
      if (loaded.right === null) {
        return yield* failAfterAudit("authorization_denied", true);
      }

      const page = loaded.right;
      const encryption = yield* EnvelopeEncryptionService;
      const decrypted = yield* Effect.forEach(
        page.groups,
        (group) =>
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
                          catch: () => new RestPersistenceError(),
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
        { concurrency: 16 },
      ).pipe(Effect.either);
      if (decrypted._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }

      const ordered = decrypted.right
        .filter(
          (group) => search === null || group.normalizedName.startsWith(search),
        )
        .sort(
          (left, right) =>
            compareText(left.normalizedName, right.normalizedName) ||
            compareText(left.publicId, right.publicId),
        )
        .filter((group) => {
          if (boundary === null) return true;
          const [name, publicId] = boundary;
          return (
            compareText(group.normalizedName, name) > 0 ||
            (group.normalizedName === name &&
              compareText(group.publicId, publicId) > 0)
          );
        });
      const selected = ordered.slice(0, limit);
      const hasMore = ordered.length > limit;
      const last = selected.at(-1);
      const nextCursorResult =
        hasMore && last !== undefined
          ? yield* cursors
              .encode({
                boundary: [last.normalizedName, last.publicId],
                context: cursorContext,
                expiresAtEpochSeconds:
                  Math.floor(startedAt.valueOf() / 1_000) + CURSOR_TTL_SECONDS,
              })
              .pipe(Effect.either)
          : { _tag: "Right" as const, right: null };
      if (nextCursorResult._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
      const asOf = new Date(page.asOf);
      const body: RestGroupList = decodeRestGroupList({
        data: selected.map((group) => ({
          display_name: group.displayName,
          group_id: group.publicId,
        })),
        meta: {
          as_of: page.asOf,
          partial: page.partial,
          stale:
            page.stale ||
            !Number.isFinite(asOf.valueOf()) ||
            readAt.valueOf() - asOf.valueOf() > 10 * 60 * 1_000,
        },
        pagination: {
          has_more: hasMore,
          next_cursor: nextCursorResult.right,
        },
      });
      const completed = yield* persistence
        .completeProtectedOperation({
          auditLogId,
          completedAt: yield* clock.now,
          errorCode: null,
          outcome: "success",
          resultCount: body.data.length,
        })
        .pipe(Effect.either);
      if (completed._tag === "Left") {
        yield* emitCompletion(LIST_GROUPS, "audit_unavailable");
        return problemResponse("unavailable", 503);
      }
      yield* emitCompletion(LIST_GROUPS, "success", body.data.length);
      return noStoreJsonResponse(body, 200);
    }).pipe(
      Effect.provide(layer),
      Effect.match({
        onFailure: (failure) =>
          failure instanceof Response
            ? failure
            : problemResponse("unavailable", 503),
        onSuccess: (response) => response,
      }),
    ),
  );

const listConversations = (
  request: Request,
  connectionPublicId: string,
  options: RestHandlerOptions,
  layer: Layer.Layer<RestRequirements, unknown>,
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const url = new URL(request.url);
      const queryKeys = [...url.searchParams.keys()];
      if (
        queryKeys.some(
          (key) => key !== "cursor" && key !== "kind" && key !== "limit",
        ) ||
        url.searchParams.getAll("cursor").length > 1 ||
        url.searchParams.getAll("kind").length > 1 ||
        url.searchParams.getAll("limit").length > 1
      ) {
        return problemResponse("invalid_request", 400);
      }
      const kind = parseConversationKind(url.searchParams.get("kind"));
      const limit = parseContactLimit(url.searchParams.get("limit"));
      const cursor = url.searchParams.get("cursor");
      if (
        kind === "invalid" ||
        limit === "invalid" ||
        (cursor !== null && (cursor.length < 1 || cursor.length > 4_096))
      ) {
        return problemResponse("invalid_request", 400);
      }

      const grant = yield* authenticate(request);
      const clock = yield* RestClock;
      const identifiers = yield* RestIdentifiers;
      const persistence = yield* RestPersistence;
      const cursors = yield* RestCursorCodec;
      const startedAt = yield* clock.now;
      const cursorContext: RestCursorContext = {
        connectionId:
          Schema.decodeUnknownSync(ConnectionId)(connectionPublicId),
        filters: { kind },
        grantId: grant.grantId,
        operationId: LIST_CONVERSATIONS_OPERATION_ID,
        pageSize: limit,
        sortVersion: CONVERSATION_SORT_VERSION,
      };
      let boundary: readonly [string, string] | null = null;
      if (cursor !== null) {
        const decoded = yield* cursors
          .decode({
            context: cursorContext,
            cursor,
            nowEpochSeconds: Math.floor(startedAt.valueOf() / 1_000),
          })
          .pipe(Effect.either);
        if (
          decoded._tag === "Left" ||
          decoded.right.length !== 2 ||
          typeof decoded.right[0] !== "string" ||
          typeof decoded.right[1] !== "string" ||
          !/^cvs_[A-Za-z0-9_-]{21}$/u.test(decoded.right[1])
        ) {
          const auditLogId = yield* identifiers.nextAuditLogId;
          const rejected = yield* persistence
            .rejectProtectedOperation({
              apiKey: {
                grantId: grant.grantId,
                name: grant.name,
                publicId: grant.id,
              },
              auditLogId,
              connectionPublicId,
              errorCode: "invalid_cursor",
              observedAt: startedAt,
              operationName: LIST_CHATS,
              permissions: grant.permissions,
              personalAccountId: grant.personalAccountId,
              requiredPermission: "messages:read",
            })
            .pipe(Effect.either);
          if (rejected._tag === "Left") {
            yield* emitCompletion(LIST_CHATS, "audit_unavailable");
            return problemResponse("unavailable", 503);
          }
          if (rejected.right === "authorization_denied") {
            yield* emitCompletion(LIST_CHATS, "authorization_denied");
            return grant.permissions.includes("messages:read")
              ? problemResponse("invalid_credentials", 401)
              : problemResponse("insufficient_permission", 403);
          }
          yield* emitCompletion(LIST_CHATS, "invalid_cursor");
          return problemResponse("invalid_cursor", 400);
        }
        boundary = [decoded.right[0], decoded.right[1]];
      }

      const auditLogId = yield* identifiers.nextAuditLogId;
      const started = yield* persistence
        .beginProtectedOperation({
          apiKey: {
            grantId: grant.grantId,
            name: grant.name,
            publicId: grant.id,
          },
          auditLogId,
          channel: "api",
          connectionPublicId,
          hourLimit: options.hourLimit,
          keyHourLimit: options.keyHourLimit,
          keyMinuteLimit: options.keyMinuteLimit,
          minuteLimit: options.minuteLimit,
          observedAt: startedAt,
          operationName: LIST_CHATS,
          permissions: grant.permissions,
          personalAccountId: grant.personalAccountId,
          requiredPermission: "messages:read" satisfies ApiKeyPermission,
        })
        .pipe(Effect.either);
      if (started._tag === "Left") {
        yield* emitCompletion(LIST_CHATS, "audit_unavailable");
        return problemResponse("unavailable", 503);
      }
      if (started.right.outcome === "authorization_denied") {
        yield* emitCompletion(LIST_CHATS, "authorization_denied");
        return grant.permissions.includes("messages:read")
          ? problemResponse("invalid_credentials", 401)
          : problemResponse("insufficient_permission", 403);
      }
      if (started.right.outcome === "rate_limited") {
        yield* emitCompletion(LIST_CHATS, "rate_limited");
        return problemResponse("rate_limited", 429, {
          retry_after_seconds: started.right.retryAfterSeconds,
          retryable: true,
          resets_at:
            started.right.resetsAt.toISOString() as ProblemDetails["resets_at"],
        });
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
          yield* emitCompletion(
            LIST_CHATS,
            completed._tag === "Left"
              ? "audit_unavailable"
              : denied
                ? "authorization_denied"
                : "unavailable",
          );
          return completed._tag === "Left"
            ? problemResponse("unavailable", 503)
            : denied
              ? problemResponse("not_found", 404)
              : problemResponse("unavailable", 503);
        });

      const loaded = yield* persistence
        .listChats({
          apiKeyGrantId: grant.grantId,
          connectionPublicId,
          cursorActivityAt: boundary?.[0] ?? null,
          cursorPublicId: boundary?.[1] ?? null,
          kind,
          limit: limit + 1,
          observedAt: yield* clock.now,
          permissions: grant.permissions,
          personalAccountId: grant.personalAccountId,
        })
        .pipe(Effect.either);
      if (loaded._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
      const page = loaded.right;
      if (page === null) {
        return yield* failAfterAudit("authorization_denied", true);
      }
      const selected = page.chats.slice(0, limit);
      const hasMore = page.chats.length > limit;
      if (
        selected.length > 0 &&
        (page.accountKey === null || page.connectionKey === null)
      ) {
        return yield* failAfterAudit("service_unavailable");
      }

      const encryption = yield* EnvelopeEncryptionService;
      const accountKey = page.accountKey;
      const connectionKey = page.connectionKey;
      const encryptedMetadata: Array<{
        readonly ciphertext: NonNullable<
          (typeof selected)[number]["displayName"]
        >;
        readonly context: {
          readonly accountId: string;
          readonly connectionId: string;
          readonly entity: string;
          readonly fieldOrObjectPurpose: string;
          readonly recordId: string;
        };
      }> = [];
      const metadataIndexes = selected.map((chat) => {
        const add = (
          ciphertext: (typeof selected)[number]["displayName"],
          entity: string,
          purpose: string,
        ): number | null => {
          if (ciphertext === null) return null;
          if (accountKey === null || connectionKey === null) {
            throw new Error("missing conversation key material");
          }
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
      const decryptedMetadata =
        encryptedMetadata.length === 0
          ? { _tag: "Right" as const, right: [] as ReadonlyArray<string> }
          : accountKey === null || connectionKey === null
            ? { _tag: "Left" as const, left: new RestPersistenceError() }
            : yield* encryption
                .decryptMany({
                  accountKey,
                  connectionKey,
                  items: encryptedMetadata,
                })
                .pipe(
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
                            return plaintexts.map((value) =>
                              decoder.decode(value),
                            );
                          },
                          catch: () => new RestPersistenceError(),
                        }),
                      (plaintexts) =>
                        Effect.sync(() => {
                          for (const value of plaintexts) value.fill(0);
                        }),
                    ),
                  ),
                  Effect.either,
                );
      if (decryptedMetadata._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
      const revealedResult = yield* Effect.try({
        try: () =>
          selected.map((chat, index) => {
            const indexes = metadataIndexes[index];
            if (indexes === undefined) {
              throw new RestPersistenceError();
            }
            const displayName =
              indexes.displayName === null
                ? null
                : (decryptedMetadata.right[indexes.displayName] ?? null);
            const phone =
              indexes.phone === null
                ? null
                : (decryptedMetadata.right[indexes.phone] ?? null);
            if (
              phone !== null &&
              (chat.kind !== "direct" || !/^\+[1-9]\d{6,14}$/u.test(phone))
            ) {
              throw new RestPersistenceError();
            }
            return {
              conversationId: chat.conversationId,
              displayName,
              kind: chat.kind,
              lastActivityAt: chat.lastActivityAt,
              lastActivityDirection: chat.lastActivityDirection,
              phoneLastFour:
                chat.kind === "direct" && phone !== null
                  ? phone.replace(/\D/gu, "").slice(-4) || null
                  : null,
              recipientId: chat.recipientId,
            };
          }),
        catch: () => new RestPersistenceError(),
      }).pipe(Effect.either);
      if (revealedResult._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
      const revealed = revealedResult.right;
      const last = revealed.at(-1);
      const nextCursorResult =
        hasMore && last !== undefined
          ? yield* cursors
              .encode({
                boundary: [last.lastActivityAt, last.conversationId],
                context: cursorContext,
                expiresAtEpochSeconds:
                  Math.floor(startedAt.valueOf() / 1_000) + CURSOR_TTL_SECONDS,
              })
              .pipe(Effect.either)
          : { _tag: "Right" as const, right: null };
      if (nextCursorResult._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
      const body: RestConversationList = decodeRestConversationList({
        data: revealed.map((chat) => ({
          conversation_id: chat.conversationId,
          display_name: chat.displayName,
          kind: chat.kind,
          last_activity_at: chat.lastActivityAt,
          last_activity_direction: chat.lastActivityDirection,
          phone_last_four: chat.phoneLastFour,
          recipient_id: chat.recipientId,
        })),
        meta: {
          as_of: page.asOf,
          partial: page.partial,
          stale: page.stale,
        },
        pagination: {
          has_more: hasMore,
          next_cursor: nextCursorResult.right,
        },
      });
      const completed = yield* persistence
        .completeProtectedOperation({
          auditLogId,
          completedAt: yield* clock.now,
          errorCode: null,
          outcome: "success",
          resultCount: body.data.length,
        })
        .pipe(Effect.either);
      if (completed._tag === "Left") {
        yield* emitCompletion(LIST_CHATS, "audit_unavailable");
        return problemResponse("unavailable", 503);
      }
      yield* emitCompletion(LIST_CHATS, "success", body.data.length);
      return noStoreJsonResponse(body, 200);
    }).pipe(
      Effect.provide(layer),
      Effect.match({
        onFailure: (failure) =>
          failure instanceof Response
            ? failure
            : problemResponse("unavailable", 503),
        onSuccess: (response) => response,
      }),
    ),
  );

const listMessages = (
  request: Request,
  connectionPublicId: string,
  conversationPublicId: string,
  options: RestHandlerOptions,
  layer: Layer.Layer<RestRequirements, unknown>,
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const url = new URL(request.url);
      const queryKeys = [...url.searchParams.keys()];
      if (
        queryKeys.some((key) => key !== "cursor" && key !== "limit") ||
        url.searchParams.getAll("cursor").length > 1 ||
        url.searchParams.getAll("limit").length > 1
      ) {
        return problemResponse("invalid_request", 400);
      }
      const limit = parseContactLimit(url.searchParams.get("limit"));
      const cursor = url.searchParams.get("cursor");
      if (
        limit === "invalid" ||
        (cursor !== null && (cursor.length < 1 || cursor.length > 4_096))
      ) {
        return problemResponse("invalid_request", 400);
      }

      const grant = yield* authenticate(request);
      const clock = yield* RestClock;
      const identifiers = yield* RestIdentifiers;
      const persistence = yield* RestPersistence;
      const cursors = yield* RestCursorCodec;
      const startedAt = yield* clock.now;
      const cursorContext: RestCursorContext = {
        connectionId:
          Schema.decodeUnknownSync(ConnectionId)(connectionPublicId),
        filters: { conversation_id: conversationPublicId },
        grantId: grant.grantId,
        operationId: LIST_MESSAGES_OPERATION_ID,
        pageSize: limit,
        sortVersion: MESSAGE_SORT_VERSION,
      };
      let boundary: readonly [string, string] | null = null;
      if (cursor !== null) {
        const decoded = yield* cursors
          .decode({
            context: cursorContext,
            cursor,
            nowEpochSeconds: Math.floor(startedAt.valueOf() / 1_000),
          })
          .pipe(Effect.either);
        if (
          decoded._tag === "Left" ||
          decoded.right.length !== 2 ||
          typeof decoded.right[0] !== "string" ||
          typeof decoded.right[1] !== "string" ||
          !/^msg_[A-Za-z0-9_-]{21}$/u.test(decoded.right[1])
        ) {
          const auditLogId = yield* identifiers.nextAuditLogId;
          const rejected = yield* persistence
            .rejectProtectedOperation({
              apiKey: {
                grantId: grant.grantId,
                name: grant.name,
                publicId: grant.id,
              },
              auditLogId,
              connectionPublicId,
              errorCode: "invalid_cursor",
              observedAt: startedAt,
              operationName: READ_MESSAGES,
              permissions: grant.permissions,
              personalAccountId: grant.personalAccountId,
              requiredPermission: "messages:read",
            })
            .pipe(Effect.either);
          if (rejected._tag === "Left") {
            yield* emitCompletion(READ_MESSAGES, "audit_unavailable");
            return problemResponse("unavailable", 503);
          }
          if (rejected.right === "authorization_denied") {
            yield* emitCompletion(READ_MESSAGES, "authorization_denied");
            return grant.permissions.includes("messages:read")
              ? problemResponse("invalid_credentials", 401)
              : problemResponse("insufficient_permission", 403);
          }
          yield* emitCompletion(READ_MESSAGES, "invalid_cursor");
          return problemResponse("invalid_cursor", 400);
        }
        boundary = [decoded.right[0], decoded.right[1]];
      }

      const auditLogId = yield* identifiers.nextAuditLogId;
      const started = yield* persistence
        .beginProtectedOperation({
          apiKey: {
            grantId: grant.grantId,
            name: grant.name,
            publicId: grant.id,
          },
          auditLogId,
          channel: "api",
          connectionPublicId,
          hourLimit: options.hourLimit,
          keyHourLimit: options.keyHourLimit,
          keyMinuteLimit: options.keyMinuteLimit,
          minuteLimit: options.minuteLimit,
          observedAt: startedAt,
          operationName: READ_MESSAGES,
          permissions: grant.permissions,
          personalAccountId: grant.personalAccountId,
          requiredPermission: "messages:read" satisfies ApiKeyPermission,
        })
        .pipe(Effect.either);
      if (started._tag === "Left") {
        yield* emitCompletion(READ_MESSAGES, "audit_unavailable");
        return problemResponse("unavailable", 503);
      }
      if (started.right.outcome === "authorization_denied") {
        yield* emitCompletion(READ_MESSAGES, "authorization_denied");
        return grant.permissions.includes("messages:read")
          ? problemResponse("invalid_credentials", 401)
          : problemResponse("insufficient_permission", 403);
      }
      if (started.right.outcome === "rate_limited") {
        yield* emitCompletion(READ_MESSAGES, "rate_limited");
        return problemResponse("rate_limited", 429, {
          retry_after_seconds: started.right.retryAfterSeconds,
          retryable: true,
          resets_at:
            started.right.resetsAt.toISOString() as ProblemDetails["resets_at"],
        });
      }

      const failAfterAudit = (
        errorCode: string,
        denied = false,
        rateLimited?: { readonly resetsAt: Date },
      ) =>
        Effect.gen(function* () {
          const completed = yield* persistence
            .completeProtectedOperation({
              auditLogId,
              completedAt: yield* clock.now,
              errorCode,
              outcome: denied
                ? "authorization_denied"
                : rateLimited !== undefined
                  ? "execution_error"
                  : "execution_error",
              resultCount: null,
            })
            .pipe(Effect.either);
          yield* emitCompletion(
            READ_MESSAGES,
            completed._tag === "Left"
              ? "audit_unavailable"
              : denied
                ? "authorization_denied"
                : rateLimited !== undefined
                  ? "rate_limited"
                  : "unavailable",
          );
          if (completed._tag === "Left") {
            return problemResponse("unavailable", 503);
          }
          if (denied) return problemResponse("not_found", 404);
          if (rateLimited !== undefined) {
            return problemResponse("rate_limited", 429, {
              retry_after_seconds: Math.max(
                0,
                Math.ceil(
                  (rateLimited.resetsAt.valueOf() - startedAt.valueOf()) /
                    1_000,
                ),
              ),
              retryable: true,
              resets_at:
                rateLimited.resetsAt.toISOString() as ProblemDetails["resets_at"],
            });
          }
          return problemResponse("unavailable", 503);
        });

      const loaded = yield* persistence
        .readMessages({
          apiKeyGrantId: grant.grantId,
          connectionPublicId,
          conversationPublicId,
          cursorPublicId: boundary?.[1] ?? null,
          cursorSentAt: boundary?.[0] ?? null,
          limit,
          observedAt: yield* clock.now,
          permissions: grant.permissions,
          personalAccountId: grant.personalAccountId,
        })
        .pipe(Effect.either);
      if (loaded._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
      const page = loaded.right;
      if (page === null) {
        return yield* failAfterAudit("authorization_denied", true);
      }

      const encryption = yield* EnvelopeEncryptionService;
      const encryptedContent: Array<{
        readonly ciphertext: NonNullable<
          (typeof page.messages)[number]["content"]
        >;
        readonly context: {
          readonly accountId: string;
          readonly connectionId: string;
          readonly entity: string;
          readonly fieldOrObjectPurpose: string;
          readonly recordId: string;
        };
      }> = [];
      const contentIndexes = page.messages.map((message) => {
        const add = (
          ciphertext: (typeof page.messages)[number]["content"],
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
            message.media?.metadata ?? null,
            "stored-media",
            "metadata",
            message.media?.id ?? "",
          ),
          senderDisplayName: add(
            message.sender?.displayName ?? null,
            "directory-contact",
            "display-name",
            message.sender?.recordId ?? "",
          ),
          senderPhone: add(
            message.sender?.phone ?? null,
            "directory-contact",
            "phone-number",
            message.sender?.recordId ?? "",
          ),
        };
      });
      const decrypted =
        encryptedContent.length === 0
          ? {
              _tag: "Right" as const,
              right: page.messages.map((message) => ({
                mediaMetadata: null as {
                  readonly fileName: string | null;
                  readonly mimeType: string;
                } | null,
                message,
                senderDisplayName: null as string | null,
                senderPhone: null as string | null,
                text: null as string | null,
              })),
            }
          : yield* encryption
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
                            if (indexes === undefined) {
                              throw new RestPersistenceError();
                            }
                            let text: string | null = null;
                            if (indexes.content !== null) {
                              const plaintext = values[indexes.content];
                              if (plaintext === undefined) {
                                throw new RestPersistenceError();
                              }
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
                              ) {
                                throw new RestPersistenceError();
                              }
                              text = (content as { text: string | null }).text;
                            }
                            let mediaMetadata: {
                              readonly fileName: string | null;
                              readonly mimeType: string;
                            } | null = null;
                            if (indexes.mediaMetadata !== null) {
                              const plaintext = values[indexes.mediaMetadata];
                              if (plaintext === undefined) {
                                throw new RestPersistenceError();
                              }
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
                              ) {
                                throw new RestPersistenceError();
                              }
                              mediaMetadata = {
                                fileName: metadata.fileName as string | null,
                                mimeType: metadata.mimeType,
                              };
                            }
                            const decodeString = (
                              valueIndex: number | null,
                            ) => {
                              if (valueIndex === null) return null;
                              const plaintext = values[valueIndex];
                              if (plaintext === undefined) {
                                throw new RestPersistenceError();
                              }
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
                        catch: () => new RestPersistenceError(),
                      }),
                    (values) =>
                      Effect.sync(() => {
                        for (const value of values) value.fill(0);
                      }),
                  ),
                ),
                Effect.either,
              );
      if (decrypted._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }

      const normalized = decrypted.right.map(
        ({ message, text, mediaMetadata, senderDisplayName, senderPhone }) => ({
          content_type: message.contentType,
          deleted: message.deleted ?? false,
          direction: message.direction,
          edited_at: message.editedAt ?? null,
          media:
            message.media == null
              ? null
              : {
                  file_name: mediaMetadata?.fileName ?? null,
                  media_id: message.media.publicId,
                  mime_type: mediaMetadata?.mimeType ?? null,
                  path:
                    message.media.state === "ready" &&
                    (message.media.plaintextSizeBytes ??
                      Number.POSITIVE_INFINITY) <= READY_MEDIA_BYTE_LIMIT
                      ? restStoredMediaPath({
                          connectionId: connectionPublicId,
                          mediaId: message.media.publicId,
                          messageId: message.publicId,
                        })
                      : null,
                  size_bytes: message.media.plaintextSizeBytes,
                  state: message.media.state,
                  type: message.contentType as
                    | "image"
                    | "audio"
                    | "video"
                    | "document"
                    | "sticker",
                  unavailable_reason:
                    message.media.state === "pending"
                      ? ("media_pending" as const)
                      : message.media.state === "rejected"
                        ? ("media_rejected" as const)
                        : message.media.state === "failed"
                          ? ("media_failed" as const)
                          : (message.media.plaintextSizeBytes ??
                                Number.POSITIVE_INFINITY) >
                              READY_MEDIA_BYTE_LIMIT
                            ? ("too_large" as const)
                            : null,
                },
          message_id: message.publicId,
          sender: {
            display_name:
              message.direction === "inbound" ? senderDisplayName : null,
            kind:
              message.direction === "outbound"
                ? ("self" as const)
                : message.conversationKind === "group"
                  ? ("group_participant" as const)
                  : ("contact" as const),
            phone_last_four:
              message.direction === "inbound" && senderPhone !== null
                ? senderPhone.replace(/\D/gu, "").slice(-4) || null
                : null,
          },
          sent_at: message.sentAt,
          text,
        }),
      );

      const encoder = new TextEncoder();
      const makeBody = (
        selectedNewestFirst: typeof normalized,
        nextCursor: string | null,
        sizeLimited: boolean,
      ): RestMessageList =>
        decodeRestMessageList({
          data: [...selectedNewestFirst].reverse(),
          meta: {
            conversation_id: page.conversation.publicId,
            gaps: page.gaps.map((gap) => ({
              cause: gap.cause,
              ends_at: gap.endsAt,
              starts_at: gap.startsAt,
            })),
            history_start_reason: page.historyStartReason,
            history_starts_at: page.historyStartsAt,
            kind: page.conversation.kind,
            recipient_id: page.conversation.recipientId,
            size_limited: sizeLimited,
          },
          pagination: {
            has_more:
              page.hasOlder || selectedNewestFirst.length < normalized.length,
            next_cursor: nextCursor,
          },
        });
      const cursorFor = (selectedNewestFirst: typeof normalized) =>
        Effect.gen(function* () {
          const oldest = selectedNewestFirst.at(-1);
          if (
            oldest === undefined ||
            (!page.hasOlder && selectedNewestFirst.length === normalized.length)
          ) {
            return null;
          }
          return yield* cursors.encode({
            boundary: [oldest.sent_at, oldest.message_id],
            context: cursorContext,
            expiresAtEpochSeconds:
              Math.floor(startedAt.valueOf() / 1_000) + CURSOR_TTL_SECONDS,
          });
        });

      let selected = normalized;
      let body: RestMessageList | null = null;
      while (selected.length > 0) {
        const olderCursor = yield* cursorFor(selected).pipe(Effect.either);
        if (olderCursor._tag === "Left") {
          return yield* failAfterAudit("service_unavailable");
        }
        const candidate = makeBody(
          selected,
          olderCursor.right,
          page.sizeLimited || selected.length < normalized.length,
        );
        if (
          encoder.encode(JSON.stringify(candidate)).byteLength <=
            REST_MESSAGE_PAGE_MAX_JSON_BYTES ||
          selected.length === 1
        ) {
          body = candidate;
          break;
        }
        selected = selected.slice(0, -1);
      }
      if (body === null) {
        body = makeBody([], null, page.sizeLimited);
      } else if (
        encoder.encode(JSON.stringify(body)).byteLength >
        REST_MESSAGE_PAGE_MAX_JSON_BYTES
      ) {
        return yield* failAfterAudit("service_unavailable");
      }

      const completion = yield* persistence
        .completeMessageRecordRead({
          apiKeyGrantId: grant.grantId,
          auditLogId,
          dailyRecordLimit: options.dailyRecordLimit,
          observedAt: yield* clock.now,
          personalAccountId: grant.personalAccountId,
          resultCount: body.data.length,
        })
        .pipe(Effect.either);
      if (completion._tag === "Left") {
        yield* emitCompletion(READ_MESSAGES, "audit_unavailable");
        return problemResponse("unavailable", 503);
      }
      if (completion.right.outcome === "record_quota_exhausted") {
        return yield* failAfterAudit("rate_limited", false, {
          resetsAt: completion.right.resetsAt,
        });
      }
      yield* emitCompletion(READ_MESSAGES, "success", body.data.length);
      return noStoreJsonResponse(body, 200);
    }).pipe(
      Effect.provide(layer),
      Effect.match({
        onFailure: (failure) =>
          failure instanceof Response
            ? failure
            : problemResponse("unavailable", 503),
        onSuccess: (response) => response,
      }),
    ),
  );

const searchMessages = (
  request: Request,
  connectionPublicId: string,
  options: RestHandlerOptions,
  layer: Layer.Layer<RestRequirements, unknown>,
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const url = new URL(request.url);
      if ([...url.searchParams.keys()].length > 0) {
        return problemResponse("invalid_request", 400);
      }
      const body = yield* Effect.tryPromise({
        try: () => parseSearchBody(request),
        catch: () => null,
      });
      if (body === null) {
        return problemResponse("invalid_request", 400);
      }
      let query: ReturnType<typeof validateMessageSearchQuery>;
      try {
        query = validateMessageSearchQuery(body.query);
      } catch {
        return problemResponse("invalid_request", 400);
      }
      const limit = parseSearchLimit(body.limit);
      const after = body.after ?? null;
      const before = body.before ?? null;
      if (
        limit === "invalid" ||
        (after !== null &&
          before !== null &&
          new Date(after).valueOf() >= new Date(before).valueOf())
      ) {
        return problemResponse("invalid_request", 400);
      }
      const conversationPublicId = body.conversation_id ?? null;
      const direction = body.direction ?? "all";
      const cursor = body.cursor ?? null;

      const grant = yield* authenticate(request);
      const clock = yield* RestClock;
      const identifiers = yield* RestIdentifiers;
      const persistence = yield* RestPersistence;
      const cursors = yield* RestCursorCodec;
      const startedAt = yield* clock.now;
      const queryDigest = yield* cursors
        .digestSearchQuery(query.terms)
        .pipe(Effect.either);
      if (queryDigest._tag === "Left") {
        return problemResponse("unavailable", 503);
      }
      const cursorContext: RestCursorContext = {
        connectionId:
          Schema.decodeUnknownSync(ConnectionId)(connectionPublicId),
        filters: {
          after,
          before,
          conversation_id: conversationPublicId,
          direction,
          index_version: "v1",
          query_digest: queryDigest.right,
        },
        grantId: grant.grantId,
        operationId: SEARCH_MESSAGES_OPERATION_ID,
        pageSize: limit,
        sortVersion: SEARCH_SORT_VERSION,
      };
      let boundary: readonly [string, string] | null = null;
      if (cursor !== null) {
        const decoded = yield* cursors
          .decode({
            context: cursorContext,
            cursor,
            nowEpochSeconds: Math.floor(startedAt.valueOf() / 1_000),
          })
          .pipe(Effect.either);
        if (
          decoded._tag === "Left" ||
          decoded.right.length !== 2 ||
          typeof decoded.right[0] !== "string" ||
          typeof decoded.right[1] !== "string" ||
          !/^msg_[A-Za-z0-9_-]{21}$/u.test(decoded.right[1])
        ) {
          const auditLogId = yield* identifiers.nextAuditLogId;
          const rejected = yield* persistence
            .rejectProtectedOperation({
              apiKey: {
                grantId: grant.grantId,
                name: grant.name,
                publicId: grant.id,
              },
              auditLogId,
              connectionPublicId,
              errorCode: "invalid_cursor",
              observedAt: startedAt,
              operationName: SEARCH_MESSAGES,
              permissions: grant.permissions,
              personalAccountId: grant.personalAccountId,
              requiredPermission: "messages:read",
            })
            .pipe(Effect.either);
          if (rejected._tag === "Left") {
            yield* emitCompletion(SEARCH_MESSAGES, "audit_unavailable");
            return problemResponse("unavailable", 503);
          }
          if (rejected.right === "authorization_denied") {
            yield* emitCompletion(SEARCH_MESSAGES, "authorization_denied");
            return grant.permissions.includes("messages:read")
              ? problemResponse("invalid_credentials", 401)
              : problemResponse("insufficient_permission", 403);
          }
          yield* emitCompletion(SEARCH_MESSAGES, "invalid_cursor");
          return problemResponse("invalid_cursor", 400);
        }
        boundary = [decoded.right[0], decoded.right[1]];
      }

      const auditLogId = yield* identifiers.nextAuditLogId;
      const started = yield* persistence
        .beginProtectedOperation({
          apiKey: {
            grantId: grant.grantId,
            name: grant.name,
            publicId: grant.id,
          },
          auditLogId,
          channel: "api",
          connectionPublicId,
          hourLimit: options.hourLimit,
          keyHourLimit: options.keyHourLimit,
          keyMinuteLimit: options.keyMinuteLimit,
          minuteLimit: options.minuteLimit,
          observedAt: startedAt,
          operationName: SEARCH_MESSAGES,
          permissions: grant.permissions,
          personalAccountId: grant.personalAccountId,
          requiredPermission: "messages:read" satisfies ApiKeyPermission,
        })
        .pipe(Effect.either);
      if (started._tag === "Left") {
        yield* emitCompletion(SEARCH_MESSAGES, "audit_unavailable");
        return problemResponse("unavailable", 503);
      }
      if (started.right.outcome === "authorization_denied") {
        yield* emitCompletion(SEARCH_MESSAGES, "authorization_denied");
        return grant.permissions.includes("messages:read")
          ? problemResponse("invalid_credentials", 401)
          : problemResponse("insufficient_permission", 403);
      }
      if (started.right.outcome === "rate_limited") {
        yield* emitCompletion(SEARCH_MESSAGES, "rate_limited");
        return problemResponse("rate_limited", 429, {
          retry_after_seconds: started.right.retryAfterSeconds,
          retryable: true,
          resets_at:
            started.right.resetsAt.toISOString() as ProblemDetails["resets_at"],
        });
      }

      const failAfterAudit = (
        errorCode: string,
        denied = false,
        rateLimited?: { readonly resetsAt: Date },
      ) =>
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
          yield* emitCompletion(
            SEARCH_MESSAGES,
            completed._tag === "Left"
              ? "audit_unavailable"
              : denied
                ? "authorization_denied"
                : rateLimited !== undefined
                  ? "rate_limited"
                  : "unavailable",
          );
          if (completed._tag === "Left") {
            return problemResponse("unavailable", 503);
          }
          if (denied) return problemResponse("not_found", 404);
          if (rateLimited !== undefined) {
            return problemResponse("rate_limited", 429, {
              retry_after_seconds: Math.max(
                0,
                Math.ceil(
                  (rateLimited.resetsAt.valueOf() - startedAt.valueOf()) /
                    1_000,
                ),
              ),
              retryable: true,
              resets_at:
                rateLimited.resetsAt.toISOString() as ProblemDetails["resets_at"],
            });
          }
          return problemResponse("unavailable", 503);
        });

      const searchInput = {
        after,
        apiKeyGrantId: grant.grantId,
        before,
        connectionPublicId,
        conversationPublicId,
        cursorPublicId: boundary?.[1] ?? null,
        cursorSentAt: boundary?.[0] ?? null,
        direction,
        limit,
        observedAt: startedAt,
        permissions: grant.permissions,
        personalAccountId: grant.personalAccountId,
      } as const;
      const material = yield* persistence
        .searchMessages({ ...searchInput, searchTokens: null })
        .pipe(Effect.either);
      if (material._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
      if (material.right === null) {
        return yield* failAfterAudit("authorization_denied", true);
      }
      const encryption = yield* EnvelopeEncryptionService;
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
      if (keyBytes._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
      const internalConnectionId = material.right.connectionKey.connectionId;
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
      if (tokens._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
      const loaded = yield* persistence
        .searchMessages({ ...searchInput, searchTokens: tokens.right })
        .pipe(Effect.either);
      if (loaded._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
      if (loaded.right === null) {
        return yield* failAfterAudit("authorization_denied", true);
      }
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
      if (plaintexts._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }
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
                if (value === undefined) {
                  throw new RestPersistenceError();
                }
                const content = JSON.parse(decoder.decode(value)) as {
                  readonly text?: unknown;
                };
                if (
                  content === null ||
                  (content.text !== null && typeof content.text !== "string")
                ) {
                  throw new RestPersistenceError();
                }
                const text = content.text as string | null;
                if (
                  text === null ||
                  !verifyMessageSearchCandidate(text, query)
                ) {
                  throw new RestPersistenceError();
                }
                return {
                  content_type: message.contentType,
                  conversation_id: Schema.decodeUnknownSync(ConversationId)(
                    message.conversationPublicId,
                  ),
                  direction: message.direction,
                  edited_at: message.editedAt ?? null,
                  message_id: message.publicId,
                  sent_at: message.sentAt,
                  text,
                };
              });
            },
            catch: () => new RestPersistenceError(),
          }),
        (values) =>
          Effect.sync(() => {
            for (const value of values) value.fill(0);
          }),
      ).pipe(Effect.either);
      if (decoded._tag === "Left") {
        return yield* failAfterAudit("service_unavailable");
      }

      const encoder = new TextEncoder();
      const makeBody = (
        selected: typeof decoded.right,
        nextCursor: string | null,
        sizeLimited: boolean,
      ): RestSearchMessagesList => {
        const reasons: Array<"index_backfill" | "ingestion_gap"> = [];
        if (!page.coverage.backfillComplete) reasons.push("index_backfill");
        if (page.coverage.gaps.length > 0) reasons.push("ingestion_gap");
        return decodeRestSearchMessagesList({
          data: selected,
          meta: {
            backfill_complete: page.coverage.backfillComplete,
            gaps: page.coverage.gaps.map((gap) => ({
              cause: gap.cause,
              ends_at: gap.endsAt,
              starts_at: gap.startsAt,
            })),
            history_start_reason: page.coverage.historyStartReason,
            history_starts_at: page.coverage.historyStartsAt,
            index_version: "v1",
            partial: reasons.length > 0,
            partial_reasons: reasons,
            searchable_history_starts_at:
              page.coverage.searchableHistoryStartsAt,
            size_limited: sizeLimited,
          },
          pagination: {
            has_more: page.hasMore || selected.length < decoded.right.length,
            next_cursor: nextCursor,
          },
        });
      };
      const cursorFor = (selected: typeof decoded.right) =>
        Effect.gen(function* () {
          const oldest = selected.at(-1);
          if (
            oldest === undefined ||
            (!page.hasMore && selected.length === decoded.right.length)
          ) {
            return null;
          }
          return yield* cursors.encode({
            boundary: [oldest.sent_at, oldest.message_id],
            context: cursorContext,
            expiresAtEpochSeconds:
              Math.floor(startedAt.valueOf() / 1_000) + CURSOR_TTL_SECONDS,
          });
        });

      let selected = decoded.right;
      let responseBody: RestSearchMessagesList | null = null;
      while (selected.length > 0) {
        const nextCursor = yield* cursorFor(selected).pipe(Effect.either);
        if (nextCursor._tag === "Left") {
          return yield* failAfterAudit("service_unavailable");
        }
        const candidate = makeBody(
          selected,
          nextCursor.right,
          page.sizeLimited || selected.length < decoded.right.length,
        );
        if (
          encoder.encode(JSON.stringify(candidate)).byteLength <=
            REST_MESSAGE_PAGE_MAX_JSON_BYTES ||
          selected.length === 1
        ) {
          responseBody = candidate;
          break;
        }
        selected = selected.slice(0, -1);
      }
      if (responseBody === null) {
        responseBody = makeBody([], null, page.sizeLimited);
      } else if (
        encoder.encode(JSON.stringify(responseBody)).byteLength >
        REST_MESSAGE_PAGE_MAX_JSON_BYTES
      ) {
        return yield* failAfterAudit("service_unavailable");
      }

      const completion = yield* persistence
        .completeMessageRecordRead({
          apiKeyGrantId: grant.grantId,
          auditLogId,
          dailyRecordLimit: options.dailyRecordLimit,
          observedAt: yield* clock.now,
          personalAccountId: grant.personalAccountId,
          resultCount: responseBody.data.length,
        })
        .pipe(Effect.either);
      if (completion._tag === "Left") {
        yield* emitCompletion(SEARCH_MESSAGES, "audit_unavailable");
        return problemResponse("unavailable", 503);
      }
      if (completion.right.outcome === "record_quota_exhausted") {
        return yield* failAfterAudit("rate_limited", false, {
          resetsAt: completion.right.resetsAt,
        });
      }
      yield* emitCompletion(
        SEARCH_MESSAGES,
        "success",
        responseBody.data.length,
      );
      return noStoreJsonResponse(responseBody, 200);
    }).pipe(
      Effect.provide(layer),
      Effect.match({
        onFailure: (failure) =>
          failure instanceof Response
            ? failure
            : problemResponse("unavailable", 503),
        onSuccess: (response) => response,
      }),
    ),
  );

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

const streamToBytes = async (
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number,
): Promise<Uint8Array> => {
  const bytes = new Uint8Array(expectedBytes);
  const reader = stream.getReader();
  let offset = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    if (offset + next.value.byteLength > expectedBytes) {
      throw new Error("Stored Media exceeded verified size");
    }
    bytes.set(next.value, offset);
    offset += next.value.byteLength;
  }
  if (offset !== expectedBytes) {
    throw new Error("Stored Media did not match verified size");
  }
  return bytes;
};

const mediaContentDisposition = (filename: string | null): string => {
  if (filename === null) return "attachment";
  return `attachment; filename="${filename.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
};

const mediaResponse = (
  body: Uint8Array,
  mimeType: string,
  filename: string | null,
): Response =>
  new Response(body, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": mediaContentDisposition(filename),
      "content-length": String(body.byteLength),
      "content-type": mimeType,
    },
    status: 200,
  });

const getStoredMedia = (
  request: Request,
  connectionPublicId: string,
  messagePublicId: string,
  mediaPublicId: string,
  options: RestHandlerOptions,
  layer: Layer.Layer<RestRequirements, unknown>,
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const url = new URL(request.url);
      if ([...url.searchParams.keys()].length > 0) {
        return problemResponse("invalid_request", 400);
      }
      const grant = yield* authenticate(request);
      const clock = yield* RestClock;
      const identifiers = yield* RestIdentifiers;
      const persistence = yield* RestPersistence;
      const startedAt = yield* clock.now;
      const auditLogId = yield* identifiers.nextAuditLogId;
      const started = yield* persistence
        .beginProtectedOperation({
          apiKey: {
            grantId: grant.grantId,
            name: grant.name,
            publicId: grant.id,
          },
          auditLogId,
          channel: "api",
          connectionPublicId,
          hourLimit: options.hourLimit,
          keyHourLimit: options.keyHourLimit,
          keyMinuteLimit: options.keyMinuteLimit,
          minuteLimit: options.minuteLimit,
          observedAt: startedAt,
          operationName: READ_STORED_MEDIA,
          permissions: grant.permissions,
          personalAccountId: grant.personalAccountId,
          requiredPermission: "messages:read" satisfies ApiKeyPermission,
        })
        .pipe(Effect.either);
      if (started._tag === "Left") {
        yield* emitCompletion(READ_STORED_MEDIA, "audit_unavailable");
        return problemResponse("unavailable", 503);
      }
      if (started.right.outcome === "authorization_denied") {
        yield* emitCompletion(READ_STORED_MEDIA, "authorization_denied");
        return grant.permissions.includes("messages:read")
          ? problemResponse("invalid_credentials", 401)
          : problemResponse("insufficient_permission", 403);
      }
      if (started.right.outcome === "rate_limited") {
        yield* emitCompletion(READ_STORED_MEDIA, "rate_limited");
        return problemResponse("rate_limited", 429, {
          retry_after_seconds: started.right.retryAfterSeconds,
          retryable: true,
          resets_at:
            started.right.resetsAt.toISOString() as ProblemDetails["resets_at"],
        });
      }

      const failAfterAudit = (
        errorCode: string,
        outcome: "authorization_denied" | "rate_limited" | "unavailable",
        extras: {
          readonly resetsAt?: Date;
        } = {},
      ) =>
        Effect.gen(function* () {
          const completed = yield* persistence
            .completeProtectedOperation({
              auditLogId,
              completedAt: yield* clock.now,
              errorCode,
              outcome:
                outcome === "authorization_denied"
                  ? "authorization_denied"
                  : "execution_error",
              resultCount: null,
            })
            .pipe(Effect.either);
          yield* emitCompletion(
            READ_STORED_MEDIA,
            completed._tag === "Left" ? "audit_unavailable" : outcome,
          );
          if (completed._tag === "Left") {
            return problemResponse("unavailable", 503);
          }
          if (outcome === "authorization_denied") {
            return problemResponse("not_found", 404);
          }
          if (outcome === "rate_limited" && extras.resetsAt !== undefined) {
            return problemResponse("rate_limited", 429, {
              retry_after_seconds: Math.max(
                0,
                Math.ceil(
                  (extras.resetsAt.valueOf() - startedAt.valueOf()) / 1_000,
                ),
              ),
              retryable: true,
              resets_at:
                extras.resetsAt.toISOString() as ProblemDetails["resets_at"],
            });
          }
          return problemResponse("unavailable", 503);
        });

      const reserved = yield* persistence
        .reserveStoredMediaRead({
          apiKeyGrantId: grant.grantId,
          auditLogId,
          connectionPublicId,
          dailyByteLimit:
            options.dailyMediaByteLimit ?? DEFAULT_DAILY_MEDIA_BYTE_LIMIT,
          mediaPublicId,
          messagePublicId,
          observedAt: startedAt,
          permissions: grant.permissions,
          personalAccountId: grant.personalAccountId,
        })
        .pipe(Effect.either);
      if (reserved._tag === "Left") {
        return yield* failAfterAudit("service_unavailable", "unavailable");
      }
      if (reserved.right.outcome === "not_found") {
        return yield* failAfterAudit("not_found", "authorization_denied");
      }
      if (reserved.right.outcome === "quota_exhausted") {
        return yield* failAfterAudit("rate_limited", "rate_limited", {
          resetsAt: reserved.right.resetsAt,
        });
      }

      const material = reserved.right.material;
      const encryption = yield* EnvelopeEncryptionService;
      const container = yield* StoredMediaContainerService;
      const metadataBytes = yield* encryption
        .decrypt({
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
        })
        .pipe(Effect.either);
      if (metadataBytes._tag === "Left") {
        const failed = yield* persistence
          .failStoredMediaRead({
            auditLogId,
            completedAt: yield* clock.now,
            errorCode: "resource_unavailable",
          })
          .pipe(Effect.either);
        yield* emitCompletion(
          READ_STORED_MEDIA,
          failed._tag === "Left" ? "audit_unavailable" : "unavailable",
        );
        return failed._tag === "Left"
          ? problemResponse("unavailable", 503)
          : problemResponse("not_found", 404);
      }

      let metadata: { fileName: string | null; mimeType: string };
      try {
        const decoded = JSON.parse(
          new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: false,
          }).decode(metadataBytes.right),
        ) as unknown;
        if (
          typeof decoded !== "object" ||
          decoded === null ||
          !("mimeType" in decoded) ||
          typeof decoded.mimeType !== "string" ||
          !("fileName" in decoded) ||
          (decoded.fileName !== null && typeof decoded.fileName !== "string")
        ) {
          throw new Error("Stored Media metadata was invalid");
        }
        metadata = decoded as typeof metadata;
      } catch {
        metadataBytes.right.fill(0);
        const failed = yield* persistence
          .failStoredMediaRead({
            auditLogId,
            completedAt: yield* clock.now,
            errorCode: "resource_unavailable",
          })
          .pipe(Effect.either);
        yield* emitCompletion(
          READ_STORED_MEDIA,
          failed._tag === "Left" ? "audit_unavailable" : "unavailable",
        );
        return failed._tag === "Left"
          ? problemResponse("unavailable", 503)
          : problemResponse("not_found", 404);
      }
      metadataBytes.right.fill(0);

      const stream = yield* container
        .read({
          accountKey: material.accountKey,
          connectionKey: material.connectionKey,
          context: {
            connectionId: material.connectionKey.connectionId,
            mediaObjectId: material.mediaId,
            personalAccountId: material.accountKey.personalAccountId,
          },
          objectKey: material.objectKey,
        })
        .pipe(Effect.either);
      if (stream._tag === "Left") {
        const failed = yield* persistence
          .failStoredMediaRead({
            auditLogId,
            completedAt: yield* clock.now,
            errorCode: "resource_unavailable",
          })
          .pipe(Effect.either);
        yield* emitCompletion(
          READ_STORED_MEDIA,
          failed._tag === "Left" ? "audit_unavailable" : "unavailable",
        );
        return failed._tag === "Left"
          ? problemResponse("unavailable", 503)
          : problemResponse("not_found", 404);
      }

      const bytes = yield* Effect.tryPromise({
        try: () => streamToBytes(stream.right, material.plaintextSizeBytes),
        catch: () => new RestPersistenceError(),
      }).pipe(Effect.either);
      if (bytes._tag === "Left") {
        const failed = yield* persistence
          .failStoredMediaRead({
            auditLogId,
            completedAt: yield* clock.now,
            errorCode: "resource_unavailable",
          })
          .pipe(Effect.either);
        yield* emitCompletion(
          READ_STORED_MEDIA,
          failed._tag === "Left" ? "audit_unavailable" : "unavailable",
        );
        return failed._tag === "Left"
          ? problemResponse("unavailable", 503)
          : problemResponse("not_found", 404);
      }

      const filename =
        metadata.fileName === null
          ? null
          : sanitizeAttachmentFilename(metadata.fileName);
      const completed = yield* persistence
        .completeProtectedOperation({
          auditLogId,
          completedAt: yield* clock.now,
          errorCode: null,
          outcome: "success",
          resultCount: 1,
        })
        .pipe(Effect.either);
      if (completed._tag === "Left") {
        yield* emitCompletion(READ_STORED_MEDIA, "audit_unavailable");
        return problemResponse("unavailable", 503);
      }
      yield* emitCompletion(READ_STORED_MEDIA, "success", 1);
      return mediaResponse(bytes.right, metadata.mimeType, filename);
    }).pipe(
      Effect.provide(layer),
      Effect.match({
        onFailure: (failure) =>
          failure instanceof Response
            ? failure
            : problemResponse("unavailable", 503),
        onSuccess: (response) => response,
      }),
    ),
  );

const headerCount = (request: Request, name: string): number => {
  let count = 0;
  for (const [header] of request.headers) {
    if (header.toLowerCase() === name) count += 1;
  }
  return count;
};

const parseIdempotencyKey = (request: Request): string | null => {
  if (headerCount(request, "idempotency-key") !== 1) return null;
  const raw = request.headers.get("idempotency-key");
  if (raw === null) return null;
  try {
    return decodeIdempotencyKey(raw);
  } catch {
    return null;
  }
};

const parseSearchBody = async (request: Request) => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return null;
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_SEND_BODY_BYTES) {
    return null;
  }
  try {
    return decodeRestSearchMessagesRequest(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
};

const parseSendBody = async (request: Request) => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return null;
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_SEND_BODY_BYTES) {
    return null;
  }
  try {
    return decodeRestCreateSendOperation(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
};

const createSendOperation = (
  request: Request,
  connectionId: string,
  layer: Layer.Layer<RestRequirements, unknown>,
  deferProviderAttempt?: (attempt: Promise<void>) => void,
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const grant = yield* authenticate(request);
      const idempotencyKey = parseIdempotencyKey(request);
      const body = yield* Effect.tryPromise({
        try: () => parseSendBody(request),
        catch: () => problemResponse("invalid_request", 400),
      });
      if (idempotencyKey === null || body === null) {
        return problemResponse("invalid_request", 400);
      }
      const send = yield* SendTextMessage;
      const result = yield* send.send(
        {
          connectionId,
          grant: apiSendGrant({
            grantId: grant.grantId,
            name: grant.name,
            permissions: grant.permissions,
            personalAccountId: grant.personalAccountId,
            publicId: grant.id,
          }),
          idempotencyKey,
          recipientId: body.recipient_id,
          text: body.text,
        },
        deferProviderAttempt,
      );
      if (result.outcome === "receipt") {
        const receipt = decodeRestSendOperation(result.receipt);
        yield* emitCompletion(SEND_OPERATION, "success", 1);
        return noStoreJsonResponse(
          receipt,
          receipt.idempotent_replay ? 200 : 201,
        );
      }
      if (result.outcome === "rate_limited") {
        yield* emitCompletion(SEND_OPERATION, "rate_limited");
        return problemResponse("rate_limited", 429, {
          retry_after_seconds: result.retryAfterSeconds,
          retryable: true,
          resets_at:
            result.resetsAt.toISOString() as ProblemDetails["resets_at"],
        });
      }
      if (result.outcome === "authorization_denied") {
        yield* emitCompletion(SEND_OPERATION, "authorization_denied");
        return grant.permissions.includes("messages:send")
          ? problemResponse("not_found", 404)
          : problemResponse("insufficient_permission", 403);
      }
      if (result.outcome === "recipient_not_found") {
        yield* emitCompletion(SEND_OPERATION, "execution_error");
        return problemResponse("not_found", 404);
      }
      if (result.outcome === "idempotency_conflict") {
        yield* emitCompletion(SEND_OPERATION, "execution_error");
        return problemResponse("idempotency_conflict", 409);
      }
      if (result.outcome === "connection_unavailable") {
        yield* emitCompletion(SEND_OPERATION, "execution_error");
        return problemResponse("connection_unavailable", 409, {
          retryable: true,
        });
      }
      yield* emitCompletion(
        SEND_OPERATION,
        result.outcome === "audit_unavailable"
          ? "audit_unavailable"
          : "unavailable",
      );
      return problemResponse("unavailable", 503);
    }).pipe(
      Effect.provide(layer),
      Effect.match({
        onFailure: (failure) =>
          failure instanceof Response
            ? failure
            : problemResponse("unavailable", 503),
        onSuccess: (response) => response,
      }),
    ),
  );

export const createRestHandler =
  (
    layer: Layer.Layer<RestRequirements, unknown>,
    options: RestHandlerOptions,
  ) =>
  async (
    request: Request,
    deferProviderAttempt?: (attempt: Promise<void>) => void,
  ): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path !== CONNECTIONS_PATH && !path.startsWith(`${CONNECTIONS_PATH}/`)) {
      return problemResponse("not_found", 404);
    }
    const contactsMatch = CONTACTS_PATH.exec(path);
    if (request.method === "GET" && contactsMatch?.[1] !== undefined) {
      return listContacts(request, contactsMatch[1], options, layer);
    }
    const groupsMatch = GROUPS_PATH.exec(path);
    if (request.method === "GET" && groupsMatch?.[1] !== undefined) {
      return listGroups(request, groupsMatch[1], options, layer);
    }
    const conversationsMatch = CONVERSATIONS_PATH.exec(path);
    if (request.method === "GET" && conversationsMatch?.[1] !== undefined) {
      return listConversations(request, conversationsMatch[1], options, layer);
    }
    const messagesMatch = MESSAGES_PATH.exec(path);
    if (
      request.method === "GET" &&
      messagesMatch?.[1] !== undefined &&
      messagesMatch[2] !== undefined
    ) {
      return listMessages(
        request,
        messagesMatch[1],
        messagesMatch[2],
        options,
        layer,
      );
    }
    const searchMatch = SEARCH_MESSAGES_PATH.exec(path);
    if (request.method === "POST" && searchMatch?.[1] !== undefined) {
      return searchMessages(request, searchMatch[1], options, layer);
    }
    const media = parseRestStoredMediaPath(path);
    if (request.method === "GET" && media !== null) {
      return getStoredMedia(
        request,
        media.connectionId,
        media.messageId,
        media.mediaId,
        options,
        layer,
      );
    }
    const sendMatch = SEND_OPERATIONS_PATH.exec(path);
    if (request.method === "POST" && sendMatch?.[1] !== undefined) {
      return createSendOperation(
        request,
        sendMatch[1],
        layer,
        deferProviderAttempt,
      );
    }
    if (request.method !== "GET" || path !== CONNECTIONS_PATH) {
      const parsed = parseBearerCredential(request);
      if (parsed === null) {
        return problemResponse("invalid_credentials", 401);
      }
      const authenticated = await Effect.runPromise(
        authenticate(request).pipe(Effect.provide(layer), Effect.either),
      );
      if (authenticated._tag === "Left") {
        return authenticated.left instanceof Response
          ? authenticated.left
          : problemResponse("unavailable", 503);
      }
      return problemResponse("not_found", 404);
    }
    return listConnections(request, options, layer);
  };

export const isRestRequest = (request: Request): boolean => {
  const path = new URL(request.url).pathname;
  return path === CONNECTIONS_PATH || path.startsWith(`${CONNECTIONS_PATH}/`);
};
