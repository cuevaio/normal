import { deriveDeletionMarkerId } from "@whatsapp-mcp/api/deletion/marker";
import {
  deriveRecipientJournalPrefix,
  type RecipientJournalBucket,
} from "@whatsapp-mcp/api/recipient/journal";
import type {
  RestoreRecipientIdentity,
  RestoreRepository,
} from "@whatsapp-mcp/db/restore";
import { Effect, Redacted } from "effect";
import { describe, expect, test, vi } from "vitest";
import { replayRestore } from "../src/replay";

const connectionId = "20000000-0000-4000-8000-000000000001";
const recipientLocator = `di1_${"A".repeat(43)}`;

const emptyJournal: RecipientJournalBucket = {
  get: async () => null,
  list: async () => ({ objects: [], truncated: false }),
  put: async () => null,
};

describe("restore replay", () => {
  test("re-purges a matching locked marker, expiry, and objects before readiness", async () => {
    const secret = Redacted.make("ab".repeat(32));
    const markerId = await deriveDeletionMarkerId(
      "production",
      secret,
      "personal_account",
      "10000000-0000-4000-8000-000000000001",
    );
    const calls: string[] = [];
    const result = await replayRestore({
      branchId: "br-restored",
      environment: "production",
      hmacSecret: secret,
      observedAt: "2026-08-03T12:00:00.000Z",
      recipientHmacSecret: Redacted.make("cd".repeat(32)),
      recipientJournal: emptyJournal,
      markers: {
        create: vi.fn(),
        enumerate: () =>
          Effect.succeed([
            {
              markerId,
              objectKey: `markers/v1/${markerId}.json`,
              marker: {
                version: 1,
                deletionKind: "personal_account",
                requestedAt: "2026-08-01T00:00:00.000Z",
                keyUnavailableAt: "2026-08-01T00:01:00.000Z",
              },
            },
          ]),
      },
      buckets: {
        stored_media: {
          delete: async () => {
            calls.push("delete-object");
          },
        },
        webhook_ingress: {
          delete: async () => {
            calls.push("delete-webhook");
          },
        },
      },
      repository: {
        begin: async () => [
          {
            deletionKind: "personal_account",
            opaqueEntityId: "10000000-0000-4000-8000-000000000001",
          },
        ],
        replayDeletion: async () => {
          calls.push("replay-marker");
          return true;
        },
        listRecipientIdentities: async () => [],
        purgeExcludedRecipientHistory: async () => {
          calls.push("purge-excluded");
          return 0;
        },
        recordUnresolvedRecipientPrefixes: async () => 0,
        replayRecipientTransition: async () => true,
        invalidateApiKeys: async () => {
          calls.push("invalidate-api-keys");
          return { digestsCleared: 3, revoked: 3 };
        },
        purgeExpired: async () => {
          calls.push("expire");
          return 2;
        },
        listObjectDeletions: async () =>
          calls.includes("delete-object")
            ? []
            : [{ bucket: "stored_media", objectKey: "opaque/object" }],
        finishObjectDeletion: async () => {
          calls.push("finish-object");
        },
        complete: async () => {
          calls.push("ready");
        },
      },
    });
    expect(result).toEqual({
      apiKeyDigestsCleared: 3,
      apiKeysRevoked: 3,
      deletedEntityCount: 1,
      expiredRecordCount: 2,
      markerCount: 1,
      recipientTransitionCount: 0,
      unresolvedRecipientPrefixCount: 0,
    });
    expect(calls).toEqual([
      "replay-marker",
      "purge-excluded",
      "expire",
      "invalidate-api-keys",
      "delete-object",
      "finish-object",
      "ready",
    ]);
  });

  test("replays every ordered WhatsApp Recipient Exclusion transition it finds", async () => {
    const recipientSecret = Redacted.make("cd".repeat(32));
    const prefix = await deriveRecipientJournalPrefix(
      "production",
      recipientSecret,
      connectionId,
      "contact",
      recipientLocator,
    );
    const objects: Record<string, string> = {
      [`recipient-transitions/v1/${prefix}/30000000-0000-4000-8000-000000000002.json`]:
        JSON.stringify({
          effectiveAt: "2026-08-02T00:00:00.000Z",
          excluded: false,
          purgeCutoffAt: "2026-08-01T00:00:00.000Z",
          transitionId: "30000000-0000-4000-8000-000000000002",
          version: 1,
        }),
      [`recipient-transitions/v1/${prefix}/30000000-0000-4000-8000-000000000001.json`]:
        JSON.stringify({
          effectiveAt: "2026-08-01T00:00:00.000Z",
          excluded: true,
          purgeCutoffAt: "2026-08-01T00:00:00.000Z",
          transitionId: "30000000-0000-4000-8000-000000000001",
          version: 1,
        }),
    };
    const identity: RestoreRecipientIdentity = {
      personalAccountId: "10000000-0000-4000-8000-000000000001",
      recipientKind: "contact",
      recipientLocator,
      recipientPublicId: "ctc_000000000000000000001",
      scanKey: `${connectionId}/contact/${recipientLocator}`,
      whatsappConnectionId: connectionId,
    };
    const replayed: Array<string> = [];
    const recordedPrefixes: Array<string> = [];
    const repository = {
      begin: async () => [],
      complete: async () => undefined,
      finishObjectDeletion: async () => undefined,
      invalidateApiKeys: async () => ({ digestsCleared: 0, revoked: 0 }),
      listObjectDeletions: async () => [],
      listRecipientIdentities: async (_limit: number, cursor: string | null) =>
        cursor === null ? [identity] : [],
      purgeExcludedRecipientHistory: async () => 0,
      purgeExpired: async () => 0,
      recordUnresolvedRecipientPrefixes: async (
        prefixes: ReadonlyArray<string>,
      ) => {
        recordedPrefixes.push(...prefixes);
        return prefixes.length;
      },
      replayDeletion: async () => false,
      replayRecipientTransition: async (input: { transitionId: string }) => {
        replayed.push(input.transitionId);
        return true;
      },
    } as unknown as RestoreRepository;

    const result = await replayRestore({
      branchId: "br-restored",
      buckets: {
        stored_media: { delete: async () => undefined },
        webhook_ingress: { delete: async () => undefined },
      },
      environment: "production",
      hmacSecret: Redacted.make("ab".repeat(32)),
      markers: { create: vi.fn(), enumerate: () => Effect.succeed([]) },
      observedAt: "2026-08-03T12:00:00.000Z",
      recipientHmacSecret: recipientSecret,
      recipientJournal: {
        get: async (key) => {
          const body = objects[key];
          return body === undefined ? null : { text: async () => body };
        },
        list: async () => ({
          objects: Object.keys(objects).map((key) => ({ key })),
          truncated: false,
        }),
        put: async () => null,
      },
      repository,
    });
    expect(result.recipientTransitionCount).toBe(2);
    // The matched prefix is resolved, so nothing needs later recovery.
    expect(recordedPrefixes).toEqual([]);
    expect(replayed).toEqual([
      "30000000-0000-4000-8000-000000000001",
      "30000000-0000-4000-8000-000000000002",
    ]);
  });

  test("records journal evidence the restored snapshot has no identity for", async () => {
    const recipientSecret = Redacted.make("cd".repeat(32));
    const prefix = await deriveRecipientJournalPrefix(
      "production",
      recipientSecret,
      connectionId,
      "contact",
      recipientLocator,
    );
    const key = `recipient-transitions/v1/${prefix}/30000000-0000-4000-8000-000000000001.json`;
    const recordedPrefixes: Array<string> = [];
    const repository = {
      begin: async () => [],
      complete: async () => undefined,
      finishObjectDeletion: async () => undefined,
      invalidateApiKeys: async () => ({ digestsCleared: 0, revoked: 0 }),
      listObjectDeletions: async () => [],
      // The snapshot predates this recipient, so the scan yields nothing.
      listRecipientIdentities: async () => [],
      purgeExcludedRecipientHistory: async () => 0,
      purgeExpired: async () => 0,
      recordUnresolvedRecipientPrefixes: async (
        prefixes: ReadonlyArray<string>,
      ) => {
        recordedPrefixes.push(...prefixes);
        return prefixes.length;
      },
      replayDeletion: async () => false,
      replayRecipientTransition: async () => true,
    } as unknown as RestoreRepository;

    const result = await replayRestore({
      branchId: "br-restored",
      buckets: {
        stored_media: { delete: async () => undefined },
        webhook_ingress: { delete: async () => undefined },
      },
      environment: "production",
      hmacSecret: Redacted.make("ab".repeat(32)),
      markers: { create: vi.fn(), enumerate: () => Effect.succeed([]) },
      observedAt: "2026-08-03T12:00:00.000Z",
      recipientHmacSecret: recipientSecret,
      recipientJournal: {
        get: async () => ({
          text: async () =>
            JSON.stringify({
              effectiveAt: "2026-08-01T00:00:00.000Z",
              excluded: true,
              purgeCutoffAt: "2026-08-01T00:00:00.000Z",
              transitionId: "30000000-0000-4000-8000-000000000001",
              version: 1,
            }),
        }),
        list: async () => ({ objects: [{ key }], truncated: false }),
        put: async () => null,
      },
      repository,
    });
    expect(recordedPrefixes).toEqual([prefix]);
    expect(result.unresolvedRecipientPrefixCount).toBe(1);
  });

  test("keeps readiness closed when a journal object is malformed", async () => {
    const recipientSecret = Redacted.make("cd".repeat(32));
    const prefix = await deriveRecipientJournalPrefix(
      "production",
      recipientSecret,
      connectionId,
      "contact",
      recipientLocator,
    );
    const key = `recipient-transitions/v1/${prefix}/30000000-0000-4000-8000-000000000001.json`;
    const identity: RestoreRecipientIdentity = {
      personalAccountId: "10000000-0000-4000-8000-000000000001",
      recipientKind: "contact",
      recipientLocator,
      recipientPublicId: "ctc_000000000000000000001",
      scanKey: `${connectionId}/contact/${recipientLocator}`,
      whatsappConnectionId: connectionId,
    };
    let completed = false;
    const repository = {
      begin: async () => [],
      complete: async () => {
        completed = true;
      },
      finishObjectDeletion: async () => undefined,
      invalidateApiKeys: async () => ({ digestsCleared: 0, revoked: 0 }),
      listObjectDeletions: async () => [],
      listRecipientIdentities: async (_limit: number, cursor: string | null) =>
        cursor === null ? [identity] : [],
      purgeExcludedRecipientHistory: async () => 0,
      purgeExpired: async () => 0,
      recordUnresolvedRecipientPrefixes: async () => 0,
      replayDeletion: async () => false,
      replayRecipientTransition: async () => true,
    } as unknown as RestoreRepository;

    await expect(
      replayRestore({
        branchId: "br-restored",
        buckets: {
          stored_media: { delete: async () => undefined },
          webhook_ingress: { delete: async () => undefined },
        },
        environment: "production",
        hmacSecret: Redacted.make("ab".repeat(32)),
        markers: { create: vi.fn(), enumerate: () => Effect.succeed([]) },
        observedAt: "2026-08-03T12:00:00.000Z",
        recipientHmacSecret: recipientSecret,
        recipientJournal: {
          get: async () => ({ text: async () => '{"version":2}' }),
          list: async () => ({ objects: [{ key }], truncated: false }),
          put: async () => null,
        },
        repository,
      }),
    ).rejects.toThrow();
    expect(completed).toBe(false);
  });

  test("drains restored API Key invalidation batches before readiness", async () => {
    const batchSizes = [
      { digestsCleared: 1000, revoked: 1000 },
      { digestsCleared: 2, revoked: 2 },
    ];
    let completed = false;
    const repository = {
      begin: async () => [],
      complete: async () => {
        completed = true;
      },
      finishObjectDeletion: async () => undefined,
      invalidateApiKeys: async () => {
        const next = batchSizes.shift();
        if (next === undefined)
          throw new Error("unexpected extra invalidation");
        return next;
      },
      listObjectDeletions: async () => [],
      listRecipientIdentities: async () => [],
      purgeExcludedRecipientHistory: async () => 0,
      purgeExpired: async () => 0,
      recordUnresolvedRecipientPrefixes: async () => 0,
      replayDeletion: async () => false,
      replayRecipientTransition: async () => true,
    } as unknown as RestoreRepository;

    const result = await replayRestore({
      branchId: "br-restored",
      buckets: {
        stored_media: { delete: async () => undefined },
        webhook_ingress: { delete: async () => undefined },
      },
      environment: "production",
      hmacSecret: Redacted.make("ab".repeat(32)),
      markers: { create: vi.fn(), enumerate: () => Effect.succeed([]) },
      observedAt: "2026-08-03T12:00:00.000Z",
      recipientHmacSecret: Redacted.make("cd".repeat(32)),
      recipientJournal: emptyJournal,
      repository,
    });
    expect(result.apiKeysRevoked).toBe(1002);
    expect(result.apiKeyDigestsCleared).toBe(1002);
    expect(completed).toBe(true);
  });

  test("keeps readiness closed when API Key invalidation fails", async () => {
    let completed = false;
    const repository = {
      begin: async () => [],
      complete: async () => {
        completed = true;
      },
      finishObjectDeletion: async () => undefined,
      invalidateApiKeys: async () => {
        throw new Error("restore api key invalidation evidence is incomplete");
      },
      listObjectDeletions: async () => [],
      listRecipientIdentities: async () => [],
      purgeExcludedRecipientHistory: async () => 0,
      purgeExpired: async () => 0,
      recordUnresolvedRecipientPrefixes: async () => 0,
      replayDeletion: async () => false,
      replayRecipientTransition: async () => true,
    } as unknown as RestoreRepository;

    await expect(
      replayRestore({
        branchId: "br-restored",
        buckets: {
          stored_media: { delete: async () => undefined },
          webhook_ingress: { delete: async () => undefined },
        },
        environment: "production",
        hmacSecret: Redacted.make("ab".repeat(32)),
        markers: { create: vi.fn(), enumerate: () => Effect.succeed([]) },
        observedAt: "2026-08-03T12:00:00.000Z",
        recipientHmacSecret: Redacted.make("cd".repeat(32)),
        recipientJournal: emptyJournal,
        repository,
      }),
    ).rejects.toThrow("restore api key invalidation evidence is incomplete");
    expect(completed).toBe(false);
  });
});
