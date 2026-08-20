import type {
  ConnectionSetupCleanupState,
  ConnectionSetupState,
} from "./first-connection-onboarding";

export type ConnectionSetupObservationPhase =
  | "setup_to_code"
  | "linking_to_active";

const minimumPollDelayMsByState: Readonly<
  Partial<Record<ConnectionSetupState, number>>
> = {
  connecting: 250,
  pending: 250,
  provisioned: 250,
  qr_available: 2_000,
  replayed: 250,
};

const maximumPollDelayMsByState: Readonly<
  Partial<Record<ConnectionSetupState, number>>
> = {
  connecting: 1_500,
  pending: 1_000,
  provisioned: 1_000,
  qr_available: 5_000,
  replayed: 1_000,
};

export const nextConnectionSetupPollDelayMs = (
  state: ConnectionSetupState,
  attempt: number,
): number => {
  const minimumDelay = minimumPollDelayMsByState[state] ?? 750;
  const maximumDelay = maximumPollDelayMsByState[state] ?? minimumDelay;
  const normalizedAttempt = Number.isFinite(attempt) ? Math.max(0, attempt) : 0;
  return Math.min(maximumDelay, minimumDelay + normalizedAttempt * 250);
};

export const observationMetricDurationMs = (
  startedAtMs: number | null,
  finishedAtMs: number,
): number | null => {
  if (
    startedAtMs === null ||
    !Number.isFinite(startedAtMs) ||
    !Number.isFinite(finishedAtMs) ||
    finishedAtMs < startedAtMs
  ) {
    return null;
  }
  return Math.max(0, Math.round(finishedAtMs - startedAtMs));
};

export const connectionSetupStatusText = (
  setupState: ConnectionSetupState,
  cleanupState: ConnectionSetupCleanupState | null,
): string => {
  if (setupState === "loading") return "Starting Connection Setup.";
  if (setupState === "unavailable") {
    return "Connection Setup is temporarily unavailable.";
  }
  if (setupState === "pending") {
    return "Connection Setup started. Normal is preparing your code to link WhatsApp.";
  }
  if (setupState === "replayed") {
    return "Connection Setup already started. Normal is preparing your code to link WhatsApp.";
  }
  if (setupState === "qr_available") {
    return "Scan this code with WhatsApp. Normal will confirm as soon as WhatsApp finishes linking.";
  }
  if (setupState === "connecting") {
    return "WhatsApp accepted the scan. Waiting for it to finish connecting.";
  }
  if (setupState === "connected") return "WhatsApp Connection active.";
  if (setupState === "provisioned") return "Connection Setup is ready.";
  if (setupState === "provider_capacity_unavailable") {
    return "WhatsApp Connection capacity is temporarily unavailable. Please try again later.";
  }
  if (setupState === "provisioning_failed") {
    return "Connection Setup could not be prepared.";
  }
  if (setupState === "provisioning_quarantined") {
    return "Connection Setup needs support review.";
  }
  if (setupState === "cancelling") return "Cancelling Connection Setup.";
  if (setupState === "cancelled") {
    return cleanupState === "complete"
      ? "Connection Setup cancelled. Provider cleanup is complete."
      : cleanupState === "retrying"
        ? "Connection Setup cancelled. Provider cleanup is retrying."
        : "Connection Setup cancelled. Provider cleanup is in progress.";
  }
  if (setupState === "expired") {
    return cleanupState === "complete"
      ? "Connection Setup expired. Provider cleanup is complete."
      : cleanupState === "retrying"
        ? "Connection Setup expired. Provider cleanup is retrying."
        : "Connection Setup expired. Provider cleanup is in progress.";
  }
  if (setupState === "number_unavailable") {
    return "That WhatsApp Number is already in use.";
  }
  if (setupState === "connection_limit_reached") {
    return "Your Personal Account already has three active setup or Connection slots.";
  }
  if (setupState === "invalid") {
    return "Enter a valid international WhatsApp Number.";
  }
  return "";
};
