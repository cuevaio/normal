import { IdempotencyKey } from "@whatsapp-mcp/contracts/handles";
import type {
  CancelledConnectionSetup,
  ConnectionSetupNameMaterial,
  PreparedConnectionSetup,
  StartConnectionSetupInput,
  StartedConnectionSetup,
} from "@whatsapp-mcp/db/connection-setup";
import {
  connectionSetupExpiresAt,
  normalizeWhatsAppNumber,
} from "@whatsapp-mcp/domain/connection-setup";
import { normalizeWhatsAppConnectionName } from "@whatsapp-mcp/domain/whatsapp-connection";
import { Context, Data, Effect, type Layer, Schema } from "effect";
import {
  HumanIdentity,
  type HumanIdentityService,
} from "./auth/human-identity";
import { decodeBase64, encodeBase64 } from "./base64-url";
import {
  ConnectionSetupProvisioningQueue,
  type ConnectionSetupProvisioningQueueError,
  type ConnectionSetupProvisioningQueueService,
} from "./connection-setup-provisioning";
import {
  type EncryptionError,
  type EnvelopeEncryption,
  EnvelopeEncryptionService,
} from "./encryption/envelope";
import { hasFailureTag } from "./failure-tag";
import { noStoreJsonResponse } from "./http-response";
import { hasExactKeys } from "./record";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const CONNECTION_SETUP_ROUTE = "/v1/connection-setups";

export class ConnectionSetupPersistenceError extends Data.TaggedError(
  "ConnectionSetupPersistenceError",
) {}

export class ConnectionSetupNotAccessible extends Data.TaggedError(
  "ConnectionSetupNotAccessible",
) {}

export class ConnectionSetupTokenError extends Data.TaggedError(
  "ConnectionSetupTokenError",
) {}

export interface ConnectionSetupPersistenceService {
  readonly cancel: (input: {
    readonly cancelledAt: string;
    readonly clerkUserId: string;
    readonly setupId: string;
  }) => Effect.Effect<
    CancelledConnectionSetup | null,
    ConnectionSetupPersistenceError
  >;
  readonly prepare: (input: {
    readonly clerkUserId: string;
    readonly idempotencyKey: string;
    readonly numberToken: Uint8Array;
  }) => Effect.Effect<
    PreparedConnectionSetup | null,
    ConnectionSetupPersistenceError
  >;
  readonly start: (
    input: StartConnectionSetupInput,
  ) => Effect.Effect<StartedConnectionSetup, ConnectionSetupPersistenceError>;
}

export const ConnectionSetupPersistence =
  Context.GenericTag<ConnectionSetupPersistenceService>(
    "@whatsapp-mcp/api/ConnectionSetupPersistence",
  );

export interface ConnectionSetupIdentifiersService {
  readonly next: Effect.Effect<string>;
}

export const ConnectionSetupIdentifiers =
  Context.GenericTag<ConnectionSetupIdentifiersService>(
    "@whatsapp-mcp/api/ConnectionSetupIdentifiers",
  );

export interface ConnectionSetupClockService {
  readonly now: Effect.Effect<string>;
}

export const ConnectionSetupClock =
  Context.GenericTag<ConnectionSetupClockService>(
    "@whatsapp-mcp/api/ConnectionSetupClock",
  );

export interface ConnectionSetupNumberTokensService {
  readonly derive: (
    normalizedWhatsAppNumber: string,
  ) => Effect.Effect<Uint8Array, ConnectionSetupTokenError>;
}

export const ConnectionSetupNumberTokens =
  Context.GenericTag<ConnectionSetupNumberTokensService>(
    "@whatsapp-mcp/api/ConnectionSetupNumberTokens",
  );

export type ConnectionSetupRequirements =
  | ConnectionSetupClockService
  | ConnectionSetupIdentifiersService
  | ConnectionSetupNumberTokensService
  | ConnectionSetupPersistenceService
  | ConnectionSetupProvisioningQueueService
  | EnvelopeEncryption
  | HumanIdentityService
  | SafeTelemetryService;

const toArrayBuffer = (value: Uint8Array): ArrayBuffer =>
  value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;

export const makeConnectionSetupNumberTokens = (
  secret: Uint8Array,
): ConnectionSetupNumberTokensService => {
  const importedKey = crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );

  return {
    derive: (normalizedWhatsAppNumber) =>
      Effect.tryPromise({
        try: async () =>
          new Uint8Array(
            await crypto.subtle.sign(
              "HMAC",
              await importedKey,
              new TextEncoder().encode(
                `whatsapp-number-reservation:v1\u0000${normalizedWhatsAppNumber}`,
              ),
            ),
          ),
        catch: () => new ConnectionSetupTokenError(),
      }),
  };
};

type ConnectionSetupOutcome =
  | {
      readonly outcome: "created" | "replay";
      readonly setup: {
        readonly createdAt: string;
        readonly expiresAt: string;
        readonly setupId: string;
        readonly state:
          | "cancelled"
          | "expired"
          | "activated"
          | "provisioned"
          | "provisioning_failed"
          | "provisioning_pending"
          | "provisioning_quarantined";
      };
    }
  | {
      readonly outcome:
        | "connection_limit_reached"
        | "idempotency_conflict"
        | "number_cleanup_in_progress"
        | "number_deletion_in_progress"
        | "number_unavailable";
    };

export const startConnectionSetup = (
  clerkUserId: string,
  idempotencyKey: string,
  displayName: string,
  normalizedWhatsAppNumber: string,
): Effect.Effect<
  ConnectionSetupOutcome,
  | ConnectionSetupNotAccessible
  | ConnectionSetupPersistenceError
  | ConnectionSetupTokenError
  | ConnectionSetupProvisioningQueueError
  | EncryptionError,
  | ConnectionSetupClockService
  | ConnectionSetupIdentifiersService
  | ConnectionSetupNumberTokensService
  | ConnectionSetupPersistenceService
  | ConnectionSetupProvisioningQueueService
  | EnvelopeEncryption
> =>
  Effect.gen(function* () {
    const tokenService = yield* ConnectionSetupNumberTokens;
    const numberToken = yield* tokenService.derive(normalizedWhatsAppNumber);
    const persistence = yield* ConnectionSetupPersistence;
    const prepared = yield* persistence.prepare({
      clerkUserId,
      idempotencyKey,
      numberToken,
    });
    if (prepared === null) {
      return yield* Effect.fail(new ConnectionSetupNotAccessible());
    }
    const matchesStoredName = (
      material: ConnectionSetupNameMaterial,
    ): Effect.Effect<boolean, EncryptionError, EnvelopeEncryption> =>
      material.name.fallback !== null
        ? Effect.succeed(material.name.fallback === displayName)
        : Effect.gen(function* () {
            if (
              material.name.ciphertext === null ||
              material.name.keyVersion === null ||
              material.name.nonce === null ||
              material.name.version === null
            )
              return false;
            const encryption = yield* EnvelopeEncryptionService;
            const plaintext = yield* encryption.decrypt({
              accountKey: material.accountKey,
              ciphertext: {
                ciphertext: encodeBase64(material.name.ciphertext),
                keyVersion: material.name.keyVersion,
                nonce: encodeBase64(material.name.nonce),
                version: material.name.version,
              },
              connectionKey: material.setupKey,
              context: {
                accountId: material.accountKey.personalAccountId,
                connectionId: material.setupKey.connectionId,
                entity: "connection-setup",
                fieldOrObjectPurpose: "display-name",
                recordId: material.setupKey.connectionId,
              },
            });
            return (
              new TextDecoder("utf-8", {
                fatal: true,
                ignoreBOM: false,
              }).decode(plaintext) === displayName
            );
          });
    if (
      prepared.outcome === "replay" &&
      !(yield* matchesStoredName(prepared.nameMaterial))
    ) {
      return { outcome: "idempotency_conflict" };
    }
    if (prepared.outcome === "idempotency_conflict") return prepared;
    const result: ConnectionSetupOutcome =
      prepared.outcome !== "unbound"
        ? { outcome: "replay", setup: prepared.setup }
        : yield* Effect.gen(function* () {
            const identifiers = yield* ConnectionSetupIdentifiers;
            const setupId = yield* identifiers.next;
            const clock = yield* ConnectionSetupClock;
            const createdAt = yield* clock.now;
            if (connectionSetupExpiresAt(createdAt) === null) {
              return yield* Effect.fail(new ConnectionSetupPersistenceError());
            }

            const encryption = yield* EnvelopeEncryptionService;
            const connectionKey = yield* encryption.createConnectionKey({
              accountId: prepared.accountKey.personalAccountId,
              accountKey: prepared.accountKey,
              connectionId: setupId,
              keyVersion: 1,
            });
            const numberCiphertext = yield* encryption.encrypt({
              accountKey: prepared.accountKey,
              connectionKey,
              context: {
                accountId: prepared.accountKey.personalAccountId,
                connectionId: setupId,
                entity: "connection-setup",
                fieldOrObjectPurpose: "whatsapp-number",
                recordId: setupId,
              },
              plaintext: new TextEncoder().encode(normalizedWhatsAppNumber),
            });
            const displayNameCiphertext = yield* encryption.encrypt({
              accountKey: prepared.accountKey,
              connectionKey,
              context: {
                accountId: prepared.accountKey.personalAccountId,
                connectionId: setupId,
                entity: "connection-setup",
                fieldOrObjectPurpose: "display-name",
                recordId: setupId,
              },
              plaintext: new TextEncoder().encode(displayName),
            });

            const started = yield* persistence.start({
              accountKey: prepared.accountKey,
              connectionKeyCiphertext: decodeBase64(connectionKey.ciphertext),
              connectionKeyNonce: decodeBase64(connectionKey.nonce),
              connectionKeyVersion: connectionKey.keyVersion,
              createdAt,
              displayNameCiphertext: decodeBase64(
                displayNameCiphertext.ciphertext,
              ),
              displayNameCiphertextNonce: decodeBase64(
                displayNameCiphertext.nonce,
              ),
              displayNameCiphertextVersion: displayNameCiphertext.version,
              displayNameKeyVersion: displayNameCiphertext.keyVersion,
              idempotencyKey,
              numberCiphertext: decodeBase64(numberCiphertext.ciphertext),
              numberCiphertextNonce: decodeBase64(numberCiphertext.nonce),
              numberCiphertextVersion: numberCiphertext.version,
              numberKeyVersion: numberCiphertext.keyVersion,
              numberToken,
              personalAccountId: prepared.accountKey.personalAccountId,
              setupId,
            });
            if (
              started.outcome === "replay" &&
              !(yield* matchesStoredName(started.nameMaterial))
            ) {
              return { outcome: "idempotency_conflict" as const };
            }
            return started;
          });
    if ("setup" in result) {
      const queue = yield* ConnectionSetupProvisioningQueue;
      if (
        result.setup.state === "cancelled" ||
        result.setup.state === "expired"
      ) {
        yield* queue.enqueueCleanup(result.setup.setupId);
      } else {
        yield* queue.enqueue(result.setup.setupId);
      }
    }
    return result;
  });

export const cancelConnectionSetup = (
  clerkUserId: string,
  setupId: string,
): Effect.Effect<
  CancelledConnectionSetup,
  | ConnectionSetupNotAccessible
  | ConnectionSetupPersistenceError
  | ConnectionSetupProvisioningQueueError,
  | ConnectionSetupClockService
  | ConnectionSetupPersistenceService
  | ConnectionSetupProvisioningQueueService
> =>
  Effect.gen(function* () {
    const clock = yield* ConnectionSetupClock;
    const persistence = yield* ConnectionSetupPersistence;
    const result = yield* persistence.cancel({
      cancelledAt: yield* clock.now,
      clerkUserId,
      setupId,
    });
    if (result === null) {
      return yield* Effect.fail(new ConnectionSetupNotAccessible());
    }
    if (result.cleanupState === "pending") {
      const queue = yield* ConnectionSetupProvisioningQueue;
      yield* queue.enqueueCleanup(setupId);
    }
    return result;
  });

const corsHeaders = (browserOrigin: string) => ({
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "DELETE,OPTIONS,POST",
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

const failureResponse = (failure: unknown, browserOrigin: string): Response =>
  hasFailureTag(failure, "InvalidHumanIdentity", "ConnectionSetupNotAccessible")
    ? notFound(browserOrigin)
    : jsonResponse({ error: "unavailable" }, 503, browserOrigin);

const decodeRequest = async (
  request: Request,
): Promise<{
  readonly displayName: string;
  readonly idempotencyKey: string;
  readonly normalizedWhatsAppNumber: string;
} | null> => {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !hasExactKeys(value, ["idempotency_key", "name", "whatsapp_number"])
  ) {
    return null;
  }
  const body = value as Record<string, unknown>;
  const displayName = normalizeWhatsAppConnectionName(body.name);
  const normalizedWhatsAppNumber = normalizeWhatsAppNumber(
    body.whatsapp_number,
  );
  if (
    typeof body.idempotency_key !== "string" ||
    displayName === null ||
    normalizedWhatsAppNumber === null
  ) {
    return null;
  }
  try {
    Schema.decodeUnknownSync(IdempotencyKey)(body.idempotency_key);
  } catch {
    return null;
  }
  return {
    displayName,
    idempotencyKey: body.idempotency_key,
    normalizedWhatsAppNumber,
  };
};

const successResponse = (
  result: Extract<ConnectionSetupOutcome, { readonly setup: unknown }>,
  browserOrigin: string,
): Response =>
  jsonResponse(
    {
      connection_setup: {
        created_at: result.setup.createdAt,
        expires_at: result.setup.expiresAt,
        id: result.setup.setupId,
        idempotent_replay: result.outcome === "replay",
        state:
          result.setup.state === "provisioning_pending"
            ? "pending"
            : result.setup.state,
      },
    },
    result.outcome === "created" ? 201 : 200,
    browserOrigin,
  );

const cancellationResponse = (
  result: CancelledConnectionSetup,
  browserOrigin: string,
): Response =>
  jsonResponse(
    {
      connection_setup: {
        cleanup_state: result.cleanupState,
        id: result.setupId,
        idempotent_replay: result.outcome === "replay",
        state: result.state,
      },
    },
    200,
    browserOrigin,
  );

const setupIdFromCancellationPath = (pathname: string): string | null => {
  const match = /^\/v1\/connection-setups\/(cst_[A-Za-z0-9_-]{21})$/u.exec(
    pathname,
  );
  return match?.[1] ?? null;
};

export const createConnectionSetupHandler =
  (
    layer: Layer.Layer<ConnectionSetupRequirements, unknown>,
    browserOrigin: string,
  ) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const cancellationSetupId = setupIdFromCancellationPath(url.pathname);
    if (
      (url.pathname !== CONNECTION_SETUP_ROUTE &&
        cancellationSetupId === null) ||
      request.headers.get("origin") !== browserOrigin
    ) {
      return notFound();
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(browserOrigin),
        status: 204,
      });
    }
    if (request.method === "DELETE" && cancellationSetupId !== null) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const identity = yield* HumanIdentity;
          const clerkUserId = yield* identity.verify(request);
          const result = yield* cancelConnectionSetup(
            clerkUserId,
            cancellationSetupId,
          );
          const telemetry = yield* SafeTelemetry;
          yield* telemetry.emit({
            event: "connection_setup.cancel.completed",
            outcome: result.outcome,
            service: "api",
          });
          return result;
        }).pipe(
          Effect.provide(layer),
          Effect.match({
            onFailure: (failure: unknown) =>
              failureResponse(failure, browserOrigin),
            onSuccess: (result) => cancellationResponse(result, browserOrigin),
          }),
        ),
      );
    }
    if (request.method !== "POST" || url.pathname !== CONNECTION_SETUP_ROUTE) {
      return notFound(browserOrigin);
    }

    const input = await decodeRequest(request);
    if (input === null) {
      return jsonResponse({ error: "invalid_request" }, 400, browserOrigin);
    }

    return Effect.runPromise(
      Effect.gen(function* () {
        const identity = yield* HumanIdentity;
        const clerkUserId = yield* identity.verify(request);
        const result = yield* startConnectionSetup(
          clerkUserId,
          input.idempotencyKey,
          input.displayName,
          input.normalizedWhatsAppNumber,
        );
        const telemetry = yield* SafeTelemetry;
        yield* telemetry.emit({
          event: "connection_setup.start.completed",
          outcome: result.outcome,
          service: "api",
        });
        return result;
      }).pipe(
        Effect.provide(layer),
        Effect.match({
          onFailure: (failure: unknown) =>
            failureResponse(failure, browserOrigin),
          onSuccess: (result) => {
            if ("setup" in result) {
              return successResponse(result, browserOrigin);
            }
            const error =
              result.outcome === "number_unavailable"
                ? "whatsapp_number_unavailable"
                : result.outcome === "number_cleanup_in_progress"
                  ? "whatsapp_number_cleanup_in_progress"
                  : result.outcome === "number_deletion_in_progress"
                    ? "whatsapp_number_deletion_in_progress"
                    : result.outcome;
            return jsonResponse({ error }, 409, browserOrigin);
          },
        }),
      ),
    );
  };

export const isConnectionSetupRequest = (request: Request): boolean =>
  new URL(request.url).pathname === CONNECTION_SETUP_ROUTE ||
  setupIdFromCancellationPath(new URL(request.url).pathname) !== null;
