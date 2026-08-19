import type { ProviderControlService } from "@whatsapp-mcp/contracts/provider-control";
import { Effect, Layer } from "effect";
import { describe, expect, test, vi } from "vitest";
import { ConnectionHealthProvider } from "../src/connection-health";
import { ConnectionSetupCleanupProvider } from "../src/connection-setup-cleanup";
import { ConnectionSetupProvisioningProvider } from "../src/connection-setup-provisioning";
import { makeProviderControlLayers } from "../src/provider-control-production";
import { WhatsAppConnectionProvider } from "../src/whatsapp-connection";

const success = { ok: true, value: { marker: "unchanged" } } as const;

const provider = () => ({
  connectSession: vi.fn().mockResolvedValue(success),
  createSession: vi.fn().mockResolvedValue(success),
  deleteSession: vi.fn().mockResolvedValue(success),
  disconnectSession: vi.fn().mockResolvedValue(success),
  getQrCode: vi.fn().mockResolvedValue(success),
  listSessions: vi.fn().mockResolvedValue(success),
  reconcileSession: vi.fn().mockResolvedValue(success),
  repairSessionConfiguration: vi.fn().mockResolvedValue(success),
  verifySessionNumber: vi.fn().mockResolvedValue(success),
});

const allLayers = (service: ProviderControlService) => {
  const layers = makeProviderControlLayers(service);
  return Layer.mergeAll(
    layers.connectionHealth,
    layers.connectionSetupCleanup,
    layers.connectionSetupProvisioning,
    layers.whatsAppConnection,
  );
};

describe("Provider Control production adapters", () => {
  test("delegates once per call and passes resolved results through unchanged", async () => {
    const control = provider();
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const health = yield* ConnectionHealthProvider;
        const cleanup = yield* ConnectionSetupCleanupProvider;
        const provisioning = yield* ConnectionSetupProvisioningProvider;
        const connection = yield* WhatsAppConnectionProvider;
        return yield* Effect.all([
          provisioning.create({ marker: "create" } as never),
          provisioning.reconcile({ marker: "provision" } as never),
          cleanup.delete({ marker: "delete" } as never),
          cleanup.reconcile({ marker: "cleanup" } as never),
          connection.connect({ marker: "connect" } as never),
          connection.disconnect({ marker: "disconnect" } as never),
          connection.getQrCode({ marker: "qr" } as never),
          connection.reconcile({ marker: "connection" } as never),
          health.reconcile({ marker: "health" } as never),
        ]);
      }).pipe(Effect.provide(allLayers(control as ProviderControlService))),
    );

    expect(results).toEqual(Array.from({ length: 9 }, () => success));
    expect(results.every((result) => (result as unknown) === success)).toBe(
      true,
    );
    expect(control.createSession).toHaveBeenCalledOnce();
    expect(control.deleteSession).toHaveBeenCalledOnce();
    expect(control.connectSession).toHaveBeenCalledOnce();
    expect(control.disconnectSession).toHaveBeenCalledOnce();
    expect(control.getQrCode).toHaveBeenCalledOnce();
    expect(control.reconcileSession).toHaveBeenCalledTimes(4);
  });

  test("classifies every rejected lifecycle write without retrying", async () => {
    const control = provider();
    control.createSession.mockRejectedValue(new Error("unavailable"));
    control.deleteSession.mockRejectedValue(new Error("unavailable"));
    control.connectSession.mockRejectedValue(new Error("unavailable"));
    control.disconnectSession.mockRejectedValue(new Error("unavailable"));

    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const cleanup = yield* ConnectionSetupCleanupProvider;
        const provisioning = yield* ConnectionSetupProvisioningProvider;
        const connection = yield* WhatsAppConnectionProvider;
        return yield* Effect.all([
          provisioning.create({} as never),
          cleanup.delete({} as never),
          connection.connect({} as never),
          connection.disconnect({} as never),
        ]);
      }).pipe(Effect.provide(allLayers(control as ProviderControlService))),
    );

    expect(results).toEqual(
      Array.from({ length: 4 }, () => ({
        error: {
          _tag: "ProviderControlFailure",
          code: "unavailable",
          operation: "lifecycle-write",
          retryAfterMs: null,
          retryDecision: "reconcile_before_repeat",
        },
        ok: false,
      })),
    );
    expect(control.createSession).toHaveBeenCalledOnce();
    expect(control.deleteSession).toHaveBeenCalledOnce();
    expect(control.connectSession).toHaveBeenCalledOnce();
    expect(control.disconnectSession).toHaveBeenCalledOnce();
  });

  test("classifies every rejected safe read without retrying", async () => {
    const control = provider();
    control.getQrCode.mockRejectedValue(new Error("unavailable"));
    control.reconcileSession.mockRejectedValue(new Error("unavailable"));

    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const health = yield* ConnectionHealthProvider;
        const cleanup = yield* ConnectionSetupCleanupProvider;
        const provisioning = yield* ConnectionSetupProvisioningProvider;
        const connection = yield* WhatsAppConnectionProvider;
        return yield* Effect.all([
          provisioning.reconcile({} as never),
          cleanup.reconcile({} as never),
          connection.getQrCode({} as never),
          connection.reconcile({} as never),
          health.reconcile({} as never),
        ]);
      }).pipe(Effect.provide(allLayers(control as ProviderControlService))),
    );

    expect(results).toEqual(
      Array.from({ length: 5 }, () => ({
        error: {
          _tag: "ProviderControlFailure",
          code: "unavailable",
          operation: "safe-read",
          retryAfterMs: null,
          retryDecision: "retry_within_safe_read_budget",
        },
        ok: false,
      })),
    );
    expect(control.getQrCode).toHaveBeenCalledOnce();
    expect(control.reconcileSession).toHaveBeenCalledTimes(4);
  });
});
