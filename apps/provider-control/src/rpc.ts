import {
  decodeConnectSessionRequest,
  decodeCreateSessionRequest,
  decodeDeleteSessionRequest,
  decodeDisconnectSessionRequest,
  decodeGetQrCodeRequest,
  decodeListSessionsRequest,
  decodeReconcileSessionRequest,
  decodeRepairSessionConfigurationRequest,
  type LifecycleSession,
  type ProviderControlFailure,
  type ProviderControlFailureCode,
  type ProviderControlResult,
  type ProviderControlRpcMethod,
  type ProviderControlRpcTelemetryEvent,
  type ProviderControlService,
  type QrCodeObservation,
  type SessionDeletionObservation,
  type SessionReconciliation,
} from "@whatsapp-mcp/contracts/provider-control";
import {
  maximumJsonResponseBytes,
  type ProviderNeutralFailure,
  type SessionLifecycle,
  type SetupMarker,
  type WebhookEndpoint,
  type WhatsAppNumber,
} from "@whatsapp-mcp/wasender/control";
import { Effect, Either, Redacted } from "effect";

export interface ProviderControlRpcOptions {
  readonly loadLifecycle: () => Promise<SessionLifecycle>;
  readonly telemetry?: (
    event: ProviderControlRpcTelemetryEvent,
  ) => void | Promise<void>;
}

const boundaryFailure = (
  code: "configuration_invalid" | "invalid_request",
): ProviderControlFailure => ({
  _tag: "ProviderControlFailure",
  code,
  operation: "boundary",
  retryAfterMs: null,
  retryDecision: "do_not_retry",
});

const invalidResponseFailure = (
  operation: "lifecycle-write" | "safe-read",
): ProviderControlFailure => ({
  _tag: "ProviderControlFailure",
  code: "invalid_response",
  operation,
  retryAfterMs: null,
  retryDecision: "do_not_retry",
});

const providerFailureCodes = new Set<ProviderNeutralFailure["code"]>([
  "authentication_failed",
  "integrity_failed",
  "invalid_response",
  "response_too_large",
  "source_rejected",
  "throttled",
  "timed_out",
  "unavailable",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hasExactlyKeys = (
  value: Record<string, unknown>,
  keys: ReadonlyArray<string>,
) => {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
};

const normalizeProviderFailure = (
  value: unknown,
  operation: "lifecycle-write" | "safe-read",
): ProviderControlFailure | null => {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "_tag",
      "code",
      "operation",
      "retryAfterMs",
      "retryDecision",
    ]) ||
    value._tag !== "ProviderNeutralFailure" ||
    !providerFailureCodes.has(value.code as ProviderNeutralFailure["code"]) ||
    value.operation !== operation
  ) {
    return null;
  }

  if (operation === "lifecycle-write") {
    if (
      value.retryAfterMs !== null ||
      (value.retryDecision !== "do_not_retry" &&
        value.retryDecision !== "reconcile_before_repeat")
    ) {
      return null;
    }
    return {
      _tag: "ProviderControlFailure",
      code: value.code as ProviderNeutralFailure["code"],
      operation,
      retryAfterMs: null,
      retryDecision: value.retryDecision,
    };
  }

  if (
    !(
      value.retryAfterMs === null ||
      (Number.isSafeInteger(value.retryAfterMs) &&
        (value.retryAfterMs as number) >= 0 &&
        (value.retryAfterMs as number) <= 5_000)
    ) ||
    (value.retryDecision !== "do_not_retry" &&
      value.retryDecision !== "retry_within_safe_read_budget")
  ) {
    return null;
  }
  return {
    _tag: "ProviderControlFailure",
    code: value.code as ProviderNeutralFailure["code"],
    operation,
    retryAfterMs: value.retryAfterMs as number | null,
    retryDecision: value.retryDecision,
  };
};

const providerFailure = (
  value: unknown,
  operation: "lifecycle-write" | "safe-read",
): ProviderControlFailure =>
  normalizeProviderFailure(value, operation) ??
  invalidResponseFailure(operation);

const lifecycleSession = (
  value: unknown,
  operation: "lifecycle-write" | "safe-read",
): LifecycleSession => {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ["authority", "connectionState", "session"])
  ) {
    throw invalidResponseFailure(operation);
  }

  let authority: unknown;
  try {
    authority = Redacted.value(value.authority as never);
  } catch {
    throw invalidResponseFailure(operation);
  }
  if (
    typeof authority !== "string" ||
    authority.length === 0 ||
    authority.length > 8_192 ||
    typeof value.connectionState !== "string" ||
    ![
      "connected",
      "connecting",
      "degraded",
      "disconnected",
      "reconnect_required",
    ].includes(value.connectionState) ||
    typeof value.session !== "string" ||
    !/^wsl_[A-Za-z0-9_-]{43}$/u.test(value.session)
  ) {
    throw invalidResponseFailure(operation);
  }
  return {
    authority,
    connectionState:
      value.connectionState as LifecycleSession["connectionState"],
    session: value.session as string,
  };
};

const deletionObservation = (value: unknown): SessionDeletionObservation => {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ["state"]) ||
    (value.state !== "absent" && value.state !== "present")
  ) {
    throw invalidResponseFailure("lifecycle-write");
  }
  return { state: value.state };
};

const qrCodeObservation = (value: unknown): QrCodeObservation => {
  if (!isRecord(value)) throw invalidResponseFailure("safe-read");
  if (value.state === "not_available" && hasExactlyKeys(value, ["state"])) {
    return { state: "not_available" };
  }
  if (
    value.state !== "available" ||
    !hasExactlyKeys(value, ["expiresAt", "image", "state"]) ||
    (value.expiresAt !== null &&
      (typeof value.expiresAt !== "string" ||
        value.expiresAt.length === 0 ||
        value.expiresAt.length > 64)) ||
    !(value.image instanceof Uint8Array) ||
    value.image.byteLength > maximumJsonResponseBytes
  ) {
    throw invalidResponseFailure("safe-read");
  }
  return {
    expiresAt: value.expiresAt,
    image: value.image,
    state: "available",
  };
};

const reconciliationObservation = (value: unknown): SessionReconciliation => {
  if (!isRecord(value)) throw invalidResponseFailure("safe-read");
  switch (value.outcome) {
    case "absent":
      if (!hasExactlyKeys(value, ["outcome"])) {
        throw invalidResponseFailure("safe-read");
      }
      return { outcome: "absent" };
    case "present":
      if (!hasExactlyKeys(value, ["outcome", "session"])) {
        throw invalidResponseFailure("safe-read");
      }
      return {
        outcome: "present",
        session: lifecycleSession(value.session, "safe-read"),
      };
    case "duplicates": {
      if (
        !hasExactlyKeys(value, ["outcome", "sessions"]) ||
        !Array.isArray(value.sessions) ||
        value.sessions.length < 2
      ) {
        throw invalidResponseFailure("safe-read");
      }
      const sessions = value.sessions.map((session) =>
        lifecycleSession(session, "safe-read"),
      ) as [LifecycleSession, LifecycleSession, ...LifecycleSession[]];
      return { outcome: "duplicates", sessions };
    }
    default:
      throw invalidResponseFailure("safe-read");
  }
};

const success = <Value>(value: Value): ProviderControlResult<Value> => ({
  ok: true,
  value,
});

const failure = <Value>(
  error: ProviderControlFailure,
): ProviderControlResult<Value> => ({
  error,
  ok: false,
});

export const makeProviderControlRpc = (
  options: ProviderControlRpcOptions,
): ProviderControlService => {
  const emit = async (
    method: ProviderControlRpcMethod,
    outcome: "success" | ProviderControlFailureCode,
    durationMs: number,
  ) => {
    try {
      await options.telemetry?.({
        durationMs,
        event: "provider_control.rpc.completed",
        method,
        outcome,
        service: "provider-control",
      });
    } catch {
      // Telemetry is deliberately non-authoritative for lifecycle calls.
    }
  };

  const invoke = async <Request, Value, Output>(
    method: ProviderControlRpcMethod,
    input: unknown,
    decode: (input: unknown) => Request,
    operation: "lifecycle-write" | "safe-read",
    run: (
      lifecycle: SessionLifecycle,
      request: Request,
    ) => Effect.Effect<Value, unknown>,
    map: (value: Value) => Output,
  ): Promise<ProviderControlResult<Output>> => {
    const startedAt = performance.now();
    const durationMs = () =>
      Math.max(0, Math.round(performance.now() - startedAt));
    let request: Request;
    try {
      request = decode(input);
    } catch {
      const error = boundaryFailure("invalid_request");
      await emit(method, error.code, durationMs());
      return failure(error);
    }

    let lifecycle: SessionLifecycle;
    try {
      lifecycle = await options.loadLifecycle();
    } catch {
      const error = boundaryFailure("configuration_invalid");
      await emit(method, error.code, durationMs());
      return failure(error);
    }

    let result: Either.Either<Value, unknown>;
    try {
      result = await Effect.runPromise(Effect.either(run(lifecycle, request)));
    } catch {
      const error = invalidResponseFailure(operation);
      await emit(method, error.code, durationMs());
      return failure(error);
    }
    if (Either.isLeft(result)) {
      const error = providerFailure(result.left, operation);
      await emit(method, error.code, durationMs());
      return failure(error);
    }

    try {
      const output = map(result.right);
      await emit(method, "success", durationMs());
      return success(output);
    } catch {
      const error = invalidResponseFailure(operation);
      await emit(method, error.code, durationMs());
      return failure(error);
    }
  };

  return {
    connectSession: (input) =>
      invoke(
        "connectSession",
        input,
        decodeConnectSessionRequest,
        "lifecycle-write",
        (lifecycle, request) =>
          lifecycle.connectSession({
            session: request.session as never,
          }),
        (value) => lifecycleSession(value, "lifecycle-write"),
      ),
    createSession: (input) =>
      invoke(
        "createSession",
        input,
        decodeCreateSessionRequest,
        "lifecycle-write",
        (lifecycle, request) =>
          lifecycle.createSession({
            phoneNumber: Redacted.make(request.phoneNumber) as WhatsAppNumber,
            setupMarker: request.setupMarker as SetupMarker,
            webhookEndpoint: Redacted.make(
              request.webhookUrl,
            ) as WebhookEndpoint,
          }),
        (value) => lifecycleSession(value, "lifecycle-write"),
      ),
    deleteSession: (input) =>
      invoke(
        "deleteSession",
        input,
        decodeDeleteSessionRequest,
        "lifecycle-write",
        (lifecycle, request) =>
          lifecycle.deleteSession({
            session: request.session as never,
          }),
        deletionObservation,
      ),
    disconnectSession: (input) =>
      invoke(
        "disconnectSession",
        input,
        decodeDisconnectSessionRequest,
        "lifecycle-write",
        (lifecycle, request) =>
          lifecycle.disconnectSession({
            session: request.session as never,
          }),
        (value) => lifecycleSession(value, "lifecycle-write"),
      ),
    getQrCode: (input) =>
      invoke(
        "getQrCode",
        input,
        decodeGetQrCodeRequest,
        "safe-read",
        (lifecycle, request) =>
          lifecycle.getQrCode({
            session: request.session as never,
          }),
        qrCodeObservation,
      ),
    listSessions: (input) =>
      invoke(
        "listSessions",
        input,
        decodeListSessionsRequest,
        "safe-read",
        (lifecycle, request) =>
          lifecycle.listSessions({
            setupMarker: request.setupMarker as SetupMarker,
          }),
        (sessions) => {
          if (!Array.isArray(sessions)) {
            throw invalidResponseFailure("safe-read");
          }
          return sessions.map((session) =>
            lifecycleSession(session, "safe-read"),
          );
        },
      ),
    reconcileSession: (input) =>
      invoke(
        "reconcileSession",
        input,
        decodeReconcileSessionRequest,
        "safe-read",
        (lifecycle, request) =>
          lifecycle.reconcileSession({
            setupMarker: request.setupMarker as SetupMarker,
            ...(request.webhookUrl === undefined
              ? {}
              : {
                  webhookEndpoint: Redacted.make(
                    request.webhookUrl,
                  ) as WebhookEndpoint,
                }),
          }),
        reconciliationObservation,
      ),
    repairSessionConfiguration: (input) =>
      invoke(
        "repairSessionConfiguration",
        input,
        decodeRepairSessionConfigurationRequest,
        "lifecycle-write",
        (lifecycle, request) =>
          lifecycle.repairSessionConfiguration({
            setupMarker: request.setupMarker as SetupMarker,
            webhookEndpoint: Redacted.make(
              request.webhookUrl,
            ) as WebhookEndpoint,
          }),
        (value) => lifecycleSession(value, "lifecycle-write"),
      ),
  };
};
