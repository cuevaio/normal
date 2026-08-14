import {
  type ApiKeyCredential,
  apiKeyCredentialHint,
  type ApiKeySummary as ContractApiKeySummary,
  decodeCreateApiKeyRequest,
} from "@whatsapp-mcp/contracts/api-key";
import { makeApiKeyId } from "@whatsapp-mcp/contracts/handles";
import type {
  ApiKeyPermission,
  ApiKeySummary,
  AuthenticatedApiKey,
  CreateApiKeyResult,
} from "@whatsapp-mcp/db/api-key";
import { Context, Data, Effect, type Layer } from "effect";
import {
  HumanIdentity,
  type HumanIdentityService,
} from "./auth/human-identity";
import { encodeBase64Url } from "./base64-url";
import { hasFailureTag } from "./failure-tag";
import { noStoreJsonResponse } from "./http-response";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const MANAGEMENT_PATH = "/v1/api-keys";
const API_KEY_HANDLE_PATTERN = /^apk_[A-Za-z0-9_-]{21}$/u;

export class ApiKeyPersistenceError extends Data.TaggedError(
  "ApiKeyPersistenceError",
)<{
  readonly code?: string;
  readonly constraint?: string;
}> {}

export class ApiKeyHmacError extends Data.TaggedError("ApiKeyHmacError") {}

export interface ApiKeyPersistenceService {
  readonly authenticate: (input: {
    readonly digest: Uint8Array;
    readonly publicId: string;
  }) => Effect.Effect<AuthenticatedApiKey | null, ApiKeyPersistenceError>;
  readonly create: (input: {
    readonly clerkUserId: string;
    readonly connectionIds: ReadonlyArray<string>;
    readonly createdAt: Date;
    readonly credentialDigest: Uint8Array;
    readonly credentialHint: string;
    readonly expiresAt: Date | null;
    readonly id: string;
    readonly name: string;
    readonly permissions: ReadonlyArray<ApiKeyPermission>;
    readonly publicId: string;
    readonly reverifiedAt: Date;
  }) => Effect.Effect<CreateApiKeyResult, ApiKeyPersistenceError>;
  readonly list: (
    clerkUserId: string,
    observedAt: Date,
  ) => Effect.Effect<
    ReadonlyArray<ApiKeySummary> | null,
    ApiKeyPersistenceError
  >;
  readonly revoke: (input: {
    readonly clerkUserId: string;
    readonly publicId: string;
    readonly revokedAt: Date;
  }) => Effect.Effect<
    { readonly revokedAt: Date } | null,
    ApiKeyPersistenceError
  >;
}

export const ApiKeyPersistence = Context.GenericTag<ApiKeyPersistenceService>(
  "@whatsapp-mcp/api/ApiKeyPersistence",
);

export interface ApiKeyClockService {
  readonly now: Effect.Effect<Date>;
}

export const ApiKeyClock = Context.GenericTag<ApiKeyClockService>(
  "@whatsapp-mcp/api/ApiKeyClock",
);

export interface ApiKeyIdentifiersService {
  readonly nextId: Effect.Effect<string>;
  readonly nextPublicId: Effect.Effect<string>;
  readonly nextSecret: Effect.Effect<string>;
}

export const ApiKeyIdentifiers = Context.GenericTag<ApiKeyIdentifiersService>(
  "@whatsapp-mcp/api/ApiKeyIdentifiers",
);

export interface ApiKeyHmacService {
  readonly digest: (
    credential: string,
  ) => Effect.Effect<Uint8Array, ApiKeyHmacError>;
}

export const ApiKeyHmac = Context.GenericTag<ApiKeyHmacService>(
  "@whatsapp-mcp/api/ApiKeyHmac",
);

export const makeApiKeyHmac = (secretHex: string): ApiKeyHmacService => {
  const keyBytes = Uint8Array.from(secretHex.match(/../gu) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
  return {
    digest: (credential) =>
      Effect.tryPromise({
        try: async () => {
          const key = await crypto.subtle.importKey(
            "raw",
            keyBytes,
            { hash: "SHA-256", name: "HMAC" },
            false,
            ["sign"],
          );
          return new Uint8Array(
            await crypto.subtle.sign(
              "HMAC",
              key,
              new TextEncoder().encode(credential),
            ),
          );
        },
        catch: () => new ApiKeyHmacError(),
      }),
  };
};

export const randomApiKeySecret = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
};

type Requirements =
  | ApiKeyClockService
  | ApiKeyHmacService
  | ApiKeyIdentifiersService
  | ApiKeyPersistenceService
  | HumanIdentityService
  | SafeTelemetryService;

const corsHeaders = (browserOrigin: string) => ({
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "DELETE,GET,OPTIONS,POST",
  "access-control-allow-origin": browserOrigin,
  vary: "Origin",
});

const jsonResponse = (
  body: unknown,
  status: number,
  browserOrigin?: string,
): Response =>
  noStoreJsonResponse(
    body,
    status,
    browserOrigin === undefined ? {} : corsHeaders(browserOrigin),
  );

const notFound = (browserOrigin?: string): Response =>
  jsonResponse({ error: "not_found" }, 404, browserOrigin);

const reverificationRequired = (browserOrigin: string): Response =>
  jsonResponse(
    {
      clerk_error: {
        metadata: {
          reverification: {
            afterMinutes: 5,
            level: "first_factor",
          },
        },
        reason: "reverification-error",
        type: "forbidden",
      },
    },
    403,
    browserOrigin,
  );

const failureResponse = (failure: unknown, browserOrigin: string): Response =>
  hasFailureTag(failure, "RecentHumanVerificationRequired")
    ? reverificationRequired(browserOrigin)
    : hasFailureTag(
          failure,
          "InvalidHumanIdentity",
          "InvalidManagementAuthorization",
        )
      ? notFound(browserOrigin)
      : jsonResponse({ error: "unavailable" }, 503, browserOrigin);

class InvalidManagementAuthorization extends Data.TaggedError(
  "InvalidManagementAuthorization",
) {}

const handleFromPath = (path: string): string | null => {
  if (!path.startsWith(`${MANAGEMENT_PATH}/`)) return null;
  const handle = path.slice(MANAGEMENT_PATH.length + 1);
  return API_KEY_HANDLE_PATTERN.test(handle) ? handle : null;
};

const toContractSummary = (summary: ApiKeySummary): ContractApiKeySummary => ({
  connection_ids:
    summary.connectionIds as ContractApiKeySummary["connection_ids"],
  created_at:
    summary.createdAt.toISOString() as ContractApiKeySummary["created_at"],
  credential_hint: summary.credentialHint,
  expires_at: (summary.expiresAt?.toISOString() ??
    null) as ContractApiKeySummary["expires_at"],
  id: summary.id as ContractApiKeySummary["id"],
  last_used_at: (summary.lastUsedAt?.toISOString() ??
    null) as ContractApiKeySummary["last_used_at"],
  name: summary.name,
  permissions: summary.permissions,
  revoked_at: (summary.revokedAt?.toISOString() ??
    null) as ContractApiKeySummary["revoked_at"],
  state: summary.state,
});

const parseCreateBody = async (request: Request) => {
  if (
    request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
  ) {
    return null;
  }
  try {
    return decodeCreateApiKeyRequest(await request.json());
  } catch {
    return null;
  }
};

const createKey = (
  request: Request,
  layer: Layer.Layer<Requirements, unknown>,
  browserOrigin: string,
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const body = yield* Effect.promise(() => parseCreateBody(request));
      if (body === null) {
        return jsonResponse({ error: "invalid" }, 400, browserOrigin);
      }
      const identity = yield* HumanIdentity;
      const verified = yield* identity.verifyRecently(request);
      const clock = yield* ApiKeyClock;
      const createdAt = yield* clock.now;
      const identifiers = yield* ApiKeyIdentifiers;
      const publicId = yield* identifiers.nextPublicId;
      const secret = yield* identifiers.nextSecret;
      const credential = `normal_${publicId}.${secret}` as ApiKeyCredential;
      const hmac = yield* ApiKeyHmac;
      const digest = yield* hmac.digest(credential);
      const persistence = yield* ApiKeyPersistence;
      const result = yield* persistence.create({
        clerkUserId: verified.clerkUserId,
        connectionIds: body.connection_ids,
        createdAt,
        credentialDigest: digest,
        credentialHint: apiKeyCredentialHint(credential),
        expiresAt:
          body.expires_at === undefined || body.expires_at === null
            ? null
            : new Date(body.expires_at),
        id: yield* identifiers.nextId,
        name: body.name,
        permissions: body.permissions,
        publicId,
        reverifiedAt: verified.reverifiedAt,
      });
      const telemetry = yield* SafeTelemetry;
      yield* telemetry.emit({
        event: "api_key.management.completed",
        operation: "create",
        outcome: result.outcome,
        service: "api",
      });
      if (result.outcome === "created") {
        return jsonResponse(
          {
            ...toContractSummary(result.summary),
            credential,
          },
          201,
          browserOrigin,
        );
      }
      if (result.outcome === "not_found") {
        return notFound(browserOrigin);
      }
      return jsonResponse({ error: result.outcome }, 400, browserOrigin);
    }).pipe(
      Effect.provide(layer),
      Effect.match({
        onFailure: (failure: unknown) =>
          failureResponse(failure, browserOrigin),
        onSuccess: (response) => response,
      }),
    ),
  );

const listKeys = (
  request: Request,
  layer: Layer.Layer<Requirements, unknown>,
  browserOrigin: string,
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const identity = yield* HumanIdentity;
      const clerkUserId = yield* identity.verify(request);
      const clock = yield* ApiKeyClock;
      const persistence = yield* ApiKeyPersistence;
      const keys = yield* persistence.list(clerkUserId, yield* clock.now);
      if (keys === null) {
        return yield* Effect.fail(new InvalidManagementAuthorization());
      }
      const telemetry = yield* SafeTelemetry;
      yield* telemetry.emit({
        event: "api_key.management.completed",
        operation: "list",
        outcome: "success",
        service: "api",
      });
      return keys;
    }).pipe(
      Effect.provide(layer),
      Effect.match({
        onFailure: (failure: unknown) =>
          failureResponse(failure, browserOrigin),
        onSuccess: (keys) =>
          jsonResponse(
            { api_keys: keys.map(toContractSummary) },
            200,
            browserOrigin,
          ),
      }),
    ),
  );

const revokeKey = (
  request: Request,
  publicId: string,
  layer: Layer.Layer<Requirements, unknown>,
  browserOrigin: string,
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const identity = yield* HumanIdentity;
      const clerkUserId = yield* identity.verify(request);
      const clock = yield* ApiKeyClock;
      const persistence = yield* ApiKeyPersistence;
      const result = yield* persistence.revoke({
        clerkUserId,
        publicId,
        revokedAt: yield* clock.now,
      });
      const telemetry = yield* SafeTelemetry;
      yield* telemetry.emit({
        event: "api_key.management.completed",
        operation: "revoke",
        outcome: result === null ? "not_found" : "success",
        service: "api",
      });
      if (result === null) {
        return yield* Effect.fail(new InvalidManagementAuthorization());
      }
      return result;
    }).pipe(
      Effect.provide(layer),
      Effect.match({
        onFailure: (failure: unknown) =>
          failureResponse(failure, browserOrigin),
        onSuccess: (result) =>
          jsonResponse(
            {
              api_key: {
                id: publicId,
                revoked_at: result.revokedAt.toISOString(),
                state: "revoked",
              },
            },
            200,
            browserOrigin,
          ),
      }),
    ),
  );

export const createApiKeyManagementHandler =
  (layer: Layer.Layer<Requirements, unknown>, browserOrigin: string) =>
  async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (
      request.headers.get("origin") !== browserOrigin ||
      (path !== MANAGEMENT_PATH && !path.startsWith(`${MANAGEMENT_PATH}/`))
    ) {
      return notFound();
    }
    const publicId = handleFromPath(path);
    if (request.method === "OPTIONS") {
      if (path !== MANAGEMENT_PATH && publicId === null) {
        return notFound(browserOrigin);
      }
      return new Response(null, {
        headers: corsHeaders(browserOrigin),
        status: 204,
      });
    }
    if (request.method === "POST" && path === MANAGEMENT_PATH) {
      return createKey(request, layer, browserOrigin);
    }
    if (request.method === "GET" && path === MANAGEMENT_PATH) {
      return listKeys(request, layer, browserOrigin);
    }
    if (request.method === "DELETE" && publicId !== null) {
      return revokeKey(request, publicId, layer, browserOrigin);
    }
    return notFound(browserOrigin);
  };

export const isApiKeyManagementRequest = (request: Request): boolean => {
  const path = new URL(request.url).pathname;
  return path === MANAGEMENT_PATH || path.startsWith(`${MANAGEMENT_PATH}/`);
};

export const productionApiKeyIdentifiers: ApiKeyIdentifiersService = {
  nextId: Effect.sync(() => crypto.randomUUID()),
  nextPublicId: Effect.sync(() => makeApiKeyId()),
  nextSecret: Effect.sync(randomApiKeySecret),
};
