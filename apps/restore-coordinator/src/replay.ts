import {
  type DeletionMarkerStore,
  deriveDeletionMarkerId,
} from "@whatsapp-mcp/api/deletion/marker";
import {
  deriveRecipientJournalPrefix,
  listJournalPrefixes,
  type RecipientJournalBucket,
  readTransitions,
} from "@whatsapp-mcp/api/recipient/journal";
import type {
  RestoreObjectDeletion,
  RestoreRepository,
} from "@whatsapp-mcp/db/restore";
import { Effect, type Redacted } from "effect";

export type RestoreObjectDeletionHandler = (
  deletion: RestoreObjectDeletion,
) => Promise<void>;

const recipientScanBatch = 500;

// Every restored recipient identity is checked against the append only journal
// before traffic reopens. Any failure propagates and leaves the readiness gate
// closed, because there is no sampled or best-effort replay.
const replayRecipientTransitions = async (input: {
  readonly environment: "development" | "preview" | "production";
  readonly journal: RecipientJournalBucket;
  readonly observedAt: string;
  readonly recipientHmacSecret: Redacted.Redacted<string>;
  readonly repository: RestoreRepository;
}) => {
  const unresolvedPrefixes = new Set(await listJournalPrefixes(input.journal));
  let cursorKey: string | null = null;
  let recipientTransitionCount = 0;
  for (;;) {
    const identities: Awaited<
      ReturnType<RestoreRepository["listRecipientIdentities"]>
    > = await input.repository.listRecipientIdentities(
      recipientScanBatch,
      cursorKey,
    );
    for (const identity of identities) {
      const prefix = await deriveRecipientJournalPrefix(
        input.environment,
        input.recipientHmacSecret,
        identity.whatsappConnectionId,
        identity.recipientKind,
        identity.recipientLocator,
      );
      unresolvedPrefixes.delete(prefix);
      for (const transition of await readTransitions(input.journal, prefix)) {
        if (
          !(await input.repository.replayRecipientTransition({
            ...identity,
            ...transition,
            observedAt: input.observedAt,
          }))
        ) {
          continue;
        }
        recipientTransitionCount += 1;
      }
    }
    if (identities.length < recipientScanBatch) break;
    const last = identities.at(-1);
    if (last === undefined || last.scanKey === cursorKey) break;
    cursorKey = last.scanKey;
  }
  for (;;) {
    const removed = await input.repository.purgeExcludedRecipientHistory(
      input.observedAt,
      1000,
    );
    if (removed < 1000) break;
  }
  // Evidence the snapshot has no identity for stays recorded so the API can
  // reapply it when the WhatsApp Directory projects that recipient again.
  const unresolvedPrefixCount =
    await input.repository.recordUnresolvedRecipientPrefixes(
      [...unresolvedPrefixes],
      input.observedAt,
    );
  return { recipientTransitionCount, unresolvedPrefixCount };
};

export const replayRestore = async (input: {
  readonly branchId: string;
  readonly currentTime?: () => string;
  readonly handleObjectDeletion: RestoreObjectDeletionHandler;
  readonly environment: "development" | "preview" | "production";
  readonly hmacSecret: Redacted.Redacted<string>;
  readonly markers: DeletionMarkerStore;
  readonly observedAt: string;
  readonly recipientHmacSecret: Redacted.Redacted<string>;
  readonly recipientJournal: RecipientJournalBucket;
  readonly requireVerification?: boolean;
  readonly repository: RestoreRepository;
}) => {
  const candidates = await input.repository.begin(
    input.branchId,
    input.observedAt,
    input.requireVerification ?? false,
  );
  if (
    candidates.length === 0 &&
    (await input.repository.isReplayComplete(input.branchId))
  ) {
    return {
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
  }
  const markerReferences = await Effect.runPromise(input.markers.enumerate());
  const markers = new Map(
    markerReferences.map((reference) => [reference.markerId, reference]),
  );
  let deletedEntityCount = 0;
  let deletedIdentifierCountRemaining = 0;
  for (const candidate of candidates) {
    const markerId = await deriveDeletionMarkerId(
      input.environment,
      input.hmacSecret,
      candidate.deletionKind,
      candidate.opaqueEntityId,
    );
    const marker = markers.get(markerId);
    if (marker?.marker.deletionKind !== candidate.deletionKind) continue;
    if (
      await input.repository.replayDeletion({
        ...candidate,
        markerId,
        observedAt: input.observedAt,
      })
    ) {
      deletedEntityCount += 1;
    } else {
      deletedIdentifierCountRemaining += 1;
    }
  }

  const recipients = await replayRecipientTransitions({
    environment: input.environment,
    journal: input.recipientJournal,
    observedAt: input.observedAt,
    recipientHmacSecret: input.recipientHmacSecret,
    repository: input.repository,
  });

  let expiredRecordCount = 0;
  let latestObservedAt = input.observedAt;
  const purgeExpired = async () => {
    let total = 0;
    const observedAt = input.currentTime?.() ?? input.observedAt;
    latestObservedAt = observedAt;
    for (;;) {
      const purged = await input.repository.purgeExpired(observedAt, 1000);
      total += purged;
      if (purged < 1000) return total;
    }
  };
  expiredRecordCount += await purgeExpired();
  // Restored API Keys must lose every digest before readiness. Incomplete
  // batches leave the gate closed because complete_restore_replay fails
  // while any authenticable grant remains.
  let apiKeysRevoked = 0;
  let apiKeyDigestsCleared = 0;
  for (;;) {
    const invalidated = await input.repository.invalidateApiKeys(
      input.observedAt,
      1000,
    );
    apiKeysRevoked += invalidated.revoked;
    apiKeyDigestsCleared += invalidated.digestsCleared;
    if (invalidated.revoked < 1000 && invalidated.digestsCleared < 1000) break;
  }
  const drainObjectDeletions = async () => {
    let total = 0;
    for (;;) {
      const deletions = await input.repository.listObjectDeletions(1000);
      for (const deletion of deletions) {
        await input.handleObjectDeletion(deletion);
        await input.repository.finishObjectDeletion(deletion);
        total += 1;
      }
      if (deletions.length < 1000) return total;
    }
  };
  let objectDeletionCount = await drainObjectDeletions();
  // Drills use a live clock so content that expires during a long replay is
  // purged, and any resulting object intents are drained, immediately before
  // readiness is recorded.
  expiredRecordCount += await purgeExpired();
  objectDeletionCount += await drainObjectDeletions();
  await input.repository.complete({
    branchId: input.branchId,
    completedAt: latestObservedAt,
    deletedEntityCount,
    expiredRecordCount,
    markerCount: markerReferences.length,
  });
  return {
    apiKeyDigestsCleared,
    apiKeysRevoked,
    deletedEntityCount,
    deletedIdentifierCountRemaining,
    expiredRecordCount,
    markerCount: markerReferences.length,
    objectDeletionCount,
    recipientTransitionCount: recipients.recipientTransitionCount,
    unresolvedRecipientPrefixCount: recipients.unresolvedPrefixCount,
  };
};
