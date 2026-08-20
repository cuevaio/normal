import { type DrillKind, validateDrillEvidence } from "./recovery-drills";

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const operationReference = /^[A-Za-z0-9_-]{16,128}$/u;

const required = (name: string) => {
  const value = process.env[name];
  if (!value || /example|placeholder|replace/iu.test(value))
    throw new Error(`${name} is unavailable`);
  return value;
};

const recoveryAutomationUrl = () => {
  const url = new URL(required("RECOVERY_AUTOMATION_URL"));
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("RECOVERY_AUTOMATION_URL must be a safe HTTPS URL");
  return url;
};

export const runRecoveryDrill = async (
  drill: DrillKind,
  options: {
    readonly fetch?: Fetch;
    readonly now?: Date;
    readonly validationNow?: Date;
    readonly random?: () => number;
    readonly sourcePoint?: Date;
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly pollIntervalMs?: number;
    readonly timeoutMs?: number;
    readonly clock?: () => number;
    readonly beforeStart?: () => Promise<void>;
    readonly beforePoll?: () => Promise<void>;
  } = {},
) => {
  const requestedAt = options.now ?? new Date();
  const random =
    options.random ??
    (() =>
      (crypto.getRandomValues(new Uint32Array(1)).at(0) ?? 0) / 0x1_0000_0000);
  const sourcePoint =
    options.sourcePoint ??
    new Date(requestedAt.getTime() - random() * 7 * 86_400_000);
  const pollIntervalMs = options.pollIntervalMs ?? 15_000;
  const timeoutMs = options.timeoutMs ?? 14_400_000;
  if (
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs <= 0 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0
  )
    throw new Error("recovery polling bounds are invalid");
  const clock = options.clock ?? Date.now;
  const deadline = clock() + timeoutMs;
  const requestSignal = () =>
    AbortSignal.timeout(Math.max(1, deadline - clock()));
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const automationUrl = recoveryAutomationUrl();
  await options.beforeStart?.();
  const response = await fetchImplementation(automationUrl, {
    method: "POST",
    redirect: "error",
    signal: requestSignal(),
    headers: {
      authorization: `Bearer ${required("RECOVERY_AUTOMATION_TOKEN")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      drill,
      requested_source_point_at: sourcePoint.toISOString(),
      serving: false,
    }),
  });
  if (response.status !== 202) throw new Error(`${drill} automation failed`);
  const started = (await response.json()) as unknown;
  if (
    typeof started !== "object" ||
    started === null ||
    Array.isArray(started) ||
    Object.keys(started).length !== 2 ||
    (started as { status?: unknown }).status !== "running" ||
    typeof (started as { operation?: unknown }).operation !== "string" ||
    !operationReference.test((started as { operation: string }).operation)
  )
    throw new Error(`${drill} automation returned an invalid operation`);

  const operation = (started as { operation: string }).operation;
  const statusUrl = new URL(
    `${automationUrl.pathname.replace(/\/?$/u, "/")}${encodeURIComponent(operation)}`,
    automationUrl,
  );
  const token = required("RECOVERY_AUTOMATION_TOKEN");
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let evidence: unknown;
  while (clock() < deadline) {
    await options.beforePoll?.();
    await sleep(Math.min(pollIntervalMs, deadline - clock()));
    if (clock() >= deadline) break;
    const statusResponse = await fetchImplementation(statusUrl, {
      method: "GET",
      redirect: "error",
      signal: requestSignal(),
      headers: { authorization: `Bearer ${token}` },
    });
    if (!statusResponse.ok)
      throw new Error(`${drill} automation status failed`);
    const status = (await statusResponse.json()) as unknown;
    if (typeof status !== "object" || status === null || Array.isArray(status))
      throw new Error(`${drill} automation returned an invalid status`);
    if ((status as { status?: unknown }).status === "running") {
      if (Object.keys(status).length !== 1)
        throw new Error(`${drill} automation returned an invalid status`);
      continue;
    }
    if (
      (status as { status?: unknown }).status === "failed" &&
      Object.keys(status).length === 1
    )
      throw new Error(`${drill} automation failed`);
    if (
      (status as { status?: unknown }).status !== "complete" ||
      Object.keys(status).length !== 2 ||
      !("evidence" in status)
    )
      throw new Error(`${drill} automation returned an invalid status`);
    evidence = (status as { evidence: unknown }).evidence;
    break;
  }
  if (evidence === undefined) throw new Error(`${drill} automation timed out`);
  const validationTime = options.validationNow ?? new Date();
  const failures = validateDrillEvidence(evidence, validationTime);
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    Array.isArray(evidence)
  )
    throw new Error(`${drill} evidence rejected: ${failures.join("; ")}`);
  if ((evidence as { drill?: unknown }).drill !== drill)
    failures.push("automation returned evidence for a different drill");
  if (
    (evidence as { source_point_at?: unknown }).source_point_at !==
    sourcePoint.toISOString()
  )
    failures.push("automation restored a different history point");
  if (failures.length > 0)
    throw new Error(`${drill} evidence rejected: ${failures.join("; ")}`);
  return evidence;
};

if (import.meta.main) {
  const drill = process.argv[2] as DrillKind;
  if (!(["weekly_restore", "quarterly_game_day"] as const).includes(drill))
    throw new Error("expected weekly_restore or quarterly_game_day");
  const beforePoll =
    drill === "quarterly_game_day"
      ? (
          await import("./refresh-recovery-game-day-credentials")
        ).makeRecoveryGameDayCredentialRefresher()
      : undefined;
  const evidence = await runRecoveryDrill(
    drill,
    beforePoll === undefined ? {} : { beforePoll, beforeStart: beforePoll },
  );
  const output = process.env.RECOVERY_EVIDENCE_PATH ?? `${drill}.json`;
  await Bun.write(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.info(JSON.stringify({ drill, evidence: output, status: "complete" }));
}
