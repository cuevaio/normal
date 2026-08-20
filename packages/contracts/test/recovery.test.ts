import { describe, expect, test } from "bun:test";
import {
  decodeRecoveryVerificationRequest,
  decodeRecoveryVerificationResponse,
} from "../src/recovery";

const identity = {
  version: 1,
  operation: `recovery_operation_${"a".repeat(32)}`,
  recovery_branch_id: "br-recovery-contract",
  source_point_at: "2026-08-18T00:00:00.000Z",
  started_at: "2026-08-18T01:00:00.000Z",
  verification_nonce: "b".repeat(64),
  replay_digest: "c".repeat(64),
} as const;

const replay = {
  deletion_markers_enumerated: 1,
  deletion_marker_failures: 0,
  deleted_entities_repurged: 1,
  deleted_identifiers_remaining: 0,
  recipient_transitions_replayed: 1,
  recipient_transition_failures: 0,
  unresolved_recipient_prefixes: 0,
  expired_records_purged: 1,
  api_keys_revoked: 1,
  api_key_digests_cleared: 1,
  object_deletion_intents_simulated: 1,
  object_deletion_failures: 0,
} as const;

const monthlyChecks = {
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
} as const;

describe("recovery verification contract", () => {
  test("decodes an exact metadata-only weekly request", () => {
    expect(
      decodeRecoveryVerificationRequest({
        ...identity,
        drill: "weekly_restore",
        environment: "production",
        serving: false,
        replay,
      }),
    ).toMatchObject({ drill: "weekly_restore", serving: false });
  });

  test("rejects request and response extensions", () => {
    expect(() =>
      decodeRecoveryVerificationRequest({
        ...identity,
        drill: "weekly_restore",
        environment: "production",
        serving: false,
        replay,
        tenant_id: "forbidden",
      }),
    ).toThrow();
    expect(() =>
      decodeRecoveryVerificationResponse({
        ...identity,
        drill: "weekly_restore",
        achieved_rpo_seconds: 1,
        achieved_first_party_availability_percent: 99.9,
        dependencies: { wasender_percent: 99, whatsapp_percent: 98 },
        checks: { ...monthlyChecks, invented_check: true },
      }),
    ).toThrow();
  });

  test("requires every quarterly check to pass", () => {
    expect(() =>
      decodeRecoveryVerificationResponse({
        ...identity,
        drill: "quarterly_game_day",
        achieved_rpo_seconds: 1,
        achieved_first_party_availability_percent: 99.9,
        dependencies: { wasender_percent: 99, whatsapp_percent: 98 },
        checks: monthlyChecks,
      }),
    ).toThrow();
  });
});
