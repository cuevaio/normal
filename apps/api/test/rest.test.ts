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
  RestCursorCodec,
  RestCursorError,
  RestIdentifiers,
  RestPersistence,
  RestPersistenceError,
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
    loadContactReadMaterial: () => Effect.succeed(null),
    listEncryptedContacts: () => Effect.succeed(null),
    listChats: () => Effect.succeed(null),
    rejectProtectedOperation: (input) =>
      Effect.succeed(
        input.requiredPermission !== undefined &&
          !input.permissions.includes(input.requiredPermission)
          ? ("authorization_denied" as const)
          : ("rejected" as const),
      ),
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
    Layer.succeed(RestCursorCodec, {
      decode: () => Effect.fail(new RestCursorError()),
      encode: () => Effect.succeed("rest-cursor"),
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

const contactMaterial = {
  accountKey: {
    ciphertext: "YQ==",
    keyVersion: 1,
    kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
    personalAccountId,
    version: 1 as const,
  },
  asOf: "2026-08-14T12:00:00.000Z",
  connectionKey: {
    accountKeyVersion: 1,
    ciphertext: "Yg==",
    connectionId: "20000000-0000-4000-8000-000000000079",
    keyVersion: 1,
    nonce: "AwMDAwMDAwMDAwMD",
    personalAccountId,
    version: 1 as const,
  },
  identityKey: {
    ciphertext: "Yw==",
    keyVersion: 1,
    nonce: "BAQEBAQEBAQEBAQE",
    version: 1 as const,
  },
  partial: false,
  personalAccountId,
  stale: false,
  whatsappConnectionId: "20000000-0000-4000-8000-000000000079",
};

const makeContactHarness = (options?: {
  readonly permissions?: ReadonlyArray<
    "connections:read" | "directory:read" | "messages:read" | "messages:send"
  >;
  readonly persistence?: Partial<RestPersistenceService>;
}) => {
  const telemetry: Array<SafeTelemetryEvent> = [];
  const persistence: RestPersistenceService = {
    beginProtectedOperation: (input) =>
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
      ),
    completeToolCall: () => Effect.void,
    listConnections: () => Effect.succeed([]),
    loadContactReadMaterial: () => Effect.succeed(contactMaterial),
    listChats: () => Effect.succeed(null),
    listEncryptedContacts: () =>
      Effect.succeed({
        asOf: "2026-08-14T12:00:00.000Z",
        contacts: [
          {
            conversationPublicId: null,
            displayNameCiphertext: {
              ciphertext: "Zg==",
              keyVersion: 1,
              nonce: "BQUFBQUFBQUFBQUF",
              version: 1 as const,
            },
            displayNameSort: "ada",
            phoneCiphertext: {
              ciphertext: "Zw==",
              keyVersion: 1,
              nonce: "BgYGBgYGBgYGBgYG",
              version: 1 as const,
            },
            providerIdentityIndex: `di1_${"i".repeat(43)}`,
            publicId: "ctc_123456789012345678901",
          },
        ],
        partial: false,
        snapshotObservedAt: "2026-08-14T12:00:00.000Z",
        stale: false,
      }),
    rejectProtectedOperation: (input) =>
      Effect.succeed(
        input.requiredPermission !== undefined &&
          !input.permissions.includes(input.requiredPermission)
          ? ("authorization_denied" as const)
          : ("rejected" as const),
      ),
    ...options?.persistence,
  };
  const layer = Layer.mergeAll(
    Layer.succeed(ApiKeyHmac, {
      digest: () => Effect.succeed(digest),
    }),
    Layer.succeed(ApiKeyPersistence, {
      authenticate: () =>
        Effect.succeed({
          connectionIds: [connectionId],
          expiresAt: null,
          grantId,
          id: publicId,
          name: "CI",
          permissions: options?.permissions ?? [
            "connections:read",
            "directory:read",
          ],
          personalAccountId,
        }),
      create: () => Effect.succeed({ outcome: "not_found" as const }),
      list: () => Effect.succeed([]),
      revoke: () => Effect.succeed(null),
    }),
    Layer.succeed(RestClock, { now: Effect.succeed(observedAt) }),
    Layer.succeed(RestIdentifiers, {
      nextAuditLogId: Effect.succeed("50000000-0000-4000-8000-000000000080"),
    }),
    Layer.succeed(RestCursorCodec, {
      decode: () => Effect.fail(new RestCursorError()),
      encode: () => Effect.succeed("rest-cursor"),
    }),
    Layer.succeed(RestPersistence, persistence),
    Layer.succeed(EnvelopeEncryptionService, {
      createConnectionKey: () => Effect.die("unused"),
      createPersonalAccountKey: () => Effect.die("unused"),
      decrypt: (input) =>
        Effect.succeed(
          input.context.fieldOrObjectPurpose === "webhook-identity-key"
            ? new Uint8Array(32).fill(17)
            : input.context.fieldOrObjectPurpose === "display-name"
              ? new TextEncoder().encode("Ada")
              : new TextEncoder().encode("+12025550199"),
        ),
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

describe("REST Directory contacts", () => {
  test("pages contacts with the REST envelope, freshness, and suffix-only phone", async () => {
    const harness = makeContactHarness();
    const response = await harness.handler(
      request(`/v1/connections/${connectionId}/contacts`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual({
      data: [
        {
          contact_id: "ctc_123456789012345678901",
          conversation_id: null,
          display_name: "Ada",
          phone_last_four: "0199",
        },
      ],
      meta: {
        as_of: "2026-08-14T12:00:00.000Z",
        partial: false,
        stale: false,
      },
      pagination: {
        has_more: false,
        next_cursor: null,
      },
    });
    expect(harness.telemetry).toEqual([
      {
        event: "rest.operation.completed",
        operation: "list_contacts",
        outcome: "success",
        resultCount: 1,
        service: "api",
      },
    ]);
    expect(JSON.stringify(harness.telemetry)).not.toContain("+12025550199");
    expect(JSON.stringify(harness.telemetry)).not.toContain(credential);
  });

  test("requires directory:read and hides unknown Connections", async () => {
    const forbidden = await makeContactHarness({
      permissions: ["connections:read"],
    }).handler(request(`/v1/connections/${connectionId}/contacts`));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      code: "insufficient_permission",
      status: 403,
    });

    const missing = await makeContactHarness({
      persistence: {
        loadContactReadMaterial: () => Effect.succeed(null),
      },
    }).handler(request(`/v1/connections/${connectionId}/contacts`));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  test("rejects extra query parameters and invalid search or limit before auth", async () => {
    const harness = makeContactHarness();
    for (const path of [
      `/v1/connections/${connectionId}/contacts?include_removed=true`,
      `/v1/connections/${connectionId}/contacts?search=Ad`,
      `/v1/connections/${connectionId}/contacts?limit=0`,
      `/v1/connections/${connectionId}/contacts?limit=51`,
    ]) {
      const response = await harness.handler(request(path));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "invalid_request",
        status: 400,
      });
    }
    expect(harness.telemetry).toEqual([]);
  });

  test("rejects MCP cursors and other invalid cursors before quota reservation", async () => {
    const harness = makeContactHarness();
    const response = await harness.handler(
      request(
        `/v1/connections/${connectionId}/contacts?cursor=mcp-or-tampered`,
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "invalid_cursor",
      status: 400,
    });
    expect(harness.telemetry).toEqual([
      {
        event: "rest.operation.completed",
        operation: "list_contacts",
        outcome: "invalid_cursor",
        service: "api",
      },
    ]);
  });

  test("withholds the page when Activity Log completion fails", async () => {
    const harness = makeContactHarness({
      persistence: {
        completeToolCall: () => Effect.fail(new RestPersistenceError()),
      },
    });
    const response = await harness.handler(
      request(`/v1/connections/${connectionId}/contacts`),
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      code: "unavailable",
      status: 503,
    });
    expect(JSON.stringify(body)).not.toContain("Ada");
  });
});

const chatPage = {
  accountKey: {
    ciphertext: "YQ==",
    keyVersion: 1,
    kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
    personalAccountId,
    version: 1 as const,
  },
  asOf: "2026-08-14T12:00:00.000Z",
  chats: [
    {
      conversationId: "cvs_123456789012345678901",
      displayName: {
        ciphertext: "Zg==",
        keyVersion: 1,
        nonce: "BQUFBQUFBQUFBQUF",
        version: 1 as const,
      },
      displayNameEntity: "directory-contact" as const,
      displayNameRecordId: `di1_${"i".repeat(43)}`,
      kind: "direct" as const,
      lastActivityAt: "2026-08-14T11:59:00.000Z",
      lastActivityDirection: "inbound" as const,
      phone: {
        ciphertext: "Zw==",
        keyVersion: 1,
        nonce: "BgYGBgYGBgYGBgYG",
        version: 1 as const,
      },
      recipientId: "ctc_123456789012345678901",
    },
  ],
  connectionKey: {
    accountKeyVersion: 1,
    ciphertext: "Yg==",
    connectionId: "20000000-0000-4000-8000-000000000079",
    keyVersion: 1,
    nonce: "AwMDAwMDAwMDAwMD",
    personalAccountId,
    version: 1 as const,
  },
  partial: false,
  stale: false,
};

const makeConversationHarness = (options?: {
  readonly permissions?: ReadonlyArray<
    "connections:read" | "directory:read" | "messages:read" | "messages:send"
  >;
  readonly persistence?: Partial<RestPersistenceService>;
}) => {
  const telemetry: Array<SafeTelemetryEvent> = [];
  const persistence: RestPersistenceService = {
    beginProtectedOperation: (input) =>
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
      ),
    completeToolCall: () => Effect.void,
    listConnections: () => Effect.succeed([]),
    loadContactReadMaterial: () => Effect.succeed(null),
    listEncryptedContacts: () => Effect.succeed(null),
    listChats: () => Effect.succeed(chatPage),
    rejectProtectedOperation: (input) =>
      Effect.succeed(
        input.requiredPermission !== undefined &&
          !input.permissions.includes(input.requiredPermission)
          ? ("authorization_denied" as const)
          : ("rejected" as const),
      ),
    ...options?.persistence,
  };
  const layer = Layer.mergeAll(
    Layer.succeed(ApiKeyHmac, {
      digest: () => Effect.succeed(digest),
    }),
    Layer.succeed(ApiKeyPersistence, {
      authenticate: () =>
        Effect.succeed({
          connectionIds: [connectionId],
          expiresAt: null,
          grantId,
          id: publicId,
          name: "CI",
          permissions: options?.permissions ?? [
            "connections:read",
            "messages:read",
          ],
          personalAccountId,
        }),
      create: () => Effect.succeed({ outcome: "not_found" as const }),
      list: () => Effect.succeed([]),
      revoke: () => Effect.succeed(null),
    }),
    Layer.succeed(RestClock, { now: Effect.succeed(observedAt) }),
    Layer.succeed(RestIdentifiers, {
      nextAuditLogId: Effect.succeed("50000000-0000-4000-8000-000000000080"),
    }),
    Layer.succeed(RestCursorCodec, {
      decode: () => Effect.fail(new RestCursorError()),
      encode: () => Effect.succeed("rest-cursor"),
    }),
    Layer.succeed(RestPersistence, persistence),
    Layer.succeed(EnvelopeEncryptionService, {
      createConnectionKey: () => Effect.die("unused"),
      createPersonalAccountKey: () => Effect.die("unused"),
      decrypt: () => Effect.die("unused"),
      decryptMany: (input) =>
        Effect.succeed(
          input.items.map((item) =>
            item.context.fieldOrObjectPurpose === "display-name"
              ? new TextEncoder().encode("Ada")
              : new TextEncoder().encode("+12025550199"),
          ),
        ),
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

describe("REST WhatsApp Conversations", () => {
  test("pages conversations with safe metadata and no full phone or snippet", async () => {
    const harness = makeConversationHarness();
    const response = await harness.handler(
      request(`/v1/connections/${connectionId}/conversations`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual({
      data: [
        {
          conversation_id: "cvs_123456789012345678901",
          display_name: "Ada",
          kind: "direct",
          last_activity_at: "2026-08-14T11:59:00.000Z",
          last_activity_direction: "inbound",
          phone_last_four: "0199",
          recipient_id: "ctc_123456789012345678901",
        },
      ],
      meta: {
        as_of: "2026-08-14T12:00:00.000Z",
        partial: false,
        stale: false,
      },
      pagination: {
        has_more: false,
        next_cursor: null,
      },
    });
    expect(harness.telemetry).toEqual([
      {
        event: "rest.operation.completed",
        operation: "list_chats",
        outcome: "success",
        resultCount: 1,
        service: "api",
      },
    ]);
    expect(JSON.stringify(harness.telemetry)).not.toContain("+12025550199");
    expect(JSON.stringify(harness.telemetry)).not.toContain(credential);
  });

  test("requires messages:read and hides unknown Connections", async () => {
    const forbidden = await makeConversationHarness({
      permissions: ["connections:read", "messages:send"],
    }).handler(request(`/v1/connections/${connectionId}/conversations`));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      code: "insufficient_permission",
      status: 403,
    });

    const missing = await makeConversationHarness({
      persistence: {
        listChats: () => Effect.succeed(null),
      },
    }).handler(request(`/v1/connections/${connectionId}/conversations`));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  test("rejects extra query parameters and invalid kind or limit before auth", async () => {
    const harness = makeConversationHarness();
    for (const path of [
      `/v1/connections/${connectionId}/conversations?search=Ada`,
      `/v1/connections/${connectionId}/conversations?kind=thread`,
      `/v1/connections/${connectionId}/conversations?limit=0`,
      `/v1/connections/${connectionId}/conversations?limit=51`,
    ]) {
      const response = await harness.handler(request(path));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "invalid_request",
        status: 400,
      });
    }
    expect(harness.telemetry).toEqual([]);
  });

  test("rejects MCP cursors and other invalid cursors before quota reservation", async () => {
    const harness = makeConversationHarness();
    const response = await harness.handler(
      request(
        `/v1/connections/${connectionId}/conversations?cursor=mcp-or-tampered`,
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "invalid_cursor",
      status: 400,
    });
    expect(harness.telemetry).toEqual([
      {
        event: "rest.operation.completed",
        operation: "list_chats",
        outcome: "invalid_cursor",
        service: "api",
      },
    ]);
  });

  test("withholds the page when Activity Log completion fails", async () => {
    const harness = makeConversationHarness({
      persistence: {
        completeToolCall: () => Effect.fail(new RestPersistenceError()),
      },
    });
    const response = await harness.handler(
      request(`/v1/connections/${connectionId}/conversations`),
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      code: "unavailable",
      status: 503,
    });
    expect(JSON.stringify(body)).not.toContain("Ada");
    expect(JSON.stringify(body)).not.toContain("+12025550199");
  });
});
