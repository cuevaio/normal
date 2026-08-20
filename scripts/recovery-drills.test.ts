import { describe, expect, test } from "bun:test";
import {
  type DrillEvidence,
  evaluateLaunchGate,
  validateDrillEvidence,
} from "./recovery-drills";

const weekly: DrillEvidence = {
  version: 1,
  drill: "weekly_restore",
  environment: "production",
  started_at: "2026-08-01T00:00:00.000Z",
  completed_at: "2026-08-01T00:12:00.000Z",
  source_point_at: "2026-07-27T00:00:00.000Z",
  recovery_branch_id: "br-recovery-evidence-123456",
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
  replay: {
    deletion_markers_enumerated: 10,
    deletion_marker_failures: 0,
    deleted_entities_repurged: 2,
    deleted_identifiers_remaining: 0,
    recipient_transitions_replayed: 4,
    recipient_transition_failures: 0,
    unresolved_recipient_prefixes: 1,
    expired_records_purged: 3,
    api_keys_revoked: 2,
    api_key_digests_cleared: 2,
    object_deletion_intents_simulated: 1,
    object_deletion_failures: 0,
  },
  checks: {
    schema_compatible: true,
    rls_isolated: true,
    sampled_keys_usable: true,
    invariants_valid: true,
    quotas_valid: true,
    audit_valid: true,
    current_time_expiry_applied: true,
    deletion_markers_replayed: true,
    recipient_transitions_replayed: true,
    recipient_purge_cutoffs_applied: true,
    prepared_recipient_transitions_drained: true,
    object_deletion_intents_drained: true,
    deleted_identifiers_absent: true,
    api_keys_revoked: true,
    api_key_digests_cleared: true,
    api_key_hmac_rotated: true,
    predecessor_hmac_rejected: true,
  },
};

const quarterly: DrillEvidence = {
  ...weekly,
  drill: "quarterly_game_day",
  checks: {
    ...weekly.checks,
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
        weekly: null,
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
    expect(validateDrillEvidence(weekly, new Date("2026-08-02"))).toEqual([]);
  });

  test("rejects first-party availability below its SLO independently of dependencies", () => {
    expect(
      validateDrillEvidence(
        {
          ...weekly,
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
          ...weekly,
          checks: {
            ...weekly.checks,
            api_keys_revoked: false,
            predecessor_hmac_rejected: undefined,
          },
        },
        new Date("2026-08-02"),
      ),
    ).toEqual([
      "weekly_restore check api_keys_revoked did not pass",
      "weekly_restore check predecessor_hmac_rejected did not pass",
    ]);
  });

  test("rejects serving restores and missing verification", () => {
    expect(
      validateDrillEvidence(
        {
          ...weekly,
          serving: true,
          checks: { ...weekly.checks, rls_isolated: false },
        },
        new Date("2026-08-02"),
      ),
    ).toEqual([
      "restore branch must be explicitly non-serving",
      "weekly_restore check rls_isolated did not pass",
    ]);
  });

  test("requires an exact metadata-only evidence shape", () => {
    const failures = validateDrillEvidence(
      {
        ...weekly,
        serving: undefined,
        tenant_id: "must-not-be-retained",
        objectives: {
          ...weekly.objectives,
          branch_id: "must-not-be-retained",
        },
        checks: { ...weekly.checks, invented_check: true },
      },
      new Date("2026-08-02"),
    );
    expect(failures).toContain("restore branch must be explicitly non-serving");
    expect(failures).toContain("evidence contains unknown field tenant_id");
    expect(failures).toContain("objectives contains unknown field branch_id");
    expect(failures).toContain("checks contains unknown field invented_check");
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

  test("requires branch-bound aggregate replay evidence and measured RTO", () => {
    const failures = validateDrillEvidence(
      {
        ...weekly,
        recovery_branch_id: "not-a-branch",
        achieved_rto_seconds: 1,
        replay: { ...weekly.replay, deletion_marker_failures: 1 },
      },
      new Date("2026-08-02"),
    );
    expect(failures).toContain(
      "recovery evidence is not bound to a Neon branch",
    );
    expect(failures).toContain(
      "achieved RTO is shorter than the measured drill duration",
    );
    expect(failures).toContain("restore replay recorded aggregate failures");
  });

  test("launch gate fails closed on stale evidence or incomplete governance", () => {
    const result = evaluateLaunchGate({
      now: new Date("2026-08-03T00:00:00.000Z"),
      weekly,
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
        weekly,
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
