import type { WebhookIngressMaterial } from "@whatsapp-mcp/db/webhook-ingress";
import { authenticateWasenderWebhook } from "@whatsapp-mcp/whatsapp-provider/webhook";
import { Context, Data, Effect, type Layer, Redacted } from "effect";
import {
  type EnvelopeEncryption,
  EnvelopeEncryptionService,
} from "./encryption/envelope";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const maximumPayloadBytes = 1_048_576;
const routePattern =
  /^\/webhooks\/wasender\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;

export class WebhookIngressPersistenceError extends Data.TaggedError(
  "WebhookIngressPersistenceError",
) {}

export class WebhookIngressObjectStoreError extends Data.TaggedError(
  "WebhookIngressObjectStoreError",
) {}

export class WebhookIngressQueueError extends Data.TaggedError(
  "WebhookIngressQueueError",
) {}

export interface WebhookIngressPersistenceService {
  readonly resolve: (
    webhookIngressId: string,
  ) => Effect.Effect<
    WebhookIngressMaterial | null,
    WebhookIngressPersistenceError
  >;
}

export const WebhookIngressPersistence =
  Context.GenericTag<WebhookIngressPersistenceService>(
    "@whatsapp-mcp/api/WebhookIngressPersistence",
  );

export interface WebhookIngressClockService {
  readonly now: Effect.Effect<string>;
}

export const WebhookIngressClock =
  Context.GenericTag<WebhookIngressClockService>(
    "@whatsapp-mcp/api/WebhookIngressClock",
  );

export interface WebhookIngressIdentifiersService {
  readonly nextObjectId: Effect.Effect<string>;
}

export const WebhookIngressIdentifiers =
  Context.GenericTag<WebhookIngressIdentifiersService>(
    "@whatsapp-mcp/api/WebhookIngressIdentifiers",
  );

export interface WebhookIngressStoredObject {
  readonly body: Uint8Array;
  readonly customMetadata: Readonly<Record<string, string>>;
  readonly objectKey: string;
}

export interface WebhookIngressObjectStoreService {
  readonly put: (
    object: WebhookIngressStoredObject,
  ) => Effect.Effect<void, WebhookIngressObjectStoreError>;
}

export const WebhookIngressObjectStore =
  Context.GenericTag<WebhookIngressObjectStoreService>(
    "@whatsapp-mcp/api/WebhookIngressObjectStore",
  );

export interface WebhookIngressQueueMessage {
  readonly ciphertext_sha256: string;
  readonly object_id: string;
  readonly payload_bytes: number;
  readonly personal_account_id: string;
  readonly received_at: string;
  readonly version: 1;
  readonly whatsapp_connection_id: string;
}

export interface WebhookIngressQueueService {
  readonly publish: (
    message: WebhookIngressQueueMessage,
  ) => Effect.Effect<void, WebhookIngressQueueError>;
}

export const WebhookIngressQueue =
  Context.GenericTag<WebhookIngressQueueService>(
    "@whatsapp-mcp/api/WebhookIngressQueue",
  );

export type WebhookIngressRequirements =
  | EnvelopeEncryption
  | SafeTelemetryService
  | WebhookIngressClockService
  | WebhookIngressIdentifiersService
  | WebhookIngressObjectStoreService
  | WebhookIngressPersistenceService
  | WebhookIngressQueueService;

type RequestBodyResult =
  | { readonly outcome: "invalid" | "too_large" | "unavailable" }
  | { readonly bytes: Uint8Array; readonly outcome: "valid" };

const boundedBody = async (request: Request): Promise<RequestBodyResult> => {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^[0-9]+$/u.test(declaredLength) ||
      Number(declaredLength) > maximumPayloadBytes)
  ) {
    return {
      outcome: /^[0-9]+$/u.test(declaredLength) ? "too_large" : "invalid",
    };
  }
  if (request.body === null) return { outcome: "invalid" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const result = await reader.read().catch(async () => {
      for (const chunk of chunks) chunk.fill(0);
      await reader.cancel().catch(() => undefined);
      return null;
    });
    if (result === null) return { outcome: "unavailable" };
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > maximumPayloadBytes) {
      for (const chunk of chunks) chunk.fill(0);
      result.value.fill(0);
      await reader.cancel().catch(() => undefined);
      return { outcome: "too_large" };
    }
    chunks.push(result.value);
  }
  if (byteLength === 0) return { outcome: "invalid" };
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
    chunk.fill(0);
  }
  return { bytes, outcome: "valid" };
};

const withZeroedBytes = <Value, Error, Requirements>(
  bytes: Uint8Array,
  use: (value: Uint8Array) => Effect.Effect<Value, Error, Requirements>,
) =>
  Effect.acquireUseRelease(Effect.succeed(bytes), use, (value) =>
    Effect.sync(() => {
      value.fill(0);
    }),
  );

const sha256Hex = (value: Uint8Array): Effect.Effect<string> =>
  Effect.promise(async () =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  );

const serializedCiphertext = (ciphertext: {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly version: 1;
}): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      ciphertext: ciphertext.ciphertext,
      key_version: ciphertext.keyVersion,
      nonce: ciphertext.nonce,
      version: ciphertext.version,
    }),
  );

type IngressOutcome =
  | "accepted"
  | "authentication_failed"
  | "invalid_payload"
  | "not_found"
  | "too_large"
  | "unavailable";

const responseFor = (outcome: IngressOutcome): Response => {
  const [body, status] =
    outcome === "accepted"
      ? [{ accepted: true }, 200]
      : outcome === "too_large"
        ? [{ error: "payload_too_large" }, 413]
        : outcome === "invalid_payload"
          ? [{ error: "invalid_request" }, 400]
          : outcome === "authentication_failed" || outcome === "not_found"
            ? [{ error: "not_found" }, 404]
            : [{ error: "unavailable" }, 503];
  return new Response(JSON.stringify(body), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status,
  });
};

const emitOutcome = (
  layer: Layer.Layer<WebhookIngressRequirements, unknown>,
  outcome: IngressOutcome,
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const telemetry = yield* SafeTelemetry;
      yield* telemetry.emit({
        event: "webhook_ingress.completed",
        outcome,
        service: "api",
      });
      return responseFor(outcome);
    }).pipe(
      Effect.provide(layer),
      Effect.catchAll(() => Effect.succeed(responseFor(outcome))),
    ),
  );

const accept = (
  webhookIngressId: string,
  payload: Uint8Array,
  signature: string,
) =>
  Effect.gen(function* () {
    const persistence = yield* WebhookIngressPersistence;
    const material = yield* persistence.resolve(webhookIngressId);
    if (material === null) return "not_found" as const;

    const encryption = yield* EnvelopeEncryptionService;
    const authority = yield* encryption.decrypt({
      accountKey: material.accountKey,
      ciphertext: material.providerAuthority,
      connectionKey: material.connectionKey,
      context: {
        accountId: material.personalAccountId,
        connectionId: material.whatsappConnectionId,
        entity: "whatsapp-connection",
        fieldOrObjectPurpose: "provider-session-authority",
        recordId: material.whatsappConnectionId,
      },
    });
    const authentication = yield* withZeroedBytes(authority, (authorityBytes) =>
      Effect.try({
        try: () =>
          Redacted.make(
            new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: false,
            }).decode(authorityBytes),
          ),
        catch: () => undefined,
      }).pipe(
        Effect.matchEffect({
          onFailure: () => Effect.succeed("invalid_authority" as const),
          onSuccess: (decodedAuthority) =>
            authenticateWasenderWebhook({
              authority: decodedAuthority,
              payload,
              signature,
            }),
        }),
      ),
    );
    if (authentication === "invalid_payload") return "invalid_payload" as const;
    if (authentication !== "authenticated") {
      return "authentication_failed" as const;
    }

    const identifiers = yield* WebhookIngressIdentifiers;
    const objectId = yield* identifiers.nextObjectId;
    const clock = yield* WebhookIngressClock;
    const receivedAt = yield* clock.now;
    const encrypted = yield* encryption.encrypt({
      accountKey: material.accountKey,
      connectionKey: material.connectionKey,
      context: {
        accountId: material.personalAccountId,
        connectionId: material.whatsappConnectionId,
        entity: "webhook-event",
        fieldOrObjectPurpose: "original-request",
        recordId: objectId,
      },
      plaintext: payload,
    });
    const body = serializedCiphertext(encrypted);
    const ciphertextHash = yield* sha256Hex(body);
    const objects = yield* WebhookIngressObjectStore;
    yield* objects.put({
      body,
      customMetadata: {
        ciphertextSha256: ciphertextHash,
        payloadBytes: String(payload.byteLength),
        personalAccountId: material.personalAccountId,
        receivedAt,
        version: "1",
        whatsappConnectionId: material.whatsappConnectionId,
      },
      objectKey: `webhook-events/${objectId}`,
    });
    const queue = yield* WebhookIngressQueue;
    yield* queue.publish({
      ciphertext_sha256: ciphertextHash,
      object_id: objectId,
      payload_bytes: payload.byteLength,
      personal_account_id: material.personalAccountId,
      received_at: receivedAt,
      version: 1,
      whatsapp_connection_id: material.whatsappConnectionId,
    });
    return "accepted" as const;
  });

export const webhookIngressIdFromRequest = (
  request: Request,
): string | null => {
  if (request.method !== "POST") return null;
  return routePattern.exec(new URL(request.url).pathname)?.[1] ?? null;
};

export const isWebhookIngressRequest = (request: Request): boolean =>
  webhookIngressIdFromRequest(request) !== null;

export const createWebhookIngressHandler =
  (layer: Layer.Layer<WebhookIngressRequirements, unknown>) =>
  async (request: Request): Promise<Response> => {
    const webhookIngressId = webhookIngressIdFromRequest(request);
    if (webhookIngressId === null) return responseFor("not_found");
    if (
      request.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    ) {
      return emitOutcome(layer, "invalid_payload");
    }

    const body = await boundedBody(request);
    if (body.outcome !== "valid") {
      return emitOutcome(
        layer,
        body.outcome === "too_large"
          ? "too_large"
          : body.outcome === "unavailable"
            ? "unavailable"
            : "invalid_payload",
      );
    }
    const signature = request.headers.get("x-webhook-signature") ?? "";

    return Effect.runPromise(
      withZeroedBytes(body.bytes, (payload) =>
        accept(webhookIngressId, payload, signature),
      ).pipe(
        Effect.matchEffect({
          onFailure: () =>
            Effect.gen(function* () {
              const telemetry = yield* SafeTelemetry;
              yield* telemetry.emit({
                event: "webhook_ingress.completed",
                outcome: "unavailable",
                service: "api",
              });
              return responseFor("unavailable");
            }),
          onSuccess: (outcome) =>
            Effect.gen(function* () {
              const telemetry = yield* SafeTelemetry;
              yield* telemetry.emit({
                event: "webhook_ingress.completed",
                outcome,
                service: "api",
              });
              return responseFor(outcome);
            }),
        }),
        Effect.provide(layer),
        Effect.catchAll(() => Effect.succeed(responseFor("unavailable"))),
      ),
    );
  };
