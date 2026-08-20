import { afterEach, expect, test } from "bun:test";
import type { DrillEvidence } from "./recovery-drills";
import { runRecoveryDrill } from "./run-recovery-drill";

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

const completeAutomation = (
  evidence: unknown | (() => unknown),
  inspectStart?: (input: string | URL | Request, init?: RequestInit) => void,
) => {
  let requests = 0;
  return async (input: string | URL | Request, init?: RequestInit) => {
    requests += 1;
    if (requests === 1) {
      inspectStart?.(input, init);
      return Response.json(
        { operation: "recovery_operation_123", status: "running" },
        { status: 202 },
      );
    }
    return Response.json({
      status: "complete",
      evidence: typeof evidence === "function" ? evidence() : evidence,
    });
  };
};

test("weekly automation requests a random prior-history point and non-serving branch", async () => {
  process.env.RECOVERY_AUTOMATION_URL = "https://recovery.internal.test/drills";
  process.env.RECOVERY_AUTOMATION_TOKEN = "secret-token";
  let requestBody: Record<string, unknown> | undefined;
  const now = new Date("2026-08-03T00:00:00.000Z");
  const source = "2026-07-29T12:00:00.000Z";
  let credentialRefreshCompleted = false;
  const evidence: DrillEvidence = {
    version: 1,
    drill: "weekly_restore",
    environment: "production",
    started_at: "2026-08-02T23:50:00.000Z",
    completed_at: "2026-08-03T00:00:00.000Z",
    source_point_at: source,
    recovery_branch_id: "br-recovery-evidence-123456",
    serving: false,
    achieved_rpo_seconds: 1,
    achieved_rto_seconds: 600,
    achieved_first_party_availability_percent: 99.7,
    objectives: {
      recovery_time_seconds: 14_400,
      neon_recovery_point_seconds: 300,
      deletion_marker_loss: 0,
      first_party_availability_percent: 99.5,
    },
    dependencies: { wasender_percent: 99, whatsapp_percent: 99 },
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
  await runRecoveryDrill("weekly_restore", {
    now,
    sourcePoint: new Date(source),
    beforeStart: async () => {
      credentialRefreshCompleted = true;
    },
    sleep: async () => {},
    fetch: completeAutomation(evidence, (_input, init) => {
      expect(credentialRefreshCompleted).toBe(true);
      requestBody = JSON.parse(String(init?.body));
      expect(init?.redirect).toBe("error");
    }),
  });
  expect(requestBody).toEqual({
    drill: "weekly_restore",
    requested_source_point_at: source,
    serving: false,
  });
});

test("random restore selection spans the configured seven-day history", async () => {
  process.env.RECOVERY_AUTOMATION_URL = "https://recovery.internal.test/drills";
  process.env.RECOVERY_AUTOMATION_TOKEN = "secret-token";
  const now = new Date("2026-08-03T00:00:00.000Z");
  let requestedSource = "";
  await runRecoveryDrill("weekly_restore", {
    now,
    random: () => 0.75,
    sleep: async () => {},
    fetch: completeAutomation(
      () => ({
        version: 1,
        drill: "weekly_restore",
        environment: "production",
        started_at: now.toISOString(),
        completed_at: now.toISOString(),
        source_point_at: requestedSource,
        recovery_branch_id: "br-recovery-evidence-123456",
        serving: false,
        achieved_rpo_seconds: 1,
        achieved_rto_seconds: 1,
        achieved_first_party_availability_percent: 99.7,
        objectives: {
          recovery_time_seconds: 14_400,
          neon_recovery_point_seconds: 300,
          deletion_marker_loss: 0,
          first_party_availability_percent: 99.5,
        },
        dependencies: { wasender_percent: 99, whatsapp_percent: 99 },
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
      }),
      (_input, init) => {
        requestedSource = JSON.parse(
          String(init?.body),
        ).requested_source_point_at;
      },
    ),
  });
  expect(now.getTime() - Date.parse(requestedSource)).toBe(
    0.75 * 7 * 86_400_000,
  );
});

test("rejects evidence for a different drill kind", async () => {
  process.env.RECOVERY_AUTOMATION_URL = "https://recovery.internal.test/drills";
  process.env.RECOVERY_AUTOMATION_TOKEN = "secret-token";
  const now = new Date("2026-08-03T00:00:00.000Z");
  const source = new Date("2026-07-29T12:00:00.000Z");
  await expect(
    runRecoveryDrill("quarterly_game_day", {
      now,
      sourcePoint: source,
      sleep: async () => {},
      fetch: completeAutomation({
        version: 1,
        drill: "weekly_restore",
        environment: "production",
        started_at: now.toISOString(),
        completed_at: now.toISOString(),
        source_point_at: source.toISOString(),
        recovery_branch_id: "br-recovery-evidence-123456",
        serving: false,
        achieved_rpo_seconds: 1,
        achieved_rto_seconds: 1,
        achieved_first_party_availability_percent: 99.7,
        objectives: {
          recovery_time_seconds: 14_400,
          neon_recovery_point_seconds: 300,
          deletion_marker_loss: 0,
          first_party_availability_percent: 99.5,
        },
        dependencies: { wasender_percent: 99, whatsapp_percent: 99 },
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
      }),
    }),
  ).rejects.toThrow("automation returned evidence for a different drill");
});

test("rejects insecure recovery automation URLs before sending credentials", async () => {
  process.env.RECOVERY_AUTOMATION_URL = "http://recovery.internal.test/drills";
  process.env.RECOVERY_AUTOMATION_TOKEN = "secret-token";
  await expect(
    runRecoveryDrill("weekly_restore", {
      fetch: async () => {
        throw new Error("fetch must not run");
      },
    }),
  ).rejects.toThrow("RECOVERY_AUTOMATION_URL must be a safe HTTPS URL");
});

test("stops polling at the configured deadline", async () => {
  process.env.RECOVERY_AUTOMATION_URL = "https://recovery.internal.test/drills";
  process.env.RECOVERY_AUTOMATION_TOKEN = "secret-token";
  let clock = 0;
  let requests = 0;
  await expect(
    runRecoveryDrill("weekly_restore", {
      now: new Date("2026-08-03T00:00:00.000Z"),
      sourcePoint: new Date("2026-07-29T12:00:00.000Z"),
      timeoutMs: 100,
      pollIntervalMs: 100,
      clock: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      fetch: async (_input, init) => {
        requests += 1;
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return Response.json(
          { operation: "recovery_operation_123", status: "running" },
          { status: 202 },
        );
      },
    }),
  ).rejects.toThrow("weekly_restore automation timed out");
  expect(requests).toBe(1);
});
