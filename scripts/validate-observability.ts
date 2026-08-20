import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const runtimeTelemetryModule = (await import(
  fileURLToPath(new URL("../apps/api/src/safe-telemetry.ts", import.meta.url))
)) as {
  readonly safeTelemetryFieldsByEvent: Readonly<
    Record<string, ReadonlyArray<string>>
  >;
};

const sourceName = z.enum(["workerTelemetry", "cloudflarePlatform"]);
const panel = z.object({
  title: z.string().min(1),
  source: sourceName,
  metric: z.string().min(1),
  filter: z.record(z.string(), z.union([z.string(), z.number()])),
  groupBy: z.array(z.string()),
});
const configSchema = z.object({
  version: z.literal(1),
  environment: z.literal("production"),
  owner: z.object({ team: z.string().min(1), runbook: z.string().min(1) }),
  delivery: z.object({
    channel: z.literal("PAGER_WEBHOOK_URL"),
    receiptChannel: z.literal("PAGER_RECEIPT_URL"),
    receiptEvidence: z.literal("cloudflare-email-final-delivery"),
    payloadFields: z.array(z.string()),
    canary: z.object({
      enabled: z.boolean(),
      schedule: z.string().min(1),
      alert: z.string().min(1),
    }),
  }),
  sources: z.record(sourceName, z.object({ fields: z.array(z.string()) })),
  slos: z.array(
    z.object({
      id: z.string(),
      objective: z.number().nullable(),
      window: z.literal("7d"),
      source: sourceName,
      indicator: z.string(),
      filter: z.record(z.string(), z.string()),
    }),
  ),
  dashboards: z.array(
    z.object({ id: z.string(), panels: z.array(panel).min(1) }),
  ),
  alerts: z.array(
    z.object({
      id: z.string(),
      severity: z.enum(["page", "ticket"]),
      source: sourceName,
      metric: z.string(),
      condition: z.enum(["gt", "gte", "lt", "canary"]),
      filter: z.record(z.string(), z.string()),
      threshold: z.number().nullable(),
      for: z.string(),
    }),
  ),
});

export type ObservabilityConfig = z.infer<typeof configSchema>;

const forbiddenField =
  /(?:account|authorization|connection|contact|content|credential|email|identifier|ip|keyArn|marker|mediaUrl|message|oauthToken|payload|phone|providerId|recipient|session|token|user)/iu;
const requiredDashboardTerms = [
  "Authentication",
  "OAuth",
  "MCP latency",
  "Send ambiguity",
  "Queue lag",
  "Dead letters",
  "webhook rejection",
  "reconciliation drift",
  "Quota",
  "Stored Media",
  "KMS",
  "Deletion",
  "Restore gate",
];
const requiredAlerts = [
  "active-dead-letters",
  "deletion-cleanup-risk",
  "restore-gate-failure",
  "key-failures",
  "quota-pressure",
  "wasender-dependency-outage",
  "whatsapp-dependency-outage",
  "alert-delivery-canary",
] as const;
const expectedAlertPolicies = {
  "active-dead-letters": {
    condition: "gt",
    filter: {},
    for: "0m",
    metric: "deadLetters",
    severity: "page",
    source: "cloudflarePlatform",
    threshold: 0,
  },
  "alert-delivery-canary": {
    condition: "canary",
    filter: {},
    for: "0m",
    metric: "availability",
    severity: "ticket",
    source: "cloudflarePlatform",
    threshold: null,
  },
  "deletion-cleanup-risk": {
    condition: "lt",
    filter: {},
    for: "0m",
    metric: "deletionDeadlineSeconds",
    severity: "page",
    source: "cloudflarePlatform",
    threshold: 21_600,
  },
  "key-failures": {
    condition: "gt",
    filter: {},
    for: "0m",
    metric: "keyFailureCount",
    severity: "page",
    source: "cloudflarePlatform",
    threshold: 0,
  },
  "quota-pressure": {
    condition: "gte",
    filter: {},
    for: "15m",
    metric: "quotaUtilization",
    severity: "ticket",
    source: "cloudflarePlatform",
    threshold: 0.8,
  },
  "restore-gate-failure": {
    condition: "gt",
    filter: {},
    for: "0m",
    metric: "restoreGateFailures",
    severity: "page",
    source: "cloudflarePlatform",
    threshold: 0,
  },
  "wasender-dependency-outage": {
    condition: "lt",
    filter: { dependency: "wasender" },
    for: "5m",
    metric: "availability",
    severity: "page",
    source: "cloudflarePlatform",
    threshold: 0.995,
  },
  "whatsapp-dependency-outage": {
    condition: "lt",
    filter: { dependency: "whatsapp" },
    for: "5m",
    metric: "availability",
    severity: "page",
    source: "cloudflarePlatform",
    threshold: 0.995,
  },
} as const;

const expectedSlos = [
  {
    filter: { dependency: "first-party" },
    id: "first-party-availability",
    indicator: "availability",
    objective: 99.5,
    source: "cloudflarePlatform",
    window: "7d",
  },
  {
    filter: { dependency: "wasender" },
    id: "wasender-availability",
    indicator: "availability",
    objective: null,
    source: "cloudflarePlatform",
    window: "7d",
  },
  {
    filter: { dependency: "whatsapp" },
    id: "whatsapp-availability",
    indicator: "availability",
    objective: null,
    source: "cloudflarePlatform",
    window: "7d",
  },
] as const;

export const loadObservabilityConfig = async (): Promise<ObservabilityConfig> =>
  configSchema.parse(
    JSON.parse(
      await readFile(
        fileURLToPath(
          new URL("../observability/production.json", import.meta.url),
        ),
        "utf8",
      ),
    ),
  );

export const validateObservabilityConfig = (input: unknown): void => {
  const config = configSchema.parse(input);
  const alertIds = new Set(config.alerts.map(({ id }) => id));
  const titles = config.dashboards.flatMap(({ panels }) =>
    panels.map(({ title }) => title),
  );

  for (const term of requiredDashboardTerms) {
    if (
      !titles.some((title) =>
        title
          .toLocaleLowerCase("en-US")
          .includes(term.toLocaleLowerCase("en-US")),
      )
    )
      throw new Error(`missing operational view: ${term}`);
  }
  for (const alert of requiredAlerts) {
    const policy = config.alerts.find(({ id }) => id === alert);
    if (policy === undefined)
      throw new Error(`missing required alert: ${alert}`);
    const { id: _id, ...actualPolicy } = policy;
    if (!isDeepStrictEqual(actualPolicy, expectedAlertPolicies[alert]))
      throw new Error(`required alert ${alert} has drifted`);
  }
  if (!config.delivery.canary.enabled)
    throw new Error("production alert delivery canary must be enabled");
  if (
    config.delivery.receiptChannel !== "PAGER_RECEIPT_URL" ||
    config.delivery.receiptEvidence !== "cloudflare-email-final-delivery"
  )
    throw new Error("pager acceptance must have final delivery evidence");
  if (!alertIds.has(config.delivery.canary.alert))
    throw new Error("alert delivery canary must target a declared alert");
  if (
    config.delivery.payloadFields.join(",") !==
    "alert,severity,status,observedAt"
  )
    throw new Error("alert delivery payload must remain identity-free");

  if (!isDeepStrictEqual(config.slos, expectedSlos))
    throw new Error("availability SLO definitions have drifted");

  const runtimeFields = new Set<string>(
    Object.values(runtimeTelemetryModule.safeTelemetryFieldsByEvent).flat(),
  );
  for (const field of config.sources.workerTelemetry.fields) {
    if (!runtimeFields.has(field))
      throw new Error(`field ${field} is not runtime telemetry-allowlisted`);
  }

  for (const dashboard of config.dashboards) {
    for (const item of dashboard.panels) {
      const allowed = new Set(config.sources[item.source].fields);
      for (const field of [
        item.metric,
        ...item.groupBy,
        ...Object.keys(item.filter),
      ]) {
        if (field !== "count" && !allowed.has(field))
          throw new Error(`field ${field} is not telemetry-allowlisted`);
        if (forbiddenField.test(field))
          throw new Error(`field ${field} may carry User or content identity`);
      }
    }
  }
  for (const alert of config.alerts) {
    if (!config.sources[alert.source].fields.includes(alert.metric))
      throw new Error(`alert metric ${alert.metric} is not allowlisted`);
    for (const field of Object.keys(alert.filter)) {
      if (!config.sources[alert.source].fields.includes(field))
        throw new Error(`alert filter ${field} is not allowlisted`);
    }
  }
};

if (import.meta.main) {
  validateObservabilityConfig(await loadObservabilityConfig());
  console.info("Production observability configuration is valid.");
}
