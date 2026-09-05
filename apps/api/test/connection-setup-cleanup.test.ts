import type {
  LifecycleSession,
  ProviderControlFailure,
  ProviderControlResult,
  SessionDeletionObservation,
  SessionReconciliation,
} from "@whatsapp-mcp/contracts/provider-control";
import type { PendingStoredMediaCandidate } from "@whatsapp-mcp/db/stored-media";
import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  ConnectionSetupCleanupClock,
  ConnectionSetupCleanupIdentifiers,
  ConnectionSetupCleanupPersistence,
  type ConnectionSetupCleanupPersistenceService,
  ConnectionSetupCleanupProvider,
  type ConnectionSetupCleanupProviderService,
  cleanupConnectionSetup,
} from "../src/connection-setup-cleanup";
import {
  createProductionQueueHandler,
  createProductionScheduledHandler,
} from "../src/production";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";

const setupId = "cst_000000000000000000001";
const workerId = "cscw_0000000000000000000000000000000000000000000";
const observedAt = "2026-07-31T12:20:00.000Z";

const session = (suffix: string): LifecycleSession => ({
  authority: `session-authority-${suffix}`,
  connectionState: "disconnected",
  session: `wsl_${suffix.padEnd(43, "0")}`,
});

const success = <Value>(value: Value): ProviderControlResult<Value> => ({
  ok: true,
  value,
});

const unavailable: ProviderControlFailure = {
  _tag: "ProviderControlFailure",
  code: "unavailable",
  operation: "lifecycle-write",
  retryAfterMs: null,
  retryDecision: "reconcile_before_repeat",
};

const makeHarness = (options: {
  readonly delete?: (
    providerSession: string,
  ) => Promise<ProviderControlResult<SessionDeletionObservation>>;
  readonly reconcile: () => Promise<
    ProviderControlResult<SessionReconciliation>
  >;
}) => {
  const calls: Array<"claim" | "delete" | "finish" | "reconcile" | "release"> =
    [];
  const deletedSessions: Array<string> = [];
  const events: Array<SafeTelemetryEvent> = [];
  let complete = false;
  let lease: string | null = null;

  const persistence: ConnectionSetupCleanupPersistenceService = {
    claim: ({ workerId: requestedWorkerId }) =>
      Effect.sync(() => {
        calls.push("claim");
        if (complete) return { outcome: "complete" as const };
        if (lease !== null) return { outcome: "leased" as const };
        lease = requestedWorkerId;
        return { outcome: "claimed" as const };
      }),
    finish: ({ workerId: requestedWorkerId }) =>
      Effect.sync(() => {
        calls.push("finish");
        if (lease !== requestedWorkerId) return false;
        complete = true;
        lease = null;
        return true;
      }),
    listCandidates: () => Effect.succeed([]),
    release: ({ workerId: requestedWorkerId }) =>
      Effect.sync(() => {
        calls.push("release");
        if (lease !== requestedWorkerId) return false;
        lease = null;
        return true;
      }),
    renew: ({ workerId: requestedWorkerId }) =>
      Effect.sync(() => lease === requestedWorkerId),
  };

  const provider: ConnectionSetupCleanupProviderService = {
    delete: ({ session: providerSession }) =>
      Effect.promise(async () => {
        calls.push("delete");
        deletedSessions.push(providerSession);
        return (
          (await options.delete?.(providerSession)) ??
          success({ state: "present" as const })
        );
      }),
    reconcile: () =>
      Effect.promise(async () => {
        calls.push("reconcile");
        return options.reconcile();
      }),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(ConnectionSetupCleanupPersistence, persistence),
    Layer.succeed(ConnectionSetupCleanupProvider, provider),
    Layer.succeed(ConnectionSetupCleanupClock, {
      now: Effect.succeed(observedAt),
    }),
    Layer.succeed(ConnectionSetupCleanupIdentifiers, {
      nextWorkerId: Effect.succeed(workerId),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    }),
  );

  return { calls, deletedSessions, events, layer };
};

describe("Connection Setup cleanup saga", () => {
  test("releases the reservation only after reconciliation confirms absence", async () => {
    const harness = makeHarness({
      reconcile: async () => success({ outcome: "absent" }),
    });

    const result = await Effect.runPromise(
      cleanupConnectionSetup(setupId).pipe(Effect.provide(harness.layer)),
    );

    expect(result).toEqual({ outcome: "complete" });
    expect(harness.calls).toEqual(["claim", "reconcile", "finish"]);
    expect(harness.deletedSessions).toEqual([]);
  });

  test("deletes one reconciled session and requires another reconciliation before completion", async () => {
    const present = session("present");
    const harness = makeHarness({
      reconcile: async () => success({ outcome: "present", session: present }),
    });

    const result = await Effect.runPromise(
      cleanupConnectionSetup(setupId).pipe(Effect.provide(harness.layer)),
    );

    expect(result).toEqual({ delaySeconds: 30, outcome: "retry" });
    expect(harness.calls).toEqual(["claim", "reconcile", "delete", "release"]);
    expect(harness.deletedSessions).toEqual([present.session]);
  });

  test("deletes only one duplicate per reconcile-first attempt", async () => {
    const first = session("duplicate-a");
    const second = session("duplicate-b");
    const harness = makeHarness({
      reconcile: async () =>
        success({ outcome: "duplicates", sessions: [first, second] }),
    });

    const result = await Effect.runPromise(
      cleanupConnectionSetup(setupId).pipe(Effect.provide(harness.layer)),
    );

    expect(result).toEqual({ delaySeconds: 30, outcome: "retry" });
    expect(harness.deletedSessions).toEqual([first.session]);
  });

  test("records cleanup failure and safely retries from reconciliation", async () => {
    const present = session("failed-delete");
    const harness = makeHarness({
      delete: async () => ({ error: unavailable, ok: false }),
      reconcile: async () => success({ outcome: "present", session: present }),
    });

    const result = await Effect.runPromise(
      cleanupConnectionSetup(setupId).pipe(Effect.provide(harness.layer)),
    );

    expect(result).toEqual({ delaySeconds: 30, outcome: "retry" });
    expect(harness.calls).toEqual(["claim", "reconcile", "delete", "release"]);
    expect(harness.events).toContainEqual({
      event: "connection_setup.cleanup.completed",
      failureCode: "unavailable",
      outcome: "retry",
      service: "api",
    });
    expect(JSON.stringify(harness.events)).not.toContain(setupId);
    expect(JSON.stringify(harness.events)).not.toContain("wsl_");
  });

  test("dispatches cleanup and provisioning independently in a mixed Queue batch", async () => {
    const outcomes = {
      cleanup: { acknowledgements: 0, retries: 0 },
      provisioning: { acknowledgements: 0, retries: 0 },
    };
    const message = (
      kind: "cleanup" | "provisioning",
      body: unknown,
    ): Message<unknown> =>
      ({
        ack: () => {
          outcomes[kind].acknowledgements += 1;
        },
        attempts: 1,
        body,
        id: kind,
        retry: () => {
          outcomes[kind].retries += 1;
        },
        timestamp: new Date(observedAt),
      }) as Message<unknown>;
    const handler = createProductionQueueHandler({
      DEPLOYMENT_ENVIRONMENT: "development",
      HYPERDRIVE: { connectionString: "test-connection-string" },
      NEON_BRANCH_ID: "br-test",
    });

    await handler({
      ackAll: () => undefined,
      messages: [
        message("cleanup", {
          kind: "connection_setup.cleanup",
          setup_id: setupId,
          version: 1,
        }),
        message("provisioning", {
          kind: "connection_setup.provision",
          setup_id: setupId,
          version: 1,
        }),
      ],
      metadata: {
        metrics: {
          backlogBytes: 0,
          backlogCount: 0,
        },
      },
      queue: "whatsapp-mcp-connection-setup-provisioning-development",
      retryAll: () => undefined,
    });

    expect(outcomes).toEqual({
      cleanup: { acknowledgements: 0, retries: 1 },
      provisioning: { acknowledgements: 0, retries: 1 },
    });
  });

  test("the four-minute scheduled handler expires setups and publishes cleanup without a browser request", async () => {
    const batches: Array<ReadonlyArray<{ readonly body: unknown }>> = [];
    const observed: Array<string> = [];
    const sweepObserved: string[] = [];
    const sendLeaseSweeps: Date[] = [];
    const processedMedia: PendingStoredMediaCandidate[] = [];
    let recoverySourcePoints = 0;
    const pendingMedia = {
      id: "30000000-0000-4000-8000-000000000045",
    } as PendingStoredMediaCandidate;
    const handler = createProductionScheduledHandler(
      {
        CONNECTION_SETUP_PROVISIONING_QUEUE: {
          sendBatch: async (
            messages: ReadonlyArray<{ readonly body: unknown }>,
          ) => {
            batches.push(messages);
          },
        },
        DEPLOYMENT_ENVIRONMENT: "development",
        NEON_BRANCH_ID: "br-test",
        HYPERDRIVE: { connectionString: "test-connection-string" },
      },
      {
        recordRecoverySourcePoint: async (connectionString) => {
          expect(connectionString).toBe("test-connection-string");
          recoverySourcePoints += 1;
          return "2026-07-31T12:16:00.000Z";
        },
        makeRepository: () => ({
          expire: async ({ observedAt: value }) => {
            observed.push(value);
            return [setupId];
          },
          listCleanupCandidates: async () => [setupId],
          listProvisioningCandidates: async () => [],
        }),
        makeSendRepository: () => ({
          expireLeases: async (value) => {
            sendLeaseSweeps.push(value);
            return 2;
          },
        }),
        listPendingStoredMedia: async (limit) => {
          expect(limit).toBe(10);
          return [pendingMedia];
        },
        processPendingStoredMedia: async (candidate) => {
          processedMedia.push(candidate);
        },
        sweepWebhookIngress: async (value) => {
          sweepObserved.push(value);
        },
      },
    );

    await handler({
      cron: "*/4 * * * *",
      scheduledTime: Date.parse("2026-07-31T12:16:00.000Z"),
    } as ScheduledController);

    expect(recoverySourcePoints).toBe(1);
    expect(observed).toEqual(["2026-07-31T12:16:00.000Z"]);
    expect(sweepObserved).toEqual(["2026-07-31T12:16:00.000Z"]);
    expect(sendLeaseSweeps).toEqual([new Date("2026-07-31T12:16:00.000Z")]);
    expect(processedMedia).toEqual([pendingMedia]);
    expect(batches).toEqual([
      [
        {
          body: {
            kind: "connection_setup.cleanup",
            setup_id: setupId,
            version: 1,
          },
        },
      ],
    ]);
  });
});
