import { describe, expect, test } from "bun:test";
import {
  loadObservabilityConfig,
  validateObservabilityConfig,
} from "./validate-observability";

describe("production observability configuration", () => {
  test("covers the operational surface with separate availability objectives", async () => {
    const config = await loadObservabilityConfig();
    expect(() => validateObservabilityConfig(config)).not.toThrow();

    expect(config.slos.map(({ id }) => id)).toEqual([
      "first-party-availability",
      "wasender-availability",
      "whatsapp-availability",
    ]);
    expect(config.slos[0]).toMatchObject({ objective: 99.5, window: "7d" });
  });

  test("rejects sensitive dimensions and incomplete alert delivery", async () => {
    const config = await loadObservabilityConfig();
    const unsafe = structuredClone(config);
    unsafe.dashboards[0]?.panels[0]?.groupBy.push("personalAccountId");
    expect(() => validateObservabilityConfig(unsafe)).toThrow(
      "field personalAccountId is not telemetry-allowlisted",
    );

    const invented = structuredClone(config);
    invented.sources.workerTelemetry.fields.push("tenantHash");
    expect(() => validateObservabilityConfig(invented)).toThrow(
      "field tenantHash is not runtime telemetry-allowlisted",
    );

    const sourceLiteralOnly = structuredClone(config);
    sourceLiteralOnly.sources.workerTelemetry.fields.push("telemetry");
    expect(() => validateObservabilityConfig(sourceLiteralOnly)).toThrow(
      "field telemetry is not runtime telemetry-allowlisted",
    );

    const noCanary = structuredClone(config);
    noCanary.delivery.canary.enabled = false;
    expect(() => validateObservabilityConfig(noCanary)).toThrow(
      "production alert delivery canary must be enabled",
    );

    const noDeliveryProof = structuredClone(config) as unknown as {
      delivery: { receiptEvidence: string };
    };
    noDeliveryProof.delivery.receiptEvidence = "http-accepted";
    expect(() => validateObservabilityConfig(noDeliveryProof)).toThrow();

    const weakenedAlert = structuredClone(config);
    const deletionAlert = weakenedAlert.alerts.find(
      ({ id }) => id === "deletion-cleanup-risk",
    );
    if (deletionAlert) deletionAlert.threshold = 60;
    expect(() => validateObservabilityConfig(weakenedAlert)).toThrow(
      "required alert deletion-cleanup-risk has drifted",
    );

    const mergedAvailability = structuredClone(config);
    const wasenderSlo = mergedAvailability.slos[1];
    if (wasenderSlo) wasenderSlo.filter.dependency = "first-party";
    expect(() => validateObservabilityConfig(mergedAvailability)).toThrow(
      "availability SLO definitions have drifted",
    );
  });
});
