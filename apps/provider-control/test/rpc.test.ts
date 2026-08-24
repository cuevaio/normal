import type {
  LifecycleSession,
  ProviderControlRpcTelemetryEvent,
} from "@whatsapp-mcp/contracts/provider-control";
import type {
  LifecycleSession as AdapterLifecycleSession,
  LifecycleSessionLocator,
  ProviderNeutralFailure,
  SessionAuthority,
  SessionLifecycle,
  SetupMarker,
} from "@whatsapp-mcp/wasender/control";
import { Effect, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import { makeProviderControlRpc } from "../src/rpc";

const setupMarker = "cst_0123456789abcdefghijk" as SetupMarker;
const webhookUrl =
  "https://api.example.test/webhooks/wasender/30000000-0000-4000-8000-000000000041";
const lifecycleSession: AdapterLifecycleSession = {
  authority: Redacted.make(
    JSON.stringify({
      sessionCredential: "session-credential",
      webhookVerificationSecret: "webhook-secret",
    }),
  ) as SessionAuthority,
  connectionState: "connecting",
  session:
    "wsl_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG" as LifecycleSessionLocator,
};

const makeLifecycle = (
  overrides: Partial<SessionLifecycle> = {},
): SessionLifecycle => ({
  connectSession: () => Effect.succeed(lifecycleSession),
  createSession: () => Effect.succeed(lifecycleSession),
  deleteSession: () => Effect.succeed({ state: "absent" }),
  disconnectSession: () =>
    Effect.succeed({ ...lifecycleSession, connectionState: "disconnected" }),
  getQrCode: () => Effect.succeed({ state: "not_available" }),
  listSessions: () => Effect.succeed([lifecycleSession]),
  reconcileSession: () =>
    Effect.succeed({ outcome: "present", session: lifecycleSession }),
  repairSessionConfiguration: () => Effect.succeed(lifecycleSession),
  verifySessionNumber: () => Effect.succeed({ outcome: "match" as const }),
  ...overrides,
});

describe("provider-control RPC authority", () => {
  test("serializes protected lifecycle values for the API binding only", async () => {
    const events: ProviderControlRpcTelemetryEvent[] = [];
    const rpc = makeProviderControlRpc({
      loadLifecycle: async () => makeLifecycle(),
      telemetry: (event) => {
        events.push(event);
      },
    });

    const result = await rpc.createSession({
      phoneNumber: "+15550123456",
      setupMarker,
      webhookUrl,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected successful lifecycle result");
    expect(result.value).toEqual({
      authority:
        '{"sessionCredential":"session-credential","webhookVerificationSecret":"webhook-secret"}',
      connectionState: "connecting",
      session: "wsl_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
    } satisfies LifecycleSession);
    expect(events).toEqual([
      {
        durationMs: expect.any(Number),
        event: "provider_control.rpc.completed",
        method: "createSession",
        outcome: "success",
        service: "provider-control",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("session-credential");
    expect(JSON.stringify(events)).not.toContain("+15550123456");
    expect(JSON.stringify(events)).not.toContain(setupMarker);
  });

  test("passes protected webhook and connect-readiness reconciliation requirements", async () => {
    let reconciledWebhookEndpoint: string | null = null;
    let reconciledConnectReadiness = false;
    const rpc = makeProviderControlRpc({
      loadLifecycle: async () =>
        makeLifecycle({
          reconcileSession: ({ requireConnectReady, webhookEndpoint }) => {
            reconciledConnectReadiness = requireConnectReady === true;
            reconciledWebhookEndpoint =
              webhookEndpoint === undefined
                ? null
                : Redacted.value(webhookEndpoint);
            return Effect.succeed({
              outcome: "present",
              session: lifecycleSession,
            });
          },
        }),
    });

    const result = await rpc.reconcileSession({
      requireConnectReady: true,
      setupMarker,
      webhookUrl,
    });

    expect(result.ok).toBe(true);
    expect(reconciledConnectReadiness).toBe(true);
    expect(reconciledWebhookEndpoint).toBe(webhookUrl);
  });

  test("passes the expected number into session verification without exposing it in telemetry", async () => {
    let verifiedPhoneNumber: string | null = null;
    const events: ProviderControlRpcTelemetryEvent[] = [];
    const rpc = makeProviderControlRpc({
      loadLifecycle: async () =>
        makeLifecycle({
          verifySessionNumber: ({ phoneNumber }) => {
            verifiedPhoneNumber = Redacted.value(phoneNumber);
            return Effect.succeed({ outcome: "mismatch" as const });
          },
        }),
      telemetry: (event) => {
        events.push(event);
      },
    });

    const result = await rpc.verifySessionNumber({
      phoneNumber: "+15550123456",
      session: lifecycleSession.session,
    });

    expect(result).toEqual({ ok: true, value: { outcome: "mismatch" } });
    expect(verifiedPhoneNumber).toBe("+15550123456");
    expect(JSON.stringify(events)).not.toContain("+15550123456");
  });

  test("rejects excess properties without constructing production authority", async () => {
    let loads = 0;
    const rpc = makeProviderControlRpc({
      loadLifecycle: async () => {
        loads += 1;
        return makeLifecycle();
      },
    });

    const result = await rpc.reconcileSession({
      accountCredential: "must-never-be-an-input",
      setupMarker,
    } as never);

    expect(result).toEqual({
      error: {
        _tag: "ProviderControlFailure",
        code: "invalid_request",
        operation: "boundary",
        retryAfterMs: null,
        retryDecision: "do_not_retry",
      },
      ok: false,
    });
    expect(loads).toBe(0);
  });

  test("maps provider failures to a content-free RPC result", async () => {
    const failure: ProviderNeutralFailure = {
      _tag: "ProviderNeutralFailure",
      code: "timed_out",
      operation: "lifecycle-write",
      retryAfterMs: null,
      retryDecision: "reconcile_before_repeat",
    };
    const rpc = makeProviderControlRpc({
      loadLifecycle: async () =>
        makeLifecycle({
          deleteSession: () => Effect.fail(failure),
        }),
    });

    const result = await rpc.deleteSession({
      session: lifecycleSession.session,
    });

    expect(result).toEqual({
      error: {
        ...failure,
        _tag: "ProviderControlFailure",
      },
      ok: false,
    });
  });

  test("contains unexpected adapter defects without leaking their cause", async () => {
    const rpc = makeProviderControlRpc({
      loadLifecycle: async () =>
        makeLifecycle({
          connectSession: () =>
            Effect.die(
              new Error(
                "account-credential-and-provider-response-must-not-cross",
              ),
            ),
        }),
    });

    const result = await rpc.connectSession({
      session: lifecycleSession.session,
    });

    expect(result).toEqual({
      error: {
        _tag: "ProviderControlFailure",
        code: "invalid_response",
        operation: "lifecycle-write",
        retryAfterMs: null,
        retryDecision: "do_not_retry",
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("account-credential");
  });

  test("rejects malformed adapter successes without crossing excess authority", async () => {
    const rpc = makeProviderControlRpc({
      loadLifecycle: async () =>
        makeLifecycle({
          connectSession: () =>
            Effect.succeed({
              ...lifecycleSession,
              accountCredential: "must-not-cross-the-binding",
            } as never),
          deleteSession: () =>
            Effect.succeed({
              accountCredential: "must-not-cross-the-binding",
              state: "absent",
            } as never),
          getQrCode: () =>
            Effect.succeed({
              image: new Uint8Array(),
              state: "available",
            } as never),
          listSessions: () =>
            Effect.succeed({
              accountCredential: "must-not-cross-the-binding",
            } as never),
          reconcileSession: () =>
            Effect.succeed({
              outcome: "duplicates",
              sessions: [lifecycleSession],
            } as never),
        }),
    });

    const results = await Promise.all([
      rpc.connectSession({ session: lifecycleSession.session }),
      rpc.deleteSession({ session: lifecycleSession.session }),
      rpc.getQrCode({ session: lifecycleSession.session }),
      rpc.listSessions({ setupMarker }),
      rpc.reconcileSession({ setupMarker }),
    ]);

    const invalidResponse = (operation: "lifecycle-write" | "safe-read") => ({
      error: {
        _tag: "ProviderControlFailure" as const,
        code: "invalid_response" as const,
        operation,
        retryAfterMs: null,
        retryDecision: "do_not_retry" as const,
      },
      ok: false as const,
    });
    expect(results).toEqual([
      invalidResponse("lifecycle-write"),
      invalidResponse("lifecycle-write"),
      invalidResponse("safe-read"),
      invalidResponse("safe-read"),
      invalidResponse("safe-read"),
    ]);
    expect(JSON.stringify(results)).not.toContain("must-not-cross");
  });

  test("rejects retry metadata that does not match the operation class", async () => {
    const rpc = makeProviderControlRpc({
      loadLifecycle: async () =>
        makeLifecycle({
          connectSession: () =>
            Effect.fail({
              _tag: "ProviderNeutralFailure",
              code: "timed_out",
              operation: "lifecycle-write",
              retryAfterMs: 1,
              retryDecision: "retry_within_safe_read_budget",
            } as never),
          listSessions: () =>
            Effect.fail({
              _tag: "ProviderNeutralFailure",
              code: "timed_out",
              operation: "safe-read",
              retryAfterMs: null,
              retryDecision: "reconcile_before_repeat",
            } as never),
        }),
    });

    const [write, read] = await Promise.all([
      rpc.connectSession({ session: lifecycleSession.session }),
      rpc.listSessions({ setupMarker }),
    ]);

    expect(write).toEqual({
      error: {
        _tag: "ProviderControlFailure",
        code: "invalid_response",
        operation: "lifecycle-write",
        retryAfterMs: null,
        retryDecision: "do_not_retry",
      },
      ok: false,
    });
    expect(read).toEqual({
      error: {
        _tag: "ProviderControlFailure",
        code: "invalid_response",
        operation: "safe-read",
        retryAfterMs: null,
        retryDecision: "do_not_retry",
      },
      ok: false,
    });
  });

  test("exposes every lifecycle method through the same validated authority", async () => {
    const rpc = makeProviderControlRpc({
      loadLifecycle: async () => makeLifecycle(),
    });

    const [
      connected,
      disconnected,
      listed,
      qr,
      reconciled,
      repaired,
      verified,
      deleted,
    ] = await Promise.all([
      rpc.connectSession({ session: lifecycleSession.session }),
      rpc.disconnectSession({ session: lifecycleSession.session }),
      rpc.listSessions({ setupMarker }),
      rpc.getQrCode({ session: lifecycleSession.session }),
      rpc.reconcileSession({ setupMarker }),
      rpc.repairSessionConfiguration({ setupMarker, webhookUrl }),
      rpc.verifySessionNumber({
        phoneNumber: "+15550123456",
        session: lifecycleSession.session,
      }),
      rpc.deleteSession({ session: lifecycleSession.session }),
    ]);

    expect(connected.ok).toBe(true);
    expect(repaired.ok).toBe(true);
    expect(disconnected).toMatchObject({
      ok: true,
      value: { connectionState: "disconnected" },
    });
    expect(listed).toEqual({
      ok: true,
      value: [
        {
          authority:
            '{"sessionCredential":"session-credential","webhookVerificationSecret":"webhook-secret"}',
          connectionState: "connecting",
          session: lifecycleSession.session,
        },
      ],
    });
    expect(qr).toEqual({
      ok: true,
      value: { state: "not_available" },
    });
    expect(reconciled.ok).toBe(true);
    expect(verified).toEqual({ ok: true, value: { outcome: "match" } });
    expect(deleted).toEqual({
      ok: true,
      value: { state: "absent" },
    });
  });

  test("rejects malformed phone numbers and opaque locators before loading authority", async () => {
    let loads = 0;
    const rpc = makeProviderControlRpc({
      loadLifecycle: async () => {
        loads += 1;
        return makeLifecycle();
      },
    });

    const [created, connected] = await Promise.all([
      rpc.createSession({
        phoneNumber: "15550123456",
        setupMarker,
        webhookUrl,
      }),
      rpc.connectSession({ session: "41" }),
    ]);

    expect(created.ok).toBe(false);
    expect(connected.ok).toBe(false);
    expect(loads).toBe(0);
  });
});
