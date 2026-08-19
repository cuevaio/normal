import { describe, expect, test } from "bun:test";
import {
  nextConnectionSetupPollDelayMs,
  observationMetricDurationMs,
} from "../src/app/connection-setup-observation";

describe("connection setup observation policy", () => {
  test("uses a fast first poll and bounded backoff while waiting for state changes", () => {
    expect(nextConnectionSetupPollDelayMs("pending", 0)).toBe(250);
    expect(nextConnectionSetupPollDelayMs("pending", 1)).toBe(500);
    expect(nextConnectionSetupPollDelayMs("pending", 4)).toBe(1_000);
    expect(nextConnectionSetupPollDelayMs("qr_available", 0)).toBe(250);
    expect(nextConnectionSetupPollDelayMs("qr_available", 3)).toBe(1_000);
    expect(nextConnectionSetupPollDelayMs("qr_available", 20)).toBe(2_000);
    expect(nextConnectionSetupPollDelayMs("connecting", 20)).toBe(2_000);
  });

  test("rounds anonymous timing metrics and rejects invalid durations", () => {
    expect(observationMetricDurationMs(100.1, 450.6)).toBe(351);
    expect(observationMetricDurationMs(null, 450.6)).toBeNull();
    expect(observationMetricDurationMs(500, 450.6)).toBeNull();
  });

  test("meets the deterministic first-party observation target", () => {
    const transitionsMs = [
      0, 50, 100, 150, 200, 250, 300, 400, 500, 625, 750, 900, 1_000, 1_250,
      1_500, 2_000, 3_000, 5_000,
    ];
    const lags = (delayForAttempt: (attempt: number) => number) =>
      transitionsMs.map((transitionAt) => {
        let observedAt = 0;
        let attempt = 0;
        while (observedAt < transitionAt) {
          observedAt += delayForAttempt(attempt);
          attempt += 1;
        }
        return observedAt - transitionAt;
      });
    const percentile = (values: ReadonlyArray<number>, proportion: number) =>
      values.toSorted((left, right) => left - right)[
        Math.ceil(values.length * proportion) - 1
      ];
    const percentiles = (values: ReadonlyArray<number>) =>
      [0.5, 0.95, 0.99].map((proportion) => percentile(values, proportion));

    expect(percentiles(lags(() => 750))).toEqual([250, 700, 700]);
    expect(
      percentiles(
        lags((attempt) => nextConnectionSetupPollDelayMs("pending", attempt)),
      ),
    ).toEqual([200, 600, 600]);
    expect(
      percentiles(
        lags((attempt) =>
          nextConnectionSetupPollDelayMs("qr_available", attempt),
        ),
      ),
    ).toEqual([200, 750, 750]);
  });
});
