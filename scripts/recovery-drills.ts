export type DrillKind = "weekly_restore" | "quarterly_game_day";

export interface DrillEvidence {
  readonly version: 1;
  readonly drill: DrillKind;
  readonly environment: "production";
  readonly started_at: string;
  readonly completed_at: string;
  readonly source_point_at: string;
  readonly recovery_branch_id: string;
  readonly serving: false;
  readonly achieved_rpo_seconds: number;
  readonly achieved_rto_seconds: number;
  readonly achieved_first_party_availability_percent: number;
  readonly objectives: {
    readonly recovery_time_seconds: number;
    readonly neon_recovery_point_seconds: number;
    readonly deletion_marker_loss: number;
    readonly first_party_availability_percent: number;
  };
  readonly dependencies: {
    readonly wasender_percent: number;
    readonly whatsapp_percent: number;
  };
  readonly replay: {
    readonly deletion_markers_enumerated: number;
    readonly deletion_marker_failures: 0;
    readonly deleted_entities_repurged: number;
    readonly deleted_identifiers_remaining: 0;
    readonly recipient_transitions_replayed: number;
    readonly recipient_transition_failures: 0;
    readonly unresolved_recipient_prefixes: number;
    readonly expired_records_purged: number;
    readonly api_keys_revoked: number;
    readonly api_key_digests_cleared: number;
    readonly object_deletion_intents_simulated: number;
    readonly object_deletion_failures: 0;
  };
  readonly checks: Readonly<Record<string, boolean>>;
}

const weeklyChecks = [
  "schema_compatible",
  "rls_isolated",
  "sampled_keys_usable",
  "invariants_valid",
  "quotas_valid",
  "audit_valid",
  "current_time_expiry_applied",
  "deletion_markers_replayed",
  "recipient_transitions_replayed",
  "recipient_purge_cutoffs_applied",
  "prepared_recipient_transitions_drained",
  "object_deletion_intents_drained",
  "deleted_identifiers_absent",
  "api_keys_revoked",
  "api_key_digests_cleared",
  "api_key_hmac_rotated",
  "predecessor_hmac_rejected",
] as const;

const quarterlyChecks = [
  "endpoint_rotation",
  "oauth_kv_reconstructed",
  "immutable_queue_replay",
  "kms_access",
  "r2_access",
  "media_loss_failed_closed",
  "alert_delivered",
  "deletion_gate_bypass_denied",
] as const;

const finiteNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const exactKeys = (
  value: unknown,
  expected: readonly string[],
  label: string,
): string[] => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return [`${label} is not an object`];
  const expectedSet = new Set(expected);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !expectedSet.has(key));
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  return [
    ...unknown.map((key) => `${label} contains unknown field ${key}`),
    ...missing.map((key) => `${label} is missing field ${key}`),
  ];
};

const evidenceKeys = [
  "version",
  "drill",
  "environment",
  "started_at",
  "completed_at",
  "source_point_at",
  "recovery_branch_id",
  "serving",
  "achieved_rpo_seconds",
  "achieved_rto_seconds",
  "achieved_first_party_availability_percent",
  "objectives",
  "dependencies",
  "replay",
  "checks",
] as const;

const objectiveKeys = [
  "recovery_time_seconds",
  "neon_recovery_point_seconds",
  "deletion_marker_loss",
  "first_party_availability_percent",
] as const;

const dependencyKeys = ["wasender_percent", "whatsapp_percent"] as const;

const replayKeys = [
  "deletion_markers_enumerated",
  "deletion_marker_failures",
  "deleted_entities_repurged",
  "deleted_identifiers_remaining",
  "recipient_transitions_replayed",
  "recipient_transition_failures",
  "unresolved_recipient_prefixes",
  "expired_records_purged",
  "api_keys_revoked",
  "api_key_digests_cleared",
  "object_deletion_intents_simulated",
  "object_deletion_failures",
] as const;

const nonnegativeInteger = (value: unknown): value is number =>
  finiteNonnegative(value) && Number.isInteger(value);

export const validateDrillEvidence = (
  candidate: unknown,
  now: Date,
): string[] => {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  )
    return ["evidence is not an object"];
  const evidence = candidate as Partial<DrillEvidence>;
  const failures = exactKeys(evidence, evidenceKeys, "evidence");
  failures.push(...exactKeys(evidence.objectives, objectiveKeys, "objectives"));
  failures.push(
    ...exactKeys(evidence.dependencies, dependencyKeys, "dependencies"),
  );
  failures.push(...exactKeys(evidence.replay, replayKeys, "replay"));
  if (evidence.version !== 1) failures.push("unsupported evidence version");
  if (evidence.environment !== "production")
    failures.push("evidence is not from production");
  if (evidence.serving !== false)
    failures.push("restore branch must be explicitly non-serving");
  if (
    typeof evidence.recovery_branch_id !== "string" ||
    !/^br-[a-z0-9-]{1,57}$/u.test(evidence.recovery_branch_id)
  )
    failures.push("recovery evidence is not bound to a Neon branch");

  const started = Date.parse(evidence.started_at ?? "");
  const completed = Date.parse(evidence.completed_at ?? "");
  const source = Date.parse(evidence.source_point_at ?? "");
  if (![started, completed, source].every(Number.isFinite))
    failures.push("evidence timestamps are invalid");
  else {
    if (source > started || started - source > 7 * 86_400_000)
      failures.push("restore point is outside the prior seven-day history");
    if (completed < started || completed > now.getTime())
      failures.push("drill completion time is invalid");
    if (
      finiteNonnegative(evidence.achieved_rto_seconds) &&
      evidence.achieved_rto_seconds * 1_000 < completed - started
    )
      failures.push("achieved RTO is shorter than the measured drill duration");
  }

  if (
    !finiteNonnegative(evidence.achieved_rpo_seconds) ||
    evidence.achieved_rpo_seconds > 300
  )
    failures.push("five-minute Neon recovery-point objective was missed");
  if (
    !finiteNonnegative(evidence.achieved_rto_seconds) ||
    evidence.achieved_rto_seconds > 14_400
  )
    failures.push("four-hour recovery objective was missed");
  if (
    !finiteNonnegative(evidence.achieved_first_party_availability_percent) ||
    evidence.achieved_first_party_availability_percent < 99.5 ||
    evidence.achieved_first_party_availability_percent > 100
  )
    failures.push("99.5 percent first-party availability objective was missed");
  if (
    evidence.objectives?.recovery_time_seconds !== 14_400 ||
    evidence.objectives?.neon_recovery_point_seconds !== 300 ||
    evidence.objectives?.deletion_marker_loss !== 0 ||
    evidence.objectives?.first_party_availability_percent !== 99.5
  )
    failures.push(
      "recovery objectives are not recorded separately and exactly",
    );
  if (
    !finiteNonnegative(evidence.dependencies?.wasender_percent) ||
    (evidence.dependencies?.wasender_percent ?? Number.NaN) > 100 ||
    !finiteNonnegative(evidence.dependencies?.whatsapp_percent) ||
    (evidence.dependencies?.whatsapp_percent ?? Number.NaN) > 100
  )
    failures.push("dependency availability evidence is missing");

  if (
    replayKeys.some(
      (key) => !nonnegativeInteger(evidence.replay?.[key] as unknown),
    )
  )
    failures.push("restore replay aggregate counts are invalid");
  if (
    evidence.replay?.deletion_marker_failures !== 0 ||
    evidence.replay?.recipient_transition_failures !== 0 ||
    evidence.replay?.object_deletion_failures !== 0
  )
    failures.push("restore replay recorded aggregate failures");

  const required =
    evidence.drill === "weekly_restore"
      ? weeklyChecks
      : evidence.drill === "quarterly_game_day"
        ? [...weeklyChecks, ...quarterlyChecks]
        : [];
  if (required.length === 0) failures.push("unknown drill kind");
  failures.push(...exactKeys(evidence.checks, required, "checks"));
  for (const check of required)
    if (evidence.checks?.[check] !== true)
      failures.push(`${evidence.drill} check ${check} did not pass`);
  return failures;
};

export const evaluateLaunchGate = (input: {
  readonly now: Date;
  readonly weekly: unknown;
  readonly quarterly: unknown;
  readonly smokePassed: boolean;
  readonly numericQuotasApproved: boolean;
  readonly providerCapacityApproved: boolean;
  readonly wasenderTermsApproved: boolean;
  readonly productionBundleHasNoFake: boolean;
}) => {
  const blockers = [
    ...validateDrillEvidence(input.weekly, input.now),
    ...validateDrillEvidence(input.quarterly, input.now),
  ];
  const evidenceRecord = (evidence: unknown): Partial<DrillEvidence> =>
    typeof evidence === "object" &&
    evidence !== null &&
    !Array.isArray(evidence)
      ? (evidence as Partial<DrillEvidence>)
      : {};
  const weekly = evidenceRecord(input.weekly);
  const quarterly = evidenceRecord(input.quarterly);
  const age = (evidence: Partial<DrillEvidence>) =>
    input.now.getTime() - Date.parse(evidence.completed_at ?? "");
  if (weekly.drill !== "weekly_restore")
    blockers.push("weekly evidence has the wrong drill kind");
  if (age(weekly) > 8 * 86_400_000)
    blockers.push("weekly recovery evidence is stale");
  if (quarterly.drill !== "quarterly_game_day")
    blockers.push("quarterly evidence has the wrong drill kind");
  if (age(quarterly) > 100 * 86_400_000)
    blockers.push("quarterly recovery evidence is stale");
  if (!input.smokePassed) blockers.push("real deployment smoke did not pass");
  if (!input.numericQuotasApproved)
    blockers.push("numeric quotas are not approved");
  if (!input.providerCapacityApproved)
    blockers.push("provider capacity is not approved");
  if (!input.wasenderTermsApproved)
    blockers.push("Wasender governance terms are not approved");
  if (!input.productionBundleHasNoFake)
    blockers.push("production bundle inspection did not exclude fakes");
  return { open: blockers.length === 0, blockers: [...new Set(blockers)] };
};
