import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  HumanIdentity,
  InvalidHumanIdentity,
} from "../src/auth/human-identity";
import {
  ConnectionSetupClock,
  ConnectionSetupIdentifiers,
  ConnectionSetupNumberTokens,
  ConnectionSetupPersistence,
  ConnectionSetupPersistenceError,
  type ConnectionSetupPersistenceService,
  createConnectionSetupHandler,
  makeConnectionSetupNumberTokens,
} from "../src/connection-setup";
import { ConnectionSetupProvisioningQueue } from "../src/connection-setup-provisioning";
import { EnvelopeEncryptionService } from "../src/encryption/envelope";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";

const browserOrigin = "https://app.example.test";
const endpoint = "https://api.example.test/v1/connection-setups";
const idempotencyKey = "123456789012345678901";
const accountKey = {
  ciphertext: "AQID",
  keyVersion: 1,
  kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
  personalAccountId: "10000000-0000-4000-8000-000000000021",
  version: 1 as const,
};
type PersistedSetupState =
  | "cancelled"
  | "expired"
  | "provisioned"
  | "provisioning_failed"
  | "provisioning_pending"
  | "provisioning_quarantined";

const makeHarness = (
  options: {
    readonly identityValid?: boolean;
    readonly numberCleanupInProgress?: boolean;
    readonly numberDeletionInProgress?: boolean;
    readonly persistenceFailure?: boolean;
  } = {},
) => {
  const bindings = new Map<
    string,
    {
      readonly numberToken: string;
      readonly setup: {
        readonly createdAt: string;
        readonly expiresAt: string;
        readonly setupId: string;
        readonly state: PersistedSetupState;
      };
    }
  >();
  const reservations = new Map<string, string>();
  const events: Array<SafeTelemetryEvent> = [];
  const encryptedNumbers: Array<string> = [];
  const enqueuedSetups: Array<string> = [];
  let generated = 0;
  let retainedConnections = 0;
  const nameMaterial = (setupId: string) => ({
    accountKey,
    name: {
      ciphertext: new Uint8Array([17, 18, 19]),
      fallback: null,
      keyVersion: 1,
      nonce: new Uint8Array(12).fill(20),
      version: 1 as const,
    },
    setupKey: {
      accountKeyVersion: 1,
      ciphertext: "BAUG",
      connectionId: setupId,
      keyVersion: 1,
      nonce: "BwgJCgsMDQ4PEA==",
      personalAccountId: accountKey.personalAccountId,
      version: 1 as const,
    },
  });

  const persistence: ConnectionSetupPersistenceService = {
    cancel: ({ clerkUserId, setupId }) =>
      options.persistenceFailure
        ? Effect.fail(new ConnectionSetupPersistenceError())
        : Effect.sync(() => {
            if (clerkUserId !== "user_connection_setup") return null;
            const entry = [...bindings.entries()].find(
              ([, binding]) => binding.setup.setupId === setupId,
            );
            if (entry === undefined) return null;
            const [key, binding] = entry;
            const replay =
              binding.setup.state === "cancelled" ||
              binding.setup.state === "expired";
            const state =
              binding.setup.state === "expired" ? "expired" : "cancelled";
            bindings.set(key, {
              ...binding,
              setup: { ...binding.setup, state },
            });
            return {
              cleanupState: "pending" as const,
              outcome: replay ? ("replay" as const) : ("cancelled" as const),
              setupId,
              state,
            };
          }),
    prepare: ({ idempotencyKey: key, numberToken }) =>
      options.persistenceFailure
        ? Effect.fail(new ConnectionSetupPersistenceError())
        : Effect.sync(() => {
            const existing = bindings.get(key);
            if (existing !== undefined) {
              return existing.numberToken ===
                Buffer.from(numberToken).toString("hex")
                ? {
                    nameMaterial: nameMaterial(existing.setup.setupId),
                    outcome: "replay" as const,
                    setup: existing.setup,
                  }
                : { outcome: "idempotency_conflict" as const };
            }
            return {
              accountKey,
              outcome: "unbound" as const,
              whatsappConnectionLimit: 3,
            };
          }),
    start: (input) =>
      options.persistenceFailure
        ? Effect.fail(new ConnectionSetupPersistenceError())
        : Effect.sync(() => {
            const token = Buffer.from(input.numberToken).toString("hex");
            const existing = bindings.get(input.idempotencyKey);
            if (existing !== undefined) {
              return existing.numberToken === token
                ? {
                    nameMaterial: nameMaterial(existing.setup.setupId),
                    outcome: "replay" as const,
                    setup: existing.setup,
                  }
                : { outcome: "idempotency_conflict" as const };
            }
            if (reservations.has(token)) {
              return {
                outcome: options.numberDeletionInProgress
                  ? ("number_deletion_in_progress" as const)
                  : options.numberCleanupInProgress
                    ? ("number_cleanup_in_progress" as const)
                    : ("number_unavailable" as const),
              };
            }
            if (retainedConnections + bindings.size >= 3) {
              return { outcome: "connection_limit_reached" as const };
            }
            const setup = {
              createdAt: input.createdAt,
              expiresAt: "2026-07-31T12:15:00.000Z",
              setupId: input.setupId,
              state: "provisioning_pending" as const,
            };
            bindings.set(input.idempotencyKey, {
              numberToken: token,
              setup,
            });
            reservations.set(token, input.setupId);
            return { outcome: "created" as const, setup };
          }),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(HumanIdentity, {
      verify: () =>
        options.identityValid === false
          ? Effect.fail(new InvalidHumanIdentity())
          : Effect.succeed("user_connection_setup"),
      verifyRecently: () => Effect.die("not used"),
    }),
    Layer.succeed(ConnectionSetupPersistence, persistence),
    Layer.succeed(ConnectionSetupClock, {
      now: Effect.succeed("2026-07-31T12:00:00.000Z"),
    }),
    Layer.succeed(ConnectionSetupIdentifiers, {
      next: Effect.sync(() => {
        generated += 1;
        return `cst_${String(generated).padStart(21, "0")}`;
      }),
    }),
    Layer.succeed(ConnectionSetupNumberTokens, {
      derive: (number) =>
        Effect.succeed(new TextEncoder().encode(`reservation:${number}`)),
    }),
    Layer.succeed(ConnectionSetupProvisioningQueue, {
      enqueue: (setupId) =>
        Effect.sync(() => {
          enqueuedSetups.push(setupId);
        }),
      enqueueCleanup: (setupId) =>
        Effect.sync(() => {
          enqueuedSetups.push(setupId);
        }),
    }),
    Layer.succeed(EnvelopeEncryptionService, {
      createConnectionKey: ({ accountId, connectionId, keyVersion }) =>
        Effect.succeed({
          accountKeyVersion: 1,
          ciphertext: "BAUG",
          connectionId,
          keyVersion,
          nonce: "BwgJCgsMDQ4PEA==",
          personalAccountId: accountId,
          version: 1 as const,
        }),
      createPersonalAccountKey: () => Effect.die("not used"),
      decrypt: ({ context }) =>
        context.fieldOrObjectPurpose === "display-name"
          ? Effect.succeed(new TextEncoder().encode("Personal WhatsApp"))
          : Effect.die("not used"),
      decryptMany: () => Effect.die("not used"),
      encrypt: ({ context, plaintext }) =>
        Effect.sync(() => {
          if (context.fieldOrObjectPurpose === "whatsapp-number") {
            encryptedNumbers.push(new TextDecoder().decode(plaintext));
          }
          return {
            ciphertext: "ERIT",
            keyVersion: 1,
            nonce: "FBUWFxgZGhscHQ==",
            version: 1 as const,
          };
        }),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    }),
  );

  return {
    bindings,
    enqueuedSetups,
    encryptedNumbers,
    events,
    handler: createConnectionSetupHandler(layer, browserOrigin),
    reservations,
    setSetupState: (state: PersistedSetupState) => {
      const binding = bindings.get(idempotencyKey);
      if (binding === undefined) {
        throw new Error("Connection Setup has not been started");
      }
      bindings.set(idempotencyKey, {
        ...binding,
        setup: { ...binding.setup, state },
      });
    },
    setRetainedConnections: (count: number) => {
      retainedConnections = count;
    },
  };
};

const setupRequest = (
  whatsappNumber: string,
  key = idempotencyKey,
  overrides: {
    readonly origin?: string;
  } = {},
) =>
  new Request(endpoint, {
    body: JSON.stringify({
      idempotency_key: key,
      name: "Personal WhatsApp",
      whatsapp_number: whatsappNumber,
    }),
    headers: {
      authorization: "Bearer signed-clerk-token",
      "content-type": "application/json",
      origin: overrides.origin ?? browserOrigin,
    },
    method: "POST",
  });

const cancelRequest = (
  setupId = "cst_000000000000000000001",
  overrides: { readonly origin?: string } = {},
) =>
  new Request(`${endpoint}/${setupId}`, {
    headers: {
      authorization: "Bearer signed-clerk-token",
      origin: overrides.origin ?? browserOrigin,
    },
    method: "DELETE",
  });

describe("Connection Setup HTTP boundary", () => {
  test("derives a domain-separated 32-byte platform reservation token", async () => {
    const tokens = makeConnectionSetupNumberTokens(new Uint8Array(32).fill(7));
    const first = await Effect.runPromise(tokens.derive("+15550123456"));
    const replay = await Effect.runPromise(tokens.derive("+15550123456"));
    const changed = await Effect.runPromise(tokens.derive("+15550123457"));

    expect(first).toHaveLength(32);
    expect(replay).toEqual(first);
    expect(changed).not.toEqual(first);
    expect(new TextDecoder().decode(first)).not.toContain("+15550123456");
  });

  test("normalizes and encrypts one WhatsApp Number and returns an exact replay", async () => {
    const harness = makeHarness();

    const first = await harness.handler(setupRequest("+1 (555) 012-3456"));
    const replay = await harness.handler(setupRequest("+15550123456"));

    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({
      connection_setup: {
        created_at: "2026-07-31T12:00:00.000Z",
        expires_at: "2026-07-31T12:15:00.000Z",
        id: "cst_000000000000000000001",
        idempotent_replay: false,
        state: "pending",
      },
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      connection_setup: {
        created_at: "2026-07-31T12:00:00.000Z",
        expires_at: "2026-07-31T12:15:00.000Z",
        id: "cst_000000000000000000001",
        idempotent_replay: true,
        state: "pending",
      },
    });
    expect(harness.bindings).toHaveLength(1);
    expect(harness.encryptedNumbers).toEqual(["+15550123456"]);
    expect(harness.enqueuedSetups).toEqual([
      "cst_000000000000000000001",
      "cst_000000000000000000001",
    ]);
    expect(JSON.stringify(harness.events)).not.toContain("+1555");
    expect(JSON.stringify(harness.events)).not.toContain("cst_");
  });

  test.each([
    "provisioned",
    "provisioning_failed",
    "provisioning_quarantined",
  ] as const)(
    "returns the visible %s state on an exact replay",
    async (state) => {
      const harness = makeHarness();
      await harness.handler(setupRequest("+15550123456"));
      harness.setSetupState(state);

      const replay = await harness.handler(setupRequest("+15550123456"));

      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toMatchObject({
        connection_setup: {
          idempotent_replay: true,
          state,
        },
      });
    },
  );

  test("fails safely when a bound idempotency key is reused with changed input", async () => {
    const harness = makeHarness();
    await harness.handler(setupRequest("+15550123456"));

    const response = await harness.handler(setupRequest("+15550123457"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "idempotency_conflict" });
    expect(harness.bindings).toHaveLength(1);
    expect(harness.encryptedNumbers).toEqual(["+15550123456"]);
  });

  test("lets only the owning User idempotently cancel through the signed-in HTTP boundary", async () => {
    const harness = makeHarness();
    await harness.handler(setupRequest("+15550123456"));

    const first = await harness.handler(cancelRequest());
    const replay = await harness.handler(cancelRequest());

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      connection_setup: {
        cleanup_state: "pending",
        id: "cst_000000000000000000001",
        idempotent_replay: false,
        state: "cancelled",
      },
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      connection_setup: {
        cleanup_state: "pending",
        id: "cst_000000000000000000001",
        idempotent_replay: true,
        state: "cancelled",
      },
    });
    expect(harness.enqueuedSetups).toEqual([
      "cst_000000000000000000001",
      "cst_000000000000000000001",
      "cst_000000000000000000001",
    ]);
    expect(harness.events).toContainEqual({
      event: "connection_setup.cancel.completed",
      outcome: "cancelled",
      service: "api",
    });
    expect(harness.events).toContainEqual({
      event: "connection_setup.cancel.completed",
      outcome: "replay",
      service: "api",
    });
  });

  test("does not disclose another User's Connection Setup during cancellation", async () => {
    const harness = makeHarness({ identityValid: false });
    const response = await harness.handler(cancelRequest());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  test("reserves a number globally and enforces the three-Connection limit", async () => {
    const harness = makeHarness();
    await harness.handler(setupRequest("+15550123456"));

    const reserved = await harness.handler(
      setupRequest("+15550123456", "223456789012345678901"),
    );
    harness.setRetainedConnections(3);
    const limited = await harness.handler(
      setupRequest("+15550123457", "323456789012345678901"),
    );

    expect(reserved.status).toBe(409);
    expect(await reserved.json()).toEqual({
      error: "whatsapp_number_unavailable",
    });
    expect(limited.status).toBe(409);
    expect(await limited.json()).toEqual({
      error: "connection_limit_reached",
    });
  });

  test("distinguishes cleanup of the User's deleted Connection from a globally unavailable number", async () => {
    const harness = makeHarness({ numberDeletionInProgress: true });
    await harness.handler(setupRequest("+15550123456"));

    const response = await harness.handler(
      setupRequest("+15550123456", "223456789012345678901"),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "whatsapp_number_deletion_in_progress",
    });
  });

  test("distinguishes cleanup of the User's previous Setup from a globally unavailable number", async () => {
    const harness = makeHarness({ numberCleanupInProgress: true });
    await harness.handler(setupRequest("+15550123456"));

    const response = await harness.handler(
      setupRequest("+15550123456", "223456789012345678901"),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "whatsapp_number_cleanup_in_progress",
    });
  });

  test.each([
    ["invalid WhatsApp Number", setupRequest("15550123456"), 400],
    ["invalid idempotency key", setupRequest("+15550123456", "too-short"), 400],
    [
      "invalid Origin",
      setupRequest("+15550123456", idempotencyKey, {
        origin: "https://attacker.example.test",
      }),
      404,
    ],
  ] as const)("rejects %s", async (_name, request, status) => {
    const response = await makeHarness().handler(request);
    expect(response.status).toBe(status);
  });

  test("fails closed without disclosing identity or persistence details", async () => {
    const identityFailure = await makeHarness({
      identityValid: false,
    }).handler(setupRequest("+15550123456"));
    const persistenceFailure = await makeHarness({
      persistenceFailure: true,
    }).handler(setupRequest("+15550123456"));

    expect(identityFailure.status).toBe(404);
    expect(await identityFailure.json()).toEqual({ error: "not_found" });
    expect(persistenceFailure.status).toBe(503);
    expect(await persistenceFailure.json()).toEqual({ error: "unavailable" });
  });
});
