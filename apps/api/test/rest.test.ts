import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  ApiKeyHmac,
  ApiKeyHmacError,
  ApiKeyPersistence,
  type ApiKeyPersistenceService,
} from "../src/api-key";
import { EnvelopeEncryptionService } from "../src/encryption/envelope";
import {
  createRestHandler,
  RestClock,
  RestIdentifiers,
  RestPersistence,
  type RestPersistenceService,
} from "../src/rest";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";

const publicId = "apk_123456789012345678901";
const secret = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const credential = `normal_${publicId}.${secret}`;
const connectionId = "con_123456789012345678901";
const grantId = "50000000-0000-4000-8000-000000000079";
const personalAccountId = "10000000-0000-4000-8000-000000000079";
const observedAt = new Date("2026-08-14T12:00:00.000Z");
const digest = new Uint8Array(32).fill(7);

const makeHarness = (options?: {
  readonly authenticate?: ApiKeyPersistenceService["authenticate"];
  readonly begin?: RestPersistenceService["beginProtectedOperation"];
  readonly hmacFails?: boolean;
  readonly permissions?: ReadonlyArray<
    "connections:read" | "directory:read" | "messages:read" | "messages:send"
  >;
}) => {
  const telemetry: Array<SafeTelemetryEvent> = [];
  const persistence: RestPersistenceService = {
    beginProtectedOperation:
      options?.begin ??
      ((input) =>
        Effect.succeed(
          input.channel === "api" &&
            input.requiredPermission !== undefined &&
            !(input.permissions ?? []).includes(input.requiredPermission)
            ? {
                auditLogId: input.auditLogId,
                outcome: "authorization_denied" as const,
              }
            : {
                auditLogId: input.auditLogId,
                outcome: "started" as const,
              },
        )),
    completeToolCall: () => Effect.void,
    listConnections: () =>
      Effect.succeed([
        {
          accountKey: null,
          connectionId: "20000000-0000-4000-8000-000000000079",
          connectionKey: null,
          displayName: null,
          displayNameFallback: "Personal WhatsApp",
          numberLastFour: "0000",
          publicId: connectionId,
          state: "connected" as const,
          stateChangedAt: "2026-08-14T12:00:00.000Z",
        },
      ]),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(ApiKeyHmac, {
      digest: () =>
        options?.hmacFails
          ? Effect.fail(new ApiKeyHmacError())
          : Effect.succeed(digest),
    }),
    Layer.succeed(ApiKeyPersistence, {
      authenticate:
        options?.authenticate ??
        (() =>
          Effect.succeed({
            connectionIds: [connectionId],
            expiresAt: null,
            grantId,
            id: publicId,
            name: "CI",
            permissions: options?.permissions ?? ["connections:read"],
            personalAccountId,
          })),
      create: () => Effect.succeed({ outcome: "not_found" as const }),
      list: () => Effect.succeed([]),
      revoke: () => Effect.succeed(null),
    }),
    Layer.succeed(RestClock, { now: Effect.succeed(observedAt) }),
    Layer.succeed(RestIdentifiers, {
      nextAuditLogId: Effect.succeed("50000000-0000-4000-8000-000000000080"),
    }),
    Layer.succeed(RestPersistence, persistence),
    Layer.succeed(EnvelopeEncryptionService, {
      createConnectionKey: () => Effect.die("unused"),
      createPersonalAccountKey: () => Effect.die("unused"),
      decrypt: () => Effect.die("unused"),
      decryptMany: () => Effect.die("unused"),
      encrypt: () => Effect.die("unused"),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) =>
        Effect.sync(() => {
          telemetry.push(event);
        }),
    }),
  );
  return {
    handler: createRestHandler(layer, {
      hourLimit: 3,
      keyHourLimit: 2,
      keyMinuteLimit: 1,
      minuteLimit: 2,
    }),
    telemetry,
  };
};

const request = (
  path = "/v1/connections",
  options: {
    readonly authorization?: string | null;
    readonly extraAuthorization?: string;
    readonly method?: string;
  } = {},
) => {
  const headers = new Headers();
  if (options.authorization !== null) {
    headers.set(
      "authorization",
      options.authorization ?? `Bearer ${credential}`,
    );
  }
  if (options.extraAuthorization !== undefined) {
    headers.append("authorization", options.extraAuthorization);
  }
  return new Request(`https://api.example.test${path}`, {
    headers,
    method: options.method ?? "GET",
  });
};

describe("REST Connections tracer", () => {
  test("lists selected Connections without CORS and without caching", async () => {
    const harness = makeHarness();
    const response = await harness.handler(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual({
      data: [
        {
          connection_id: connectionId,
          display_name: "Personal WhatsApp",
          number_last_four: "0000",
          state: "connected",
          state_changed_at: "2026-08-14T12:00:00.000Z",
        },
      ],
      pagination: { has_more: false, next_cursor: null },
    });
    expect(harness.telemetry).toEqual([
      {
        event: "rest.operation.completed",
        operation: "list_connections",
        outcome: "success",
        resultCount: 1,
        service: "api",
      },
    ]);
    expect(JSON.stringify(harness.telemetry)).not.toContain(credential);
  });

  test("returns Problem Details for invalid, forbidden, missing, and unavailable outcomes", async () => {
    const missing = await makeHarness().handler(
      request("/v1/connections", { authorization: null }),
    );
    expect(missing.status).toBe(401);
    expect(missing.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(await missing.json()).toMatchObject({
      code: "invalid_credentials",
      status: 401,
    });

    const forbidden = await makeHarness({
      permissions: ["messages:send"],
    }).handler(request());
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      code: "insufficient_permission",
      status: 403,
    });

    const unknown = await makeHarness().handler(
      request(`/v1/connections/${connectionId}`),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({
      code: "not_found",
      status: 404,
    });

    const limited = await makeHarness({
      begin: () =>
        Effect.succeed({
          auditLogId: "50000000-0000-4000-8000-000000000080",
          outcome: "rate_limited",
          resetsAt: new Date("2026-08-14T12:01:00.000Z"),
          retryAfterSeconds: 60,
        }),
    }).handler(request());
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({
      code: "rate_limited",
      retry_after_seconds: 60,
      retryable: true,
      status: 429,
    });

    const unavailable = await makeHarness({ hmacFails: true }).handler(
      request(),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      code: "unavailable",
      status: 503,
    });
  });

  test("rejects revoked credentials on the next request without a cache", async () => {
    let revoked = false;
    const harness = makeHarness({
      authenticate: () =>
        Effect.succeed(
          revoked
            ? null
            : {
                connectionIds: [connectionId],
                expiresAt: null,
                grantId,
                id: publicId,
                name: "CI",
                permissions: ["connections:read"],
                personalAccountId,
              },
        ),
    });
    expect((await harness.handler(request())).status).toBe(200);
    revoked = true;
    const denied = await harness.handler(request());
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({
      code: "invalid_credentials",
      status: 401,
    });
  });
});
