import { describe, expect, test, vi } from "vitest";
import { ObservabilityError, queryAvailability } from "../src/availability";
import type { RecoveryVerifierEnvironment } from "../src/environment";

const asOf = "2026-08-18T12:00:00.000Z";
const input = {
  version: 1,
  drill: "weekly_restore",
  environment: "production",
  serving: false,
  operation: `recovery_operation_${"a".repeat(32)}`,
  recovery_branch_id: "br-recovery-assurance",
  source_point_at: "2026-08-17T12:00:00.000Z",
  started_at: asOf,
  verification_nonce: "b".repeat(64),
  replay_digest: "c".repeat(64),
  replay: {
    deletion_markers_enumerated: 0,
    deletion_marker_failures: 0,
    deleted_entities_repurged: 0,
    deleted_identifiers_remaining: 0,
    recipient_transitions_replayed: 0,
    recipient_transition_failures: 0,
    unresolved_recipient_prefixes: 0,
    expired_records_purged: 0,
    api_keys_revoked: 0,
    api_key_digests_cleared: 0,
    object_deletion_intents_simulated: 0,
    object_deletion_failures: 0,
  },
} as const;
const env = {
  OBSERVABILITY_QUERY_URL: "https://monitoring.internal.test/query",
  OBSERVABILITY_QUERY_TOKEN: "monitoring-token",
} as RecoveryVerifierEnvironment;

describe("recovery availability evidence", () => {
  test("accepts only the exact rolling seven-day aggregate", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        version: 1,
        window: "7d",
        as_of: asOf,
        window_started_at: "2026-08-11T12:00:00.000Z",
        window_completed_at: asOf,
        first_party_percent: 99.7,
        wasender_percent: 98.1,
        whatsapp_percent: 97.2,
        sampled_keys_usable: true,
        operation: input.operation,
        recovery_branch_id: input.recovery_branch_id,
        source_point_at: input.source_point_at,
        verification_nonce: input.verification_nonce,
        replay_digest: input.replay_digest,
      }),
    );
    await expect(queryAvailability(env, input, fetcher)).resolves.toEqual({
      firstPartyPercent: 99.7,
      wasenderPercent: 98.1,
      whatsappPercent: 97.2,
      sampledKeysUsable: true,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test("rejects an unbound or extended report", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        version: 1,
        window: "7d",
        as_of: "2026-08-17T12:00:00.000Z",
        window_started_at: "2026-08-10T12:00:00.000Z",
        window_completed_at: "2026-08-17T12:00:00.000Z",
        first_party_percent: 100,
        wasender_percent: 100,
        whatsapp_percent: 100,
        tenant_id: "forbidden",
        sampled_keys_usable: true,
        operation: input.operation,
        recovery_branch_id: input.recovery_branch_id,
        source_point_at: input.source_point_at,
        verification_nonce: input.verification_nonce,
        replay_digest: input.replay_digest,
      }),
    );
    await expect(queryAvailability(env, input, fetcher)).rejects.toThrow(
      "invalid evidence",
    );
  });

  test("retains only a fixed failed authority stage", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { status: "failed" },
        {
          status: 503,
          headers: { "x-operations-availability-stage": "sampled_keys" },
        },
      ),
    );
    await expect(queryAvailability(env, input, fetcher)).rejects.toEqual(
      new ObservabilityError("sampled_keys"),
    );
  });
});
