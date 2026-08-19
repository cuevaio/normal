import type {
  ProviderControlFailure,
  ProviderControlService,
} from "@whatsapp-mcp/contracts/provider-control";
import { Effect, Layer } from "effect";
import { ConnectionHealthProvider } from "./connection-health";
import { ConnectionSetupCleanupProvider } from "./connection-setup-cleanup";
import { ConnectionSetupProvisioningProvider } from "./connection-setup-provisioning";
import { WhatsAppConnectionProvider } from "./whatsapp-connection";

const unavailable = (
  operation: "lifecycle-write" | "safe-read",
): { readonly error: ProviderControlFailure; readonly ok: false } => ({
  error: {
    _tag: "ProviderControlFailure",
    code: "unavailable",
    operation,
    retryAfterMs: null,
    retryDecision:
      operation === "lifecycle-write"
        ? "reconcile_before_repeat"
        : "retry_within_safe_read_budget",
  },
  ok: false,
});

const lifecycleWrite = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: () => unavailable("lifecycle-write"),
  }).pipe(Effect.catchAll((failure) => Effect.succeed(failure)));

const safeRead = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: () => unavailable("safe-read"),
  }).pipe(Effect.catchAll((failure) => Effect.succeed(failure)));

export const makeProviderControlLayers = (provider: ProviderControlService) => {
  const reconcile = (
    input: Parameters<ProviderControlService["reconcileSession"]>[0],
  ) => safeRead(() => provider.reconcileSession(input));

  return {
    connectionHealth: Layer.succeed(ConnectionHealthProvider, {
      reconcile,
      repair: (input) =>
        lifecycleWrite(() => provider.repairSessionConfiguration(input)),
    }),
    connectionSetupCleanup: Layer.succeed(ConnectionSetupCleanupProvider, {
      delete: (input) => lifecycleWrite(() => provider.deleteSession(input)),
      reconcile,
    }),
    connectionSetupProvisioning: Layer.succeed(
      ConnectionSetupProvisioningProvider,
      {
        create: (input) => lifecycleWrite(() => provider.createSession(input)),
        reconcile,
      },
    ),
    whatsAppConnection: Layer.succeed(WhatsAppConnectionProvider, {
      connect: (input) => lifecycleWrite(() => provider.connectSession(input)),
      disconnect: (input) =>
        lifecycleWrite(() => provider.disconnectSession(input)),
      getQrCode: (input) => safeRead(() => provider.getQrCode(input)),
      reconcile,
      verifyNumber: (input) =>
        safeRead(() => provider.verifySessionNumber(input)),
    }),
  } as const;
};
