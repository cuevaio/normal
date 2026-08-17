import { parseApiKeyCredential } from "@whatsapp-mcp/contracts/api-key";
import { IdempotencyKey } from "@whatsapp-mcp/contracts/handles";
import {
  decodeRestConnectionList,
  decodeRestCreateSendOperation,
  decodeRestSendOperation,
  type ProblemCode,
  type ProblemDetails,
  problemType,
  type RestConnectionList,
} from "@whatsapp-mcp/contracts/rest";
import type {
  ApiKeyPermission,
  AuthenticatedApiKey,
} from "@whatsapp-mcp/db/api-key";
import type {
  BeginProtectedOperationInput,
  BeginToolCallResult,
  McpToolConnectionRecord,
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
  EncryptionError,
  type EnvelopeEncryption,
  EnvelopeEncryptionService,
} from "./encryption/envelope";
import { noStoreJsonResponse, noStoreResponse } from "./http-response";
import { SendTextMessage, type SendTextMessageService } from "./mcp";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const CONNECTIONS_PATH = "/v1/connections";
const MAX_AUTHORIZATION_LENGTH = 128;
const MAX_SEND_BODY_BYTES = 32_768;
const LIST_CONNECTIONS_OPERATION = "list_connections" as const;
const SEND_OPERATION = "send_text_message" as const;
const SEND_OPERATIONS_PATH =
  /^\/v1\/connections\/(con_[A-Za-z0-9_-]{21})\/send-operations$/u;
const decodeIdempotencyKey = Schema.decodeUnknownSync(IdempotencyKey);

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

type RestRequirements =
  | ApiKeyHmacService
  | ApiKeyPersistenceService
  | EnvelopeEncryption
  | RestClockService
  | RestIdentifiersService
  | RestPersistenceService
  | SafeTelemetryService
  | SendTextMessageService;

export interface RestHandlerOptions {
  readonly hourLimit: number;
  readonly keyHourLimit: number;
  readonly keyMinuteLimit: number;
  readonly minuteLimit: number;
}

const problemTitles: Record<ProblemCode, string> = {
  connection_unavailable: "Connection unavailable",
  idempotency_conflict: "Idempotency conflict",
  insufficient_permission: "Insufficient permission",
  invalid_credentials: "Invalid credentials",
  invalid_request: "Invalid request",
  not_found: "Not found",
  rate_limited: "Rate limited",
  unavailable: "Unavailable",
};

const problemDetails: Record<ProblemCode, string> = {
  connection_unavailable:
    "The WhatsApp Connection is not connected for a new Send Operation.",
  idempotency_conflict:
    "This Idempotency-Key is already bound to a different Send Operation.",
  insufficient_permission:
    "The API Key does not include the required permission.",
  invalid_credentials:
    "The API Key is missing, malformed, expired, or revoked.",
  invalid_request: "The request body or Idempotency-Key is missing or invalid.",
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
  operation: "list_connections" | "send_text_message",
  outcome:
    | "audit_unavailable"
    | "authorization_denied"
    | "execution_error"
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
          operationName: LIST_CONNECTIONS_OPERATION,
          permissions: grant.permissions,
          personalAccountId: grant.personalAccountId,
          requiredPermission: "connections:read" satisfies ApiKeyPermission,
        })
        .pipe(Effect.either);
      if (started._tag === "Left") {
        yield* emitCompletion(LIST_CONNECTIONS_OPERATION, "audit_unavailable");
        return problemResponse("unavailable", 503);
      }
      if (started.right.outcome === "authorization_denied") {
        yield* emitCompletion(
          LIST_CONNECTIONS_OPERATION,
          "authorization_denied",
        );
        return grant.permissions.includes("connections:read")
          ? problemResponse("invalid_credentials", 401)
          : problemResponse("insufficient_permission", 403);
      }
      if (started.right.outcome === "rate_limited") {
        yield* emitCompletion(LIST_CONNECTIONS_OPERATION, "rate_limited");
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
          LIST_CONNECTIONS_OPERATION,
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
          LIST_CONNECTIONS_OPERATION,
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
          LIST_CONNECTIONS_OPERATION,
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
        yield* emitCompletion(LIST_CONNECTIONS_OPERATION, "audit_unavailable");
        return problemResponse("unavailable", 503);
      }
      yield* emitCompletion(
        LIST_CONNECTIONS_OPERATION,
        "success",
        body.data.length,
      );
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
    const sendMatch = path.match(SEND_OPERATIONS_PATH);
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
