import type {
  LifecycleSession,
  ProviderControlResult,
  QrCodeObservation,
  SessionNumberVerification,
  SessionReconciliation,
} from "@whatsapp-mcp/contracts/provider-control";
import type {
  ActivateWhatsAppConnectionInput,
  ConnectionSetupActivation,
  WhatsAppConnectionDeletionPreparation,
  WhatsAppConnectionDeletionReceipt,
  WhatsAppConnectionLifecycleAction,
  WhatsAppConnectionLifecycleClaim,
  WhatsAppConnectionRecord,
} from "@whatsapp-mcp/db/whatsapp-connection";
import {
  normalizeWhatsAppConnectionName,
  type WhatsAppConnectionState,
} from "@whatsapp-mcp/domain/whatsapp-connection";
import { Context, Data, Effect, type Layer } from "effect";
import {
  HumanIdentity,
  type HumanIdentityService,
} from "./auth/human-identity";
import { decodeBase64 } from "./base64-url";
import {
  ConnectionSetupProvisioningQueue,
  type ConnectionSetupProvisioningQueueError,
  type ConnectionSetupProvisioningQueueService,
} from "./connection-setup-provisioning";
import {
  type EncryptionError,
  type EnvelopeEncryption,
  EnvelopeEncryptionService,
} from "./encryption/envelope";
import { hasFailureTag } from "./failure-tag";
import { noStoreJsonResponse } from "./http-response";
import {
  RestoreSafeDeletion,
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const CONNECTIONS_ROUTE = "/v1/whatsapp-connections";
const qrRoutePattern =
  /^\/v1\/connection-setups\/(cst_[A-Za-z0-9_-]{21})\/qr$/u;
const lifecycleRoutePattern =
  /^\/v1\/whatsapp-connections\/(con_[A-Za-z0-9_-]{21})\/(disconnect|reconnect|delete)$/u;
const nameRoutePattern =
  /^\/v1\/whatsapp-connections\/(con_[A-Za-z0-9_-]{21})\/name$/u;

export class WhatsAppConnectionPersistenceError extends Data.TaggedError(
  "WhatsAppConnectionPersistenceError",
) {}

export class WhatsAppConnectionNotAccessible extends Data.TaggedError(
  "WhatsAppConnectionNotAccessible",
) {}

export class WhatsAppConnectionProviderError extends Data.TaggedError(
  "WhatsAppConnectionProviderError",
) {}

export class WhatsAppConnectionActivationError extends Data.TaggedError(
  "WhatsAppConnectionActivationError",
) {}

interface VisibleWhatsAppConnectionRecord {
  readonly displayName: string;
  readonly numberSuffix: string;
  readonly publicId: string;
  readonly state: WhatsAppConnectionState;
  readonly stateChangedAt: string;
}

export interface WhatsAppConnectionPersistenceService {
  readonly activate: (
    input: ActivateWhatsAppConnectionInput,
  ) => Effect.Effect<
    WhatsAppConnectionRecord,
    WhatsAppConnectionPersistenceError
  >;
  readonly list: (
    clerkUserId: string,
  ) => Effect.Effect<
    ReadonlyArray<WhatsAppConnectionRecord>,
    WhatsAppConnectionPersistenceError
  >;
  readonly rename: (input: {
    readonly clerkUserId: string;
    readonly displayNameCiphertext: Uint8Array;
    readonly displayNameCiphertextVersion: number;
    readonly displayNameKeyVersion: number;
    readonly displayNameNonce: Uint8Array;
    readonly publicId: string;
  }) => Effect.Effect<
    WhatsAppConnectionRecord | null,
    WhatsAppConnectionPersistenceError
  >;
  readonly loadForRename: (input: {
    readonly clerkUserId: string;
    readonly publicId: string;
  }) => Effect.Effect<
    WhatsAppConnectionRecord | null,
    WhatsAppConnectionPersistenceError
  >;
  readonly prepareDeletion: (input: {
    readonly clerkUserId: string;
    readonly publicId: string;
  }) => Effect.Effect<
    WhatsAppConnectionDeletionPreparation | null,
    WhatsAppConnectionPersistenceError
  >;
  readonly finishDeletion: (input: {
    readonly clerkUserId: string;
    readonly publicId: string;
    readonly deletionMarkerId: string;
    readonly requestedAt: string;
  }) => Effect.Effect<
    WhatsAppConnectionDeletionReceipt | null,
    WhatsAppConnectionPersistenceError
  >;
  readonly claimLifecycle: (input: {
    readonly action: WhatsAppConnectionLifecycleAction;
    readonly claimId: string;
    readonly clerkUserId: string;
    readonly publicId: string;
    readonly requestedAt: string;
  }) => Effect.Effect<
    WhatsAppConnectionLifecycleClaim | null,
    WhatsAppConnectionPersistenceError
  >;
  readonly finishLifecycle: (input: {
    readonly claimId: string;
    readonly clerkUserId: string;
    readonly observedAt: string;
    readonly publicId: string;
    readonly state: Exclude<WhatsAppConnectionState, "deleting">;
  }) => Effect.Effect<
    WhatsAppConnectionRecord | null,
    WhatsAppConnectionPersistenceError
  >;
  readonly loadSetup: (input: {
    readonly clerkUserId: string;
    readonly observedAt: string;
    readonly setupId: string;
  }) => Effect.Effect<
    ConnectionSetupActivation | null,
    WhatsAppConnectionPersistenceError
  >;
  readonly failSetupActivation: (input: {
    readonly failureCode: string;
    readonly observedAt: string;
    readonly personalAccountId: string;
    readonly setupId: string;
  }) => Effect.Effect<boolean, WhatsAppConnectionPersistenceError>;
}

export const WhatsAppConnectionPersistence =
  Context.GenericTag<WhatsAppConnectionPersistenceService>(
    "@whatsapp-mcp/api/WhatsAppConnectionPersistence",
  );

export interface WhatsAppConnectionProviderService {
  readonly connect: (input: {
    readonly session: string;
  }) => Effect.Effect<ProviderControlResult<LifecycleSession>>;
  readonly disconnect: (input: {
    readonly session: string;
  }) => Effect.Effect<ProviderControlResult<LifecycleSession>>;
  readonly getQrCode: (input: {
    readonly session: string;
  }) => Effect.Effect<ProviderControlResult<QrCodeObservation>>;
  readonly reconcile: (input: {
    readonly requireConnectReady?: true | undefined;
    readonly setupMarker: string;
  }) => Effect.Effect<ProviderControlResult<SessionReconciliation>>;
  readonly verifyNumber: (input: {
    readonly phoneNumber: string;
    readonly session: string;
  }) => Effect.Effect<ProviderControlResult<SessionNumberVerification>>;
}

export const WhatsAppConnectionProvider =
  Context.GenericTag<WhatsAppConnectionProviderService>(
    "@whatsapp-mcp/api/WhatsAppConnectionProvider",
  );

export interface WhatsAppConnectionClockService {
  readonly now: Effect.Effect<string>;
}

export const WhatsAppConnectionClock =
  Context.GenericTag<WhatsAppConnectionClockService>(
    "@whatsapp-mcp/api/WhatsAppConnectionClock",
  );

export interface WhatsAppConnectionIdentifiersService {
  readonly nextConnectionId: Effect.Effect<string>;
  readonly nextLifecycleClaimId: Effect.Effect<string>;
  readonly nextPublicId: Effect.Effect<string>;
  readonly nextWebhookIdentityKey: Effect.Effect<Uint8Array>;
}

export const WhatsAppConnectionIdentifiers =
  Context.GenericTag<WhatsAppConnectionIdentifiersService>(
    "@whatsapp-mcp/api/WhatsAppConnectionIdentifiers",
  );

export type WhatsAppConnectionRequirements =
  | ConnectionSetupProvisioningQueueService
  | EnvelopeEncryption
  | HumanIdentityService
  | SafeTelemetryService
  | WhatsAppConnectionClockService
  | WhatsAppConnectionIdentifiersService
  | WhatsAppConnectionPersistenceService
  | WhatsAppConnectionProviderService
  | RestoreSafeDeletion;

type SetupObservation =
  | {
      readonly outcome: "connected";
      readonly connection: VisibleWhatsAppConnectionRecord;
    }
  | {
      readonly outcome: "qr_available";
      readonly expiresAt: string | null;
      readonly image: Uint8Array;
    }
  | {
      readonly outcome: "connecting" | "pending" | "provisioning_quarantined";
    }
  | {
      readonly outcome:
        | "number_confirmation_failed"
        | "provider_capacity_unavailable"
        | "provisioning_failed";
    };

type LifecycleObservation =
  | {
      readonly action: WhatsAppConnectionLifecycleAction;
      readonly connection: VisibleWhatsAppConnectionRecord;
      readonly outcome: "complete" | "in_progress" | "recovery_required";
    }
  | {
      readonly action: "reconnect";
      readonly connection: VisibleWhatsAppConnectionRecord;
      readonly expiresAt: string | null;
      readonly image: Uint8Array;
      readonly outcome: "qr_available";
    };

const withZeroedBytes = <Value, Error, Requirements>(
  bytes: Uint8Array,
  use: (value: Uint8Array) => Effect.Effect<Value, Error, Requirements>,
) =>
  Effect.acquireUseRelease(Effect.succeed(bytes), use, (value) =>
    Effect.sync(() => {
      value.fill(0);
    }),
  );

const revealConnection = (connection: WhatsAppConnectionRecord) =>
  connection.displayName.fallback !== null
    ? Effect.succeed({
        displayName: connection.displayName.fallback,
        numberSuffix: connection.numberSuffix,
        publicId: connection.publicId,
        state: connection.state,
        stateChangedAt: connection.stateChangedAt,
      })
    : Effect.gen(function* () {
        if (connection.displayName.ciphertext === null) {
          return yield* Effect.fail(new WhatsAppConnectionActivationError());
        }
        const encryption = yield* EnvelopeEncryptionService;
        const plaintext = yield* encryption.decrypt({
          accountKey: connection.accountKey,
          ciphertext: connection.displayName.ciphertext,
          connectionKey: connection.connectionKey,
          context: {
            accountId: connection.accountKey.personalAccountId,
            connectionId: connection.connectionId,
            entity: "whatsapp-connection",
            fieldOrObjectPurpose: "display-name",
            recordId: connection.connectionId,
          },
        });
        const displayName = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: false,
        }).decode(plaintext);
        if (normalizeWhatsAppConnectionName(displayName) !== displayName) {
          return yield* Effect.fail(new WhatsAppConnectionActivationError());
        }
        return {
          displayName,
          numberSuffix: connection.numberSuffix,
          publicId: connection.publicId,
          state: connection.state,
          stateChangedAt: connection.stateChangedAt,
        };
      });

const revealSetupName = (
  setup: Extract<
    ConnectionSetupActivation,
    { readonly outcome: "provisioned" }
  >["setup"],
) =>
  setup.displayName.fallback !== null
    ? Effect.succeed(setup.displayName.fallback)
    : Effect.gen(function* () {
        if (setup.displayName.ciphertext === null) {
          return yield* Effect.fail(new WhatsAppConnectionActivationError());
        }
        const encryption = yield* EnvelopeEncryptionService;
        const plaintext = yield* encryption.decrypt({
          accountKey: setup.accountKey,
          ciphertext: setup.displayName.ciphertext,
          connectionKey: setup.setupKey,
          context: {
            accountId: setup.personalAccountId,
            connectionId: setup.setupId,
            entity: "connection-setup",
            fieldOrObjectPurpose: "display-name",
            recordId: setup.setupId,
          },
        });
        const displayName = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: false,
        }).decode(plaintext);
        if (normalizeWhatsAppConnectionName(displayName) !== displayName) {
          return yield* Effect.fail(new WhatsAppConnectionActivationError());
        }
        return displayName;
      });

const encryptConnectionValue = (
  setup: Extract<
    ConnectionSetupActivation,
    { readonly outcome: "provisioned" }
  >["setup"],
  connectionId: string,
  connectionKey: {
    readonly accountKeyVersion: number;
    readonly ciphertext: string;
    readonly connectionId: string;
    readonly keyVersion: number;
    readonly nonce: string;
    readonly personalAccountId: string;
    readonly version: 1;
  },
  purpose: string,
  plaintext: Uint8Array,
) =>
  Effect.gen(function* () {
    const encryption = yield* EnvelopeEncryptionService;
    return yield* encryption.encrypt({
      accountKey: setup.accountKey,
      connectionKey,
      context: {
        accountId: setup.personalAccountId,
        connectionId,
        entity: "whatsapp-connection",
        fieldOrObjectPurpose: purpose,
        recordId: connectionId,
      },
      plaintext,
    });
  });

const activate = (
  setup: Extract<
    ConnectionSetupActivation,
    { readonly outcome: "provisioned" }
  >["setup"],
  providerSession: LifecycleSession,
) =>
  Effect.gen(function* () {
    const identifiers = yield* WhatsAppConnectionIdentifiers;
    const connectionId = yield* identifiers.nextConnectionId;
    const publicId = yield* identifiers.nextPublicId;
    const webhookIdentityKey = yield* identifiers.nextWebhookIdentityKey;
    const messageSearchKey = crypto.getRandomValues(new Uint8Array(32));
    if (
      webhookIdentityKey.byteLength !== 32 ||
      messageSearchKey.byteLength !== 32
    ) {
      return yield* Effect.fail(new WhatsAppConnectionActivationError());
    }
    return yield* withZeroedBytes(
      messageSearchKey,
      (messageSearchKeyPlaintext) =>
        withZeroedBytes(webhookIdentityKey, (identityKeyPlaintext) =>
          Effect.gen(function* () {
            const clock = yield* WhatsAppConnectionClock;
            const connectedAt = yield* clock.now;
            const encryption = yield* EnvelopeEncryptionService;
            const connectionKey = yield* encryption.createConnectionKey({
              accountId: setup.personalAccountId,
              accountKey: setup.accountKey,
              connectionId,
              keyVersion: 1,
            });
            const displayName = yield* revealSetupName(setup);
            const displayNameCiphertext = yield* encryptConnectionValue(
              setup,
              connectionId,
              connectionKey,
              "display-name",
              new TextEncoder().encode(displayName),
            );
            const numberBytes = yield* encryption.decrypt({
              accountKey: setup.accountKey,
              ciphertext: setup.numberCiphertext,
              connectionKey: setup.setupKey,
              context: {
                accountId: setup.personalAccountId,
                connectionId: setup.setupId,
                entity: "connection-setup",
                fieldOrObjectPurpose: "whatsapp-number",
                recordId: setup.setupId,
              },
            });

            return yield* withZeroedBytes(numberBytes, (numberPlaintext) =>
              Effect.gen(function* () {
                const number = new TextDecoder().decode(numberPlaintext);
                const numberSuffix = number.slice(-4);
                if (
                  !/^\+[1-9]\d{7,14}$/u.test(number) ||
                  !/^[0-9]{4}$/u.test(numberSuffix)
                ) {
                  return yield* Effect.fail(
                    new WhatsAppConnectionActivationError(),
                  );
                }
                const locator = yield* encryptConnectionValue(
                  setup,
                  connectionId,
                  connectionKey,
                  "provider-session-locator",
                  new TextEncoder().encode(providerSession.session),
                );
                const authority = yield* encryptConnectionValue(
                  setup,
                  connectionId,
                  connectionKey,
                  "provider-session-authority",
                  new TextEncoder().encode(providerSession.authority),
                );
                const identityKey = yield* encryptConnectionValue(
                  setup,
                  connectionId,
                  connectionKey,
                  "webhook-identity-key",
                  identityKeyPlaintext,
                );
                const protectedMessageSearchKey = yield* encryptConnectionValue(
                  setup,
                  connectionId,
                  connectionKey,
                  "message-search-key",
                  messageSearchKeyPlaintext,
                );
                const persistence = yield* WhatsAppConnectionPersistence;
                const persisted = yield* persistence.activate({
                  accountKeyVersion: connectionKey.accountKeyVersion,
                  authorityCiphertext: decodeBase64(authority.ciphertext),
                  authorityCiphertextVersion: authority.version,
                  authorityKeyVersion: authority.keyVersion,
                  authorityNonce: decodeBase64(authority.nonce),
                  connectionId,
                  connectionKeyCiphertext: decodeBase64(
                    connectionKey.ciphertext,
                  ),
                  connectionKeyNonce: decodeBase64(connectionKey.nonce),
                  connectionKeyVersion: connectionKey.keyVersion,
                  connectedAt,
                  displayNameCiphertext: decodeBase64(
                    displayNameCiphertext.ciphertext,
                  ),
                  displayNameCiphertextVersion: displayNameCiphertext.version,
                  displayNameKeyVersion: displayNameCiphertext.keyVersion,
                  displayNameNonce: decodeBase64(displayNameCiphertext.nonce),
                  locatorCiphertext: decodeBase64(locator.ciphertext),
                  locatorCiphertextVersion: locator.version,
                  locatorKeyVersion: locator.keyVersion,
                  locatorNonce: decodeBase64(locator.nonce),
                  messageSearchKeyCiphertext: decodeBase64(
                    protectedMessageSearchKey.ciphertext,
                  ),
                  messageSearchKeyCiphertextVersion:
                    protectedMessageSearchKey.version,
                  messageSearchKeyVersion: protectedMessageSearchKey.keyVersion,
                  messageSearchKeyNonce: decodeBase64(
                    protectedMessageSearchKey.nonce,
                  ),
                  numberSuffix,
                  personalAccountId: setup.personalAccountId,
                  publicId,
                  setupId: setup.setupId,
                  webhookIngressId: setup.webhookIngressId,
                  webhookSecretCiphertext: decodeBase64(identityKey.ciphertext),
                  webhookSecretCiphertextVersion: identityKey.version,
                  webhookSecretKeyVersion: identityKey.keyVersion,
                  webhookSecretNonce: decodeBase64(identityKey.nonce),
                });
                return yield* revealConnection(persisted);
              }),
            );
          }),
        ),
    );
  });

const revealSetupNumber = (
  setup: Extract<
    ConnectionSetupActivation,
    { readonly outcome: "provisioned" }
  >["setup"],
) =>
  Effect.gen(function* () {
    const encryption = yield* EnvelopeEncryptionService;
    const numberBytes = yield* encryption.decrypt({
      accountKey: setup.accountKey,
      ciphertext: setup.numberCiphertext,
      connectionKey: setup.setupKey,
      context: {
        accountId: setup.personalAccountId,
        connectionId: setup.setupId,
        entity: "connection-setup",
        fieldOrObjectPurpose: "whatsapp-number",
        recordId: setup.setupId,
      },
    });
    return yield* withZeroedBytes(numberBytes, (numberPlaintext) =>
      Effect.sync(() => {
        const number = new TextDecoder().decode(numberPlaintext);
        if (!/^\+[1-9]\d{7,14}$/u.test(number)) {
          throw new WhatsAppConnectionActivationError();
        }
        return number;
      }),
    );
  });

const rejectSetupActivation = (
  setup: Extract<
    ConnectionSetupActivation,
    { readonly outcome: "provisioned" }
  >["setup"],
  failureCode: "scanned_number_mismatch" | "scanned_number_unverified",
) =>
  Effect.gen(function* () {
    const clock = yield* WhatsAppConnectionClock;
    const persistence = yield* WhatsAppConnectionPersistence;
    const failed = yield* persistence.failSetupActivation({
      failureCode,
      observedAt: yield* clock.now,
      personalAccountId: setup.personalAccountId,
      setupId: setup.setupId,
    });
    if (!failed) {
      return yield* Effect.fail(new WhatsAppConnectionActivationError());
    }
    const queue = yield* ConnectionSetupProvisioningQueue;
    yield* queue.enqueueCleanup(setup.setupId);
    return { outcome: "number_confirmation_failed" as const };
  });

const providerValue = <Value>(
  result: ProviderControlResult<Value>,
): Effect.Effect<Value, WhatsAppConnectionProviderError> =>
  result.ok
    ? Effect.succeed(result.value)
    : Effect.fail(new WhatsAppConnectionProviderError());

export const observeConnectionSetup = (
  clerkUserId: string,
  setupId: string,
): Effect.Effect<
  SetupObservation,
  | EncryptionError
  | ConnectionSetupProvisioningQueueError
  | WhatsAppConnectionActivationError
  | WhatsAppConnectionNotAccessible
  | WhatsAppConnectionPersistenceError
  | WhatsAppConnectionProviderError,
  | EnvelopeEncryption
  | ConnectionSetupProvisioningQueueService
  | WhatsAppConnectionClockService
  | WhatsAppConnectionIdentifiersService
  | WhatsAppConnectionPersistenceService
  | WhatsAppConnectionProviderService
> =>
  Effect.gen(function* () {
    const persistence = yield* WhatsAppConnectionPersistence;
    const clock = yield* WhatsAppConnectionClock;
    const observedAt = yield* clock.now;
    const loaded = yield* persistence.loadSetup({
      clerkUserId,
      observedAt,
      setupId,
    });
    if (loaded === null) {
      return yield* Effect.fail(new WhatsAppConnectionNotAccessible());
    }
    if (loaded.outcome === "activated") {
      return {
        connection: yield* revealConnection(loaded.connection),
        outcome: "connected",
      };
    }
    if (loaded.outcome !== "provisioned") {
      if (
        loaded.outcome === "provisioning_failed" &&
        loaded.failureCode === "source_rejected"
      ) {
        return { outcome: "provider_capacity_unavailable" };
      }
      if (
        loaded.outcome === "provisioning_failed" &&
        (loaded.failureCode === "scanned_number_mismatch" ||
          loaded.failureCode === "scanned_number_unverified")
      ) {
        return { outcome: "number_confirmation_failed" };
      }
      return { outcome: loaded.outcome };
    }

    const provider = yield* WhatsAppConnectionProvider;
    const reconciliation = yield* providerValue(
      yield* provider.reconcile({ setupMarker: setupId }),
    );
    if (reconciliation.outcome !== "present") {
      return yield* Effect.fail(new WhatsAppConnectionProviderError());
    }

    let session = reconciliation.session;
    let startedConnecting = false;
    if (
      session.connectionState !== "connected" &&
      session.connectionState !== "connecting"
    ) {
      session = yield* providerValue(
        yield* provider.connect({ session: session.session }),
      );
      startedConnecting = true;
    }
    if (session.connectionState === "connected") {
      const number = yield* revealSetupNumber(loaded.setup);
      const verification = yield* providerValue(
        yield* provider.verifyNumber({
          phoneNumber: number,
          session: session.session,
        }),
      );
      if (verification.outcome === "mismatch") {
        return yield* rejectSetupActivation(
          loaded.setup,
          "scanned_number_mismatch",
        );
      }
      if (verification.outcome === "unverified") {
        return yield* rejectSetupActivation(
          loaded.setup,
          "scanned_number_unverified",
        );
      }
      return {
        connection: yield* activate(loaded.setup, session),
        outcome: "connected",
      };
    }

    if (startedConnecting && session.connectionState === "connecting") {
      return { outcome: "connecting" };
    }

    const qr = yield* providerValue(
      yield* provider.getQrCode({ session: session.session }),
    );
    return qr.state === "available"
      ? {
          expiresAt: qr.expiresAt,
          image: qr.image,
          outcome: "qr_available",
        }
      : { outcome: "connecting" };
  });

const lifecycleState = (
  action: WhatsAppConnectionLifecycleAction,
  reconciliation: SessionReconciliation,
): {
  readonly session: LifecycleSession | null;
  readonly state: Exclude<WhatsAppConnectionState, "deleting">;
} => {
  if (reconciliation.outcome === "duplicates") {
    return { session: null, state: "degraded" };
  }
  if (reconciliation.outcome === "absent") {
    return {
      session: null,
      state: action === "disconnect" ? "disconnected" : "reconnect_required",
    };
  }
  return {
    session: reconciliation.session,
    state: reconciliation.session.connectionState,
  };
};

export const reconcileWhatsAppConnectionLifecycle = (
  clerkUserId: string,
  publicId: string,
  action: WhatsAppConnectionLifecycleAction,
) =>
  Effect.gen(function* () {
    const identifiers = yield* WhatsAppConnectionIdentifiers;
    const clock = yield* WhatsAppConnectionClock;
    const persistence = yield* WhatsAppConnectionPersistence;
    const claimId = yield* identifiers.nextLifecycleClaimId;
    const requestedAt = yield* clock.now;
    const claim = yield* persistence.claimLifecycle({
      action,
      claimId,
      clerkUserId,
      publicId,
      requestedAt,
    });
    if (claim === null) {
      return yield* Effect.fail(new WhatsAppConnectionNotAccessible());
    }
    const claimedConnection = yield* revealConnection(claim.connection);
    if (claim.outcome !== "claimed") {
      return {
        action,
        connection: claimedConnection,
        outcome: claim.outcome,
      };
    }

    const provider = yield* WhatsAppConnectionProvider;
    let providerSession: LifecycleSession | null = null;
    let state: Exclude<WhatsAppConnectionState, "deleting"> = "degraded";
    const reconciled = yield* provider.reconcile({
      ...(action === "reconnect" ? { requireConnectReady: true as const } : {}),
      setupMarker: claim.setupMarker,
    });
    if (reconciled.ok) {
      ({ session: providerSession, state } = lifecycleState(
        action,
        reconciled.value,
      ));
    }

    const needsWrite =
      providerSession !== null &&
      (action === "disconnect"
        ? providerSession.connectionState === "connected" ||
          providerSession.connectionState === "connecting"
        : providerSession.connectionState === "disconnected" ||
          providerSession.connectionState === "reconnect_required");

    if (needsWrite && providerSession !== null) {
      const written =
        action === "disconnect"
          ? yield* provider.disconnect({ session: providerSession.session })
          : yield* provider.connect({ session: providerSession.session });
      if (written.ok) {
        providerSession = written.value;
        state =
          action === "disconnect" &&
          written.value.connectionState === "reconnect_required"
            ? "disconnected"
            : written.value.connectionState;
      } else {
        const afterAmbiguousWrite = yield* provider.reconcile({
          ...(action === "reconnect"
            ? { requireConnectReady: true as const }
            : {}),
          setupMarker: claim.setupMarker,
        });
        if (afterAmbiguousWrite.ok) {
          ({ session: providerSession, state } = lifecycleState(
            action,
            afterAmbiguousWrite.value,
          ));
        } else {
          providerSession = null;
          state = "degraded";
        }
      }
    }

    if (
      action === "disconnect" &&
      state !== "disconnected" &&
      state !== "reconnect_required"
    ) {
      state = "degraded";
    }
    if (action === "disconnect" && state === "reconnect_required") {
      state = "disconnected";
    }

    const observedAt = yield* clock.now;
    const persistedConnection = yield* persistence.finishLifecycle({
      claimId,
      clerkUserId,
      observedAt,
      publicId,
      state,
    });
    if (persistedConnection === null) {
      return {
        action,
        connection: claimedConnection,
        outcome: "in_progress",
      } as const;
    }
    const connection = yield* revealConnection(persistedConnection);

    if (
      action === "reconnect" &&
      providerSession !== null &&
      state === "connecting"
    ) {
      const qr = yield* provider.getQrCode({
        session: providerSession.session,
      });
      if (qr.ok && qr.value.state === "available") {
        return {
          action: "reconnect",
          connection,
          expiresAt: qr.value.expiresAt,
          image: qr.value.image,
          outcome: "qr_available",
        } as const;
      }
    }

    const complete =
      (action === "disconnect" && connection.state === "disconnected") ||
      (action === "reconnect" && connection.state === "connected");
    return {
      action,
      connection,
      outcome: complete
        ? "complete"
        : connection.state === "connecting"
          ? "in_progress"
          : "recovery_required",
    } as const;
  });

export const deleteWhatsAppConnection = (
  clerkUserId: string,
  publicId: string,
  fixedRequestedAt?: string,
) =>
  Effect.gen(function* () {
    const persistence = yield* WhatsAppConnectionPersistence;
    const prepared = yield* persistence.prepareDeletion({
      clerkUserId,
      publicId,
    });
    if (prepared === null)
      return yield* Effect.fail(new WhatsAppConnectionNotAccessible());
    if (prepared.outcome === "complete") return prepared;
    const encryption = yield* EnvelopeEncryptionService;
    const locatorBytes = yield* encryption.decrypt({
      accountKey: prepared.accountKey,
      connectionKey: prepared.connectionKey,
      ciphertext: prepared.providerLocator,
      context: {
        accountId: prepared.personalAccountId,
        connectionId: prepared.connectionId,
        entity: "whatsapp-connection",
        fieldOrObjectPurpose: "provider-session-locator",
        recordId: prepared.connectionId,
      },
    });
    return yield* withZeroedBytes(locatorBytes, (bytes) =>
      Effect.gen(function* () {
        const sessionLocator = new TextDecoder().decode(bytes);
        const clock = yield* WhatsAppConnectionClock;
        const requestedAt = fixedRequestedAt ?? (yield* clock.now);
        const deletion = yield* RestoreSafeDeletion;
        const marker = yield* deletion.markers.create({
          deletionKind: "whatsapp_connection",
          keyUnavailableAt: requestedAt,
          opaqueEntityId: prepared.connectionId,
          requestedAt,
        });
        yield* deletion.capsules.create({
          deletionMarkerId: marker.markerId,
          keyVersion: 1,
          providerCleanupIdentifiers: { sessionLocator },
        });
        const receipt = yield* persistence.finishDeletion({
          clerkUserId,
          publicId,
          requestedAt: marker.marker.requestedAt,
          deletionMarkerId: marker.markerId,
        });
        if (receipt === null)
          return yield* Effect.fail(new WhatsAppConnectionNotAccessible());
        return { outcome: "complete" as const, ...receipt };
      }),
    );
  });

const corsHeaders = (browserOrigin: string) => ({
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  "access-control-allow-origin": browserOrigin,
  vary: "Origin",
});

const jsonResponse = (
  body: unknown,
  status: number,
  browserOrigin?: string,
): Response =>
  noStoreJsonResponse(
    body,
    status,
    browserOrigin === undefined ? {} : corsHeaders(browserOrigin),
  );

const notFound = (browserOrigin?: string): Response =>
  jsonResponse({ error: "not_found" }, 404, browserOrigin);

const stateResponse = (
  state: "connecting" | "pending",
  browserOrigin: string,
): Response =>
  new Response(null, {
    headers: {
      ...corsHeaders(browserOrigin),
      "cache-control": "no-store",
      "x-connection-setup-state": state,
    },
    status: 202,
  });

const qrResponse = (
  image: Uint8Array,
  expiresAt: string | null,
  browserOrigin: string,
): Response =>
  new Response(image, {
    headers: {
      ...corsHeaders(browserOrigin),
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "content-type": "image/svg+xml",
      ...(expiresAt === null
        ? {}
        : { "x-connection-setup-qr-expires-at": expiresAt }),
      "x-content-type-options": "nosniff",
    },
    status: 200,
  });

const reconnectQrResponse = (
  observation: Extract<LifecycleObservation, { outcome: "qr_available" }>,
  browserOrigin: string,
): Response =>
  new Response(observation.image, {
    headers: {
      ...corsHeaders(browserOrigin),
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "content-type": "image/svg+xml",
      ...(observation.expiresAt === null
        ? {}
        : { "x-whatsapp-connection-qr-expires-at": observation.expiresAt }),
      "x-content-type-options": "nosniff",
      "x-whatsapp-connection-state": observation.connection.state,
    },
    status: 200,
  });

const connectionJson = (connection: VisibleWhatsAppConnectionRecord) => ({
  display_name: connection.displayName,
  id: connection.publicId,
  number_suffix: connection.numberSuffix,
  state: connection.state,
  state_changed_at: connection.stateChangedAt,
});

const decodeNameRequest = async (request: Request): Promise<string | null> => {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.hasOwn(value, "name") ||
    Object.keys(value).length !== 1
  ) {
    return null;
  }
  return normalizeWhatsAppConnectionName(
    (value as { readonly name: unknown }).name,
  );
};

export const createWhatsAppConnectionHandler =
  (
    layer: Layer.Layer<WhatsAppConnectionRequirements, unknown>,
    browserOrigin: string,
  ) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const qrMatch = qrRoutePattern.exec(url.pathname);
    const lifecycleMatch = lifecycleRoutePattern.exec(url.pathname);
    const nameMatch = nameRoutePattern.exec(url.pathname);
    if (
      (url.pathname !== CONNECTIONS_ROUTE &&
        qrMatch === null &&
        lifecycleMatch === null &&
        nameMatch === null) ||
      request.headers.get("origin") !== browserOrigin
    ) {
      return notFound();
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(browserOrigin),
        status: 204,
      });
    }
    if (
      (lifecycleMatch !== null && request.method !== "POST") ||
      (nameMatch !== null && request.method !== "PUT") ||
      (lifecycleMatch === null &&
        nameMatch === null &&
        request.method !== "GET")
    ) {
      return notFound(browserOrigin);
    }

    const requestedName =
      nameMatch === null ? null : await decodeNameRequest(request);
    if (nameMatch !== null && requestedName === null) {
      return jsonResponse({ error: "invalid_request" }, 400, browserOrigin);
    }

    return Effect.runPromise(
      Effect.gen(function* () {
        const identity = yield* HumanIdentity;
        const clerkUserId = yield* identity.verify(request);
        if (nameMatch !== null && requestedName !== null) {
          const publicId = nameMatch[1];
          if (publicId === undefined) {
            return yield* Effect.fail(new WhatsAppConnectionNotAccessible());
          }
          const persistence = yield* WhatsAppConnectionPersistence;
          const material = yield* persistence.loadForRename({
            clerkUserId,
            publicId,
          });
          if (material === null) {
            return yield* Effect.fail(new WhatsAppConnectionNotAccessible());
          }
          const encryption = yield* EnvelopeEncryptionService;
          const protectedName = yield* encryption.encrypt({
            accountKey: material.accountKey,
            connectionKey: material.connectionKey,
            context: {
              accountId: material.accountKey.personalAccountId,
              connectionId: material.connectionId,
              entity: "whatsapp-connection",
              fieldOrObjectPurpose: "display-name",
              recordId: material.connectionId,
            },
            plaintext: new TextEncoder().encode(requestedName),
          });
          const persisted = yield* persistence.rename({
            clerkUserId,
            displayNameCiphertext: decodeBase64(protectedName.ciphertext),
            displayNameCiphertextVersion: protectedName.version,
            displayNameKeyVersion: protectedName.keyVersion,
            displayNameNonce: decodeBase64(protectedName.nonce),
            publicId,
          });
          if (persisted === null) {
            return yield* Effect.fail(new WhatsAppConnectionNotAccessible());
          }
          const connection = yield* revealConnection(persisted);
          const telemetry = yield* SafeTelemetry;
          yield* telemetry.emit({
            event: "whatsapp_connection.rename.completed",
            service: "api",
          });
          return { connection, kind: "rename" as const };
        }
        if (lifecycleMatch !== null) {
          const publicId = lifecycleMatch[1];
          const action = lifecycleMatch[2];
          if (
            publicId === undefined ||
            (action !== "disconnect" &&
              action !== "reconnect" &&
              action !== "delete")
          ) {
            return yield* Effect.fail(new WhatsAppConnectionNotAccessible());
          }
          if (action === "delete") {
            const receipt = yield* deleteWhatsAppConnection(
              clerkUserId,
              publicId,
            );
            const telemetry = yield* SafeTelemetry;
            yield* telemetry.emit({
              event: "whatsapp_connection.deletion.completed",
              outcome: "complete",
              service: "api",
            });
            return { kind: "deletion" as const, receipt };
          }
          const observation = yield* reconcileWhatsAppConnectionLifecycle(
            clerkUserId,
            publicId,
            action,
          );
          const telemetry = yield* SafeTelemetry;
          yield* telemetry.emit({
            event: "whatsapp_connection.lifecycle.completed",
            operation: action,
            outcome: observation.outcome,
            service: "api",
          });
          return { kind: "lifecycle" as const, observation };
        }
        if (qrMatch !== null) {
          const setupId = qrMatch[1];
          if (setupId === undefined) {
            return yield* Effect.fail(new WhatsAppConnectionNotAccessible());
          }
          const observation = yield* observeConnectionSetup(
            clerkUserId,
            setupId,
          );
          const telemetry = yield* SafeTelemetry;
          yield* telemetry.emit({
            event: "connection_setup.qr.completed",
            outcome: observation.outcome,
            service: "api",
          });
          return { kind: "observation" as const, observation };
        }
        const persistence = yield* WhatsAppConnectionPersistence;
        const protectedConnections = yield* persistence.list(clerkUserId);
        const connections = yield* Effect.forEach(
          protectedConnections,
          revealConnection,
          { concurrency: 3 },
        );
        const telemetry = yield* SafeTelemetry;
        yield* telemetry.emit({
          connectionCount: connections.length,
          event: "whatsapp_connection.list.completed",
          service: "api",
        });
        return { connections, kind: "connections" as const };
      }).pipe(
        Effect.provide(layer),
        Effect.match({
          onFailure: (failure: unknown) =>
            hasFailureTag(
              failure,
              "InvalidHumanIdentity",
              "WhatsAppConnectionNotAccessible",
            )
              ? notFound(browserOrigin)
              : jsonResponse({ error: "unavailable" }, 503, browserOrigin),
          onSuccess: (result) => {
            if (result.kind === "rename") {
              return jsonResponse(
                { whatsapp_connection: connectionJson(result.connection) },
                200,
                browserOrigin,
              );
            }
            if (result.kind === "deletion") {
              return jsonResponse(
                {
                  deletion: {
                    outcome: "complete",
                    requested_at: result.receipt.requestedAt,
                  },
                  whatsapp_connection_id: result.receipt.publicId,
                },
                200,
                browserOrigin,
              );
            }
            if (result.kind === "lifecycle") {
              const observation = result.observation;
              if (observation.outcome === "qr_available") {
                return reconnectQrResponse(observation, browserOrigin);
              }
              return jsonResponse(
                {
                  lifecycle: {
                    action: observation.action,
                    outcome: observation.outcome,
                  },
                  whatsapp_connection: connectionJson(observation.connection),
                },
                observation.outcome === "complete"
                  ? 200
                  : observation.outcome === "in_progress"
                    ? 202
                    : 409,
                browserOrigin,
              );
            }
            if (result.kind === "connections") {
              return jsonResponse(
                {
                  whatsapp_connections: result.connections.map(connectionJson),
                },
                200,
                browserOrigin,
              );
            }
            const observation = result.observation;
            switch (observation.outcome) {
              case "connected":
                return new Response(null, {
                  headers: {
                    ...corsHeaders(browserOrigin),
                    "cache-control": "no-store",
                    "x-connection-setup-state": "connected",
                  },
                  status: 204,
                });
              case "qr_available":
                return qrResponse(
                  observation.image,
                  observation.expiresAt,
                  browserOrigin,
                );
              case "connecting":
              case "pending":
                return stateResponse(observation.outcome, browserOrigin);
              case "number_confirmation_failed":
                return jsonResponse(
                  {
                    error: observation.outcome,
                    message:
                      "Retry by scanning the same WhatsApp account you entered.",
                  },
                  409,
                  browserOrigin,
                );
              case "provisioning_failed":
              case "provider_capacity_unavailable":
              case "provisioning_quarantined":
                return jsonResponse(
                  { error: observation.outcome },
                  409,
                  browserOrigin,
                );
            }
          },
        }),
      ),
    );
  };

export const isWhatsAppConnectionRequest = (request: Request): boolean => {
  const path = new URL(request.url).pathname;
  return (
    path === CONNECTIONS_ROUTE ||
    qrRoutePattern.test(path) ||
    lifecycleRoutePattern.test(path) ||
    nameRoutePattern.test(path)
  );
};
