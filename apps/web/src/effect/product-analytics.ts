export type ProductAnalyticsEvent =
  | {
      event: "onboarding_stage_viewed";
      stage:
        | "welcome"
        | "profile"
        | "security"
        | "connection_setup"
        | "success";
    }
  | {
      event: "onboarding_stage_completed";
      stage:
        | "welcome"
        | "profile"
        | "security"
        | "connection_setup"
        | "success";
    }
  | { event: "onboarding_profile_completed" }
  | { event: "onboarding_security_reached" }
  | { event: "connection_setup_started" }
  | {
      event: "connection_setup_completed";
      outcome: "success" | "failed" | "cancelled" | "capacity_unavailable";
    }
  | { event: "onboarding_completed" }
  | {
      event: "feature_used";
      feature:
        | "additional_connection_setup"
        | "mcp_guide_opened"
        | "activity_logs_viewed";
    };

export interface ProductAnalytics {
  readonly capture: (event: ProductAnalyticsEvent) => void;
}

export interface ProductAnalyticsConfiguration {
  readonly host: string;
  readonly projectKey: string;
}

const allowedEventNames = new Set<ProductAnalyticsEvent["event"]>([
  "onboarding_stage_viewed",
  "onboarding_stage_completed",
  "onboarding_profile_completed",
  "onboarding_security_reached",
  "connection_setup_started",
  "connection_setup_completed",
  "onboarding_completed",
  "feature_used",
]);

const onboardingStages = new Set([
  "welcome",
  "profile",
  "security",
  "connection_setup",
  "success",
]);
const connectionSetupOutcomes = new Set([
  "success",
  "failed",
  "cancelled",
  "capacity_unavailable",
]);
const features = new Set([
  "additional_connection_setup",
  "mcp_guide_opened",
  "activity_logs_viewed",
]);

const hasExactKeys = (
  value: object,
  expected: ReadonlyArray<string>,
): boolean => {
  const actual = Object.keys(value).sort();
  const expectedSorted = [...expected].sort();
  return (
    actual.length === expectedSorted.length &&
    actual.every((key, index) => key === expectedSorted[index])
  );
};

const decodeEvent = (value: unknown): ProductAnalyticsEvent | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const event = value as Record<string, unknown>;
  if (
    typeof event.event !== "string" ||
    !allowedEventNames.has(event.event as ProductAnalyticsEvent["event"])
  ) {
    return null;
  }
  if (
    event.event === "onboarding_stage_viewed" ||
    event.event === "onboarding_stage_completed"
  ) {
    return hasExactKeys(event, ["event", "stage"]) &&
      typeof event.stage === "string" &&
      onboardingStages.has(event.stage)
      ? (event as unknown as ProductAnalyticsEvent)
      : null;
  }
  if (event.event === "connection_setup_completed") {
    return hasExactKeys(event, ["event", "outcome"]) &&
      typeof event.outcome === "string" &&
      connectionSetupOutcomes.has(event.outcome)
      ? (event as unknown as ProductAnalyticsEvent)
      : null;
  }
  if (event.event === "feature_used") {
    return hasExactKeys(event, ["event", "feature"]) &&
      typeof event.feature === "string" &&
      features.has(event.feature)
      ? (event as unknown as ProductAnalyticsEvent)
      : null;
  }
  return hasExactKeys(event, ["event"])
    ? (event as unknown as ProductAnalyticsEvent)
    : null;
};

let configuredAnalytics: ProductAnalyticsConfiguration | null = null;
let ephemeralSessionId: string | null = null;

const randomSessionId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `sess_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
};

const sessionId = (): string => {
  ephemeralSessionId ??= randomSessionId();
  return ephemeralSessionId;
};

export const isAllowlistedProductAnalyticsEvent = (
  event: unknown,
): event is ProductAnalyticsEvent => decodeEvent(event) !== null;

const posthogCapture =
  (configuration: ProductAnalyticsConfiguration): ProductAnalytics["capture"] =>
  (event) => {
    if (!isAllowlistedProductAnalyticsEvent(event)) return;
    const { event: eventName, ...properties } = event;
    const distinctId = sessionId();
    const body = {
      api_key: configuration.projectKey,
      event: eventName,
      properties: {
        ...properties,
        $process_person_profile: false,
        $session_id: distinctId,
        distinct_id: distinctId,
      },
    };
    void fetch(new URL("/capture/", configuration.host), {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      keepalive: true,
      method: "POST",
      mode: "cors",
    }).catch(() => undefined);
  };

export const configureProductAnalytics = (
  configuration: ProductAnalyticsConfiguration | null,
): void => {
  configuredAnalytics = configuration;
};

export const parseProductAnalyticsConfiguration = (input: {
  readonly host?: string | undefined;
  readonly projectKey?: string | undefined;
}): ProductAnalyticsConfiguration | null => {
  const projectKey = input.projectKey?.trim() ?? "";
  const hostValue = input.host?.trim() ?? "";
  if (projectKey.length === 0 && hostValue.length === 0) return null;
  if (projectKey.length === 0 || hostValue.length === 0) return null;
  let host: URL;
  try {
    host = new URL(hostValue);
  } catch {
    return null;
  }
  if (
    host.protocol !== "https:" ||
    host.username !== "" ||
    host.password !== "" ||
    host.pathname !== "/" ||
    host.search !== "" ||
    host.hash !== ""
  ) {
    return null;
  }
  return {
    host: host.origin,
    projectKey,
  };
};

export function captureProductAnalyticsEvent(
  event: ProductAnalyticsEvent,
): void {
  try {
    if (configuredAnalytics === null) return;
    const decoded = decodeEvent(event);
    if (decoded === null) return;
    posthogCapture(configuredAnalytics)(decoded);
  } catch {
    // Analytics must never affect the product journey.
  }
}
