import type { ConnectionSetupState } from "./first-connection-onboarding";

export type ConnectionSetupObservationPhase =
  | "start_to_code_observed"
  | "code_observed_to_active_observed";

const minimumPollDelayMsByState: Readonly<
  Partial<Record<ConnectionSetupState, number>>
> = {
  connecting: 250,
  pending: 250,
  provisioned: 250,
  qr_available: 250,
  replayed: 250,
};

const maximumPollDelayMsByState: Readonly<
  Partial<Record<ConnectionSetupState, number>>
> = {
  connecting: 2_000,
  pending: 1_000,
  provisioned: 1_000,
  qr_available: 2_000,
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
