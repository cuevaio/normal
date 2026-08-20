import { describe, expect, test } from "vitest";
import { decodeRecoveryVerificationResponse } from "../src/contract";

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

const response = {
  version: 1,
  drill: "weekly_restore",
  operation: `recovery_operation_${"a".repeat(32)}`,
  recovery_branch_id: "br-recovery-123",
  source_point_at: "2026-08-17T12:00:00.000Z",
  started_at: "2026-08-18T12:00:00.000Z",
  verification_nonce: "b".repeat(64),
  replay_digest: "c".repeat(64),
  achieved_rpo_seconds: 0,
  achieved_first_party_availability_percent: 99.9,
  dependencies: { wasender_percent: 99, whatsapp_percent: 98 },
  checks: monthlyChecks,
} as const;

describe("recovery verifier response contract", () => {
  test("accepts exact branch-bound aggregate evidence", () => {
    expect(decodeRecoveryVerificationResponse(response)).toEqual(response);
  });

  test("rejects generic, stale, or extended attestations", () => {
    expect(() =>
      decodeRecoveryVerificationResponse({
        ...response,
        recovery_branch_id: undefined,
      }),
    ).toThrow();
    expect(() =>
      decodeRecoveryVerificationResponse({
        ...response,
        verification_nonce: "d".repeat(64),
        tenant: "forbidden",
      }),
    ).toThrow();
    expect(() =>
      decodeRecoveryVerificationResponse({
        ...response,
        checks: { ...monthlyChecks, schema_compatible: false },
      }),
    ).toThrow();
  });
});
