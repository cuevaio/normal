import type { RecoveryVerificationRequest } from "@whatsapp-mcp/contracts/recovery";
import { required, safeHttpsUrl } from "./config";
import type { RecoveryVerifierEnvironment } from "./environment";

export interface AvailabilityEvidence {
  readonly firstPartyPercent: number;
  readonly sampledKeysUsable: true;
  readonly wasenderPercent: number;
  readonly whatsappPercent: number;
}

export type AvailabilityFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type ObservabilityStage = "dependency" | "first_party" | "sampled_keys";

export class ObservabilityError extends Error {
  constructor(readonly stage?: ObservabilityStage) {
    super("Observability query failed");
  }
}

const percentage = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 100;

export const queryAvailability = async (
  env: RecoveryVerifierEnvironment,
  input: RecoveryVerificationRequest,
  fetcher: AvailabilityFetch = fetch,
): Promise<AvailabilityEvidence> => {
  const response = await fetcher(
    safeHttpsUrl(env.OBSERVABILITY_QUERY_URL, "Observability query URL"),
    {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${required(
          env.OBSERVABILITY_QUERY_TOKEN,
          "Observability query token",
        )}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        window: "7d",
        as_of: input.started_at,
        operation: input.operation,
        recovery_branch_id: input.recovery_branch_id,
        source_point_at: input.source_point_at,
        verification_nonce: input.verification_nonce,
        replay_digest: input.replay_digest,
      }),
    },
  );
  if (
    !response.ok ||
    !response.headers.get("content-type")?.startsWith("application/json")
  ) {
    const stage = response.headers.get("x-operations-availability-stage");
    throw new ObservabilityError(
      stage === "dependency" ||
        stage === "first_party" ||
        stage === "sampled_keys"
        ? stage
        : undefined,
    );
  }
  const candidate = (await response.json()) as Record<string, unknown>;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    Object.keys(candidate).length !== 14 ||
    candidate.version !== 1 ||
    candidate.window !== "7d" ||
    candidate.as_of !== input.started_at ||
    candidate.operation !== input.operation ||
    candidate.recovery_branch_id !== input.recovery_branch_id ||
    candidate.source_point_at !== input.source_point_at ||
    candidate.verification_nonce !== input.verification_nonce ||
    candidate.replay_digest !== input.replay_digest ||
    !percentage(candidate.first_party_percent) ||
    !percentage(candidate.wasender_percent) ||
    !percentage(candidate.whatsapp_percent)
  )
    throw new Error("Observability query returned invalid evidence");
  const started = Date.parse(String(candidate.window_started_at));
  const completed = Date.parse(String(candidate.window_completed_at));
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(completed) ||
    completed !== Date.parse(input.started_at) ||
    completed - started !== 7 * 86_400_000
  )
    throw new Error("Observability query returned the wrong window");
  if (candidate.sampled_keys_usable !== true)
    throw new Error("Observability query returned invalid recovery evidence");
  return {
    firstPartyPercent: candidate.first_party_percent,
    sampledKeysUsable: true,
    wasenderPercent: candidate.wasender_percent,
    whatsappPercent: candidate.whatsapp_percent,
  };
};
