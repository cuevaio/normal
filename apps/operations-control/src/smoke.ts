import type { OperationsFetch } from "./cloudflare";
import { required, safeOrigin } from "./config";
import type { OperationsControlEnvironment } from "./environment";

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export const verifySampledKeys = async (
  env: OperationsControlEnvironment,
  fetcher: OperationsFetch = fetch,
  pause: (milliseconds: number) => Promise<void> = sleep,
): Promise<true> => {
  const origin = safeOrigin(env.API_ORIGIN, "API origin");
  const authorization = `Bearer ${required(
    env.SMOKE_CHECK_SECRET,
    "Smoke check secret",
  )}`;
  const started = await fetcher(`${origin}/_internal/deployment-smoke`, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    headers: { authorization },
  });
  const startedBody = started.ok
    ? ((await started.json()) as { canary_id?: unknown })
    : null;
  if (
    started.status !== 202 ||
    typeof startedBody?.canary_id !== "string" ||
    !/^smk_[A-Za-z0-9_-]{43}$/u.test(startedBody.canary_id)
  )
    throw new Error("Production key canary was rejected");

  // Workers KV may continue serving the pending value from an edge cache for
  // up to a minute after the queue consumer records completion. Keep this
  // aligned with the production deployment smoke window so a healthy canary
  // is not rejected while that update propagates.
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const response = await fetcher(
      `${origin}/_internal/deployment-smoke?id=${startedBody.canary_id}`,
      {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: { authorization },
      },
    );
    const body = response.ok
      ? ((await response.json()) as {
          readonly status?: unknown;
          readonly subsystems?: unknown;
        })
      : null;
    if (
      response.ok &&
      body?.status === "complete" &&
      Array.isArray(body.subsystems) &&
      body.subsystems.includes("r2-kms")
    )
      return true;
    if (!response.ok || body?.status === "failed")
      throw new Error("Production key canary failed");
    await pause(1_000);
  }
  throw new Error("Production key canary timed out");
};
