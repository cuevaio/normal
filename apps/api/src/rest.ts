import { parseApiKeyCredential } from "@whatsapp-mcp/contracts/api-key";
import {
  type CursorBoundary,
  type RestCursorContext,
  signRestCursor,
  verifyRestCursor,
} from "@whatsapp-mcp/contracts/cursor";
import { ConnectionId } from "@whatsapp-mcp/contracts/handles";
import {
  decodeRestConnectionList,
  decodeRestContactList,
  decodeRestConversationList,
  type ProblemCode,
  type ProblemDetails,
  problemType,
  type RestConnectionList,
  type RestContactList,
  type RestConversationList,
} from "@whatsapp-mcp/contracts/rest";
import type {
  ApiKeyPermission,
  AuthenticatedApiKey,
} from "@whatsapp-mcp/db/api-key";
import type {
  BeginProtectedOperationInput,
  BeginToolCallResult,
  McpToolChatPage,
  McpToolConnectionRecord,
  McpToolContactReadMaterial,
  McpToolEncryptedContactPage,
  RejectToolCallResult,
} from "@whatsapp-mcp/db/mcp-tool";
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
import { noStoreJsonResponse, noStoreResponse } from "./http-response";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const CONNECTIONS_PATH = "/v1/connections";
const CONTACTS_PATH = /^\/v1\/connections\/(con_[A-Za-z0-9_-]{21})\/contacts$/u;
const CONVERSATIONS_PATH =
  /^\/v1\/connections\/(con_[A-Za-z0-9_-]{21})\/conversations$/u;
const MAX_AUTHORIZATION_LENGTH = 128;
const LIST_CONNECTIONS = "list_connections";
const LIST_CONTACTS = "list_contacts";
const LIST_CHATS = "list_chats";
const LIST_CONTACTS_OPERATION_ID = "listContacts";
const LIST_CONVERSATIONS_OPERATION_ID = "listConversations";
const CONTACT_SORT_VERSION = "contacts-v1";
const CONVERSATION_SORT_VERSION = "conversations-v1";
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const CURSOR_TTL_SECONDS = 900;

export class RestPersistenceError extends Data.TaggedError(
  "RestPersistenceError",
) {}

export interface RestPersistenceService {
  readonly beginProtectedOperation: (
    input: BeginProtectedOperationInput,
  ) => Effect.Effect<BeginToolCallResult, RestPersistenceError>;
  readonly completeToolCall: (input: {
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
  }) => Effect.Effect<RejectToolCallResult, RestPersistenceError>;
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
  | SafeTelemetryService;

export interface RestHandlerOptions {
  readonly hourLimit: number;
  readonly keyHourLimit: number;
  readonly keyMinuteLimit: number;
  readonly minuteLimit: number;
}

const problemTitles: Record<ProblemCode, string> = {
  insufficient_permission: "Insufficient permission",
  invalid_credentials: "Invalid credentials",
  invalid_cursor: "Invalid cursor",
  invalid_request: "Invalid request",
  not_found: "Not found",
  rate_limited: "Rate limited",
  unavailable: "Unavailable",
};

const problemDetails: Record<ProblemCode, string> = {
  insufficient_permission:
    "The API Key does not include the required permission.",
  invalid_credentials:
    "The API Key is missing, malformed, expired, or revoked.",
  invalid_cursor:
    "The cursor is expired, tampered, or bound to another grant or query.",
  invalid_request: "The request parameters are invalid.",
  not_found: "The requested resource was not found.",
  rate_limited: "The request quota is exhausted.",
  unavailable: "The service is temporarily unavailable.",
};

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
  operation: "list_connections" | "list_contacts" | "list_chats",
  outcome:
    | "audit_unavailable"
    | "authorization_denied"
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
          .completeToolCall({
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
          .completeToolCall({
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
          .completeToolCall({
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
        .completeToolCall({
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
            .completeToolCall({
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
        .completeToolCall({
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
            .completeToolCall({
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
        .completeToolCall({
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

export const createRestHandler =
  (
    layer: Layer.Layer<RestRequirements, unknown>,
    options: RestHandlerOptions,
  ) =>
  async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path !== CONNECTIONS_PATH && !path.startsWith(`${CONNECTIONS_PATH}/`)) {
      return problemResponse("not_found", 404);
    }
    const contactsMatch = CONTACTS_PATH.exec(path);
    if (request.method === "GET" && contactsMatch?.[1] !== undefined) {
      return listContacts(request, contactsMatch[1], options, layer);
    }
    const conversationsMatch = CONVERSATIONS_PATH.exec(path);
    if (request.method === "GET" && conversationsMatch?.[1] !== undefined) {
      return listConversations(request, conversationsMatch[1], options, layer);
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
