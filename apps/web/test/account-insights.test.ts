import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_INSIGHTS_WINDOW_DAYS,
  decodeAccountInsights,
  describeAccountInsights,
} from "../src/app/account-insights";

const series = Array.from(
  { length: ACCOUNT_INSIGHTS_WINDOW_DAYS },
  (_, index) => {
    const day = new Date(Date.UTC(2026, 6, 24 + index));
    return {
      date: day.toISOString().slice(0, 10),
      inbound: index === ACCOUNT_INSIGHTS_WINDOW_DAYS - 1 ? 4 : 0,
      outbound: index === ACCOUNT_INSIGHTS_WINDOW_DAYS - 1 ? 1 : 0,
    };
  },
);

const validBody = {
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
  series,
  window_days: 30,
};

describe("account insights decoder", () => {
  test("accepts the closed aggregate allowlist", () => {
    const decoded = decodeAccountInsights(validBody);
    expect(decoded).toMatchObject({
      authorizations: { active: 1 },
      connections: { connected: 1, needsAttention: 1, total: 2 },
      messages: {
        inbound: 24,
        outbound: 8,
        previousInbound: 18,
        previousOutbound: 6,
      },
      windowDays: 30,
    });
    expect(decoded?.series).toHaveLength(30);
  });

  test("rejects content-bearing or short payloads", () => {
    expect(
      decodeAccountInsights({
        ...validBody,
        messages: { ...validBody.messages, preview: "hello" },
      }),
    ).toBeNull();
    expect(
      decodeAccountInsights({
        ...validBody,
        series: validBody.series.slice(0, 7),
      }),
    ).toBeNull();
    expect(decodeAccountInsights({ error: "unavailable" })).toBeNull();
  });
});

describe("account insights copy", () => {
  test("writes non-technical headlines and period changes", () => {
    const decoded = decodeAccountInsights(validBody);
    expect(decoded).not.toBeNull();
    if (decoded === null) throw new Error("expected insights");
    const copy = describeAccountInsights(decoded);
    expect(copy.headline).toBe(
      "In the last 30 days, 24 messages arrived and 8 messages went out.",
    );
    expect(copy.connection).toBe("1 of 2 WhatsApp numbers connected");
    expect(copy.conversation).toBe(
      "3 chats were active this week, including 2 groups",
    );
    expect(copy.apps).toBe("1 app can use WhatsApp");
    expect(copy.inboundChange).toBe(
      "33% more incoming than the previous 30 days.",
    );
    expect(copy.sendNote).toBe("1 send is still unconfirmed.");
    expect(copy.headline).not.toMatch(/MCP|API|provider|payload/iu);
  });

  test("explains an empty connected account without technical jargon", () => {
    const empty = decodeAccountInsights({
      ...validBody,
      connections: { connected: 1, needs_attention: 0, total: 1 },
      conversations: { active: 0, direct: 0, group: 0, total: 0 },
      messages: {
        inbound: 0,
        outbound: 0,
        previous_inbound: 0,
        previous_outbound: 0,
      },
      sends: { confirmed: 0, failed: 0, unknown: 0 },
      series: series.map((point) => ({ ...point, inbound: 0, outbound: 0 })),
    });
    expect(empty).not.toBeNull();
    if (empty === null) throw new Error("expected empty insights");
    const copy = describeAccountInsights(empty);
    expect(copy.headline).toBe(
      "Your WhatsApp is connected. New chats will show up here as they arrive.",
    );
    expect(copy.connection).toBe("1 WhatsApp number connected");
    expect(copy.conversation).toBe("No chats observed yet");
    expect(copy.sendNote).toBeNull();
  });
});
