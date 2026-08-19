import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  HumanIdentity,
  InvalidHumanIdentity,
} from "../src/auth/human-identity";
import { ConnectionSetupProvisioningQueue } from "../src/connection-setup-provisioning";
import { EnvelopeEncryptionService } from "../src/encryption/envelope";
import {
  RestoreSafeDeletion,
  SafeTelemetry,
  type SafeTelemetryEvent,
} from "../src/services";
import {
  createWhatsAppConnectionHandler,
  WhatsAppConnectionClock,
  WhatsAppConnectionIdentifiers,
  WhatsAppConnectionPersistence,
  type WhatsAppConnectionPersistenceService,
  WhatsAppConnectionProvider,
  type WhatsAppConnectionProviderService,
} from "../src/whatsapp-connection";

const browserOrigin = "https://app.example.test";
const setupId = "cst_000000000000000000041";
const qrEndpoint = `https://api.example.test/v1/connection-setups/${setupId}/qr`;
const listEndpoint = "https://api.example.test/v1/whatsapp-connections";
const connectionId = "con_000000000000000000041";
const disconnectEndpoint = `${listEndpoint}/${connectionId}/disconnect`;
const reconnectEndpoint = `${listEndpoint}/${connectionId}/reconnect`;
const deleteEndpoint = `${listEndpoint}/${connectionId}/delete`;
const nameEndpoint = `${listEndpoint}/${connectionId}/name`;
const accountKey = {
  ciphertext: "AQID",
  keyVersion: 1,
  kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
  personalAccountId: "10000000-0000-4000-8000-000000000041",
  version: 1 as const,
};
const setupKey = {
  accountKeyVersion: 1,
  ciphertext: "BAUG",
  connectionId: setupId,
  keyVersion: 1,
  nonce: "BwgJCgsMDQ4PEA==",
  personalAccountId: accountKey.personalAccountId,
  version: 1 as const,
};
const versionedCiphertext = {
  ciphertext: "ERIT",
  keyVersion: 1,
  nonce: "FBUWFxgZGhscHQ==",
  version: 1 as const,
};
const lifecycleSession = {
  authority: "session-authority-must-not-leak",
  connectionState: "connecting" as const,
  session: "wsl_0000000000000000000000000000000000000000041",
};
const qrBytes = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1H0z"/></svg>',
);

const makeHarness = (
  options: {
    readonly disconnectFailureState?: "connected" | "degraded" | "disconnected";
    readonly identityValid?: boolean;
    readonly initialFailureCode?: string;
    readonly numberVerification?: "match" | "mismatch" | "unverified";
    readonly initialSetupState?:
      | "activated"
      | "pending"
      | "provisioned"
      | "provisioning_failed"
      | "provisioning_quarantined";
  } = {},
) => {
  const events: SafeTelemetryEvent[] = [];
  const providerCalls: string[] = [];
  const cleanupEnqueues: string[] = [];
  const encryptedPurposes: string[] = [];
  const connections: Array<{
    displayName: string;
    numberSuffix: string;
    publicId: string;
    state:
      | "connected"
      | "connecting"
      | "degraded"
      | "disconnected"
      | "reconnect_required";
    stateChangedAt: string;
  }> = [];
  let providerConnected = false;
  let disconnectFailed = false;
  let lifecycleClaimId: string | null = null;
  let setupState = options.initialSetupState ?? "provisioned";
  let setupFailureCode = options.initialFailureCode ?? "unavailable";
  let lastEncryptedName = "Personal WhatsApp";
  let deletionReceipt: {
    deletionMarkerId: string;
    publicId: string;
    requestedAt: string;
  } | null = null;
  const protectedConnection = (connection: (typeof connections)[number]) => ({
    accountKey,
    connectionId: "20000000-0000-4000-8000-000000000041",
    connectionKey: {
      ...setupKey,
      connectionId: "20000000-0000-4000-8000-000000000041",
    },
    displayName: { ciphertext: versionedCiphertext, fallback: null },
    numberSuffix: connection.numberSuffix,
    publicId: connection.publicId,
    state: connection.state,
    stateChangedAt: connection.stateChangedAt,
  });

  const persistence: WhatsAppConnectionPersistenceService = {
    activate: (input) =>
      Effect.sync(() => {
        const existing = connections[0];
        if (existing !== undefined) return protectedConnection(existing);
        const connection = {
          displayName: "Personal WhatsApp",
          numberSuffix: input.numberSuffix,
          publicId: input.publicId,
          state: "connected" as const,
          stateChangedAt: input.connectedAt,
        };
        connections.push(connection);
        setupState = "activated";
        return protectedConnection(connection);
      }),
    claimLifecycle: ({ action, claimId, clerkUserId, publicId, requestedAt }) =>
      Effect.sync(() => {
        const connection = connections.find(
          (candidate) =>
            clerkUserId === "user_connectionowner" &&
            candidate.publicId === publicId,
        );
        if (connection === undefined) return null;
        const target = action === "disconnect" ? "disconnected" : "connected";
        if (connection.state === target) {
          return {
            connection: protectedConnection(connection),
            outcome: "complete" as const,
          };
        }
        if (lifecycleClaimId !== null) {
          return {
            connection: protectedConnection(connection),
            outcome: "in_progress" as const,
          };
        }
        lifecycleClaimId = claimId;
        connection.state = action === "disconnect" ? "degraded" : "connecting";
        connection.stateChangedAt = requestedAt;
        return {
          action,
          connection: protectedConnection(connection),
          outcome: "claimed" as const,
          setupMarker: setupId,
        };
      }),
    finishLifecycle: ({ claimId, clerkUserId, observedAt, publicId, state }) =>
      Effect.sync(() => {
        const connection = connections.find(
          (candidate) =>
            clerkUserId === "user_connectionowner" &&
            candidate.publicId === publicId,
        );
        if (
          connection === undefined ||
          lifecycleClaimId === null ||
          lifecycleClaimId !== claimId
        ) {
          return null;
        }
        lifecycleClaimId = null;
        if (connection.state !== state) {
          connection.state = state;
          connection.stateChangedAt = observedAt;
        }
        return protectedConnection(connection);
      }),
    list: () => Effect.succeed(connections.map(protectedConnection)),
    loadForRename: ({ clerkUserId, publicId }) =>
      Effect.sync(() => {
        const connection = connections.find(
          (candidate) =>
            clerkUserId === "user_connectionowner" &&
            candidate.publicId === publicId,
        );
        return connection === undefined
          ? null
          : protectedConnection(connection);
      }),
    rename: ({ clerkUserId, publicId }) =>
      Effect.sync(() => {
        const connection = connections.find(
          (candidate) =>
            clerkUserId === "user_connectionowner" &&
            candidate.publicId === publicId,
        );
        if (connection === undefined) return null;
        connection.displayName = lastEncryptedName;
        return protectedConnection(connection);
      }),
    prepareDeletion: ({ clerkUserId, publicId }) =>
      Effect.succeed(
        clerkUserId !== "user_connectionowner" || publicId !== connectionId
          ? null
          : deletionReceipt === null
            ? {
                outcome: "prepared" as const,
                publicId,
                personalAccountId: accountKey.personalAccountId,
                connectionId: "20000000-0000-4000-8000-000000000041",
                accountKey,
                connectionKey: {
                  ...setupKey,
                  connectionId: "20000000-0000-4000-8000-000000000041",
                },
                providerLocator: versionedCiphertext,
              }
            : { outcome: "complete" as const, ...deletionReceipt },
      ),
    finishDeletion: ({
      clerkUserId,
      publicId,
      deletionMarkerId,
      requestedAt,
    }) =>
      Effect.sync(() => {
        if (clerkUserId !== "user_connectionowner" || publicId !== connectionId)
          return null;
        deletionReceipt = { deletionMarkerId, publicId, requestedAt };
        connections.splice(0);
        return deletionReceipt;
      }),
    loadSetup: ({ clerkUserId }) =>
      Effect.succeed(
        clerkUserId !== "user_connectionowner"
          ? null
          : setupState === "activated"
            ? {
                connection: protectedConnection(
                  connections[0] ?? {
                    displayName: "Personal WhatsApp",
                    numberSuffix: "3456",
                    publicId: "con_000000000000000000041",
                    state: "connected" as const,
                    stateChangedAt: "2026-07-31T12:04:00.000Z",
                  },
                ),
                outcome: "activated" as const,
              }
            : setupState === "provisioned"
              ? {
                  outcome: "provisioned" as const,
                  setup: {
                    accountKey,
                    displayName: {
                      ciphertext: versionedCiphertext,
                      fallback: null,
                    },
                    numberCiphertext: versionedCiphertext,
                    personalAccountId: accountKey.personalAccountId,
                    setupId,
                    setupKey,
                    webhookIngressId: "30000000-0000-4000-8000-000000000041",
                  },
                }
              : setupState === "provisioning_failed"
                ? {
                    failureCode: setupFailureCode,
                    outcome: "provisioning_failed" as const,
                  }
                : {
                    outcome: setupState,
                  },
      ),
    failSetupActivation: ({ failureCode }) =>
      Effect.sync(() => {
        setupState = "provisioning_failed";
        setupFailureCode = failureCode;
        return true;
      }),
  };

  const provider: WhatsAppConnectionProviderService = {
    connect: () =>
      Effect.sync(() => {
        providerCalls.push("connectSession");
        return {
          ok: true as const,
          value: lifecycleSession,
        };
      }),
    disconnect: () =>
      Effect.sync(() => {
        providerCalls.push("disconnectSession");
        if (options.disconnectFailureState !== undefined) {
          disconnectFailed = true;
          return {
            error: {
              _tag: "ProviderControlFailure" as const,
              code: "timed_out" as const,
              operation: "lifecycle-write" as const,
              retryAfterMs: null,
              retryDecision: "reconcile_before_repeat" as const,
            },
            ok: false as const,
          };
        }
        providerConnected = false;
        return {
          ok: true as const,
          value: {
            ...lifecycleSession,
            connectionState: "disconnected" as const,
          },
        };
      }),
    getQrCode: () =>
      Effect.sync(() => {
        providerCalls.push("getQrCode");
        return {
          ok: true as const,
          value: {
            expiresAt: null,
            image: qrBytes,
            state: "available" as const,
          },
        };
      }),
    reconcile: () =>
      Effect.sync(() => {
        providerCalls.push("reconcileSession");
        return {
          ok: true as const,
          value: {
            outcome: "present" as const,
            session: {
              ...lifecycleSession,
              connectionState: providerConnected
                ? disconnectFailed
                  ? (options.disconnectFailureState ?? "degraded")
                  : ("connected" as const)
                : ("disconnected" as const),
            },
          },
        };
      }),
    verifyNumber: () =>
      Effect.sync(() => {
        providerCalls.push("verifySessionNumber");
        return {
          ok: true as const,
          value: { outcome: options.numberVerification ?? "match" },
        };
      }),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(HumanIdentity, {
      verify: () =>
        options.identityValid === false
          ? Effect.fail(new InvalidHumanIdentity())
          : Effect.succeed("user_connectionowner"),
      verifyRecently: () => Effect.die("not used"),
    }),
    Layer.succeed(WhatsAppConnectionPersistence, persistence),
    Layer.succeed(WhatsAppConnectionProvider, provider),
    Layer.succeed(ConnectionSetupProvisioningQueue, {
      enqueue: () => Effect.die("not used"),
      enqueueCleanup: (requestedSetupId) =>
        Effect.sync(() => {
          cleanupEnqueues.push(requestedSetupId);
        }),
    }),
    Layer.succeed(WhatsAppConnectionClock, {
      now: Effect.succeed("2026-07-31T12:04:00.000Z"),
    }),
    Layer.succeed(WhatsAppConnectionIdentifiers, {
      nextConnectionId: Effect.succeed("20000000-0000-4000-8000-000000000041"),
      nextLifecycleClaimId: Effect.succeed(
        "40000000-0000-4000-8000-000000000041",
      ),
      nextPublicId: Effect.succeed("con_000000000000000000041"),
      nextWebhookIdentityKey: Effect.succeed(new Uint8Array(32).fill(41)),
    }),
    Layer.succeed(EnvelopeEncryptionService, {
      createConnectionKey: ({ accountId, connectionId, keyVersion }) =>
        Effect.succeed({
          accountKeyVersion: 1,
          ciphertext: "ISIj",
          connectionId,
          keyVersion,
          nonce: "JCUmJygpKissLQ==",
          personalAccountId: accountId,
          version: 1 as const,
        }),
      createPersonalAccountKey: () => Effect.die("not used"),
      decrypt: ({ context }) =>
        context.fieldOrObjectPurpose === "whatsapp-number"
          ? Effect.succeed(new TextEncoder().encode("+15550123456"))
          : context.fieldOrObjectPurpose === "provider-session-locator"
            ? Effect.succeed(new TextEncoder().encode(lifecycleSession.session))
            : context.fieldOrObjectPurpose === "display-name"
              ? Effect.succeed(
                  new TextEncoder().encode(
                    context.entity === "connection-setup"
                      ? "Personal WhatsApp"
                      : (connections[0]?.displayName ?? lastEncryptedName),
                  ),
                )
              : Effect.die("unexpected decryption"),
      decryptMany: () => Effect.die("not used"),
      encrypt: ({ context, plaintext }) =>
        Effect.sync(() => {
          encryptedPurposes.push(context.fieldOrObjectPurpose);
          if (context.fieldOrObjectPurpose === "display-name") {
            lastEncryptedName = new TextDecoder().decode(plaintext);
          }
          return {
            ciphertext: "Li8w",
            keyVersion: 1,
            nonce: "MTIzNDU2Nzg5Og==",
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
    Layer.succeed(RestoreSafeDeletion, {
      markers: {
        create: (input) =>
          Effect.succeed({
            markerId: "a".repeat(64),
            objectKey: `markers/v1/${"a".repeat(64)}.json`,
            marker: {
              version: 1,
              deletionKind: input.deletionKind,
              requestedAt: input.requestedAt,
              keyUnavailableAt: input.keyUnavailableAt,
            },
          }),
        enumerate: () => Effect.succeed([]),
      },
      capsules: {
        create: ({ deletionMarkerId, keyVersion }) =>
          Effect.succeed({
            ciphertext: new Uint8Array([1]),
            deletionMarkerId,
            encryptionContext: {},
            keyId: "deletion-key",
            keyVersion,
          }),
      },
    }),
  );

  return {
    cleanupEnqueues,
    connections,
    encryptedPurposes,
    events,
    handler: createWhatsAppConnectionHandler(layer, browserOrigin),
    providerCalls,
    scanQr: () => {
      providerConnected = true;
    },
  };
};

const request = (url: string, method = "GET") =>
  new Request(url, {
    headers: {
      authorization: "Bearer signed-clerk-token",
      origin: browserOrigin,
    },
    method,
  });

const renameRequest = (name: unknown) =>
  new Request(nameEndpoint, {
    body: JSON.stringify({ name }),
    headers: {
      authorization: "Bearer signed-clerk-token",
      "content-type": "application/json",
      origin: browserOrigin,
    },
    method: "PUT",
  });

describe("WhatsApp Connection HTTP boundary", () => {
  test("streams current QR bytes without retaining or emitting them", async () => {
    const harness = makeHarness();

    const response = await harness.handler(request(qrEndpoint));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(qrBytes);
    expect(harness.events).toContainEqual({
      event: "connection_setup.qr.completed",
      outcome: "qr_available",
      service: "api",
    });
    expect(harness.providerCalls).toEqual([
      "reconcileSession",
      "connectSession",
      "getQrCode",
    ]);
    expect(JSON.stringify(harness.events)).not.toContain("<svg");
    expect(JSON.stringify(harness.events)).not.toContain("cst_");
    expect(harness.connections).toEqual([]);
    expect(harness.cleanupEnqueues).toEqual([]);
  });

  test("activates once from trusted connected state and lists only safe fields", async () => {
    const harness = makeHarness();
    harness.scanQr();

    const observed = await harness.handler(request(qrEndpoint));
    const replay = await harness.handler(request(qrEndpoint));
    const listed = await harness.handler(request(listEndpoint));

    expect(observed.status).toBe(204);
    expect(replay.status).toBe(204);
    expect(harness.connections).toHaveLength(1);
    expect(harness.providerCalls).toEqual([
      "reconcileSession",
      "verifySessionNumber",
    ]);
    expect(harness.encryptedPurposes).toEqual([
      "display-name",
      "provider-session-locator",
      "provider-session-authority",
      "webhook-identity-key",
      "message-search-key",
    ]);
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    expect(JSON.parse(listedText)).toEqual({
      whatsapp_connections: [
        {
          display_name: "Personal WhatsApp",
          id: "con_000000000000000000041",
          number_suffix: "3456",
          state: "connected",
          state_changed_at: "2026-07-31T12:04:00.000Z",
        },
      ],
    });
    expect(listedText).not.toContain("session-authority");
  });

  test("renames an owned Connection and rejects invalid names", async () => {
    const harness = makeHarness();
    harness.scanQr();
    await harness.handler(request(qrEndpoint));

    const renamed = await harness.handler(renameRequest("  Work WhatsApp  "));
    const invalid = await harness.handler(renameRequest("   "));

    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      whatsapp_connection: {
        display_name: "Work WhatsApp",
        id: connectionId,
      },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_request" });
    expect(harness.connections[0]?.displayName).toBe("Work WhatsApp");
  });

  test("reports pending provisioning without invoking provider-control", async () => {
    const harness = makeHarness({ initialSetupState: "pending" });

    const response = await harness.handler(request(qrEndpoint));

    expect(response.status).toBe(202);
    expect(response.headers.get("x-connection-setup-state")).toBe("pending");
    expect(harness.providerCalls).toEqual([]);
  });

  test("reports a definitive provider rejection as temporary Connection capacity unavailability", async () => {
    const harness = makeHarness({
      initialFailureCode: "source_rejected",
      initialSetupState: "provisioning_failed",
    });

    const response = await harness.handler(request(qrEndpoint));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "provider_capacity_unavailable",
    });
    expect(harness.providerCalls).toEqual([]);
  });

  test.each(["scanned_number_mismatch", "scanned_number_unverified"])(
    "preserves actionable number confirmation failure for persisted %s polls",
    async (initialFailureCode) => {
      const harness = makeHarness({
        initialFailureCode,
        initialSetupState: "provisioning_failed",
      });

      const response = await harness.handler(request(qrEndpoint));

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "number_confirmation_failed",
        message: "Retry by scanning the same WhatsApp account you entered.",
      });
      expect(harness.providerCalls).toEqual([]);
    },
  );

  test("fails closed when the scanned WhatsApp account does not match the reserved number", async () => {
    const harness = makeHarness({ numberVerification: "mismatch" });
    harness.scanQr();

    const response = await harness.handler(request(qrEndpoint));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "number_confirmation_failed",
      message: "Retry by scanning the same WhatsApp account you entered.",
    });
    expect(harness.connections).toEqual([]);
    expect(harness.cleanupEnqueues).toEqual([setupId]);
    expect(harness.providerCalls).toEqual([
      "reconcileSession",
      "verifySessionNumber",
    ]);
    expect(JSON.stringify(harness.events)).not.toContain("+15550123456");
    expect(JSON.stringify(harness.providerCalls)).not.toContain("wsl_");
  });

  test("fails closed when provider identity evidence is unavailable", async () => {
    const harness = makeHarness({ numberVerification: "unverified" });
    harness.scanQr();

    const response = await harness.handler(request(qrEndpoint));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "number_confirmation_failed",
      message: "Retry by scanning the same WhatsApp account you entered.",
    });
    expect(harness.connections).toEqual([]);
    expect(harness.cleanupEnqueues).toEqual([setupId]);
    expect(harness.providerCalls).toEqual([
      "reconcileSession",
      "verifySessionNumber",
    ]);
  });

  test("makes deletion immediately terminal and idempotent at the authenticated boundary", async () => {
    const harness = makeHarness();
    harness.scanQr();
    await harness.handler(request(qrEndpoint));
    const deleted = await harness.handler(request(deleteEndpoint, "POST"));
    const replay = await harness.handler(request(deleteEndpoint, "POST"));
    const reconnectAfterDeletion = await harness.handler(
      request(reconnectEndpoint, "POST"),
    );
    const listed = await harness.handler(request(listEndpoint));
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({
      deletion: { outcome: "complete" },
      whatsapp_connection_id: connectionId,
    });
    expect(replay.status).toBe(200);
    expect(reconnectAfterDeletion.status).toBe(404);
    expect(await listed.json()).toEqual({ whatsapp_connections: [] });
  });

  test("disconnects and reconnects the retained Connection through reconciled lifecycle writes", async () => {
    const harness = makeHarness();
    harness.scanQr();
    await harness.handler(request(qrEndpoint));
    harness.providerCalls.length = 0;

    const disconnected = await harness.handler(
      request(disconnectEndpoint, "POST"),
    );
    const disconnectReplay = await harness.handler(
      request(disconnectEndpoint, "POST"),
    );
    const reconnectQr = await harness.handler(
      request(reconnectEndpoint, "POST"),
    );
    harness.scanQr();
    const reconnected = await harness.handler(
      request(reconnectEndpoint, "POST"),
    );

    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toMatchObject({
      lifecycle: { action: "disconnect", outcome: "complete" },
      whatsapp_connection: {
        id: connectionId,
        number_suffix: "3456",
        state: "disconnected",
      },
    });
    expect(disconnectReplay.status).toBe(200);
    expect(reconnectQr.status).toBe(200);
    expect(reconnectQr.headers.get("content-type")).toBe("image/svg+xml");
    expect(reconnectQr.headers.get("x-whatsapp-connection-state")).toBe(
      "connecting",
    );
    expect(reconnected.status).toBe(200);
    expect(await reconnected.json()).toMatchObject({
      lifecycle: { action: "reconnect", outcome: "complete" },
      whatsapp_connection: {
        id: connectionId,
        state: "connected",
      },
    });
    expect(harness.connections).toEqual([
      expect.objectContaining({
        numberSuffix: "3456",
        publicId: connectionId,
        state: "connected",
      }),
    ]);
    expect(harness.providerCalls).toEqual([
      "reconcileSession",
      "disconnectSession",
      "reconcileSession",
      "connectSession",
      "getQrCode",
      "reconcileSession",
    ]);
    expect(JSON.stringify(harness.events)).not.toContain(setupId);
    expect(JSON.stringify(harness.events)).not.toContain("session-authority");
  });

  test("fails lifecycle requests closed for another User and unknown Connection", async () => {
    const invalidIdentity = makeHarness({ identityValid: false });
    const owner = makeHarness();

    const responses = await Promise.all([
      invalidIdentity.handler(request(disconnectEndpoint, "POST")),
      owner.handler(
        request(`${listEndpoint}/con_999999999999999999999/disconnect`, "POST"),
      ),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([404, 404]);
    expect(invalidIdentity.providerCalls).toEqual([]);
    expect(owner.providerCalls).toEqual([]);
  });

  test("reconciles one ambiguous disconnect without repeating the provider write", async () => {
    const harness = makeHarness({
      disconnectFailureState: "disconnected",
    });
    harness.scanQr();
    await harness.handler(request(qrEndpoint));
    harness.providerCalls.length = 0;

    const response = await harness.handler(request(disconnectEndpoint, "POST"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      lifecycle: { action: "disconnect", outcome: "complete" },
      whatsapp_connection: {
        id: connectionId,
        state: "disconnected",
      },
    });
    expect(harness.providerCalls).toEqual([
      "reconcileSession",
      "disconnectSession",
      "reconcileSession",
    ]);
  });

  test("blocks side effects as degraded when ambiguous disconnect reconciliation still observes connected", async () => {
    const harness = makeHarness({
      disconnectFailureState: "connected",
    });
    harness.scanQr();
    await harness.handler(request(qrEndpoint));
    harness.providerCalls.length = 0;

    const response = await harness.handler(request(disconnectEndpoint, "POST"));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      lifecycle: { action: "disconnect", outcome: "recovery_required" },
      whatsapp_connection: {
        id: connectionId,
        state: "degraded",
      },
    });
    expect(
      harness.providerCalls.filter((call) => call === "disconnectSession"),
    ).toHaveLength(1);
  });

  test("does not repeat an ambiguous disconnect when reconciliation remains degraded", async () => {
    const harness = makeHarness({
      disconnectFailureState: "degraded",
    });
    harness.scanQr();
    await harness.handler(request(qrEndpoint));
    harness.providerCalls.length = 0;

    const first = await harness.handler(request(disconnectEndpoint, "POST"));
    const reconciledAgain = await harness.handler(
      request(disconnectEndpoint, "POST"),
    );

    expect(first.status).toBe(409);
    expect(reconciledAgain.status).toBe(409);
    expect(await reconciledAgain.json()).toMatchObject({
      lifecycle: { action: "disconnect", outcome: "recovery_required" },
      whatsapp_connection: {
        id: connectionId,
        state: "degraded",
      },
    });
    expect(
      harness.providerCalls.filter((call) => call === "disconnectSession"),
    ).toHaveLength(1);
  });

  test("fails closed for another User, invalid Origin, and invalid setup handle", async () => {
    const invalidIdentity = makeHarness({ identityValid: false });
    const owner = makeHarness();

    const responses = await Promise.all([
      invalidIdentity.handler(request(qrEndpoint)),
      owner.handler(
        new Request(qrEndpoint, {
          headers: {
            authorization: "Bearer signed-clerk-token",
            origin: "https://attacker.example.test",
          },
        }),
      ),
      owner.handler(
        request("https://api.example.test/v1/connection-setups/not-a-setup/qr"),
      ),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([404, 404, 404]);
    expect(invalidIdentity.providerCalls).toEqual([]);
    expect(owner.providerCalls).toEqual([]);
  });
});
