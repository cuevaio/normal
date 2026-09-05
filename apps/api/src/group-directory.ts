import { makeGroupId } from "@whatsapp-mcp/contracts/handles";
import type {
  GroupProjectionEntry,
  GroupReconciliationCandidate,
  ProtectedGroupFields,
} from "@whatsapp-mcp/db/group";
import type {
  DirectoryGroup,
  DirectoryObservation,
  ProviderNeutralFailure,
} from "@whatsapp-mcp/whatsapp-provider/session";
import { Context, Data, Effect, Redacted } from "effect";
import { decodeBase64 } from "./base64-url";
import {
  type EnvelopeEncryption,
  EnvelopeEncryptionService,
} from "./encryption/envelope";
import {
  groupNamePrefixIndexes,
  importGroupDirectoryIndexKey,
} from "./group-privacy";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

export class GroupDirectoryPersistenceError extends Data.TaggedError(
  "GroupDirectoryPersistenceError",
) {}

export interface GroupDirectoryPersistenceService {
  readonly fail: (input: {
    readonly claimId: string;
    readonly connectionId: string;
    readonly failedAt: string;
    readonly personalAccountId: string;
  }) => Effect.Effect<boolean, GroupDirectoryPersistenceError>;
  readonly reconcile: (input: {
    readonly claimId: string;
    readonly completeness: "complete" | "partial";
    readonly connectionId: string;
    readonly entries: ReadonlyArray<GroupProjectionEntry>;
    readonly observedAt: string;
    readonly personalAccountId: string;
    readonly protect: (
      entry: GroupProjectionEntry,
      recordId: string,
    ) => Promise<ProtectedGroupFields>;
    readonly stale: boolean;
  }) => Effect.Effect<
    { readonly applied: number; readonly unjoined: number },
    GroupDirectoryPersistenceError
  >;
}

export const GroupDirectoryPersistence =
  Context.GenericTag<GroupDirectoryPersistenceService>(
    "@whatsapp-mcp/api/GroupDirectoryPersistence",
  );

export interface GroupDirectoryProviderService {
  readonly read: (input: {
    readonly authority: Redacted.Redacted<string>;
    readonly identityKey: Redacted.Redacted<Uint8Array>;
  }) => Effect.Effect<
    DirectoryObservation<DirectoryGroup>,
    ProviderNeutralFailure
  >;
}

export const GroupDirectoryProvider =
  Context.GenericTag<GroupDirectoryProviderService>(
    "@whatsapp-mcp/api/GroupDirectoryProvider",
  );

export interface GroupDirectoryIdentifiersService {
  readonly nextGroup: Effect.Effect<{
    readonly id: string;
    readonly publicId: string;
  }>;
}

export const GroupDirectoryIdentifiers =
  Context.GenericTag<GroupDirectoryIdentifiersService>(
    "@whatsapp-mcp/api/GroupDirectoryIdentifiers",
  );

type GroupDirectoryRequirements =
  | EnvelopeEncryption
  | GroupDirectoryIdentifiersService
  | GroupDirectoryPersistenceService
  | GroupDirectoryProviderService
  | SafeTelemetryService;

const protectValue = async (
  encryption: EnvelopeEncryption,
  candidate: GroupReconciliationCandidate,
  recordId: string,
  purpose: string,
  plaintext: string,
) => {
  const value = await Effect.runPromise(
    encryption.encrypt({
      accountKey: candidate.accountKey,
      connectionKey: candidate.connectionKey,
      context: {
        accountId: candidate.personalAccountId,
        connectionId: candidate.connectionId,
        entity: "whatsapp-group",
        fieldOrObjectPurpose: purpose,
        recordId,
      },
      plaintext: new TextEncoder().encode(plaintext),
    }),
  );
  return {
    ciphertext: decodeBase64(value.ciphertext),
    keyVersion: value.keyVersion,
    nonce: decodeBase64(value.nonce),
    version: value.version,
  } as const;
};

const withZeroed = <Value, Error, Requirements>(
  value: Uint8Array,
  use: (bytes: Uint8Array) => Effect.Effect<Value, Error, Requirements>,
) =>
  Effect.acquireUseRelease(Effect.succeed(value), use, (bytes) =>
    Effect.sync(() => bytes.fill(0)),
  );

export const reconcileGroupDirectory = (
  candidate: GroupReconciliationCandidate,
  failedAt: string,
): Effect.Effect<
  { readonly applied: number; readonly unjoined: number } | null,
  unknown,
  GroupDirectoryRequirements
> =>
  Effect.gen(function* () {
    const encryption = yield* EnvelopeEncryptionService;
    const provider = yield* GroupDirectoryProvider;
    const persistence = yield* GroupDirectoryPersistence;
    const identifiers = yield* GroupDirectoryIdentifiers;
    const telemetry = yield* SafeTelemetry;
    const authority = yield* encryption.decrypt({
      accountKey: candidate.accountKey,
      ciphertext: candidate.providerAuthority,
      connectionKey: candidate.connectionKey,
      context: {
        accountId: candidate.personalAccountId,
        connectionId: candidate.connectionId,
        entity: "whatsapp-connection",
        fieldOrObjectPurpose: "provider-session-authority",
        recordId: candidate.connectionId,
      },
    });
    const observation = yield* withZeroed(authority, (authorityBytes) =>
      encryption
        .decrypt({
          accountKey: candidate.accountKey,
          ciphertext: candidate.identityKey,
          connectionKey: candidate.connectionKey,
          context: {
            accountId: candidate.personalAccountId,
            connectionId: candidate.connectionId,
            entity: "whatsapp-connection",
            fieldOrObjectPurpose: "webhook-identity-key",
            recordId: candidate.connectionId,
          },
        })
        .pipe(
          Effect.flatMap((identityKey) =>
            withZeroed(identityKey, (identityBytes) =>
              Effect.gen(function* () {
                const indexKey =
                  yield* importGroupDirectoryIndexKey(identityBytes);
                const decodedAuthority = yield* Effect.try({
                  try: () =>
                    Redacted.make(
                      new TextDecoder("utf-8", {
                        fatal: true,
                        ignoreBOM: false,
                      }).decode(authorityBytes),
                    ),
                  catch: () => new Error("invalid provider authority"),
                });
                const value = yield* provider.read({
                  authority: decodedAuthority,
                  identityKey: Redacted.make(identityBytes),
                });
                return { indexKey, value };
              }),
            ),
          ),
        ),
    ).pipe(Effect.either);

    if (observation._tag === "Left") {
      yield* persistence.fail({
        claimId: candidate.claimId,
        connectionId: candidate.connectionId,
        failedAt,
        personalAccountId: candidate.personalAccountId,
      });
      yield* telemetry.emit({
        event: "group_directory.reconciliation.completed",
        outcome: "failed",
        service: "api",
      });
      return null;
    }

    const entries: GroupProjectionEntry[] = [];
    for (const group of observation.right.value.entries) {
      const next = yield* identifiers.nextGroup;
      entries.push({
        displayName: group.displayName,
        groupId: next.id,
        joined: group.joined,
        locator: group.identity,
        namePrefixIndexes: group.joined
          ? yield* groupNamePrefixIndexes(
              observation.right.indexKey,
              candidate.connectionId,
              group.displayName,
            )
          : [],
        providerIdentity: group.recipient,
        publicId: next.publicId,
      });
    }
    const result = yield* persistence.reconcile({
      claimId: candidate.claimId,
      completeness: observation.right.value.completeness,
      connectionId: candidate.connectionId,
      entries,
      observedAt: observation.right.value.observedAt,
      personalAccountId: candidate.personalAccountId,
      protect: async (entry, recordId) => ({
        displayName:
          entry.displayName === null
            ? null
            : await protectValue(
                encryption,
                candidate,
                recordId,
                "display-name",
                entry.displayName,
              ),
        providerIdentity: await protectValue(
          encryption,
          candidate,
          recordId,
          "provider-identity",
          entry.providerIdentity,
        ),
      }),
      stale: observation.right.value.stale,
    });
    yield* telemetry.emit({
      appliedCount: result.applied,
      event: "group_directory.reconciliation.completed",
      outcome: "success",
      service: "api",
      unjoinedCount: result.unjoined,
    });
    return result;
  });

export const makeGroupDirectoryId = () => ({
  id: crypto.randomUUID(),
  publicId: makeGroupId(),
});
