import { describe, expect, test, vi } from "vitest";
import { createProductionScheduledHandler } from "../src/production";

describe("API Key retention schedule", () => {
  test("expires and purges API Key metadata in bounded batches", async () => {
    const expiredLimits: Array<number> = [];
    const purgedLimits: Array<number> = [];
    const events: Array<string> = [];
    const info = vi.spyOn(console, "info").mockImplementation((event) => {
      events.push(String(event));
    });
    let expirePage = 0;
    let purgePage = 0;
    const handler = createProductionScheduledHandler(
      {
        HYPERDRIVE: { connectionString: "test-connection-string" },
        NEON_BRANCH_ID: "br-test",
      },
      {
        makeGroupRepository: () => ({ claim: async () => [] }),
        expireApiKeyCredentials: async (limit) => {
          expiredLimits.push(limit);
          expirePage += 1;
          return expirePage === 1 ? 500 : 2;
        },
        purgeExpiredApiKeyMetadata: async (limit) => {
          purgedLimits.push(limit);
          purgePage += 1;
          return purgePage === 1 ? 500 : 1;
        },
        purgeExpiredActivityLogs: async () => 0,
        purgeExpiredMessages: async () => 0,
        purgeExcludedRecipientHistory: async () => 0,
        recoverRecipientExclusions: async () => undefined,
        retainWebhookSources: async () => undefined,
        runMessageSearchBackfill: async () => undefined,
        purgePersonalAccounts: async () => undefined,
      },
    );

    try {
      await handler({
        cron: "0 * * * *",
        scheduledTime: Date.parse("2026-08-17T00:00:00.000Z"),
      } as ScheduledController);
    } finally {
      info.mockRestore();
    }

    expect(expiredLimits).toEqual([500, 500]);
    expect(purgedLimits).toEqual([500, 500]);
    expect(events).toContain(
      JSON.stringify({
        event: "api_key.retention.completed",
        expiredCount: 502,
        purgedCount: 501,
        service: "api",
      }),
    );
    expect(events.join("\n")).not.toMatch(
      /apk_|normal_|digest|credential|personal_account|tenant/iu,
    );
  });

  test("emits zero counts when no API Key metadata is due", async () => {
    const events: Array<string> = [];
    const info = vi.spyOn(console, "info").mockImplementation((event) => {
      events.push(String(event));
    });
    const handler = createProductionScheduledHandler(
      {
        HYPERDRIVE: { connectionString: "test-connection-string" },
        NEON_BRANCH_ID: "br-test",
      },
      {
        makeGroupRepository: () => ({ claim: async () => [] }),
        expireApiKeyCredentials: async () => 0,
        purgeExpiredApiKeyMetadata: async () => 0,
        purgeExpiredActivityLogs: async () => 0,
        purgeExpiredMessages: async () => 0,
        purgeExcludedRecipientHistory: async () => 0,
        recoverRecipientExclusions: async () => undefined,
        retainWebhookSources: async () => undefined,
        runMessageSearchBackfill: async () => undefined,
        purgePersonalAccounts: async () => undefined,
      },
    );

    try {
      await handler({
        cron: "0 * * * *",
        scheduledTime: Date.parse("2026-08-17T01:00:00.000Z"),
      } as ScheduledController);
    } finally {
      info.mockRestore();
    }

    expect(events).toContain(
      JSON.stringify({
        event: "api_key.retention.completed",
        expiredCount: 0,
        purgedCount: 0,
        service: "api",
      }),
    );
  });
});
