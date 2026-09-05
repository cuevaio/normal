import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  HumanIdentity,
  InvalidHumanIdentity,
} from "../src/auth/human-identity";
import { EnvelopeEncryptionService } from "../src/encryption/envelope";
import {
  createPersonalAccountHandler,
  PersonalAccountIdentifiers,
  PersonalAccountPersistence,
  PersonalAccountPersistenceError,
  type PersonalAccountPersistenceService,
} from "../src/personal-account";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";

const browserOrigin = "https://app.example.test";
const endpoint = "https://api.example.test/v1/personal-account/bootstrap";
const clerkUserId = "user_2RfWKJREkjKbHZy0Wqa5qrHeAnb";

const makeHarness = (
  options: {
    readonly deleted?: boolean;
    readonly identityValid?: boolean;
    readonly persistenceFailure?: boolean;
  } = {},
) => {
  const accounts = new Map<
    string,
    { readonly keyAvailable: boolean; readonly personalAccountId: string }
  >();
  const events: Array<SafeTelemetryEvent> = [];
  let generatedKeys = 0;
  let nextIdentifier = 0;

  const persistence: PersonalAccountPersistenceService = {
    create: (input) =>
      options.persistenceFailure
        ? Effect.fail(new PersonalAccountPersistenceError())
        : Effect.sync(() => {
            if (options.deleted) return null;
            const existing = accounts.get(input.clerkUserId);
            if (existing) {
              return {
                admissionState: "active" as const,
                created: false,
                messageRetentionDays: 30,
                personalAccountId: existing.personalAccountId,
                storedMediaLimitBytes: 5_368_709_120,
                whatsappConnectionLimit: 3,
              };
            }
            accounts.set(input.clerkUserId, {
              keyAvailable: true,
              personalAccountId: input.personalAccountId,
            });
            return {
              admissionState: "active" as const,
              created: true,
              messageRetentionDays: 30,
              personalAccountId: input.personalAccountId,
              storedMediaLimitBytes: 5_368_709_120,
              whatsappConnectionLimit: 3,
            };
          }),
    resolve: (requestedClerkUserId) =>
      options.persistenceFailure
        ? Effect.fail(new PersonalAccountPersistenceError())
        : Effect.sync(() => {
            if (options.deleted) return null;
            const existing = accounts.get(requestedClerkUserId);
            return existing
              ? {
                  ...existing,
                  admissionState: "active" as const,
                  messageRetentionDays: 30,
                  storedMediaLimitBytes: 5_368_709_120,
                  whatsappConnectionLimit: 3,
                }
              : null;
          }),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(HumanIdentity, {
      verify: (request) =>
        options.identityValid === false ||
        request.headers.get("authorization") !== "Bearer signed-clerk-token"
          ? Effect.fail(new InvalidHumanIdentity())
          : Effect.succeed(clerkUserId),
      verifyRecently: () => Effect.die("not used"),
    }),
    Layer.succeed(PersonalAccountPersistence, persistence),
    Layer.succeed(PersonalAccountIdentifiers, {
      next: Effect.sync(() => {
        nextIdentifier += 1;
        return `10000000-0000-4000-8000-${String(nextIdentifier).padStart(
          12,
          "0",
        )}`;
      }),
    }),
    Layer.succeed(EnvelopeEncryptionService, {
      createPersonalAccountKey: ({ accountId, keyVersion }) =>
        Effect.sync(() => {
          generatedKeys += 1;
          return {
            ciphertext: "AQID",
            keyVersion,
            kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
            personalAccountId: accountId,
            version: 1 as const,
          };
        }),
      createConnectionKey: () => Effect.die("not used"),
      decrypt: () => Effect.die("not used"),
      decryptMany: () => Effect.die("not used"),
      encrypt: () => Effect.die("not used"),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    }),
  );

  return {
    accounts,
    events,
    generatedKeys: () => generatedKeys,
    handler: createPersonalAccountHandler(layer, browserOrigin),
  };
};

const bootstrapRequest = (
  overrides: {
    readonly authorization?: string | undefined;
    readonly origin?: string | undefined;
  } = {},
) =>
  new Request(endpoint, {
    headers: {
      authorization: overrides.authorization ?? "Bearer signed-clerk-token",
      origin: overrides.origin ?? browserOrigin,
    },
    method: "POST",
  });

describe("Personal Account bootstrap HTTP boundary", () => {
  test("bootstraps a Clerk-approved User without an additional gate", async () => {
    const harness = makeHarness();
    const response = await harness.handler(bootstrapRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      personal_account: {
        state: "active",
        message_retention_days: 30,
        stored_media_limit_bytes: 5_368_709_120,
        whatsapp_connection_limit: 3,
      },
    });
    expect(harness.generatedKeys()).toBe(1);
    expect(harness.accounts.size).toBe(1);
  });

  test("creates once, recovers idempotently, and never returns an internal account identifier", async () => {
    const harness = makeHarness();

    const first = await harness.handler(bootstrapRequest());
    const replay = await harness.handler(bootstrapRequest());

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      personal_account: {
        state: "active",
        message_retention_days: 30,
        stored_media_limit_bytes: 5_368_709_120,
        whatsapp_connection_limit: 3,
      },
    });
    expect(await replay.json()).toEqual({
      personal_account: {
        state: "active",
        message_retention_days: 30,
        stored_media_limit_bytes: 5_368_709_120,
        whatsapp_connection_limit: 3,
      },
    });
    expect(harness.accounts).toHaveLength(1);
    expect(harness.generatedKeys()).toBe(1);
    expect(harness.events).toEqual([
      {
        event: "personal_account.bootstrap.completed",
        outcome: "created",
        service: "api",
      },
      {
        event: "personal_account.bootstrap.completed",
        outcome: "recovered",
        service: "api",
      },
    ]);
  });

  test("concurrent first requests converge on one Personal Account", async () => {
    const harness = makeHarness();

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        harness.handler(bootstrapRequest()).then(async (response) => ({
          body: await response.json(),
          status: response.status,
        })),
      ),
    );

    expect(responses.every(({ status }) => status === 200)).toBe(true);
    expect(harness.accounts).toHaveLength(1);
  });

  test.each([
    ["invalid claims", { identityValid: false }, {}],
    ["invalid Origin", {}, { origin: "https://attacker.example.test" }],
    ["deleted identity state", { deleted: true }, {}],
  ] as const)(
    "uses the same non-disclosing boundary for %s",
    async (_name, harnessOptions, requestOptions) => {
      const harness = makeHarness(harnessOptions);
      const response = await harness.handler(bootstrapRequest(requestOptions));

      expect(response.status).toBe(404);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "origin" in requestOptions ? null : browserOrigin,
      );
      expect(await response.json()).toEqual({ error: "not_found" });
    },
  );

  test("fails closed without leaking database failure details", async () => {
    const harness = makeHarness({ persistenceFailure: true });
    const response = await harness.handler(bootstrapRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });

  test("answers only the exact allowed Origin during CORS preflight", async () => {
    const harness = makeHarness();
    const allowed = await harness.handler(
      new Request(endpoint, {
        headers: { origin: browserOrigin },
        method: "OPTIONS",
      }),
    );
    const denied = await harness.handler(
      new Request(endpoint, {
        headers: { origin: "https://attacker.example.test" },
        method: "OPTIONS",
      }),
    );

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      browserOrigin,
    );
    expect(denied.status).toBe(404);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });
});
