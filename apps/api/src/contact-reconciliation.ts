import type {
  ContactReconciliationCandidate,
  ReconciledProtectedContact,
} from "@whatsapp-mcp/db/directory";
import {
  type DirectorySessionAuthority,
  makeWasenderSessionDirectory,
  type ProviderIdentityProtectionKey,
  type WasenderDirectoryTelemetryEvent,
} from "@whatsapp-mcp/whatsapp-provider/session";
import { Context, Data, Effect, Redacted } from "effect";
import {
  importDirectoryIndexKey,
  protectDirectoryContact,
} from "./directory-privacy";
import {
  type EnvelopeEncryption,
  EnvelopeEncryptionService,
} from "./encryption/envelope";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

export class ContactReconciliationPersistenceError extends Data.TaggedError(
  "ContactReconciliationPersistenceError",
) {}

export interface ContactReconciliationPersistenceService {
  readonly fail: (input: {
    readonly claimId: string;
    readonly failedAt: string;
    readonly whatsappConnectionId: string;
  }) => Effect.Effect<void, ContactReconciliationPersistenceError>;
  readonly finish: (input: {
    readonly claimId: string;
    readonly contacts: ReadonlyArray<ReconciledProtectedContact>;
    readonly observedAt: string;
    readonly partial: boolean;
    readonly stale: boolean;
    readonly whatsappConnectionId: string;
  }) => Effect.Effect<void, ContactReconciliationPersistenceError>;
}

export const ContactReconciliationPersistence =
  Context.GenericTag<ContactReconciliationPersistenceService>(
    "@whatsapp-mcp/api/ContactReconciliationPersistence",
  );

export interface ContactReconciliationClockService {
  readonly now: Effect.Effect<string>;
}

export const ContactReconciliationClock =
  Context.GenericTag<ContactReconciliationClockService>(
    "@whatsapp-mcp/api/ContactReconciliationClock",
  );

export interface ContactReconciliationIdentifiersService {
  readonly nextContactId: Effect.Effect<string>;
}

export const ContactReconciliationIdentifiers =
  Context.GenericTag<ContactReconciliationIdentifiersService>(
    "@whatsapp-mcp/api/ContactReconciliationIdentifiers",
  );

export type ContactReconciliationRequirements =
  | ContactReconciliationClockService
  | ContactReconciliationIdentifiersService
  | ContactReconciliationPersistenceService
  | EnvelopeEncryption
  | SafeTelemetryService;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const decodeSessionAuthority = (
  plaintext: Uint8Array,
): DirectorySessionAuthority => {
  const parsed = JSON.parse(decoder.decode(plaintext)) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("sessionCredential" in parsed) ||
    typeof parsed.sessionCredential !== "string" ||
    !/^[\x21-\x7e]{1,4096}$/u.test(parsed.sessionCredential)
  ) {
    throw new Error("invalid Wasender Directory authority");
  }
  return Redacted.make(parsed.sessionCredential) as DirectorySessionAuthority;
};

const emit = (outcome: "complete" | "failed" | "partial", count: number) =>
  Effect.gen(function* () {
    const telemetry = yield* SafeTelemetry;
    yield* telemetry.emit({
      contactCount: count,
      event: "directory.contacts.reconciliation.completed",
      outcome,
      service: "api",
    });
  });

export const reconcileContacts = (
  candidate: ContactReconciliationCandidate,
): Effect.Effect<
  void,
  ContactReconciliationPersistenceError,
  ContactReconciliationRequirements
> =>
  Effect.gen(function* () {
    const encryption = yield* EnvelopeEncryptionService;
    const persistence = yield* ContactReconciliationPersistence;
    const identifiers = yield* ContactReconciliationIdentifiers;
    const providerEvents: Array<WasenderDirectoryTelemetryEvent> = [];
    const observationResult = yield* Effect.acquireUseRelease(
      encryption.decrypt({
        accountKey: candidate.accountKey,
        ciphertext: candidate.authority,
        connectionKey: candidate.connectionKey,
        context: {
          accountId: candidate.personalAccountId,
          connectionId: candidate.whatsappConnectionId,
          entity: "whatsapp-connection",
          fieldOrObjectPurpose: "provider-session-authority",
          recordId: candidate.whatsappConnectionId,
        },
      }),
      (authority) =>
        Effect.acquireUseRelease(
          encryption.decrypt({
            accountKey: candidate.accountKey,
            ciphertext: candidate.identityKey,
            connectionKey: candidate.connectionKey,
            context: {
              accountId: candidate.personalAccountId,
              connectionId: candidate.whatsappConnectionId,
              entity: "whatsapp-connection",
              fieldOrObjectPurpose: "webhook-identity-key",
              recordId: candidate.whatsappConnectionId,
            },
          }),
          (identity) =>
            Effect.gen(function* () {
              const sessionAuthority = yield* Effect.try({
                try: () => decodeSessionAuthority(authority),
                catch: () => new ContactReconciliationPersistenceError(),
              });
              const identityProtectionKey = Redacted.make(
                identity,
              ) as ProviderIdentityProtectionKey;
              return yield* makeWasenderSessionDirectory({
                authority: sessionAuthority,
                emitTelemetry: (event) => providerEvents.push(event),
                identityKey: identityProtectionKey,
              }).readContacts();
            }),
          (identity) => Effect.sync(() => identity.fill(0)),
        ),
      (authority) => Effect.sync(() => authority.fill(0)),
    ).pipe(Effect.either);
    const telemetry = yield* SafeTelemetry;
    yield* Effect.forEach(providerEvents, (event) =>
      telemetry.emit({
        ...event,
        event: "directory.provider_read.completed",
        service: "api",
      }),
    );
    if (observationResult._tag === "Left") {
      return yield* Effect.fail(observationResult.left);
    }
    const observation = observationResult.right;
    const indexBytes = yield* encryption.decrypt({
      accountKey: candidate.accountKey,
      ciphertext: candidate.identityKey,
      connectionKey: candidate.connectionKey,
      context: {
        accountId: candidate.personalAccountId,
        connectionId: candidate.whatsappConnectionId,
        entity: "whatsapp-connection",
        fieldOrObjectPurpose: "webhook-identity-key",
        recordId: candidate.whatsappConnectionId,
      },
    });
    const protectedContacts = yield* Effect.acquireUseRelease(
      Effect.succeed(indexBytes),
      (identity) =>
        Effect.gen(function* () {
          const indexKey = yield* importDirectoryIndexKey(identity);
          return yield* Effect.forEach(
            observation.entries,
            (contact) =>
              Effect.gen(function* () {
                const protectedContact = yield* protectDirectoryContact({
                  accountKey: candidate.accountKey,
                  connectionKey: candidate.connectionKey,
                  contact,
                  encryption,
                  indexKey,
                });
                return {
                  ...protectedContact,
                  publicId: yield* identifiers.nextContactId,
                };
              }),
            { concurrency: 16 },
          );
        }),
      (identity) =>
        Effect.sync(() => {
          identity.fill(0);
        }),
    );
    yield* persistence.finish({
      claimId: candidate.claimId,
      contacts: protectedContacts,
      observedAt: observation.observedAt,
      partial: observation.completeness === "partial",
      stale: observation.stale,
      whatsappConnectionId: candidate.whatsappConnectionId,
    });
    yield* emit(
      observation.completeness === "partial" ? "partial" : "complete",
      protectedContacts.length,
    );
  }).pipe(
    Effect.catchAll(() =>
      Effect.gen(function* () {
        const persistence = yield* ContactReconciliationPersistence;
        const clock = yield* ContactReconciliationClock;
        yield* persistence.fail({
          claimId: candidate.claimId,
          failedAt: yield* clock.now,
          whatsappConnectionId: candidate.whatsappConnectionId,
        });
        yield* emit("failed", 0);
      }),
    ),
  );
