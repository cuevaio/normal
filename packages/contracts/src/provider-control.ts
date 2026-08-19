import { Schema } from "effect";

const SetupMarker = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{1,128}$/u),
);
const SessionLocator = Schema.String.pipe(
  Schema.pattern(/^wsl_[A-Za-z0-9_-]{43}$/u),
);
const WhatsAppNumber = Schema.String.pipe(Schema.pattern(/^\+[1-9]\d{7,14}$/u));
const WebhookUrl = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        /^\/webhooks\/wasender\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          url.pathname,
        ) &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  }),
);

const ReconcileSessionRequest = Schema.Struct({
  setupMarker: SetupMarker,
  webhookUrl: Schema.optional(WebhookUrl),
});
const RepairSessionConfigurationRequest = Schema.Struct({
  setupMarker: SetupMarker,
  webhookUrl: WebhookUrl,
});
const ListSessionsRequest = Schema.Struct({
  setupMarker: SetupMarker,
});
const CreateSessionRequest = Schema.Struct({
  phoneNumber: WhatsAppNumber,
  setupMarker: SetupMarker,
  webhookUrl: WebhookUrl,
});
const SessionRequest = Schema.Struct({
  session: SessionLocator,
});
const VerifySessionNumberRequest = Schema.Struct({
  phoneNumber: WhatsAppNumber,
  session: SessionLocator,
});

const strictDecode = <A, I>(schema: Schema.Schema<A, I>) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });

export const decodeReconcileSessionRequest = strictDecode(
  ReconcileSessionRequest,
);
export const decodeRepairSessionConfigurationRequest = strictDecode(
  RepairSessionConfigurationRequest,
);
export const decodeListSessionsRequest = strictDecode(ListSessionsRequest);
export const decodeCreateSessionRequest = strictDecode(CreateSessionRequest);
export const decodeConnectSessionRequest = strictDecode(SessionRequest);
export const decodeDisconnectSessionRequest = strictDecode(SessionRequest);
export const decodeGetQrCodeRequest = strictDecode(SessionRequest);
export const decodeDeleteSessionRequest = strictDecode(SessionRequest);
export const decodeVerifySessionNumberRequest = strictDecode(
  VerifySessionNumberRequest,
);

export interface ReconcileSessionRequest {
  readonly setupMarker: string;
  readonly webhookUrl?: string | undefined;
}
export interface RepairSessionConfigurationRequest {
  readonly setupMarker: string;
  readonly webhookUrl: string;
}

export interface ListSessionsRequest {
  readonly setupMarker: string;
}

export interface CreateSessionRequest {
  readonly phoneNumber: string;
  readonly setupMarker: string;
  readonly webhookUrl: string;
}

export interface SessionRequest {
  readonly session: string;
}

export interface VerifySessionNumberRequest {
  readonly phoneNumber: string;
  readonly session: string;
}

export type LifecycleConnectionState =
  | "connected"
  | "connecting"
  | "degraded"
  | "disconnected"
  | "reconnect_required";

/**
 * `authority` is per-session authority, never the account-level Provider API
 * Credential. The API Worker must envelope-encrypt it before persistence.
 */
export interface LifecycleSession {
  readonly authority: string;
  readonly connectionState: LifecycleConnectionState;
  readonly session: string;
}

export type SessionReconciliation =
  | {
      readonly outcome: "absent";
    }
  | {
      readonly outcome: "present";
      readonly session: LifecycleSession;
    }
  | {
      readonly outcome: "duplicates";
      readonly sessions: readonly [
        LifecycleSession,
        LifecycleSession,
        ...ReadonlyArray<LifecycleSession>,
      ];
    };

export type QrCodeObservation =
  | {
      readonly state: "not_available";
    }
  | {
      readonly expiresAt: string | null;
      readonly image: Uint8Array;
      readonly state: "available";
    };

export interface SessionDeletionObservation {
  readonly state: "absent" | "present";
}

export interface SessionNumberVerification {
  readonly outcome: "match" | "mismatch" | "unverified";
}

export type ProviderControlFailureCode =
  | "authentication_failed"
  | "configuration_invalid"
  | "integrity_failed"
  | "invalid_request"
  | "invalid_response"
  | "response_too_large"
  | "source_rejected"
  | "throttled"
  | "timed_out"
  | "unavailable";

export type ProviderControlOperation =
  | "boundary"
  | "lifecycle-write"
  | "safe-read";

export type ProviderControlRetryDecision =
  | "do_not_retry"
  | "reconcile_before_repeat"
  | "retry_within_safe_read_budget";

export interface ProviderControlFailure {
  readonly _tag: "ProviderControlFailure";
  readonly code: ProviderControlFailureCode;
  readonly operation: ProviderControlOperation;
  readonly retryAfterMs: number | null;
  readonly retryDecision: ProviderControlRetryDecision;
}

export type ProviderControlResult<Value> =
  | {
      readonly ok: true;
      readonly value: Value;
    }
  | {
      readonly error: ProviderControlFailure;
      readonly ok: false;
    };

export type ProviderControlRpcMethod =
  | "connectSession"
  | "createSession"
  | "deleteSession"
  | "disconnectSession"
  | "getQrCode"
  | "listSessions"
  | "repairSessionConfiguration"
  | "reconcileSession"
  | "verifySessionNumber";

export interface ProviderControlRpcTelemetryEvent {
  readonly durationMs: number;
  readonly event: "provider_control.rpc.completed";
  readonly method: ProviderControlRpcMethod;
  readonly outcome: "success" | ProviderControlFailureCode;
  readonly service: "provider-control";
}

export interface ProviderControlService {
  readonly connectSession: (
    request: SessionRequest,
  ) => Promise<ProviderControlResult<LifecycleSession>>;
  readonly createSession: (
    request: CreateSessionRequest,
  ) => Promise<ProviderControlResult<LifecycleSession>>;
  readonly deleteSession: (
    request: SessionRequest,
  ) => Promise<ProviderControlResult<SessionDeletionObservation>>;
  readonly disconnectSession: (
    request: SessionRequest,
  ) => Promise<ProviderControlResult<LifecycleSession>>;
  readonly getQrCode: (
    request: SessionRequest,
  ) => Promise<ProviderControlResult<QrCodeObservation>>;
  readonly listSessions: (
    request: ListSessionsRequest,
  ) => Promise<ProviderControlResult<ReadonlyArray<LifecycleSession>>>;
  readonly reconcileSession: (
    request: ReconcileSessionRequest,
  ) => Promise<ProviderControlResult<SessionReconciliation>>;
  readonly repairSessionConfiguration: (
    request: RepairSessionConfigurationRequest,
  ) => Promise<ProviderControlResult<LifecycleSession>>;
  readonly verifySessionNumber: (
    request: VerifySessionNumberRequest,
  ) => Promise<ProviderControlResult<SessionNumberVerification>>;
}
