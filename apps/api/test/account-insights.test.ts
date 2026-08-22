import type { AccountInsights } from "@whatsapp-mcp/db/account-insights";
import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  AccountInsightsClock,
  AccountInsightsPersistence,
  AccountInsightsPersistenceError,
  createAccountInsightsHandler,
} from "../src/account-insights";
import {
  HumanIdentity,
  InvalidHumanIdentity,
} from "../src/auth/human-identity";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";

const browserOrigin = "https://app.example.test";
const generatedAt = new Date("2026-08-22T18:00:00.000Z");

const safeInsights: AccountInsights = {
  authorizations: { active: 1 },
  connections: { connected: 1, needsAttention: 1, total: 2 },
  conversations: { active: 3, direct: 8, group: 2, total: 10 },
  generatedAt,
  messages: {
    inbound: 24,
    outbound: 8,
    previousInbound: 18,
    previousOutbound: 6,
  },
  sends: { confirmed: 7, failed: 0, unknown: 1 },
  series: [
    { date: "2026-08-21", inbound: 10, outbound: 3 },
    { date: "2026-08-22", inbound: 14, outbound: 5 },
  ],
  windowDays: 30,
};

const makeHandler = (options: { readonly unavailable?: boolean } = {}) => {
  const telemetry: SafeTelemetryEvent[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(HumanIdentity, {
      verify: (request) =>
        request.headers.get("authorization") === "Bearer owner"
          ? Effect.succeed("user_owner")
          : Effect.fail(new InvalidHumanIdentity()),
      verifyRecently: () => Effect.die("not used"),
    }),
    Layer.succeed(AccountInsightsClock, {
      now: Effect.succeed(generatedAt),
    }),
    Layer.succeed(AccountInsightsPersistence, {
      read: (clerkUserId) =>
        options.unavailable
          ? Effect.fail(new AccountInsightsPersistenceError())
          : Effect.succeed(clerkUserId === "user_owner" ? safeInsights : null),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) => Effect.sync(() => telemetry.push(event)),
    }),
  );
  return {
    handler: createAccountInsightsHandler(layer, browserOrigin),
    telemetry,
  };
};

const request = (authorization = "Bearer owner", origin = browserOrigin) =>
  new Request("https://api.example.test/v1/personal-account/insights", {
    headers: { authorization, origin },
  });

describe("Account insights product boundary", () => {
  test("returns only aggregate counts for the owning Personal Account", async () => {
    const harness = makeHandler();
    const response = await harness.handler(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      authorizations: { active: 1 },
      connections: { connected: 1, needs_attention: 1, total: 2 },
      conversations: { active: 3, direct: 8, group: 2, total: 10 },
      generated_at: "2026-08-22T18:00:00.000Z",
      messages: {
        inbound: 24,
        outbound: 8,
        previous_inbound: 18,
        previous_outbound: 6,
      },
      sends: { confirmed: 7, failed: 0, unknown: 1 },
      series: [
        { date: "2026-08-21", inbound: 10, outbound: 3 },
        { date: "2026-08-22", inbound: 14, outbound: 5 },
      ],
      window_days: 30,
    });
    expect(JSON.stringify(body)).not.toMatch(
      /phone|credential|token|payload|provider|tenant|ciphertext|content/iu,
    );
    expect(harness.telemetry).toEqual([
      {
        event: "account_insights.review.completed",
        inboundCount: 24,
        outboundCount: 8,
        service: "api",
        windowDays: 30,
      },
    ]);
  });

  test("does not disclose invalid identities, origins, or persistence failures", async () => {
    expect((await makeHandler().handler(request("Bearer other"))).status).toBe(
      404,
    );
    expect(
      (
        await makeHandler().handler(
          request("Bearer owner", "https://evil.test"),
        )
      ).status,
    ).toBe(404);
    expect(
      (await makeHandler({ unavailable: true }).handler(request())).status,
    ).toBe(503);
    expect(
      (
        await makeHandler().handler(
          new Request(
            "https://api.example.test/v1/personal-account/insights?window=7",
            {
              headers: { authorization: "Bearer owner", origin: browserOrigin },
            },
          ),
        )
      ).status,
    ).toBe(400);
  });
});
