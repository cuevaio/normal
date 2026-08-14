import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  ApiKeyClock,
  ApiKeyHmac,
  ApiKeyIdentifiers,
  ApiKeyPersistence,
  type ApiKeyPersistenceService,
  createApiKeyManagementHandler,
} from "../src/api-key";
import {
  HumanIdentity,
  InvalidHumanIdentity,
  RecentHumanVerificationRequired,
} from "../src/auth/human-identity";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";

const browserOrigin = "https://app.example.test";
const publicId = "apk_123456789012345678901";
const secret = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const credential = `normal_${publicId}.${secret}`;
const connectionId = "con_123456789012345678901";
const createdAt = new Date("2026-08-14T12:00:00.000Z");
const digest = new Uint8Array(32).fill(7);

const makeHarness = (options?: { readonly requireRecent?: boolean }) => {
  const keys: Array<{
    connectionIds: ReadonlyArray<string>;
    createdAt: Date;
    credentialHint: string;
    expiresAt: Date | null;
    id: string;
    lastUsedAt: Date | null;
    name: string;
    permissions: ReadonlyArray<
      "connections:read" | "directory:read" | "messages:read" | "messages:send"
    >;
    revokedAt: Date | null;
    state: "active" | "expired" | "revoked";
  }> = [];
  const telemetry: Array<SafeTelemetryEvent> = [];
  const persistence: ApiKeyPersistenceService = {
    authenticate: () => Effect.succeed(null),
    create: (input) =>
      Effect.sync(() => {
        if (input.clerkUserId !== "user_owner") {
          return { outcome: "not_found" as const };
        }
        if (input.connectionIds.includes("con_999999999999999999999")) {
          return { outcome: "not_found" as const };
        }
        if (input.name.toLowerCase() === "duplicate") {
          return { outcome: "duplicate_name" as const };
        }
        if (input.name === "limit") {
          return { outcome: "limit_reached" as const };
        }
        if (input.expiresAt !== null && input.expiresAt <= input.createdAt) {
          return { outcome: "invalid" as const };
        }
        const summary = {
          connectionIds: input.connectionIds,
          createdAt: input.createdAt,
          credentialHint: input.credentialHint,
          expiresAt: input.expiresAt,
          id: input.publicId,
          lastUsedAt: null,
          name: input.name,
          permissions: input.permissions,
          revokedAt: null,
          state: "active" as const,
        };
        keys.push(summary);
        return { outcome: "created" as const, summary };
      }),
    list: (clerkUserId) =>
      Effect.succeed(clerkUserId === "user_owner" ? keys : []),
    revoke: (input) =>
      Effect.sync(() => {
        if (input.clerkUserId !== "user_owner") return null;
        const existing = keys.find((key) => key.id === input.publicId);
        if (existing === undefined) return null;
        existing.revokedAt ??= input.revokedAt;
        existing.state = "revoked";
        return { revokedAt: existing.revokedAt };
      }),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(HumanIdentity, {
      verify: (request) => {
        const authorization = request.headers.get("authorization");
        if (authorization === "Bearer owner") {
          return Effect.succeed("user_owner");
        }
        if (authorization === "Bearer other") {
          return Effect.succeed("user_other");
        }
        return Effect.fail(new InvalidHumanIdentity());
      },
      verifyRecently: (request) => {
        if (options?.requireRecent) {
          return Effect.fail(new RecentHumanVerificationRequired());
        }
        const authorization = request.headers.get("authorization");
        if (authorization === "Bearer owner") {
          return Effect.succeed({
            clerkUserId: "user_owner",
            reverifiedAt: new Date("2026-08-14T11:59:00.000Z"),
          });
        }
        return Effect.fail(new InvalidHumanIdentity());
      },
    }),
    Layer.succeed(ApiKeyClock, {
      now: Effect.succeed(createdAt),
    }),
    Layer.succeed(ApiKeyIdentifiers, {
      nextId: Effect.succeed("50000000-0000-4000-8000-000000000078"),
      nextPublicId: Effect.succeed(publicId),
      nextSecret: Effect.succeed(secret),
    }),
    Layer.succeed(ApiKeyHmac, {
      digest: () => Effect.succeed(digest),
    }),
    Layer.succeed(ApiKeyPersistence, persistence),
    Layer.succeed(SafeTelemetry, {
      emit: (event) =>
        Effect.sync(() => {
          telemetry.push(event);
        }),
    }),
  );
  return {
    handler: createApiKeyManagementHandler(layer, browserOrigin),
    telemetry,
  };
};

const request = (
  path: string,
  options: {
    readonly authorization?: string;
    readonly body?: unknown;
    readonly method?: string;
    readonly origin?: string;
  } = {},
) =>
  new Request(`https://api.example.test${path}`, {
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
    headers: {
      authorization: options.authorization ?? "Bearer owner",
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      origin: options.origin ?? browserOrigin,
    },
    method: options.method ?? "GET",
  });

const createBody = {
  connection_ids: [connectionId],
  name: "CI",
  permissions: ["connections:read"],
};

describe("API Key management HTTP boundary", () => {
  test("creates an API Key once and never redisplays the plaintext", async () => {
    const harness = makeHarness();
    const created = await harness.handler(
      request("/v1/api-keys", { body: createBody, method: "POST" }),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("access-control-allow-origin")).toBe(
      browserOrigin,
    );
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({
      connection_ids: [connectionId],
      credential,
      credential_hint: `normal_${publicId}.…DEFG`,
      id: publicId,
      name: "CI",
      state: "active",
    });

    const listed = await harness.handler(request("/v1/api-keys"));
    expect(listed.status).toBe(200);
    const listBody = await listed.json();
    expect(listBody).toEqual({
      api_keys: [
        {
          connection_ids: [connectionId],
          created_at: createdAt.toISOString(),
          credential_hint: `normal_${publicId}.…DEFG`,
          expires_at: null,
          id: publicId,
          last_used_at: null,
          name: "CI",
          permissions: ["connections:read"],
          revoked_at: null,
          state: "active",
        },
      ],
    });
    expect(JSON.stringify(listBody)).not.toContain(credential);
    expect(JSON.stringify(listBody)).not.toContain(secret);

    const revoked = await harness.handler(
      request(`/v1/api-keys/${publicId}`, { method: "DELETE" }),
    );
    const replay = await harness.handler(
      request(`/v1/api-keys/${publicId}`, { method: "DELETE" }),
    );
    expect(revoked.status).toBe(200);
    const revokedBody = await revoked.json();
    const replayBody = await replay.json();
    expect(revokedBody).toEqual({
      api_key: {
        id: publicId,
        revoked_at: createdAt.toISOString(),
        state: "revoked",
      },
    });
    expect(replayBody).toEqual(revokedBody);
    expect(JSON.stringify(revokedBody)).not.toContain(credential);
  });

  test("maps create outcomes and requires recent first-factor verification", async () => {
    const harness = makeHarness();
    const notFound = await harness.handler(
      request("/v1/api-keys", {
        body: { ...createBody, connection_ids: ["con_999999999999999999999"] },
        method: "POST",
      }),
    );
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error: "not_found" });

    const duplicate = await harness.handler(
      request("/v1/api-keys", {
        body: { ...createBody, name: "Duplicate" },
        method: "POST",
      }),
    );
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({ error: "duplicate_name" });

    const limit = await harness.handler(
      request("/v1/api-keys", {
        body: { ...createBody, name: "limit" },
        method: "POST",
      }),
    );
    expect(limit.status).toBe(400);
    expect(await limit.json()).toEqual({ error: "limit_reached" });

    const recent = makeHarness({ requireRecent: true });
    const challenge = await recent.handler(
      request("/v1/api-keys", { body: createBody, method: "POST" }),
    );
    expect(challenge.status).toBe(403);
    expect(await challenge.json()).toEqual({
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
    });
  });

  test("rejects invalid origin, identity, and unknown handles without discovery", async () => {
    const harness = makeHarness();
    const invalidOrigin = await harness.handler(
      request("/v1/api-keys", {
        origin: "https://attacker.example.test",
      }),
    );
    const invalidIdentity = await harness.handler(
      request("/v1/api-keys", { authorization: "Bearer invalid" }),
    );
    const unknown = await harness.handler(
      request("/v1/api-keys/apk_999999999999999999999", { method: "DELETE" }),
    );
    const crossAccount = await harness.handler(
      request(`/v1/api-keys/${publicId}`, {
        authorization: "Bearer other",
        method: "DELETE",
      }),
    );
    const options = await harness.handler(
      request("/v1/api-keys", { method: "OPTIONS" }),
    );

    expect(invalidOrigin.status).toBe(404);
    expect(invalidIdentity.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(crossAccount.status).toBe(404);
    expect(await unknown.text()).toBe(await crossAccount.text());
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBe(
      browserOrigin,
    );
  });
});
