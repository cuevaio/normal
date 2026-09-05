import { sql } from "drizzle-orm";
import {
  makeDatabase,
  postgresErrorCode,
  postgresTextArray,
  type QueryConnection,
  withPgQueryConnection,
} from "./database";

export interface RestoreCandidate {
  readonly deletionKind: "personal_account" | "whatsapp_connection";
  readonly opaqueEntityId: string;
}

export interface RestoreObjectDeletion {
  readonly bucket: "stored_media" | "webhook_ingress";
  readonly objectKey: string;
}

export interface RestoreRecipientIdentity {
  readonly personalAccountId: string;
  readonly recipientKind: "contact" | "group";
  readonly recipientLocator: string;
  readonly recipientPublicId: string;
  readonly scanKey: string;
  readonly whatsappConnectionId: string;
}

export interface RestoreRecipientTransition {
  readonly effectiveAt: string;
  readonly excluded: boolean;
  readonly purgeCutoffAt: string | null;
  readonly transitionId: string;
}

export interface RestoreRepository {
  readonly begin: (
    branchId: string,
    observedAt: string,
    requireVerification: boolean,
  ) => Promise<ReadonlyArray<RestoreCandidate>>;
  readonly complete: (input: {
    readonly branchId: string;
    readonly completedAt: string;
    readonly deletedEntityCount: number;
    readonly expiredRecordCount: number;
    readonly markerCount: number;
  }) => Promise<void>;
  readonly finishObjectDeletion: (
    deletion: RestoreObjectDeletion,
  ) => Promise<void>;
  readonly invalidateApiKeys: (
    observedAt: string,
    limit: number,
  ) => Promise<{
    readonly digestsCleared: number;
    readonly revoked: number;
  }>;
  readonly isReplayComplete: (branchId: string) => Promise<boolean>;
  readonly listObjectDeletions: (
    limit: number,
  ) => Promise<ReadonlyArray<RestoreObjectDeletion>>;
  readonly listRecipientIdentities: (
    limit: number,
    cursorKey: string | null,
  ) => Promise<ReadonlyArray<RestoreRecipientIdentity>>;
  readonly purgeExcludedRecipientHistory: (
    observedAt: string,
    limit: number,
  ) => Promise<number>;
  readonly purgeExpired: (observedAt: string, limit: number) => Promise<number>;
  readonly recordUnresolvedRecipientPrefixes: (
    prefixes: ReadonlyArray<string>,
    observedAt: string,
  ) => Promise<number>;
  readonly replayDeletion: (
    input: RestoreCandidate & {
      readonly markerId: string;
      readonly observedAt: string;
    },
  ) => Promise<boolean>;
  readonly replayRecipientTransition: (
    input: RestoreRecipientIdentity &
      RestoreRecipientTransition & { readonly observedAt: string },
  ) => Promise<boolean>;
}

const withClient = <Value>(
  connectionString: string,
  use: (client: QueryConnection) => Promise<Value>,
) => withPgQueryConnection(connectionString, use, 30_000, 10_000);

export const makePgRestoreRepository = (
  connectionString: string,
): RestoreRepository => ({
  begin: (branchId, observedAt, requireVerification) =>
    withClient(connectionString, async (client) => {
      const db = makeDatabase(client);
      const result = await db.execute<{
        deletion_kind: RestoreCandidate["deletionKind"];
        opaque_entity_id: string;
      }>(sql`
        SELECT * FROM public.begin_restore_replay(
          ${branchId}, ${observedAt}, ${requireVerification}
        )
      `);
      return result.map((row) => ({
        deletionKind: row.deletion_kind,
        opaqueEntityId: row.opaque_entity_id,
      }));
    }),
  isReplayComplete: (branchId) =>
    withClient(connectionString, async (client) => {
      const result = await makeDatabase(client).execute<{ complete: boolean }>(
        sql`SELECT public.is_restore_replay_complete(${branchId}) AS complete`,
      );
      return result[0]?.complete === true;
    }),
  replayDeletion: (input) =>
    withClient(connectionString, async (client) => {
      const db = makeDatabase(client);
      const result = await db.execute<{ replayed: boolean }>(sql`
        SELECT public.replay_restore_deletion(
          ${input.deletionKind}, ${input.opaqueEntityId}, ${input.markerId},
          ${input.observedAt}
        ) AS replayed
      `);
      return result[0]?.replayed === true;
    }),
  listRecipientIdentities: (limit, cursorKey) =>
    withClient(connectionString, async (client) => {
      const db = makeDatabase(client);
      const result = await db.execute<{
        personal_account_id: string;
        recipient_kind: RestoreRecipientIdentity["recipientKind"];
        recipient_locator: string;
        recipient_public_id: string;
        scan_key: string;
        whatsapp_connection_id: string;
      }>(sql`
        SELECT * FROM public.list_restore_recipient_identities(
          ${limit}, ${cursorKey}
        )
      `);
      return result.map((row) => ({
        personalAccountId: row.personal_account_id,
        recipientKind: row.recipient_kind,
        recipientLocator: row.recipient_locator,
        recipientPublicId: row.recipient_public_id,
        scanKey: row.scan_key,
        whatsappConnectionId: row.whatsapp_connection_id,
      }));
    }),
  replayRecipientTransition: (input) =>
    withClient(connectionString, async (client) => {
      const db = makeDatabase(client);
      const result = await db.execute<{ replayed: boolean }>(sql`
        SELECT public.replay_whatsapp_recipient_exclusion(
          ${input.personalAccountId}, ${input.whatsappConnectionId},
          ${input.recipientKind}, ${input.recipientLocator},
          ${input.recipientPublicId}, ${input.excluded}, ${input.effectiveAt},
          ${input.purgeCutoffAt}, ${input.transitionId}, ${input.observedAt}
        ) AS replayed
      `);
      return result[0]?.replayed === true;
    }),
  recordUnresolvedRecipientPrefixes: (prefixes, observedAt) =>
    withClient(connectionString, async (client) => {
      const db = makeDatabase(client);
      try {
        const result = await db.execute<{ recorded: number }>(sql`
          SELECT public.record_unresolved_recipient_transition_prefixes(
            ${postgresTextArray(prefixes)}, ${observedAt}
          ) AS recorded
        `);
        return Number(result[0]?.recorded ?? 0);
      } catch (error) {
        throw new Error(
          `Recipient transition prefix recording failed with PostgreSQL code ${postgresErrorCode(error)}`,
          { cause: error },
        );
      }
    }),
  purgeExcludedRecipientHistory: (observedAt, limit) =>
    withClient(connectionString, async (client) => {
      const db = makeDatabase(client);
      const result = await db.execute<{ removed: number }>(sql`
        SELECT public.purge_excluded_recipient_history(
          ${observedAt}, ${limit}
        ) AS removed
      `);
      return Number(result[0]?.removed ?? 0);
    }),
  invalidateApiKeys: (observedAt, limit) =>
    withClient(connectionString, async (client) => {
      const db = makeDatabase(client);
      const result = await db.execute<{
        digests_cleared: number;
        revoked: number;
      }>(sql`
        SELECT * FROM public.invalidate_restored_api_keys(
          ${observedAt}, ${limit}
        )
      `);
      return {
        digestsCleared: Number(result[0]?.digests_cleared ?? 0),
        revoked: Number(result[0]?.revoked ?? 0),
      };
    }),
  purgeExpired: (observedAt, limit) =>
    withClient(connectionString, async (client) => {
      const db = makeDatabase(client);
      const result = await db.execute<{ purged: number }>(sql`
        SELECT public.purge_restore_expired(${observedAt}, ${limit}) AS purged
      `);
      return result[0]?.purged ?? 0;
    }),
  listObjectDeletions: (limit) =>
    withClient(connectionString, async (client) => {
      const db = makeDatabase(client);
      const result = await db.execute<{
        bucket: RestoreObjectDeletion["bucket"];
        object_key: string;
      }>(sql`
        SELECT * FROM public.list_restore_object_deletions(${limit})
      `);
      return result.map((row) => ({
        bucket: row.bucket,
        objectKey: row.object_key,
      }));
    }),
  finishObjectDeletion: (deletion) =>
    withClient(connectionString, async (client) => {
      const db = makeDatabase(client);
      await db.execute(sql`
        SELECT public.finish_restore_object_deletion(
          ${deletion.bucket}, ${deletion.objectKey}
        )
      `);
    }),
  complete: (input) =>
    withClient(connectionString, async (client) => {
      const db = makeDatabase(client);
      await db.execute(sql`
        SELECT public.complete_restore_replay(
          ${input.branchId}, ${input.completedAt}, ${input.markerCount},
          ${input.deletedEntityCount}, ${input.expiredRecordCount}
        )
      `);
    }),
});
