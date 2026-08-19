import { Context } from "effect";
import type {
  AdapterEffect,
  AdapterReference,
  ProtectedAdapterValue,
  UtcTimestamp,
} from "./common";
import { maximumJsonResponseBytes } from "./common";

export type {
  AdapterFailureCode,
  BoundedRetryAfterMs,
  OperationClass,
  ProviderNeutralFailure,
  RetryDecision,
} from "./common";
export { makeBoundedRetryAfterMs, maximumJsonResponseBytes } from "./common";

declare const setupMarker: unique symbol;

export type SetupMarker = string & {
  readonly [setupMarker]: "SetupMarker";
};
export type LifecycleSessionLocator =
  AdapterReference<"LifecycleSessionLocator">;
export type SessionAuthority = ProtectedAdapterValue<"SessionAuthority">;
export type WhatsAppNumber = ProtectedAdapterValue<"WhatsAppNumber">;
export type WebhookEndpoint = ProtectedAdapterValue<"WebhookEndpoint">;

export type LifecycleConnectionState =
  | "connected"
  | "connecting"
  | "degraded"
  | "disconnected"
  | "reconnect_required";

export interface LifecycleSession {
  /**
   * Log-safe session authority. The owning Worker envelope-encrypts the value
   * before persistence and supplies it only to a per-session adapter Layer.
   */
  readonly authority: SessionAuthority;
  readonly connectionState: LifecycleConnectionState;
  /**
   * An adapter-produced locator, never a raw Wasender session identifier.
   */
  readonly session: LifecycleSessionLocator;
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
      readonly expiresAt: UtcTimestamp | null;
      readonly image: Uint8Array;
      readonly state: "available";
    };

export type SessionNumberVerification =
  | {
      readonly outcome: "match";
    }
  | {
      readonly outcome: "mismatch";
    }
  | {
      readonly outcome: "unverified";
    };

export interface SessionDeletionObservation {
  /**
   * A present result requires another reconciliation before delete is repeated.
   */
  readonly state: "absent" | "present";
}

/**
 * Account-level lifecycle authority. A production Layer is configured with the
 * Provider API Credential; the credential is never a method input or output.
 */
export interface SessionLifecycle {
  readonly listSessions: (request: {
    readonly setupMarker: SetupMarker;
  }) => AdapterEffect<ReadonlyArray<LifecycleSession>>;
  readonly createSession: (request: {
    readonly phoneNumber: WhatsAppNumber;
    readonly setupMarker: SetupMarker;
    readonly webhookEndpoint: WebhookEndpoint;
  }) => AdapterEffect<LifecycleSession>;
  readonly connectSession: (request: {
    readonly session: LifecycleSessionLocator;
  }) => AdapterEffect<LifecycleSession>;
  readonly disconnectSession: (request: {
    readonly session: LifecycleSessionLocator;
  }) => AdapterEffect<LifecycleSession>;
  readonly getQrCode: (request: {
    readonly session: LifecycleSessionLocator;
  }) => AdapterEffect<QrCodeObservation>;
  readonly verifySessionNumber: (request: {
    readonly phoneNumber: WhatsAppNumber;
    readonly session: LifecycleSessionLocator;
  }) => AdapterEffect<SessionNumberVerification>;
  readonly reconcileSession: (request: {
    readonly setupMarker: SetupMarker;
    readonly webhookEndpoint?: WebhookEndpoint | undefined;
  }) => AdapterEffect<SessionReconciliation>;
  readonly repairSessionConfiguration: (request: {
    readonly setupMarker: SetupMarker;
    readonly webhookEndpoint: WebhookEndpoint;
  }) => AdapterEffect<LifecycleSession>;
  readonly deleteSession: (request: {
    readonly session: LifecycleSessionLocator;
  }) => AdapterEffect<SessionDeletionObservation>;
}

export const SessionLifecycle = Context.GenericTag<SessionLifecycle>(
  "@whatsapp-mcp/wasender/SessionLifecycle",
);

export const lifecycleWritePolicy = {
  ambiguity: "provider-state-may-have-changed",
  attemptTimeoutMs: 15_000,
  maxAttemptsBeforeReconciliation: 1,
  maxResponseBytes: maximumJsonResponseBytes,
  operationClass: "lifecycle-write",
  reconciliation: "required-before-repeat",
  repeatStrategy: "reconcile-before-repeat",
} as const;

export {
  makeWasenderSessionLifecycle,
  makeWasenderSessionLifecycleLayer,
  type WasenderLifecycleConfig,
  type WasenderLifecycleDependencies,
  type WasenderLifecycleTelemetryEvent,
} from "./control-wasender";
