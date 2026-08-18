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
import type { RestoreRepository } from "@whatsapp-mcp/db/restore";
import { Effect, type Redacted } from "effect";

export interface RestoreBuckets {
  readonly stored_media: Pick<R2Bucket, "delete">;
  readonly webhook_ingress: Pick<R2Bucket, "delete">;
}

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
  readonly buckets: RestoreBuckets;
  readonly environment: "development" | "preview" | "production";
  readonly hmacSecret: Redacted.Redacted<string>;
  readonly markers: DeletionMarkerStore;
  readonly observedAt: string;
  readonly recipientHmacSecret: Redacted.Redacted<string>;
  readonly recipientJournal: RecipientJournalBucket;
  readonly repository: RestoreRepository;
}) => {
  const [candidates, markerReferences] = await Promise.all([
    input.repository.begin(input.branchId, input.observedAt),
    Effect.runPromise(input.markers.enumerate()),
  ]);
  const markers = new Map(
    markerReferences.map((reference) => [reference.markerId, reference]),
  );
  let deletedEntityCount = 0;
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
  for (;;) {
    const purged = await input.repository.purgeExpired(input.observedAt, 1000);
    expiredRecordCount += purged;
    if (purged < 1000) break;
  }
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
  for (;;) {
    const deletions = await input.repository.listObjectDeletions(1000);
    for (const deletion of deletions) {
      await input.buckets[deletion.bucket].delete(deletion.objectKey);
      await input.repository.finishObjectDeletion(deletion);
    }
    if (deletions.length < 1000) break;
  }
  await input.repository.complete({
    branchId: input.branchId,
    completedAt: input.observedAt,
    deletedEntityCount,
    expiredRecordCount,
    markerCount: markerReferences.length,
  });
  return {
    apiKeyDigestsCleared,
    apiKeysRevoked,
    deletedEntityCount,
    expiredRecordCount,
    markerCount: markerReferences.length,
    recipientTransitionCount: recipients.recipientTransitionCount,
    unresolvedRecipientPrefixCount: recipients.unresolvedPrefixCount,
  };
};
