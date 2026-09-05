import { describe, expect, test, vi } from "vitest";
import worker, { createScheduledHandler } from "../src/index";

const replayResult = {
  apiKeyDigestsCleared: 0,
  apiKeysRevoked: 0,
  deletedEntityCount: 0,
  deletedIdentifierCountRemaining: 0,
  expiredRecordCount: 0,
  markerCount: 0,
  objectDeletionCount: 0,
  recipientTransitionCount: 0,
  unresolvedRecipientPrefixCount: 0,
};

const environment = (branchId: string) =>
  ({
    DELETION_MARKERS: {},
    DELETION_MARKER_HMAC_SECRET: "ab".repeat(32),
    DEPLOYMENT_ENVIRONMENT: "production",
    NEON_BRANCH_ID: branchId,
    RECIPIENT_TRANSITIONS: {},
    RECIPIENT_TRANSITION_HMAC_SECRET: "cd".repeat(32),
    RESTORE_DATABASE_URL:
      "postgresql://whatsapp_restore_runtime:secret@ep-test.neon.tech/database?sslmode=require",
    STORED_MEDIA: {},
    WEBHOOK_INGRESS: {},
  }) as unknown as Parameters<ReturnType<typeof createScheduledHandler>>[1];

const controller = {
  scheduledTime: Date.parse("2026-09-05T12:00:00.000Z"),
} as ScheduledController;

describe("restore coordinator entrypoint", () => {
  test("exposes only the scheduled replay boundary", () => {
    expect(Object.keys(worker)).toEqual(["scheduled"]);
  });

  test("skips repeated completed replay for the same warm-isolate branch", async () => {
    const replay = vi.fn(async () => replayResult);
    const scheduled = createScheduledHandler({ replay });

    await scheduled(
      controller,
      environment("br-serving"),
      {} as ExecutionContext,
    );
    await scheduled(
      controller,
      environment("br-serving"),
      {} as ExecutionContext,
    );

    expect(replay).toHaveBeenCalledTimes(1);
  });

  test("retries failures and never shares completion across branches", async () => {
    const replay = vi
      .fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(replayResult);
    const scheduled = createScheduledHandler({ replay });

    await expect(
      scheduled(controller, environment("br-a"), {} as ExecutionContext),
    ).rejects.toThrow("database unavailable");
    await scheduled(controller, environment("br-a"), {} as ExecutionContext);
    await scheduled(controller, environment("br-b"), {} as ExecutionContext);

    expect(replay).toHaveBeenCalledTimes(3);
  });

  test("invalidates an older completion when a different branch fails", async () => {
    const replay = vi
      .fn()
      .mockResolvedValueOnce(replayResult)
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(replayResult);
    const scheduled = createScheduledHandler({ replay });

    await scheduled(controller, environment("br-a"), {} as ExecutionContext);
    await expect(
      scheduled(controller, environment("br-b"), {} as ExecutionContext),
    ).rejects.toThrow("database unavailable");
    await scheduled(controller, environment("br-a"), {} as ExecutionContext);

    expect(replay).toHaveBeenCalledTimes(3);
  });
});
