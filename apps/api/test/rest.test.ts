import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  ApiKeyHmac,
  ApiKeyHmacError,
  ApiKeyPersistence,
  type ApiKeyPersistenceService,
} from "../src/api-key";
import { EnvelopeEncryptionService } from "../src/encryption/envelope";
import { SendTextMessage, type SendTextMessageResult } from "../src/mcp";
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

const receipt = {
  send_id: "snd_123456789012345678901" as never,
  status: "processing" as const,
  created_at: "2026-08-17T12:00:00.000Z" as never,
  status_changed_at: "2026-08-17T12:00:00.000Z" as never,
  idempotent_replay: false,
};

const makeHarness = (options?: {
  readonly authenticate?: ApiKeyPersistenceService["authenticate"];
  readonly begin?: RestPersistenceService["beginProtectedOperation"];
  readonly hmacFails?: boolean;
  readonly listConnections?: RestPersistenceService["listConnections"];
  readonly permissions?: ReadonlyArray<
    "connections:read" | "directory:read" | "messages:read" | "messages:send"
  >;
  readonly send?: (
    input: {
      readonly connectionId: string;
      readonly grant: { readonly kind: "api" | "mcp" };
      readonly idempotencyKey: string;
      readonly recipientId: string;
      readonly text: string;
    },
    deferProviderAttempt?: (attempt: Promise<void>) => void,
  ) => Effect.Effect<SendTextMessageResult, never>;
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
    completeProtectedOperation: () => Effect.void,
    listConnections:
      options?.listConnections ??
      (() =>
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
        ])),
    loadContactReadMaterial: () => Effect.succeed(null),
    listEncryptedContacts: () => Effect.succeed(null),
    loadGroupSearchMaterial: () => Effect.succeed(null),
    listGroups: () => Effect.succeed(null),
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
    Layer.succeed(SendTextMessage, {
      send:
        options?.send ??
        (() =>
          Effect.succeed({
            outcome: "receipt" as const,
            receipt,
          })),
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
    readonly body?: unknown;
    readonly extraAuthorization?: string;
    readonly extraIdempotencyKey?: string;
    readonly idempotencyKey?: string | null;
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
  if (options.idempotencyKey !== null && options.idempotencyKey !== undefined) {
    headers.set("idempotency-key", options.idempotencyKey);
  }
  if (options.extraIdempotencyKey !== undefined) {
    headers.append("idempotency-key", options.extraIdempotencyKey);
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Request(`https://api.example.test${path}`, {
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
    headers,
    method: options.method ?? "GET",
  });
};

const sendPath = `/v1/connections/${connectionId}/send-operations`;
const sendBody = {
  recipient_id: "ctc_123456789012345678901",
  text: "Hello from REST",
} as const;
const idempotencyKey = "123456789012345678901";

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

  test("treats last-selected Connection Deletion like an invalid credential", async () => {
    const deleted = await makeHarness({
      authenticate: () => Effect.succeed(null),
    }).handler(request());
    const unknown = await makeHarness({
      authenticate: () => Effect.succeed(null),
    }).handler(request("/v1/connections", { authorization: null }));
    expect(deleted.status).toBe(401);
    expect(await deleted.json()).toEqual(await unknown.json());
  });

  test("lists only remaining selected Connections after Connection Deletion", async () => {
    const retainedId = "con_123456789012345678902";
    const harness = makeHarness({
      authenticate: () =>
        Effect.succeed({
          connectionIds: [retainedId],
          expiresAt: null,
          grantId,
          id: publicId,
          name: "CI",
          permissions: ["connections:read"],
          personalAccountId,
        }),
      listConnections: () =>
        Effect.succeed([
          {
            accountKey: null,
            connectionId: "20000000-0000-4000-8000-000000000080",
            connectionKey: null,
            displayName: null,
            displayNameFallback: "Retained WhatsApp",
            numberLastFour: "7890",
            publicId: retainedId,
            state: "connected" as const,
            stateChangedAt: "2026-08-14T12:00:00.000Z",
          },
        ]),
    });
    const listed = await harness.handler(request());
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      data: [
        {
          connection_id: retainedId,
          display_name: "Retained WhatsApp",
          number_last_four: "7890",
          state: "connected",
          state_changed_at: "2026-08-14T12:00:00.000Z",
        },
      ],
      pagination: { has_more: false, next_cursor: null },
    });
  });

  test("keeps a disconnected selected Connection readable", async () => {
    const harness = makeHarness({
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
            state: "disconnected" as const,
            stateChangedAt: "2026-08-14T12:05:00.000Z",
          },
        ]),
    });
    const listed = await harness.handler(request());
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      data: [{ connection_id: connectionId, state: "disconnected" }],
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
    completeProtectedOperation: () => Effect.void,
    listConnections: () => Effect.succeed([]),
    loadContactReadMaterial: () => Effect.succeed(contactMaterial),
    loadGroupSearchMaterial: () => Effect.succeed(null),
    listGroups: () => Effect.succeed(null),
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
    Layer.succeed(SendTextMessage, {
      send: () =>
        Effect.succeed({
          outcome: "receipt" as const,
          receipt,
        }),
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

    const deleted = await makeContactHarness({
      persistence: {
        loadContactReadMaterial: () => Effect.succeed(null),
      },
    }).handler(request(`/v1/connections/${connectionId}/contacts`));
    const unknownHandle = await makeContactHarness({
      persistence: {
        loadContactReadMaterial: () => Effect.succeed(null),
      },
    }).handler(request("/v1/connections/con_999999999999999999999/contacts"));
    expect(deleted.status).toBe(404);
    expect(await deleted.json()).toEqual(await unknownHandle.json());
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
        completeProtectedOperation: () =>
          Effect.fail(new RestPersistenceError()),
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

const groupPage = {
  accountKey: contactMaterial.accountKey,
  asOf: "2026-08-14T12:00:00.000Z",
  connectionKey: contactMaterial.connectionKey,
  groups: [
    {
      displayName: {
        ciphertext: "Zg==",
        keyVersion: 1,
        nonce: "BQUFBQUFBQUFBQUF",
        version: 1 as const,
      },
      id: "30000000-0000-4000-8000-000000000082",
      publicId: "grp_123456789012345678901",
    },
    {
      displayName: {
        ciphertext: "Zw==",
        keyVersion: 1,
        nonce: "BgYGBgYGBgYGBgYG",
        version: 1 as const,
      },
      id: "30000000-0000-4000-8000-000000000083",
      publicId: "grp_123456789012345678902",
    },
  ],
  partial: false,
  stale: false,
};

const makeGroupHarness = (options?: {
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
    completeProtectedOperation: () => Effect.void,
    listConnections: () => Effect.succeed([]),
    loadContactReadMaterial: () => Effect.succeed(null),
    listEncryptedContacts: () => Effect.succeed(null),
    loadGroupSearchMaterial: () =>
      Effect.succeed({
        accountKey: contactMaterial.accountKey,
        connectionKey: contactMaterial.connectionKey,
        identityKey: contactMaterial.identityKey,
      }),
    listGroups: () => Effect.succeed(groupPage),
    listChats: () => Effect.succeed(null),
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
    Layer.succeed(SendTextMessage, {
      send: () =>
        Effect.succeed({
          outcome: "receipt" as const,
          receipt,
        }),
    }),
    Layer.succeed(RestPersistence, persistence),
    Layer.succeed(EnvelopeEncryptionService, {
      createConnectionKey: () => Effect.die("unused"),
      createPersonalAccountKey: () => Effect.die("unused"),
      decrypt: (input) =>
        Effect.succeed(
          input.context.fieldOrObjectPurpose === "webhook-identity-key"
            ? new Uint8Array(32).fill(17)
            : input.context.entity === "whatsapp-group" &&
                input.context.recordId ===
                  "30000000-0000-4000-8000-000000000083"
              ? new TextEncoder().encode("Neighbors")
              : new TextEncoder().encode("Family"),
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

describe("REST Directory groups", () => {
  test("pages joined groups with the REST envelope and freshness", async () => {
    const harness = makeGroupHarness();
    const response = await harness.handler(
      request(`/v1/connections/${connectionId}/groups`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const body = await response.json();
    expect(body).toEqual({
      data: [
        {
          group_id: "grp_123456789012345678901",
          display_name: "Family",
        },
        {
          group_id: "grp_123456789012345678902",
          display_name: "Neighbors",
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
        operation: "list_groups",
        outcome: "success",
        resultCount: 2,
        service: "api",
      },
    ]);
    expect(JSON.stringify(harness.telemetry)).not.toContain(credential);
    expect(JSON.stringify(body)).not.toContain("cvs_");
  });

  test("requires directory:read and hides unknown Connections", async () => {
    const forbidden = await makeGroupHarness({
      permissions: ["connections:read"],
    }).handler(request(`/v1/connections/${connectionId}/groups`));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      code: "insufficient_permission",
      status: 403,
    });

    const missing = await makeGroupHarness({
      persistence: {
        listGroups: () => Effect.succeed(null),
      },
    }).handler(request(`/v1/connections/${connectionId}/groups`));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  test("rejects extra query parameters and invalid search or limit before auth", async () => {
    const harness = makeGroupHarness();
    for (const path of [
      `/v1/connections/${connectionId}/groups?include_left=true`,
      `/v1/connections/${connectionId}/groups?search=Fa`,
      `/v1/connections/${connectionId}/groups?limit=0`,
      `/v1/connections/${connectionId}/groups?limit=51`,
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
    const harness = makeGroupHarness();
    const response = await harness.handler(
      request(`/v1/connections/${connectionId}/groups?cursor=mcp-or-tampered`),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "invalid_cursor",
      status: 400,
    });
    expect(harness.telemetry).toEqual([
      {
        event: "rest.operation.completed",
        operation: "list_groups",
        outcome: "invalid_cursor",
        service: "api",
      },
    ]);
  });

  test("pages with a bound REST cursor and withholds results if audit completion fails", async () => {
    const paged = await makeGroupHarness().handler(
      request(`/v1/connections/${connectionId}/groups?limit=1`),
    );
    expect(paged.status).toBe(200);
    expect(await paged.json()).toEqual({
      data: [
        {
          group_id: "grp_123456789012345678901",
          display_name: "Family",
        },
      ],
      meta: {
        as_of: "2026-08-14T12:00:00.000Z",
        partial: false,
        stale: false,
      },
      pagination: {
        has_more: true,
        next_cursor: "rest-cursor",
      },
    });

    const withheld = await makeGroupHarness({
      persistence: {
        completeProtectedOperation: () =>
          Effect.fail(new RestPersistenceError()),
      },
    }).handler(request(`/v1/connections/${connectionId}/groups`));
    expect(withheld.status).toBe(503);
    const body = await withheld.json();
    expect(body).toMatchObject({
      code: "unavailable",
      status: 503,
    });
    expect(JSON.stringify(body)).not.toContain("Family");
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
    completeProtectedOperation: () => Effect.void,
    listConnections: () => Effect.succeed([]),
    loadContactReadMaterial: () => Effect.succeed(null),
    listEncryptedContacts: () => Effect.succeed(null),
    loadGroupSearchMaterial: () => Effect.succeed(null),
    listGroups: () => Effect.succeed(null),
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
    Layer.succeed(SendTextMessage, {
      send: () =>
        Effect.succeed({
          outcome: "receipt" as const,
          receipt,
        }),
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
        completeProtectedOperation: () =>
          Effect.fail(new RestPersistenceError()),
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

describe("REST Send Operations", () => {
  test("creates a Send Operation through the shared grant-aware send service", async () => {
    const deferred: Array<Promise<void>> = [];
    const harness = makeHarness({
      permissions: ["messages:send"],
      send: (input, deferProviderAttempt) => {
        expect(input.connectionId).toBe(connectionId);
        expect(input.grant.kind).toBe("api");
        expect(input.idempotencyKey).toBe(idempotencyKey);
        expect(input.recipientId).toBe(sendBody.recipient_id);
        expect(input.text).toBe(sendBody.text);
        deferProviderAttempt?.(Promise.resolve());
        return Effect.succeed({
          outcome: "receipt" as const,
          receipt,
        });
      },
    });
    const response = await harness.handler(
      request(sendPath, {
        body: sendBody,
        idempotencyKey,
        method: "POST",
      }),
      (attempt) => {
        deferred.push(attempt);
      },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual({
      send_id: receipt.send_id,
      status: "processing",
      created_at: receipt.created_at,
      status_changed_at: receipt.status_changed_at,
      idempotent_replay: false,
    });
    expect(deferred).toHaveLength(1);
    expect(harness.telemetry).toEqual([
      {
        event: "rest.operation.completed",
        operation: "send_text_message",
        outcome: "success",
        resultCount: 1,
        service: "api",
      },
    ]);
    expect(JSON.stringify(harness.telemetry)).not.toContain(credential);
    expect(JSON.stringify(harness.telemetry)).not.toContain(sendBody.text);
  });

  test("replays an exact Send Operation and rejects changed or unaccepted payloads", async () => {
    const replay = await makeHarness({
      permissions: ["messages:send"],
      send: () =>
        Effect.succeed({
          outcome: "receipt" as const,
          receipt: { ...receipt, idempotent_replay: true },
        }),
    }).handler(
      request(sendPath, {
        body: sendBody,
        idempotencyKey,
        method: "POST",
      }),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      send_id: receipt.send_id,
      idempotent_replay: true,
    });

    const conflict = await makeHarness({
      permissions: ["messages:send"],
      send: () => Effect.succeed({ outcome: "idempotency_conflict" }),
    }).handler(
      request(sendPath, {
        body: sendBody,
        idempotencyKey,
        method: "POST",
      }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "idempotency_conflict",
      status: 409,
    });

    const missingKey = await makeHarness({
      permissions: ["messages:send"],
    }).handler(
      request(sendPath, {
        body: sendBody,
        method: "POST",
      }),
    );
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toMatchObject({
      code: "invalid_request",
      status: 400,
    });

    const rejected = await makeHarness({
      permissions: ["messages:send"],
    }).handler(
      request(sendPath, {
        body: {
          recipient_id: "+15551234567",
          text: "hello",
          confirmed: true,
          conversation_id: "cvs_123456789012345678901",
        },
        idempotencyKey,
        method: "POST",
      }),
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      code: "invalid_request",
      status: 400,
    });
  });

  test("returns Send Operation resources after the provider-attempt boundary", async () => {
    for (const status of ["failed", "unknown"] as const) {
      const response = await makeHarness({
        permissions: ["messages:send"],
        send: () =>
          Effect.succeed({
            outcome: "receipt" as const,
            receipt: { ...receipt, status },
          }),
      }).handler(
        request(sendPath, {
          body: sendBody,
          idempotencyKey,
          method: "POST",
        }),
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        send_id: receipt.send_id,
        status,
      });
    }
  });

  test("maps pre-operation send failures to Problem Details", async () => {
    const forbidden = await makeHarness({
      permissions: ["connections:read"],
      send: () => Effect.succeed({ outcome: "authorization_denied" }),
    }).handler(
      request(sendPath, {
        body: sendBody,
        idempotencyKey,
        method: "POST",
      }),
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      code: "insufficient_permission",
      status: 403,
    });

    const missingRecipient = await makeHarness({
      permissions: ["messages:send"],
      send: () => Effect.succeed({ outcome: "recipient_not_found" }),
    }).handler(
      request(sendPath, {
        body: sendBody,
        idempotencyKey,
        method: "POST",
      }),
    );
    expect(missingRecipient.status).toBe(404);
    expect(await missingRecipient.json()).toMatchObject({
      code: "not_found",
      status: 404,
    });

    const disconnected = await makeHarness({
      permissions: ["messages:send"],
      send: () => Effect.succeed({ outcome: "connection_unavailable" }),
    }).handler(
      request(sendPath, {
        body: sendBody,
        idempotencyKey,
        method: "POST",
      }),
    );
    expect(disconnected.status).toBe(409);
    expect(await disconnected.json()).toMatchObject({
      code: "connection_unavailable",
      retryable: true,
      status: 409,
    });
  });
});
