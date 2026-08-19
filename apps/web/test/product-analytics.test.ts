import { afterEach, describe, expect, test } from "bun:test";
import {
  captureProductAnalyticsEvent,
  configureProductAnalytics,
  isAllowlistedProductAnalyticsEvent,
  type ProductAnalyticsEvent,
  parseProductAnalyticsConfiguration,
} from "../src/effect/product-analytics";

const originalFetch = globalThis.fetch;

afterEach(() => {
  configureProductAnalytics(null);
  globalThis.fetch = originalFetch;
});

describe("product analytics boundary", () => {
  test("parses only bare HTTPS PostHog origins with a project key", () => {
    expect(
      parseProductAnalyticsConfiguration({
        host: "https://us.i.posthog.com",
        projectKey: "phc_example",
      }),
    ).toEqual({
      host: "https://us.i.posthog.com",
      projectKey: "phc_example",
    });
    expect(
      parseProductAnalyticsConfiguration({
        host: "http://us.i.posthog.com",
        projectKey: "phc_example",
      }),
    ).toBeNull();
    expect(
      parseProductAnalyticsConfiguration({
        host: "https://us.i.posthog.com/path",
        projectKey: "phc_example",
      }),
    ).toBeNull();
    expect(
      parseProductAnalyticsConfiguration({
        host: "https://us.i.posthog.com",
        projectKey: "",
      }),
    ).toBeNull();
    expect(parseProductAnalyticsConfiguration({})).toBeNull();
  });

  test("serializes only allowlisted events and bounded properties", async () => {
    const requests: Array<{ body: unknown; url: string }> = [];
    globalThis.fetch = ((input, init) => {
      requests.push({
        body: JSON.parse(String(init?.body)) as unknown,
        url: String(input),
      });
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;
    configureProductAnalytics({
      host: "https://us.i.posthog.com",
      projectKey: "phc_example",
    });

    const allowed: ProductAnalyticsEvent = {
      event: "onboarding_stage_viewed",
      stage: "welcome",
    };
    expect(isAllowlistedProductAnalyticsEvent(allowed)).toBe(true);
    expect(
      isAllowlistedProductAnalyticsEvent({
        ...allowed,
        personal_account_id: "account-secret",
      }),
    ).toBe(false);
    expect(
      isAllowlistedProductAnalyticsEvent({
        event: "connection_setup_completed",
        outcome: "provider_error",
      }),
    ).toBe(false);
    expect(
      isAllowlistedProductAnalyticsEvent({
        durationMs: 320,
        event: "connection_setup_timing_recorded",
        phase: "start_to_code_observed",
      }),
    ).toBe(true);

    captureProductAnalyticsEvent(allowed);
    captureProductAnalyticsEvent({
      durationMs: 320,
      event: "connection_setup_timing_recorded",
      phase: "start_to_code_observed",
    });
    captureProductAnalyticsEvent({
      event: "onboarding_completed",
      email: "user@example.test",
    } as ProductAnalyticsEvent);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("https://us.i.posthog.com/capture/");
    expect(requests[0]?.body).toMatchObject({
      api_key: "phc_example",
      event: "onboarding_stage_viewed",
      properties: {
        $process_person_profile: false,
        stage: "welcome",
      },
    });
    expect(requests[1]?.body).toMatchObject({
      api_key: "phc_example",
      event: "connection_setup_timing_recorded",
      properties: {
        $process_person_profile: false,
        durationMs: 320,
        phase: "start_to_code_observed",
      },
    });
    const body = requests[0]?.body as {
      readonly distinct_id?: unknown;
      readonly properties?: {
        readonly $session_id?: unknown;
        readonly distinct_id?: unknown;
      };
    };
    expect(body.distinct_id).toBeUndefined();
    expect(body.properties?.distinct_id).toBeString();
    expect(body.properties?.distinct_id).toBe(body.properties?.$session_id);
    expect(JSON.stringify(requests)).not.toMatch(
      /clerk|email|personal_account|whatsapp|phone|message|qr|provider/iu,
    );
  });

  test("swallows capture failures so onboarding can continue", () => {
    globalThis.fetch = (() => {
      throw new Error("analytics unavailable");
    }) as unknown as typeof fetch;
    configureProductAnalytics({
      host: "https://us.i.posthog.com",
      projectKey: "phc_example",
    });
    expect(() =>
      captureProductAnalyticsEvent({ event: "onboarding_completed" }),
    ).not.toThrow();
  });

  test("allowlists the prominent ChatGPT onboarding action without identifying properties", async () => {
    const requests: Array<unknown> = [];
    globalThis.fetch = ((_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as unknown);
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;
    configureProductAnalytics({
      host: "https://us.i.posthog.com",
      projectKey: "phc_example",
    });
    const action: ProductAnalyticsEvent = {
      event: "feature_used",
      feature: "onboarding_chatgpt_opened",
    };

    expect(isAllowlistedProductAnalyticsEvent(action)).toBe(true);
    expect(
      isAllowlistedProductAnalyticsEvent({
        ...action,
        connection_id: "con_secret",
        server_url: "https://api.example.test/mcp",
        user_id: "user_secret",
      }),
    ).toBe(false);

    captureProductAnalyticsEvent(action);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      event: "feature_used",
      properties: {
        feature: "onboarding_chatgpt_opened",
        $process_person_profile: false,
      },
    });
    expect(JSON.stringify(requests)).not.toMatch(
      /connection_id|server_url|user_id/iu,
    );
  });

  test("does not capture when analytics is unconfigured", () => {
    let requests = 0;
    globalThis.fetch = (() => {
      requests += 1;
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;
    captureProductAnalyticsEvent({ event: "onboarding_security_reached" });
    expect(requests).toBe(0);
  });
});
