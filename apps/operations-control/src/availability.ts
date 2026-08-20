import {
  CloudflareAnalyticsError,
  type CloudflareAnalyticsFailure,
  type OperationsFetch,
  queryFirstPartyAvailability,
} from "./cloudflare";
import { canonicalTimestamp, exactKeys, readJson, safeJson } from "./config";
import type { OperationsControlEnvironment } from "./environment";
import { verifySampledKeys } from "./smoke";
import { queryDependencyAvailability } from "./wasender";

const keys = [
  "version",
  "window",
  "as_of",
  "operation",
  "recovery_branch_id",
  "source_point_at",
  "verification_nonce",
  "replay_digest",
] as const;

export type AvailabilityStage = "dependency" | "first_party" | "sampled_keys";

export class AvailabilityError extends Error {
  constructor(
    readonly stage: AvailabilityStage,
    readonly reason?: CloudflareAnalyticsFailure,
  ) {
    super("Availability evidence is unavailable");
  }
}

const withStage = async <Value>(
  stage: AvailabilityStage,
  operation: Promise<Value>,
) => {
  try {
    return await operation;
  } catch (error) {
    throw new AvailabilityError(
      stage,
      error instanceof CloudflareAnalyticsError ? error.failure : undefined,
    );
  }
};

export const handleAvailability = async (
  request: Request,
  env: OperationsControlEnvironment,
  dependencies: {
    readonly fetch?: OperationsFetch;
    readonly keys?: () => Promise<true>;
  } = {},
) => {
  const candidate = await readJson(request);
  if (
    !exactKeys(candidate, keys) ||
    candidate.version !== 1 ||
    candidate.window !== "7d" ||
    !canonicalTimestamp(candidate.as_of) ||
    !canonicalTimestamp(candidate.source_point_at) ||
    typeof candidate.operation !== "string" ||
    !/^recovery_operation_[a-f0-9]{32}$/u.test(candidate.operation) ||
    typeof candidate.recovery_branch_id !== "string" ||
    !/^br-[A-Za-z0-9_-]{1,120}$/u.test(candidate.recovery_branch_id) ||
    typeof candidate.verification_nonce !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.verification_nonce) ||
    typeof candidate.replay_digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.replay_digest)
  )
    throw new Error("Availability request is invalid");
  const completedAt = candidate.as_of;
  const startedAt = new Date(
    Date.parse(completedAt) - 7 * 86_400_000,
  ).toISOString();
  const fetcher = dependencies.fetch ?? fetch;
  const [firstPartyPercent, dependenciesResult, sampledKeysUsable] =
    await Promise.all([
      withStage(
        "first_party",
        queryFirstPartyAvailability(env, { completedAt, startedAt }, fetcher),
      ),
      withStage(
        "dependency",
        queryDependencyAvailability(completedAt, fetcher),
      ),
      withStage(
        "sampled_keys",
        dependencies.keys?.() ?? verifySampledKeys(env, fetcher),
      ),
    ]);
  return safeJson({
    version: 1,
    window: "7d",
    as_of: completedAt,
    window_started_at: startedAt,
    window_completed_at: completedAt,
    operation: candidate.operation,
    recovery_branch_id: candidate.recovery_branch_id,
    source_point_at: candidate.source_point_at,
    verification_nonce: candidate.verification_nonce,
    replay_digest: candidate.replay_digest,
    first_party_percent: firstPartyPercent,
    wasender_percent: dependenciesResult.wasenderPercent,
    whatsapp_percent: dependenciesResult.whatsappPercent,
    sampled_keys_usable: sampledKeysUsable,
  });
};
