import type {
  LifecycleSession,
  ProviderControlFailure,
  ProviderControlResult,
  SessionReconciliation,
} from "@whatsapp-mcp/contracts/provider-control";
import { Effect, Layer } from "effect";
import { describe, expect, test, vi } from "vitest";
import {
  ConnectionSetupProvisioningClock,
  ConnectionSetupProvisioningIdentifiers,
  ConnectionSetupProvisioningPersistence,
  type ConnectionSetupProvisioningPersistenceService,
  ConnectionSetupProvisioningProvider,
  type ConnectionSetupProvisioningProviderService,
  ConnectionSetupProvisioningWebhook,
  provisionConnectionSetup,
} from "../src/connection-setup-provisioning";
import {
  EnvelopeEncryptionService,
  type VersionedCiphertext,
} from "../src/encryption/envelope";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";

const setupId = "cst_000000000000000000001";
const personalAccountId = "10000000-0000-4000-8000-000000000021";
const observedAt = "2026-07-31T12:00:00.000Z";
const workerId = "cspw_0000000000000000000000000000000000000000000";
const accountKey = {
  ciphertext: "AQID",
  keyVersion: 1,
  kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
  personalAccountId,
  version: 1 as const,
};
const connectionKey = {
  accountKeyVersion: 1,
  ciphertext: "BAUG",
  connectionId: setupId,
  keyVersion: 1,
  nonce: "BwgJCgsMDQ4PEA==",
  personalAccountId,
  version: 1 as const,
};
const numberCiphertext = {
  ciphertext: "ERIT",
  keyVersion: 1,
  nonce: "FBUWFxgZGhscHQ==",
  version: 1 as const,
};

const session = (
  suffix: string,
  authority = `session-authority-${suffix}`,
): LifecycleSession => ({
  authority,
  connectionState: "disconnected",
  session: `wsl_${suffix.padEnd(43, "0")}`,
});

const success = <Value>(value: Value): ProviderControlResult<Value> => ({
  ok: true,
  value,
});

const ambiguousCreate: ProviderControlFailure = {
  _tag: "ProviderControlFailure",
  code: "timed_out",
  operation: "lifecycle-write",
  retryAfterMs: null,
  retryDecision: "reconcile_before_repeat",
};

const makeHarness = (options: {
  readonly create?: (
    attempt: number,
  ) => Promise<ProviderControlResult<LifecycleSession>>;
  readonly reconcile: (
    attempt: number,
  ) => Promise<ProviderControlResult<SessionReconciliation>>;
}) => {
  const calls: Array<"claim" | "create" | "finish" | "reconcile" | "renew"> =
    [];
  const events: Array<SafeTelemetryEvent> = [];
  const encryptedPlaintexts: Array<string> = [];
  const createInputs: Array<{
    readonly phoneNumber: string;
    readonly setupMarker: string;
    readonly webhookUrl: string;
  }> = [];
  const reconcileInputs: Array<{
    readonly setupMarker: string;
    readonly webhookUrl: string;
  }> = [];
  const persisted: Array<{
    readonly outcome: "provisioned" | "quarantined";
    readonly sessions: ReadonlyArray<object>;
  }> = [];
  let activeLease: string | null = null;
  let claimCount = 0;
  let terminalFailure = false;
  let createAttempts = 0;
  let reconcileAttempts = 0;
  let encryptionSequence = 0;

  const persistence: ConnectionSetupProvisioningPersistenceService = {
    claim: ({ workerId: requestedWorkerId }) =>
      Effect.sync(() => {
        calls.push("claim");
        if (persisted.length > 0 || terminalFailure) {
          return { outcome: "not_pending" as const };
        }
        if (activeLease !== null) {
          return { outcome: "leased" as const };
        }
        activeLease = requestedWorkerId;
        claimCount += 1;
        return {
          outcome: "claimed" as const,
          setup: {
            accountKey,
            connectionKey,
            createdAt: "2026-07-31T11:59:00.000Z",
            firstClaim: claimCount === 1,
            numberCiphertext,
            personalAccountId,
            provisioningStartedAt: observedAt,
            setupId,
            webhookIngressId: "30000000-0000-4000-8000-000000000021",
          },
        };
      }),
    fail: ({ workerId: requestedWorkerId }) =>
      Effect.sync(() => {
        if (activeLease !== requestedWorkerId) return false;
        activeLease = null;
        terminalFailure = true;
        return true;
      }),
    finish: (input) =>
      Effect.sync(() => {
        calls.push("finish");
        if (activeLease !== input.workerId) return false;
        persisted.push({
          outcome: input.outcome,
          sessions: input.sessions,
        });
        activeLease = null;
        return true;
      }),
    listCandidates: () => Effect.succeed([]),
    release: ({ workerId: requestedWorkerId }) =>
      Effect.sync(() => {
        if (activeLease === requestedWorkerId) activeLease = null;
        return true;
      }),
    renew: ({ workerId: requestedWorkerId }) =>
      Effect.sync(() => {
        calls.push("renew");
        return activeLease === requestedWorkerId;
      }),
  };

  const provider: ConnectionSetupProvisioningProviderService = {
    create: (input) =>
      Effect.promise(async () => {
        calls.push("create");
        createInputs.push(input);
        createAttempts += 1;
        return (
          (await options.create?.(createAttempts)) ??
          success(session("created"))
        );
      }),
    reconcile: (input) =>
      Effect.promise(async () => {
        calls.push("reconcile");
        reconcileInputs.push(input);
        reconcileAttempts += 1;
        return options.reconcile(reconcileAttempts);
      }),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(ConnectionSetupProvisioningPersistence, persistence),
    Layer.succeed(ConnectionSetupProvisioningProvider, provider),
    Layer.succeed(ConnectionSetupProvisioningClock, {
      now: Effect.succeed(observedAt),
    }),
    Layer.succeed(ConnectionSetupProvisioningIdentifiers, {
      nextWorkerId: Effect.succeed(workerId),
    }),
    Layer.succeed(ConnectionSetupProvisioningWebhook, {
      urlFor: (webhookIngressId) =>
        Effect.succeed(
          `https://api.example.test/webhooks/wasender/${webhookIngressId}`,
        ),
    }),
    Layer.succeed(EnvelopeEncryptionService, {
      createConnectionKey: () => Effect.die("not used"),
      createPersonalAccountKey: () => Effect.die("not used"),
      decrypt: ({ context }) =>
        context.fieldOrObjectPurpose === "whatsapp-number"
          ? Effect.succeed(new TextEncoder().encode("+15550123456"))
          : Effect.die("unexpected decrypt"),
      decryptMany: () => Effect.die("not used"),
      encrypt: ({ plaintext }) =>
        Effect.sync(() => {
          const value = new TextDecoder().decode(plaintext);
          encryptedPlaintexts.push(value);
          encryptionSequence += 1;
          return {
            ciphertext: Buffer.from(
              `ciphertext-${encryptionSequence}`,
            ).toString("base64"),
            keyVersion: 1,
            nonce: Buffer.from(
              `nonce-${String(encryptionSequence).padStart(6, "0")}`,
            )
              .subarray(0, 12)
              .toString("base64"),
            version: 1,
          } satisfies VersionedCiphertext;
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
    calls,
    createAttempts: () => createAttempts,
    createInputs,
    encryptedPlaintexts,
    events,
    layer,
    persisted,
    reconcileInputs,
  };
};

describe("Connection Setup provisioning saga", () => {
  test("reconciles absence before one create and encrypts provider identity before advancing", async () => {
    const harness = makeHarness({
      reconcile: async () => success({ outcome: "absent" }),
    });

    const result = await Effect.runPromise(
      provisionConnectionSetup(setupId).pipe(Effect.provide(harness.layer)),
    );

    expect(result).toEqual({ outcome: "provisioned" });
    expect(harness.calls).toEqual([
      "claim",
      "reconcile",
      "renew",
      "create",
      "finish",
    ]);
    expect(harness.events).toContainEqual({
      event: "connection_setup.provision.claimed",
      queueDelayMs: 60_000,
      service: "api",
    });
    expect(harness.events).toContainEqual({
      durationMs: 0,
      event: "connection_setup.provision.completed",
      outcome: "provisioned",
      service: "api",
    });
    expect(harness.reconcileInputs).toEqual([
      {
        setupMarker: setupId,
        webhookUrl:
          "https://api.example.test/webhooks/wasender/30000000-0000-4000-8000-000000000021",
      },
    ]);
    expect(harness.persisted).toHaveLength(1);
    expect(harness.createInputs).toEqual([
      {
        phoneNumber: "+15550123456",
        setupMarker: setupId,
        webhookUrl:
          "https://api.example.test/webhooks/wasender/30000000-0000-4000-8000-000000000021",
      },
    ]);
    expect(harness.persisted[0]).toMatchObject({
      outcome: "provisioned",
      sessions: [{ ordinal: 0 }],
    });
    expect(JSON.stringify(harness.persisted)).not.toContain("+15550123456");
    expect(JSON.stringify(harness.persisted)).not.toContain(
      "session-authority",
    );
    expect(JSON.stringify(harness.persisted)).not.toContain("wsl_");
    expect(harness.encryptedPlaintexts).toEqual([
      "wsl_created000000000000000000000000000000000000",
      "session-authority-created",
    ]);
    expect(JSON.stringify(harness.events)).not.toContain(setupId);
    expect(JSON.stringify(harness.events)).not.toContain("wsl_");
  });

  test("adopts exactly one reconciled provider session without creating", async () => {
    const adopted = session("adopted");
    const harness = makeHarness({
      reconcile: async () => success({ outcome: "present", session: adopted }),
    });

    const result = await Effect.runPromise(
      provisionConnectionSetup(setupId).pipe(Effect.provide(harness.layer)),
    );

    expect(result).toEqual({ outcome: "provisioned" });
    expect(harness.createAttempts()).toBe(0);
    expect(harness.calls).toEqual(["claim", "reconcile", "finish"]);
    expect(harness.persisted[0]).toMatchObject({
      outcome: "provisioned",
      sessions: [{ ordinal: 0 }],
    });
  });

  test("durably quarantines every matching provider session when reconciliation finds duplicates", async () => {
    const harness = makeHarness({
      reconcile: async () =>
        success({
          outcome: "duplicates",
          sessions: [session("duplicate-a"), session("duplicate-b")],
        }),
    });

    const result = await Effect.runPromise(
      provisionConnectionSetup(setupId).pipe(Effect.provide(harness.layer)),
    );

    expect(result).toEqual({ outcome: "quarantined" });
    expect(harness.createAttempts()).toBe(0);
    expect(harness.persisted[0]).toMatchObject({
      outcome: "quarantined",
      sessions: [{ ordinal: 0 }, { ordinal: 1 }],
    });
    expect(JSON.stringify(harness.events)).not.toContain("duplicate");
  });

  test("reconciles an ambiguous create on retry and never repeats the create side effect", async () => {
    const adopted = session("after-timeout");
    const harness = makeHarness({
      create: async () => ({ error: ambiguousCreate, ok: false }),
      reconcile: async (attempt) =>
        attempt === 1
          ? success({ outcome: "absent" })
          : success({ outcome: "present", session: adopted }),
    });

    const first = await Effect.runPromise(
      provisionConnectionSetup(setupId).pipe(Effect.provide(harness.layer)),
    );
    const retry = await Effect.runPromise(
      provisionConnectionSetup(setupId).pipe(Effect.provide(harness.layer)),
    );

    expect(first).toEqual({ delaySeconds: 30, outcome: "retry" });
    expect(retry).toEqual({ outcome: "provisioned" });
    expect(harness.createAttempts()).toBe(1);
    expect(harness.calls.filter((call) => call === "reconcile")).toHaveLength(
      2,
    );
    expect(
      harness.events.filter(
        (event) => event.event === "connection_setup.provision.claimed",
      ),
    ).toHaveLength(1);
  });

  test("records a definitive lifecycle rejection without scheduling another create", async () => {
    const definitiveFailure: ProviderControlFailure = {
      _tag: "ProviderControlFailure",
      code: "source_rejected",
      operation: "lifecycle-write",
      retryAfterMs: null,
      retryDecision: "do_not_retry",
    };
    const harness = makeHarness({
      create: async () => ({ error: definitiveFailure, ok: false }),
      reconcile: async () => success({ outcome: "absent" }),
    });

    const first = await Effect.runPromise(
      provisionConnectionSetup(setupId).pipe(Effect.provide(harness.layer)),
    );
    const replayedMessage = await Effect.runPromise(
      provisionConnectionSetup(setupId).pipe(Effect.provide(harness.layer)),
    );

    expect(first).toEqual({ outcome: "failed" });
    expect(replayedMessage).toEqual({ outcome: "ignored" });
    expect(harness.createAttempts()).toBe(1);
  });

  test("records a definitive webhook reconciliation failure instead of retrying forever", async () => {
    const definitiveFailure: ProviderControlFailure = {
      _tag: "ProviderControlFailure",
      code: "integrity_failed",
      operation: "safe-read",
      retryAfterMs: null,
      retryDecision: "do_not_retry",
    };
    const harness = makeHarness({
      reconcile: async () => ({ error: definitiveFailure, ok: false }),
    });

    const first = await Effect.runPromise(
      provisionConnectionSetup(setupId).pipe(Effect.provide(harness.layer)),
    );
    const replayedMessage = await Effect.runPromise(
      provisionConnectionSetup(setupId).pipe(Effect.provide(harness.layer)),
    );

    expect(first).toEqual({ outcome: "failed" });
    expect(replayedMessage).toEqual({ outcome: "ignored" });
    expect(harness.createAttempts()).toBe(0);
  });

  test("lets only one concurrent worker hold the provisioning lease", async () => {
    let releaseCreate: (
      value: ProviderControlResult<LifecycleSession>,
    ) => void = () => undefined;
    const createResult = new Promise<ProviderControlResult<LifecycleSession>>(
      (resolve) => {
        releaseCreate = resolve;
      },
    );
    const harness = makeHarness({
      create: async () => createResult,
      reconcile: async () => success({ outcome: "absent" }),
    });

    const first = Effect.runPromise(
      provisionConnectionSetup(setupId).pipe(Effect.provide(harness.layer)),
    );
    await vi.waitFor(() => {
      expect(harness.calls).toContain("create");
    });
    const concurrent = await Effect.runPromise(
      provisionConnectionSetup(setupId).pipe(Effect.provide(harness.layer)),
    );
    releaseCreate(success(session("single")));

    expect(concurrent).toEqual({ delaySeconds: 30, outcome: "retry" });
    await expect(first).resolves.toEqual({ outcome: "provisioned" });
    expect(harness.createAttempts()).toBe(1);
    expect(harness.persisted).toHaveLength(1);
  });
});
