import { describe, expect, test } from "bun:test";
import {
  type DrillEvidence,
  evaluateLaunchGate,
  validateDrillEvidence,
} from "./recovery-drills";

const monthly: DrillEvidence = {
  version: 1,
  drill: "monthly_restore",
  environment: "production",
  started_at: "2026-08-01T00:00:00.000Z",
  completed_at: "2026-08-01T00:12:00.000Z",
  source_point_at: "2026-07-17T00:00:00.000Z",
  serving: false,
  achieved_rpo_seconds: 120,
  achieved_rto_seconds: 720,
  achieved_first_party_availability_percent: 99.7,
  objectives: {
    recovery_time_seconds: 14_400,
    neon_recovery_point_seconds: 300,
    deletion_marker_loss: 0,
    first_party_availability_percent: 99.5,
  },
  dependencies: { wasender_percent: 98.1, whatsapp_percent: 97.4 },
  checks: {
    schema_compatible: true,
    rls_isolated: true,
    sampled_keys_usable: true,
    invariants_valid: true,
    quotas_valid: true,
    audit_valid: true,
    current_time_expiry_applied: true,
    deletion_markers_replayed: true,
    deleted_identifiers_absent: true,
    api_keys_revoked: true,
    api_key_digests_cleared: true,
    api_key_hmac_rotated: true,
    predecessor_hmac_rejected: true,
  },
};

const quarterly: DrillEvidence = {
  ...monthly,
  drill: "quarterly_game_day",
  checks: {
    ...monthly.checks,
    endpoint_rotation: true,
    oauth_kv_reconstructed: true,
    immutable_queue_replay: true,
    kms_access: true,
    r2_access: true,
    media_loss_failed_closed: true,
    alert_delivered: true,
    deletion_gate_bypass_denied: true,
  },
};

describe("recovery drill evidence", () => {
  test("rejects malformed evidence without throwing", () => {
    expect(validateDrillEvidence(null, new Date("2026-08-02"))).toEqual([
      "evidence is not an object",
    ]);
    expect(
      evaluateLaunchGate({
        now: new Date("2026-08-02"),
        monthly: null,
        quarterly: null,
        smokePassed: true,
        numericQuotasApproved: true,
        providerCapacityApproved: true,
        wasenderTermsApproved: true,
        productionBundleHasNoFake: true,
      }).open,
    ).toBe(false);
  });

  test("accepts separate first-party objectives and dependency measurements", () => {
    expect(validateDrillEvidence(monthly, new Date("2026-08-02"))).toEqual([]);
  });

  test("rejects first-party availability below its SLO independently of dependencies", () => {
    expect(
      validateDrillEvidence(
        {
          ...monthly,
          achieved_first_party_availability_percent: 99.4,
          dependencies: { wasender_percent: 100, whatsapp_percent: 100 },
        },
        new Date("2026-08-02"),
      ),
    ).toContain("99.5 percent first-party availability objective was missed");
  });

  test("rejects missing API Key restore invalidation evidence", () => {
    expect(
      validateDrillEvidence(
        {
          ...monthly,
          checks: {
            ...monthly.checks,
            api_keys_revoked: false,
            predecessor_hmac_rejected: undefined,
          },
        },
        new Date("2026-08-02"),
      ),
    ).toEqual([
      "monthly_restore check api_keys_revoked did not pass",
      "monthly_restore check predecessor_hmac_rejected did not pass",
    ]);
  });

  test("rejects serving restores and missing verification", () => {
    expect(
      validateDrillEvidence(
        {
          ...monthly,
          serving: true,
          checks: { ...monthly.checks, rls_isolated: false },
        },
        new Date("2026-08-02"),
      ),
    ).toEqual([
      "restore branch must be non-serving",
      "monthly_restore check rls_isolated did not pass",
    ]);
  });

  test("requires restore verification during quarterly game days", () => {
    expect(
      validateDrillEvidence(
        {
          ...quarterly,
          checks: { ...quarterly.checks, deletion_markers_replayed: false },
        },
        new Date("2026-08-02"),
      ),
    ).toContain(
      "quarterly_game_day check deletion_markers_replayed did not pass",
    );
  });

  test("launch gate fails closed on stale evidence or incomplete governance", () => {
    const result = evaluateLaunchGate({
      now: new Date("2026-08-03T00:00:00.000Z"),
      monthly,
      quarterly: { ...quarterly, completed_at: "2026-03-01T00:00:00.000Z" },
      smokePassed: true,
      numericQuotasApproved: true,
      providerCapacityApproved: true,
      wasenderTermsApproved: false,
      productionBundleHasNoFake: true,
    });
    expect(result.open).toBe(false);
    expect(result.blockers).toContain("quarterly recovery evidence is stale");
    expect(result.blockers).toContain(
      "Wasender governance terms are not approved",
    );
  });

  test("opens only when every launch gate passes", () => {
    expect(
      evaluateLaunchGate({
        now: new Date("2026-08-03T00:00:00.000Z"),
        monthly,
        quarterly,
        smokePassed: true,
        numericQuotasApproved: true,
        providerCapacityApproved: true,
        wasenderTermsApproved: true,
        productionBundleHasNoFake: true,
      }),
    ).toEqual({ open: true, blockers: [] });
  });
});
