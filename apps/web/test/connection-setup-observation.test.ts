import { describe, expect, test } from "bun:test";
import {
  connectionSetupStatusText,
  nextConnectionSetupPollDelayMs,
  observationMetricDurationMs,
} from "../src/app/connection-setup-observation";

describe("connection setup observation policy", () => {
  test("backs off quickly while Normal is preparing the QR code", () => {
    expect(nextConnectionSetupPollDelayMs("pending", 0)).toBe(250);
    expect(nextConnectionSetupPollDelayMs("pending", 1)).toBe(500);
    expect(nextConnectionSetupPollDelayMs("pending", 8)).toBe(1_000);
  });

  test("polls more slowly while waiting for the QR scan", () => {
    expect(nextConnectionSetupPollDelayMs("qr_available", 0)).toBe(1_000);
    expect(nextConnectionSetupPollDelayMs("qr_available", 2)).toBe(1_500);
    expect(nextConnectionSetupPollDelayMs("qr_available", 8)).toBe(2_000);
  });

  test("keeps scan-to-active polling responsive but bounded", () => {
    expect(nextConnectionSetupPollDelayMs("connecting", 0)).toBe(250);
    expect(nextConnectionSetupPollDelayMs("connecting", 3)).toBe(1_000);
    expect(nextConnectionSetupPollDelayMs("connecting", 9)).toBe(1_500);
  });

  test("measures only non-negative observation durations", () => {
    expect(observationMetricDurationMs(100, 540)).toBe(440);
    expect(observationMetricDurationMs(null, 540)).toBeNull();
    expect(observationMetricDurationMs(600, 540)).toBeNull();
  });

  test("uses realistic waiting copy for the visible setup states", () => {
    expect(connectionSetupStatusText("pending", null)).toBe(
      "Connection Setup started. Normal is preparing your code to link WhatsApp.",
    );
    expect(connectionSetupStatusText("qr_available", null)).toBe(
      "Scan this code with WhatsApp. Normal will confirm as soon as WhatsApp finishes linking.",
    );
    expect(connectionSetupStatusText("connecting", null)).toBe(
      "WhatsApp accepted the scan. Waiting for it to finish connecting.",
    );
  });
});
