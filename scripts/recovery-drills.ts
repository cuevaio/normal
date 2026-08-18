export type DrillKind = "monthly_restore" | "quarterly_game_day";

export interface DrillEvidence {
  readonly version: 1;
  readonly drill: DrillKind;
  readonly environment: "production";
  readonly started_at: string;
  readonly completed_at: string;
  readonly source_point_at: string;
  readonly serving: boolean;
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
  readonly checks: Readonly<Record<string, boolean>>;
}

const monthlyChecks = [
  "schema_compatible",
  "rls_isolated",
  "sampled_keys_usable",
  "invariants_valid",
  "quotas_valid",
  "audit_valid",
  "current_time_expiry_applied",
  "deletion_markers_replayed",
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
  const failures: string[] = [];
  if (evidence.version !== 1) failures.push("unsupported evidence version");
  if (evidence.environment !== "production")
    failures.push("evidence is not from production");
  if (evidence.serving) failures.push("restore branch must be non-serving");

  const started = Date.parse(evidence.started_at ?? "");
  const completed = Date.parse(evidence.completed_at ?? "");
  const source = Date.parse(evidence.source_point_at ?? "");
  if (![started, completed, source].every(Number.isFinite))
    failures.push("evidence timestamps are invalid");
  else {
    if (source > started || started - source > 30 * 86_400_000)
      failures.push("restore point is outside the prior 30-day history");
    if (completed < started || completed > now.getTime())
      failures.push("drill completion time is invalid");
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

  const required =
    evidence.drill === "monthly_restore"
      ? monthlyChecks
      : evidence.drill === "quarterly_game_day"
        ? [...monthlyChecks, ...quarterlyChecks]
        : [];
  if (required.length === 0) failures.push("unknown drill kind");
  for (const check of required)
    if (evidence.checks?.[check] !== true)
      failures.push(`${evidence.drill} check ${check} did not pass`);
  return failures;
};

export const evaluateLaunchGate = (input: {
  readonly now: Date;
  readonly monthly: unknown;
  readonly quarterly: unknown;
  readonly smokePassed: boolean;
  readonly numericQuotasApproved: boolean;
  readonly providerCapacityApproved: boolean;
  readonly wasenderTermsApproved: boolean;
  readonly productionBundleHasNoFake: boolean;
}) => {
  const blockers = [
    ...validateDrillEvidence(input.monthly, input.now),
    ...validateDrillEvidence(input.quarterly, input.now),
  ];
  const evidenceRecord = (evidence: unknown): Partial<DrillEvidence> =>
    typeof evidence === "object" &&
    evidence !== null &&
    !Array.isArray(evidence)
      ? (evidence as Partial<DrillEvidence>)
      : {};
  const monthly = evidenceRecord(input.monthly);
  const quarterly = evidenceRecord(input.quarterly);
  const age = (evidence: Partial<DrillEvidence>) =>
    input.now.getTime() - Date.parse(evidence.completed_at ?? "");
  if (monthly.drill !== "monthly_restore")
    blockers.push("monthly evidence has the wrong drill kind");
  if (age(monthly) > 35 * 86_400_000)
    blockers.push("monthly recovery evidence is stale");
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
