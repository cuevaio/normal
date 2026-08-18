import { afterEach, expect, test } from "bun:test";
import type { DrillEvidence } from "./recovery-drills";
import { runRecoveryDrill } from "./run-recovery-drill";

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

test("monthly automation requests a random prior-history point and non-serving branch", async () => {
  process.env.RECOVERY_AUTOMATION_URL = "https://recovery.internal.test/drills";
  process.env.RECOVERY_AUTOMATION_TOKEN = "secret-token";
  let requestBody: Record<string, unknown> | undefined;
  const now = new Date("2026-08-03T00:00:00.000Z");
  const source = "2026-07-19T12:00:00.000Z";
  const evidence: DrillEvidence = {
    version: 1,
    drill: "monthly_restore",
    environment: "production",
    started_at: "2026-08-02T23:50:00.000Z",
    completed_at: "2026-08-03T00:00:00.000Z",
    source_point_at: source,
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
  await runRecoveryDrill("monthly_restore", {
    now,
    sourcePoint: new Date(source),
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json(evidence);
    },
  });
  expect(requestBody).toEqual({
    drill: "monthly_restore",
    requested_source_point_at: source,
    serving: false,
  });
});

test("random restore selection spans the full prior 30-day history", async () => {
  process.env.RECOVERY_AUTOMATION_URL = "https://recovery.internal.test/drills";
  process.env.RECOVERY_AUTOMATION_TOKEN = "secret-token";
  const now = new Date("2026-08-03T00:00:00.000Z");
  let requestedSource = "";
  await runRecoveryDrill("monthly_restore", {
    now,
    random: () => 0.75,
    fetch: async (_input, init) => {
      requestedSource = JSON.parse(
        String(init?.body),
      ).requested_source_point_at;
      const source = requestedSource;
      return Response.json({
        version: 1,
        drill: "monthly_restore",
        environment: "production",
        started_at: now.toISOString(),
        completed_at: now.toISOString(),
        source_point_at: source,
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
      });
    },
  });
  expect(now.getTime() - Date.parse(requestedSource)).toBe(
    0.75 * 30 * 86_400_000,
  );
});

test("rejects evidence for a different drill kind", async () => {
  process.env.RECOVERY_AUTOMATION_URL = "https://recovery.internal.test/drills";
  process.env.RECOVERY_AUTOMATION_TOKEN = "secret-token";
  const now = new Date("2026-08-03T00:00:00.000Z");
  const source = new Date("2026-07-19T12:00:00.000Z");
  await expect(
    runRecoveryDrill("quarterly_game_day", {
      now,
      sourcePoint: source,
      fetch: async () =>
        Response.json({
          version: 1,
          drill: "monthly_restore",
          environment: "production",
          started_at: now.toISOString(),
          completed_at: now.toISOString(),
          source_point_at: source.toISOString(),
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
        }),
    }),
  ).rejects.toThrow("automation returned evidence for a different drill");
});
