import { Effect, Layer } from "effect";
import {
  ActivityLogClock,
  ActivityLogPersistence,
} from "../../src/activity-log";
import {
  ApiKeyClock,
  ApiKeyHmac,
  ApiKeyIdentifiers,
  ApiKeyPersistence,
  makeApiKeyHmac,
  productionApiKeyIdentifiers,
} from "../../src/api-key";
import {
  HumanIdentity,
  InvalidHumanIdentity as InvalidHumanIdentityRequest,
} from "../../src/auth/human-identity";
import {
  ConnectionSetupClock,
  ConnectionSetupIdentifiers,
  ConnectionSetupNumberTokens,
  ConnectionSetupPersistence,
} from "../../src/connection-setup";
import {
  ConnectionSetupProvisioningClock,
  ConnectionSetupProvisioningIdentifiers,
  ConnectionSetupProvisioningPersistence,
  ConnectionSetupProvisioningProvider,
  ConnectionSetupProvisioningQueue,
  ConnectionSetupProvisioningWebhook,
} from "../../src/connection-setup-provisioning";
import { EnvelopeEncryptionService } from "../../src/encryption/envelope";
import type { Env } from "../../src/index";
import { SendTextMessage } from "../../src/mcp";
import {
  McpAuthorizationClock,
  McpAuthorizationPersistence,
} from "../../src/mcp-authorization";
import {
  createMessageRetentionHandler,
  isMessageRetentionRequest,
  MessageRetentionClock,
  MessageRetentionPersistence,
} from "../../src/message-retention";
import {
  OnboardingProfileClock,
  OnboardingProfilePersistence,
} from "../../src/onboarding-profile";
import {
  PersonalAccountIdentifiers,
  PersonalAccountPersistence,
} from "../../src/personal-account";
import { createProductionHandler } from "../../src/production";
import {
  BoundaryClock,
  BoundaryIdentifiers,
  BoundaryIdentity,
  BoundaryProvider,
  BoundaryResource,
  ControlledBoundaryFailure,
  InvalidBoundaryIdentity,
} from "../../src/public-boundary";
import { createPublicBoundaryWorker } from "../../src/public-boundary-worker";
import {
  createRecipientExclusionHandler,
  isRecipientExclusionRequest,
  RecipientExclusionClock,
  RecipientExclusionPersistence,
  RecipientTransitionJournal,
} from "../../src/recipient-exclusion";
import {
  RestClock,
  RestCursorCodec,
  RestCursorError,
  RestIdentifiers,
  RestPersistence,
} from "../../src/rest";
import { RestoreSafeDeletion, SafeTelemetry } from "../../src/services";
import {
  WebhookEventClock,
  WebhookEventIdentifiers,
  WebhookEventObjectStore,
  WebhookEventObjectStoreError,
  WebhookEventPersistence,
  WebhookEventPersistenceError,
  WebhookEventRetrySchedule,
  wasenderWebhookEventNormalizationLayer,
} from "../../src/webhook-event";
import {
  WebhookIngressClock,
  WebhookIngressIdentifiers,
  WebhookIngressObjectStore,
  WebhookIngressObjectStoreError,
  WebhookIngressPersistence,
  WebhookIngressPersistenceError,
  WebhookIngressQueue,
  WebhookIngressQueueError,
  type WebhookIngressQueueMessage,
} from "../../src/webhook-ingress";
import {
  WebhookRecoveryCheckpoint,
  WebhookRecoveryCheckpointError,
  WebhookRecoveryObjectStore,
  WebhookRecoveryObjectStoreError,
  WebhookRecoveryPersistence,
} from "../../src/webhook-recovery";
import {
  WebhookReplayClock,
  WebhookReplayPersistence,
  WebhookReplayQueue,
  WebhookSourceObjectStore,
} from "../../src/webhook-replay";
import {
  WhatsAppConnectionClock,
  WhatsAppConnectionIdentifiers,
  WhatsAppConnectionPersistence,
  WhatsAppConnectionProvider,
} from "../../src/whatsapp-connection";

const TEST_LAYER_SENTINEL = "TEST_LAYER_SENTINEL_DO_NOT_INCLUDE_IN_PRODUCTION";
const TEST_FAULT_INJECTOR_SENTINEL =
  "TEST_FAULT_INJECTOR_DO_NOT_INCLUDE_IN_PRODUCTION";

const browserOrigin = "http://127.0.0.1:3000";
const personalAccounts = new Map<string, string>();
const onboardingProfiles = new Map<
  string,
  {
    readonly completedAt: string;
    readonly createdAt: string;
    readonly intendedMcpClient: "claude" | "chatgpt" | "other" | "not_sure";
    readonly primaryUseCase:
      | "conversation_search"
      | "summaries"
      | "draft_replies"
      | "outbound_sends"
      | "follow_ups"
      | "exploration"
      | "other";
    readonly researchCallInterest: "yes" | "no" | "not_sure";
    readonly role:
      | "founder_or_owner"
      | "engineer"
      | "product_or_design"
      | "operations_or_support"
      | "marketing_or_sales"
      | "consultant_or_freelancer"
      | "student_or_researcher"
      | "other"
      | "not_sure";
    readonly updatedAt: string;
    readonly whatsappUsageContext: "personal" | "work" | "both";
  }
>();
const connectionSetups = new Map<
  string,
  {
    readonly displayName: string;
    readonly numberToken: string;
    readonly setup: {
      readonly createdAt: string;
      readonly expiresAt: string;
      readonly setupId: string;
      readonly state: "cancelled" | "expired" | "provisioning_pending";
    };
  }
>();
let nextConnectionSetupId = 0;
const provisioningLeases = new Map<string, string>();
const provisionedSetups = new Set<string>();
let authorizationRevokedAt: Date | null = null;
const testAuthorizationId = "mca_123456789012345678901";
const testPersonalAccountId = "10000000-0000-4000-8000-000000000018";
const apiKeys: Array<{
  clerkUserId: string;
  connectionIds: ReadonlyArray<string>;
  createdAt: Date;
  credentialDigest: Uint8Array;
  credentialHint: string;
  expiresAt: Date | null;
  grantId: string;
  lastUsedAt: Date | null;
  name: string;
  permissions: ReadonlyArray<
    "connections:read" | "directory:read" | "messages:read" | "messages:send"
  >;
  personalAccountId: string;
  publicId: string;
  revokedAt: Date | null;
  state: "active" | "expired" | "revoked";
}> = [];
const apiActivityLogs: Array<{
  apiKeyId: string;
  clientName: string;
  completedAt: Date | null;
  errorCode: string | null;
  id: string;
  outcome:
    | "started"
    | "success"
    | "execution_error"
    | "rate_limited"
    | "authorization_denied";
  resultCount: number | null;
  startedAt: Date;
  toolName: string;
}> = [];
const providerObservations: string[] = [];
const qrObservations = new Map<string, number>();
let providerConnectionState:
  | "connected"
  | "connecting"
  | "disconnected"
  | "reconnect_required"
  | "degraded" = "disconnected";
let lifecycleClaimId: string | null = null;
const retentionPolicies = new Map<string, number | null>();
const recipientExclusions = new Map<string, boolean>();
const testRecipients = [
  {
    displayName: "Ada Lovelace",
    id: "ctc_000000000000000000001",
    kind: "contact" as const,
    phoneLastFour: "0123",
  },
  {
    displayName: "Grace Hopper",
    id: "ctc_000000000000000000002",
    kind: "contact" as const,
    phoneLastFour: "0456",
  },
  {
    displayName: "Release crew",
    id: "grp_000000000000000000001",
    kind: "group" as const,
    phoneLastFour: null,
  },
];
const whatsAppConnections: Array<{
  displayName: string;
  numberSuffix: string;
  publicId: string;
  state:
    | "connected"
    | "connecting"
    | "degraded"
    | "disconnected"
    | "reconnect_required";
  stateChangedAt: string;
}> = [];
const publishedWebhookMessages: WebhookIngressQueueMessage[] = [];
const encryptedWebhookPayloads = new Map<string, Uint8Array>();
const encryptedDisplayNames = new Map<string, string>();
const testAccountKey = {
  ciphertext: "AQID",
  keyVersion: 1,
  kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/test-content-root",
  personalAccountId: "10000000-0000-4000-8000-000000000018",
  version: 1 as const,
};
const testConnectionKey = (connectionId: string) => ({
  accountKeyVersion: 1,
  ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
  connectionId,
  keyVersion: 1,
  nonce: "AQIDBAUGBwgJCgsM",
  personalAccountId: testAccountKey.personalAccountId,
  version: 1 as const,
});
const protectedTestConnection = (
  connection: (typeof whatsAppConnections)[number],
) => ({
  accountKey: testAccountKey,
  connectionId: "20000000-0000-4000-8000-000000000018",
  connectionKey: testConnectionKey("20000000-0000-4000-8000-000000000018"),
  displayName: {
    ciphertext: {
      ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
      keyVersion: 1,
      nonce: "AQIDBAUGBwgJCgsM",
      version: 1 as const,
    },
    fallback: null,
  },
  numberSuffix: connection.numberSuffix,
  publicId: connection.publicId,
  state: connection.state,
  stateChangedAt: connection.stateChangedAt,
});
const claimedWebhookItems = new Set<string>();
const claimedWebhookEvents = new Set<string>();
const deadLetteredWebhookEvents = new Set<string>();
let latestDeadLetteredWebhookEventId: string | null = null;
const webhookIncidentReference = "50000000-0000-4000-8000-000000000018";
const webhookReplayAttempts = new Map<
  string,
  {
    readonly message: WebhookIngressQueueMessage;
    status: "dispatched" | "pending";
  }
>();
let projectedConnectionStateVersion: string | null = null;
let projectedConnectionStateReceivedAt: string | null = null;
let nextWebhookObjectId = 0;

const tokenKey = (value: Uint8Array) => Array.from(value).join(",");

type FailureTarget =
  | "identity"
  | "provider"
  | "webhook-database"
  | "webhook-queue"
  | "webhook-r2";

const failWhenSelected = (
  selected: FailureTarget | undefined,
  target: "identity" | "provider",
) =>
  selected === target
    ? Effect.fail(new ControlledBoundaryFailure({ target }))
    : Effect.void;

const makeTestLayer = (
  failure: FailureTarget | undefined,
  environment?: {
    readonly INGESTION_QUEUE: Queue;
    readonly OAUTH_KV: KVNamespace;
    readonly WEBHOOK_INGRESS: R2Bucket;
  },
) => {
  void TEST_LAYER_SENTINEL;
  void TEST_FAULT_INJECTOR_SENTINEL;

  return Layer.mergeAll(
    wasenderWebhookEventNormalizationLayer,
    Layer.succeed(BoundaryIdentity, {
      verify: (authorization) =>
        Effect.gen(function* () {
          yield* failWhenSelected(failure, "identity");
          if (authorization !== "Bearer signed-test-user") {
            return yield* Effect.fail(new InvalidBoundaryIdentity());
          }
          return "user_test_public_boundary";
        }),
    }),
    Layer.succeed(HumanIdentity, {
      verify: (request) => {
        const authorization = request.headers.get("authorization");
        if (authorization === "Bearer signed-test-user") {
          return Effect.succeed("user_test_public_boundary");
        }
        if (authorization === "Bearer signed-second-test-user") {
          return Effect.succeed("user_second_test_public_boundary");
        }
        return Effect.fail(new InvalidHumanIdentityRequest());
      },
      verifyRecently: (request) => {
        const authorization = request.headers.get("authorization");
        if (authorization === "Bearer signed-test-user") {
          return Effect.succeed({
            clerkUserId: "user_test_public_boundary",
            reverifiedAt: new Date("2026-01-02T03:03:00.000Z"),
          });
        }
        if (authorization === "Bearer signed-second-test-user") {
          return Effect.succeed({
            clerkUserId: "user_second_test_public_boundary",
            reverifiedAt: new Date("2026-01-02T03:03:00.000Z"),
          });
        }
        return Effect.fail(new InvalidHumanIdentityRequest());
      },
    }),
    Layer.succeed(BoundaryProvider, {
      observeConnection: failWhenSelected(failure, "provider").pipe(
        Effect.as("connected" as const),
      ),
    }),
    Layer.succeed(BoundaryClock, {
      now: Effect.succeed("2026-01-02T03:04:05.000Z"),
    }),
    Layer.succeed(BoundaryIdentifiers, {
      authorizationCode: Effect.succeed("oauth_test_code"),
      connection: Effect.succeed("con_0123456789abcdefghijk"),
    }),
    Layer.succeed(BoundaryResource, {
      read: Effect.succeed(new TextEncoder().encode("protected boundary")),
    }),
    Layer.succeed(PersonalAccountIdentifiers, {
      next: Effect.succeed("10000000-0000-4000-8000-000000000018"),
    }),
    Layer.succeed(PersonalAccountPersistence, {
      create: (input) =>
        Effect.sync(() => {
          const existing = personalAccounts.get(input.clerkUserId);
          if (existing) {
            return {
              admissionState: "active" as const,
              created: false,
              messageRetentionDays: 30,
              personalAccountId: existing,
              storedMediaLimitBytes: 5_368_709_120,
              whatsappConnectionLimit: 3,
            };
          }
          personalAccounts.set(input.clerkUserId, input.personalAccountId);
          return {
            admissionState: "active" as const,
            created: true,
            messageRetentionDays: 30,
            personalAccountId: input.personalAccountId,
            storedMediaLimitBytes: 5_368_709_120,
            whatsappConnectionLimit: 3,
          };
        }),
      resolve: (clerkUserId) =>
        Effect.sync(() => {
          const existing = personalAccounts.get(clerkUserId);
          return existing
            ? {
                admissionState: "active" as const,
                keyAvailable: true,
                messageRetentionDays: 30,
                personalAccountId: existing,
                storedMediaLimitBytes: 5_368_709_120,
                whatsappConnectionLimit: 3,
              }
            : null;
        }),
    }),
    Layer.succeed(ConnectionSetupClock, {
      now: Effect.succeed("2026-01-02T03:04:05.000Z"),
    }),
    Layer.succeed(ConnectionSetupIdentifiers, {
      next: Effect.sync(() => {
        nextConnectionSetupId += 1;
        return `cst_${String(nextConnectionSetupId).padStart(21, "0")}`;
      }),
    }),
    Layer.succeed(ConnectionSetupNumberTokens, {
      derive: (number) =>
        Effect.succeed(
          new Uint8Array(32).map(
            (_, index) => number.charCodeAt(index % number.length) % 256,
          ),
        ),
    }),
    Layer.succeed(ConnectionSetupProvisioningQueue, {
      enqueue: () => Effect.void,
      enqueueCleanup: () => Effect.void,
    }),
    Layer.succeed(ConnectionSetupProvisioningClock, {
      now: Effect.succeed("2026-01-02T03:05:00.000Z"),
    }),
    Layer.succeed(ConnectionSetupProvisioningIdentifiers, {
      nextWorkerId: Effect.succeed(
        "cspw_0000000000000000000000000000000000000000000",
      ),
    }),
    Layer.succeed(ConnectionSetupProvisioningWebhook, {
      urlFor: (webhookIngressId) =>
        Effect.succeed(
          `https://api.example.test/webhooks/wasender/${webhookIngressId}`,
        ),
    }),
    Layer.succeed(ConnectionSetupProvisioningPersistence, {
      claim: ({ setupId, workerId }) =>
        Effect.sync(() => {
          if (provisionedSetups.has(setupId)) {
            return { outcome: "not_pending" as const };
          }
          if (provisioningLeases.has(setupId)) {
            return { outcome: "leased" as const };
          }
          provisioningLeases.set(setupId, workerId);
          return {
            outcome: "claimed" as const,
            setup: {
              accountKey: {
                ciphertext: "AQID",
                keyVersion: 1,
                kmsKeyId:
                  "arn:aws:kms:us-east-1:111122223333:key/test-content-root",
                personalAccountId: "10000000-0000-4000-8000-000000000018",
                version: 1 as const,
              },
              connectionKey: {
                accountKeyVersion: 1,
                ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                connectionId: setupId,
                keyVersion: 1,
                nonce: "AQIDBAUGBwgJCgsM",
                personalAccountId: "10000000-0000-4000-8000-000000000018",
                version: 1 as const,
              },
              numberCiphertext: {
                ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                keyVersion: 1,
                nonce: "AQIDBAUGBwgJCgsM",
                version: 1 as const,
              },
              personalAccountId: "10000000-0000-4000-8000-000000000018",
              setupId,
              webhookIngressId: "30000000-0000-4000-8000-000000000018",
            },
          };
        }),
      finish: ({ setupId, workerId }) =>
        Effect.sync(() => {
          if (provisioningLeases.get(setupId) !== workerId) return false;
          provisioningLeases.delete(setupId);
          provisionedSetups.add(setupId);
          return true;
        }),
      fail: ({ setupId, workerId }) =>
        Effect.sync(() => {
          if (provisioningLeases.get(setupId) !== workerId) return false;
          provisioningLeases.delete(setupId);
          provisionedSetups.add(setupId);
          return true;
        }),
      listCandidates: () => Effect.succeed([]),
      release: ({ setupId, workerId }) =>
        Effect.sync(() => {
          if (provisioningLeases.get(setupId) !== workerId) return false;
          provisioningLeases.delete(setupId);
          return true;
        }),
      renew: ({ setupId, workerId }) =>
        Effect.sync(() => provisioningLeases.get(setupId) === workerId),
    }),
    Layer.succeed(ConnectionSetupProvisioningProvider, {
      create: () =>
        Effect.succeed({
          ok: true as const,
          value: {
            authority: "test-session-authority",
            connectionState: "disconnected" as const,
            session: "wsl_0000000000000000000000000000000000000000000",
          },
        }),
      reconcile: () =>
        Effect.succeed({
          ok: true as const,
          value: { outcome: "absent" as const },
        }),
    }),
    Layer.succeed(McpAuthorizationClock, {
      now: Effect.succeed(new Date("2026-01-02T03:05:00.000Z")),
    }),
    Layer.succeed(ActivityLogClock, {
      now: Effect.succeed(new Date("2026-01-02T03:05:00.000Z")),
    }),
    Layer.succeed(ActivityLogPersistence, {
      list: (clerkUserId, _observedAt, cursor) =>
        Effect.succeed(
          clerkUserId === "user_test_public_boundary"
            ? {
                logs: [
                  ...apiActivityLogs.map((log) => ({
                    apiKeyId: log.apiKeyId,
                    authorizationId: null,
                    channel: "api" as const,
                    clientId: log.apiKeyId,
                    clientName: log.clientName,
                    completedAt: log.completedAt,
                    connectionId: null,
                    errorCode: log.errorCode,
                    latencyMs:
                      log.completedAt === null
                        ? null
                        : log.completedAt.valueOf() - log.startedAt.valueOf(),
                    mediaBytes: 0,
                    outcome: log.outcome,
                    resultCount: log.resultCount,
                    sendId: null,
                    startedAt: log.startedAt,
                    toolName: log.toolName,
                  })),
                  ...(cursor === null
                    ? [
                        {
                          apiKeyId: null,
                          authorizationId: testAuthorizationId,
                          channel: "mcp" as const,
                          clientId: "approved-client",
                          clientName: "Approved MCP Client",
                          completedAt: new Date("2026-01-02T03:04:05.120Z"),
                          connectionId: "con_123456789012345678901",
                          errorCode: null,
                          latencyMs: 120,
                          mediaBytes: 0,
                          outcome: "success" as const,
                          resultCount: 1,
                          sendId: null,
                          startedAt: new Date("2026-01-02T03:04:05.000Z"),
                          toolName: "list_connections",
                        },
                      ]
                    : [
                        {
                          apiKeyId: null,
                          authorizationId: testAuthorizationId,
                          channel: "mcp" as const,
                          clientId: "approved-client",
                          clientName: "Approved MCP Client",
                          completedAt: new Date("2026-01-02T03:03:05.045Z"),
                          connectionId: "con_123456789012345678901",
                          errorCode: null,
                          latencyMs: 45,
                          mediaBytes: 0,
                          outcome: "success" as const,
                          resultCount: 2,
                          sendId: null,
                          startedAt: new Date("2026-01-02T03:03:05.000Z"),
                          toolName: "read_messages",
                        },
                      ]),
                ],
                nextCursor:
                  cursor === null ? "tcl_123456789012345678901" : null,
              }
            : null,
        ),
    }),
    Layer.succeed(MessageRetentionClock, {
      now: Effect.succeed("2026-08-03T12:00:00.000Z"),
    }),
    Layer.succeed(MessageRetentionPersistence, {
      get: ({ connectionPublicId }) =>
        Effect.succeed(
          whatsAppConnections.some(
            (connection) => connection.publicId === connectionPublicId,
          )
            ? {
                days: retentionPolicies.get(connectionPublicId) ?? 30,
                updatedAt: "2026-08-03T12:00:00.000Z",
              }
            : null,
        ),
      update: ({ connectionPublicId, days, expectedDays, updatedAt }) =>
        Effect.sync(() => {
          if (
            !whatsAppConnections.some(
              (connection) => connection.publicId === connectionPublicId,
            ) ||
            (retentionPolicies.get(connectionPublicId) ?? 30) !== expectedDays
          ) {
            return null;
          }
          retentionPolicies.set(connectionPublicId, days);
          return { days, updatedAt };
        }),
    }),
    Layer.succeed(OnboardingProfileClock, {
      now: Effect.succeed("2026-08-03T12:00:00.000Z"),
    }),
    Layer.succeed(OnboardingProfilePersistence, {
      get: ({ clerkUserId }) =>
        Effect.sync(() => {
          if (!personalAccounts.has(clerkUserId)) {
            return { accessible: false as const };
          }
          return {
            accessible: true as const,
            profile: onboardingProfiles.get(clerkUserId) ?? null,
          };
        }),
      upsert: (input) =>
        Effect.sync(() => {
          if (!personalAccounts.has(input.clerkUserId)) {
            return null;
          }
          const existing = onboardingProfiles.get(input.clerkUserId);
          const profile = {
            completedAt: existing?.completedAt ?? input.updatedAt,
            createdAt: existing?.createdAt ?? input.updatedAt,
            intendedMcpClient: input.intendedMcpClient,
            primaryUseCase: input.primaryUseCase,
            researchCallInterest: input.researchCallInterest,
            role: input.role,
            updatedAt: input.updatedAt,
            whatsappUsageContext: input.whatsappUsageContext,
          };
          onboardingProfiles.set(input.clerkUserId, profile);
          return profile;
        }),
    }),
    Layer.succeed(RecipientExclusionClock, {
      now: Effect.succeed("2026-08-03T12:00:00.000Z"),
    }),
    Layer.succeed(RecipientTransitionJournal, {
      append: () => Effect.void,
    }),
    Layer.succeed(RecipientExclusionPersistence, {
      finalize: ({ recipientPublicId }) =>
        Effect.succeed({
          effectiveAt: "2026-08-03T12:00:00.000Z",
          excluded: recipientExclusions.get(recipientPublicId) === true,
          purgeCutoffAt: "2026-08-03T12:00:00.000Z",
        }),
      list: ({ connectionPublicId, kind, search }) =>
        Effect.succeed(
          whatsAppConnections.some(
            (connection) => connection.publicId === connectionPublicId,
          )
            ? {
                material: {
                  accountKey: {
                    ciphertext: "AA==",
                    keyVersion: 1,
                    kmsKeyId: "test",
                    personalAccountId: "10000000-0000-4000-8000-000000000001",
                    version: 1,
                  },
                  connectionKey: {
                    accountKeyVersion: 1,
                    ciphertext: "AA==",
                    connectionId: "20000000-0000-4000-8000-000000000001",
                    keyVersion: 1,
                    nonce: "AAAAAAAAAAAAAAAA",
                    personalAccountId: "10000000-0000-4000-8000-000000000001",
                    version: 1,
                  },
                  identityKey: {
                    ciphertext: "AA==",
                    keyVersion: 1,
                    nonce: "AAAAAAAAAAAAAAAA",
                    version: 1,
                  },
                  personalAccountId: "10000000-0000-4000-8000-000000000001",
                  projection: {
                    asOf: "2026-08-03T11:00:00.000Z",
                    partial: false,
                    stale: false,
                  },
                  whatsappConnectionId: "20000000-0000-4000-8000-000000000001",
                },
                recipients: testRecipients
                  .filter(
                    (recipient) =>
                      recipient.kind === kind &&
                      (search === null ||
                        (recipient.displayName ?? "")
                          .toLowerCase()
                          .startsWith(search.toLowerCase())),
                  )
                  .map((recipient) => ({
                    displayNameCiphertext: null,
                    excluded: recipientExclusions.get(recipient.id) === true,
                    phoneCiphertext: null,
                    publicId: recipient.id,
                    recordId: recipient.id,
                  })),
              }
            : null,
        ),
      open: ({ recipients }) =>
        Effect.succeed(
          recipients.map((recipient) => {
            const known = testRecipients.find(
              (candidate) => candidate.id === recipient.publicId,
            );
            return {
              displayName: known?.displayName ?? null,
              excluded: recipient.excluded,
              phoneLastFour: known?.phoneLastFour ?? null,
              publicId: recipient.publicId,
            };
          }),
        ),
      prepare: ({ excluded, expectedExcluded, recipientPublicId }) =>
        Effect.sync(() => {
          const known = testRecipients.find(
            (candidate) => candidate.id === recipientPublicId,
          );
          if (known === undefined) return null;
          const current = recipientExclusions.get(recipientPublicId) === true;
          if (current !== expectedExcluded) {
            return {
              effectiveAt: "2026-08-03T12:00:00.000Z",
              excluded: current,
              outcome: "conflict" as const,
              personalAccountId: "10000000-0000-4000-8000-000000000001",
              purgeCutoffAt: null,
              recipientKind: known.kind,
              recipientLocator:
                known.kind === "contact"
                  ? `di1_${"A".repeat(43)}`
                  : `wi1_${"A".repeat(43)}`,
              transitionId: null,
              whatsappConnectionId: "20000000-0000-4000-8000-000000000001",
            };
          }
          recipientExclusions.set(recipientPublicId, excluded);
          return {
            effectiveAt: "2026-08-03T12:00:00.000Z",
            excluded,
            outcome: "prepared" as const,
            personalAccountId: "10000000-0000-4000-8000-000000000001",
            purgeCutoffAt: "2026-08-03T12:00:00.000Z",
            recipientKind: known.kind,
            recipientLocator:
              known.kind === "contact"
                ? `di1_${"A".repeat(43)}`
                : `wi1_${"A".repeat(43)}`,
            transitionId: "30000000-0000-4000-8000-000000000001",
            whatsappConnectionId: "20000000-0000-4000-8000-000000000001",
          };
        }),
    }),
    Layer.succeed(McpAuthorizationPersistence, {
      create: () => Effect.die("not used"),
      isActive: () => Effect.succeed(authorizationRevokedAt === null),
      list: (clerkUserId) =>
        Effect.succeed(
          clerkUserId === "user_test_public_boundary"
            ? [
                {
                  authorizationId: testAuthorizationId,
                  authorizedAt: new Date("2026-01-01T03:05:00.000Z"),
                  clientClass: "approved",
                  clientId: "approved-client",
                  clientName: "Approved MCP Client",
                  connectionIds: ["con_123456789012345678901"],
                  expired: false,
                  expiresAt: new Date("2026-04-01T03:05:00.000Z"),
                  revoked: authorizationRevokedAt !== null,
                  revokedAt: authorizationRevokedAt,
                  scopes: ["connections:read", "messages:send"] as const,
                },
              ]
            : [],
        ),
      listConnections: () => Effect.succeed([]),
      registerRefreshCredential: () => Effect.die("not used"),
      revoke: ({ authorizationId, clerkUserId, revokedAt }) =>
        Effect.sync(() => {
          if (
            clerkUserId !== "user_test_public_boundary" ||
            authorizationId !== testAuthorizationId
          ) {
            return null;
          }
          authorizationRevokedAt ??= revokedAt;
          return { revokedAt: authorizationRevokedAt };
        }),
      rotateRefreshCredential: () => Effect.die("not used"),
    }),
    Layer.succeed(ApiKeyClock, {
      now: Effect.succeed(new Date("2026-01-02T03:04:05.000Z")),
    }),
    Layer.succeed(ApiKeyIdentifiers, productionApiKeyIdentifiers),
    Layer.succeed(
      ApiKeyHmac,
      makeApiKeyHmac(
        "4242424242424242424242424242424242424242424242424242424242424242",
      ),
    ),
    Layer.succeed(ApiKeyPersistence, {
      authenticate: (input) =>
        Effect.sync(() => {
          const existing = apiKeys.find(
            (key) =>
              key.publicId === input.publicId &&
              key.state === "active" &&
              key.credentialDigest.length === input.digest.length &&
              key.credentialDigest.every(
                (byte, index) => byte === input.digest[index],
              ),
          );
          if (existing === undefined) return null;
          existing.lastUsedAt = new Date("2026-01-02T03:04:05.000Z");
          return {
            connectionIds: existing.connectionIds,
            expiresAt: existing.expiresAt,
            grantId: existing.grantId,
            id: existing.publicId,
            name: existing.name,
            permissions: existing.permissions,
            personalAccountId: existing.personalAccountId,
          };
        }),
      create: (input) =>
        Effect.sync(() => {
          if (
            input.clerkUserId !== "user_test_public_boundary" &&
            input.clerkUserId !== "user_second_test_public_boundary"
          ) {
            return { outcome: "not_found" as const };
          }
          if (
            apiKeys.filter(
              (key) =>
                key.clerkUserId === input.clerkUserId && key.state === "active",
            ).length >= 10
          ) {
            return { outcome: "limit_reached" as const };
          }
          if (
            apiKeys.some(
              (key) =>
                key.clerkUserId === input.clerkUserId &&
                key.state === "active" &&
                key.name.toLowerCase() === input.name.toLowerCase(),
            )
          ) {
            return { outcome: "duplicate_name" as const };
          }
          if (input.expiresAt !== null && input.expiresAt <= input.createdAt) {
            return { outcome: "invalid" as const };
          }
          const summary = {
            clerkUserId: input.clerkUserId,
            connectionIds: input.connectionIds,
            createdAt: input.createdAt,
            credentialDigest: input.credentialDigest,
            credentialHint: input.credentialHint,
            expiresAt: input.expiresAt,
            grantId: input.id,
            lastUsedAt: null,
            name: input.name,
            permissions: input.permissions,
            personalAccountId: testPersonalAccountId,
            publicId: input.publicId,
            revokedAt: null,
            state: "active" as const,
          };
          apiKeys.push(summary);
          return {
            outcome: "created" as const,
            summary: {
              connectionIds: summary.connectionIds,
              createdAt: summary.createdAt,
              credentialHint: summary.credentialHint,
              expiresAt: summary.expiresAt,
              id: summary.publicId,
              lastUsedAt: summary.lastUsedAt,
              name: summary.name,
              permissions: summary.permissions,
              revokedAt: summary.revokedAt,
              state: summary.state,
            },
          };
        }),
      list: (clerkUserId, observedAt) =>
        Effect.succeed(
          apiKeys
            .filter((key) => key.clerkUserId === clerkUserId)
            .map((key) => ({
              connectionIds: key.connectionIds,
              createdAt: key.createdAt,
              credentialHint: key.credentialHint,
              expiresAt: key.expiresAt,
              id: key.publicId,
              lastUsedAt: key.lastUsedAt,
              name: key.name,
              permissions: key.permissions,
              revokedAt: key.revokedAt,
              state:
                key.state === "revoked"
                  ? ("revoked" as const)
                  : key.expiresAt !== null && key.expiresAt <= observedAt
                    ? ("expired" as const)
                    : ("active" as const),
            })),
        ),
      revoke: (input) =>
        Effect.sync(() => {
          const existing = apiKeys.find(
            (key) =>
              key.clerkUserId === input.clerkUserId &&
              key.publicId === input.publicId,
          );
          if (existing === undefined) return null;
          existing.revokedAt ??= input.revokedAt;
          existing.state = "revoked";
          return { revokedAt: existing.revokedAt };
        }),
    }),
    Layer.succeed(RestClock, {
      now: Effect.succeed(new Date("2026-01-02T03:04:05.000Z")),
    }),
    Layer.succeed(RestIdentifiers, {
      nextAuditLogId: Effect.succeed("50000000-0000-4000-8000-000000000079"),
    }),
    Layer.succeed(SendTextMessage, {
      send: (input) =>
        Effect.succeed(
          input.grant.kind === "api" &&
            input.grant.apiKey.permissions.includes("messages:send")
            ? {
                outcome: "receipt" as const,
                receipt: {
                  send_id: "snd_123456789012345678901" as never,
                  status: "processing" as const,
                  created_at: "2026-08-17T12:00:00.000Z" as never,
                  status_changed_at: "2026-08-17T12:00:00.000Z" as never,
                  idempotent_replay: false,
                },
              }
            : { outcome: "authorization_denied" as const },
        ),
    }),
    Layer.succeed(RestCursorCodec, {
      decode: () => Effect.fail(new RestCursorError()),
      encode: () => Effect.succeed("rest-cursor"),
    }),
    Layer.succeed(RestPersistence, {
      beginProtectedOperation: (input) =>
        Effect.sync(() => {
          if (input.channel !== "api") {
            return {
              auditLogId: input.auditLogId,
              outcome: "authorization_denied" as const,
            };
          }
          if (
            input.requiredPermission !== undefined &&
            !(input.permissions ?? []).includes(input.requiredPermission)
          ) {
            apiActivityLogs.unshift({
              apiKeyId: input.apiKey.publicId,
              clientName: input.apiKey.name,
              completedAt: input.observedAt,
              errorCode: "authorization_denied",
              id: input.auditLogId,
              outcome: "authorization_denied",
              resultCount: null,
              startedAt: input.observedAt,
              toolName: input.operationName,
            });
            return {
              auditLogId: input.auditLogId,
              outcome: "authorization_denied" as const,
            };
          }
          apiActivityLogs.unshift({
            apiKeyId: input.apiKey.publicId,
            clientName: input.apiKey.name,
            completedAt: null,
            errorCode: null,
            id: input.auditLogId,
            outcome: "started",
            resultCount: null,
            startedAt: input.observedAt,
            toolName: input.operationName,
          });
          return {
            auditLogId: input.auditLogId,
            outcome: "started" as const,
          };
        }),
      completeProtectedOperation: (input) =>
        Effect.sync(() => {
          const existing = apiActivityLogs.find(
            (log) => log.id === input.auditLogId,
          );
          if (existing === undefined) return;
          existing.completedAt = input.completedAt;
          existing.errorCode = input.errorCode;
          existing.outcome = input.outcome;
          existing.resultCount = input.resultCount;
        }),
      loadContactReadMaterial: () => Effect.succeed(null),
      listEncryptedContacts: () => Effect.succeed(null),
      loadGroupSearchMaterial: () => Effect.succeed(null),
      listGroups: () => Effect.succeed(null),
      listChats: () => Effect.succeed(null),
      rejectProtectedOperation: (input) =>
        Effect.sync(() => {
          if (
            input.requiredPermission !== undefined &&
            !input.permissions.includes(input.requiredPermission)
          ) {
            apiActivityLogs.unshift({
              apiKeyId: input.apiKey.publicId,
              clientName: input.apiKey.name,
              completedAt: input.observedAt,
              errorCode: "authorization_denied",
              id: input.auditLogId,
              outcome: "authorization_denied",
              resultCount: null,
              startedAt: input.observedAt,
              toolName: input.operationName,
            });
            return "authorization_denied" as const;
          }
          apiActivityLogs.unshift({
            apiKeyId: input.apiKey.publicId,
            clientName: input.apiKey.name,
            completedAt: input.observedAt,
            errorCode: input.errorCode,
            id: input.auditLogId,
            outcome: "execution_error",
            resultCount: null,
            startedAt: input.observedAt,
            toolName: input.operationName,
          });
          return "rejected" as const;
        }),
      listConnections: (input) =>
        Effect.sync(() => {
          const key = apiKeys.find(
            (candidate) =>
              candidate.grantId === input.apiKeyGrantId &&
              candidate.personalAccountId === input.personalAccountId &&
              candidate.state === "active" &&
              candidate.permissions.includes("connections:read"),
          );
          if (key === undefined) return null;
          return key.connectionIds.flatMap((publicId) => {
            const known = whatsAppConnections.find(
              (connection) => connection.publicId === publicId,
            );
            const fallback =
              publicId === "con_123456789012345678901"
                ? {
                    displayName: "Personal WhatsApp",
                    numberSuffix: "3456",
                    state: "connected" as const,
                    stateChangedAt: "2026-08-14T12:00:00.000Z",
                  }
                : publicId === "con_123456789012345678902"
                  ? {
                      displayName: "Work WhatsApp",
                      numberSuffix: "7890",
                      state: "disconnected" as const,
                      stateChangedAt: "2026-08-14T12:00:00.000Z",
                    }
                  : null;
            const record = known ?? fallback;
            if (record === null) return [];
            return [
              {
                accountKey: null,
                connectionId: "20000000-0000-4000-8000-000000000018",
                connectionKey: null,
                displayName: null,
                displayNameFallback: record.displayName,
                numberLastFour: record.numberSuffix,
                publicId,
                state: record.state,
                stateChangedAt: record.stateChangedAt,
              },
            ];
          });
        }),
    }),
    Layer.succeed(ConnectionSetupPersistence, {
      cancel: ({ clerkUserId, setupId }) =>
        Effect.sync(() => {
          if (clerkUserId !== "user_test_public_boundary") return null;
          const entry = [...connectionSetups.entries()].find(
            ([, value]) => value.setup.setupId === setupId,
          );
          if (entry === undefined) return null;
          const [idempotencyKey, value] = entry;
          const replay =
            value.setup.state === "cancelled" ||
            value.setup.state === "expired";
          const state =
            value.setup.state === "expired" ? "expired" : "cancelled";
          connectionSetups.set(idempotencyKey, {
            ...value,
            setup: { ...value.setup, state },
          });
          return {
            cleanupState: "pending" as const,
            outcome: replay ? ("replay" as const) : ("cancelled" as const),
            setupId,
            state,
          };
        }),
      prepare: ({ clerkUserId, idempotencyKey, numberToken }) =>
        Effect.sync(() => {
          const existing = connectionSetups.get(idempotencyKey);
          if (existing !== undefined) {
            return existing.numberToken === tokenKey(numberToken)
              ? {
                  nameMaterial: {
                    accountKey: testAccountKey,
                    name: {
                      ciphertext: new Uint8Array(32).fill(1),
                      fallback: null,
                      keyVersion: 1,
                      nonce: new Uint8Array(12).fill(2),
                      version: 1 as const,
                    },
                    setupKey: testConnectionKey(existing.setup.setupId),
                  },
                  outcome: "replay" as const,
                  setup: existing.setup,
                }
              : { outcome: "idempotency_conflict" as const };
          }
          const hasRetainedConnection =
            clerkUserId === "user_test_public_boundary" &&
            whatsAppConnections.length > 0;
          if (!onboardingProfiles.has(clerkUserId) && !hasRetainedConnection) {
            return { outcome: "onboarding_profile_required" as const };
          }
          return {
            accountKey: {
              ciphertext: "AQID",
              keyVersion: 1,
              kmsKeyId:
                "arn:aws:kms:us-east-1:111122223333:key/test-content-root",
              personalAccountId: "10000000-0000-4000-8000-000000000018",
              version: 1 as const,
            },
            outcome: "unbound" as const,
            whatsappConnectionLimit: 3,
          };
        }),
      start: (input) =>
        Effect.sync(() => {
          const existing = connectionSetups.get(input.idempotencyKey);
          if (existing !== undefined) {
            return existing.numberToken === tokenKey(input.numberToken)
              ? {
                  nameMaterial: {
                    accountKey: testAccountKey,
                    name: {
                      ciphertext: new Uint8Array(32).fill(1),
                      fallback: null,
                      keyVersion: 1,
                      nonce: new Uint8Array(12).fill(2),
                      version: 1 as const,
                    },
                    setupKey: testConnectionKey(existing.setup.setupId),
                  },
                  outcome: "replay" as const,
                  setup: existing.setup,
                }
              : { outcome: "idempotency_conflict" as const };
          }
          const setup = {
            createdAt: input.createdAt,
            expiresAt: "2026-01-02T03:19:05.000Z",
            setupId: input.setupId,
            state: "provisioning_pending" as const,
          };
          connectionSetups.set(input.idempotencyKey, {
            displayName:
              encryptedDisplayNames.get(input.setupId) ?? "Test WhatsApp",
            numberToken: tokenKey(input.numberToken),
            setup,
          });
          return { outcome: "created" as const, setup };
        }),
    }),
    Layer.succeed(WhatsAppConnectionClock, {
      now: Effect.succeed("2026-01-02T03:06:00.000Z"),
    }),
    Layer.succeed(WhatsAppConnectionIdentifiers, {
      nextConnectionId: Effect.succeed("20000000-0000-4000-8000-000000000018"),
      nextLifecycleClaimId: Effect.succeed(
        "40000000-0000-4000-8000-000000000018",
      ),
      nextPublicId: Effect.succeed("con_000000000000000000018"),
      nextWebhookIdentityKey: Effect.succeed(new Uint8Array(32).fill(18)),
    }),
    Layer.succeed(WhatsAppConnectionPersistence, {
      activate: (input) =>
        Effect.sync(() => {
          const existing = whatsAppConnections[0];
          if (existing !== undefined) return protectedTestConnection(existing);
          const connection = {
            displayName:
              [...connectionSetups.values()].find(
                ({ setup }) => setup.setupId === input.setupId,
              )?.displayName ?? "Test WhatsApp",
            numberSuffix: input.numberSuffix,
            publicId: input.publicId,
            state: "connected" as const,
            stateChangedAt: input.connectedAt,
          };
          whatsAppConnections.push(connection);
          return protectedTestConnection(connection);
        }),
      claimLifecycle: ({
        action,
        claimId,
        clerkUserId,
        publicId,
        requestedAt,
      }) =>
        Effect.sync(() => {
          const connection = whatsAppConnections.find(
            (candidate) =>
              clerkUserId === "user_test_public_boundary" &&
              candidate.publicId === publicId,
          );
          if (connection === undefined) return null;
          const target = action === "disconnect" ? "disconnected" : "connected";
          if (connection.state === target) {
            return {
              connection: protectedTestConnection(connection),
              outcome: "complete" as const,
            };
          }
          if (lifecycleClaimId !== null) {
            return {
              connection: protectedTestConnection(connection),
              outcome: "in_progress" as const,
            };
          }
          lifecycleClaimId = claimId;
          connection.state =
            action === "disconnect" ? "degraded" : "connecting";
          connection.stateChangedAt = requestedAt;
          return {
            action,
            connection: protectedTestConnection(connection),
            outcome: "claimed" as const,
            setupMarker: [...connectionSetups.values()][0]?.setup.setupId ?? "",
          };
        }),
      finishLifecycle: ({
        claimId,
        clerkUserId,
        observedAt,
        publicId,
        state,
      }) =>
        Effect.sync(() => {
          const connection = whatsAppConnections.find(
            (candidate) =>
              clerkUserId === "user_test_public_boundary" &&
              candidate.publicId === publicId,
          );
          if (
            connection === undefined ||
            lifecycleClaimId === null ||
            lifecycleClaimId !== claimId
          ) {
            return null;
          }
          lifecycleClaimId = null;
          if (connection.state !== state) {
            connection.state = state;
            connection.stateChangedAt = observedAt;
          }
          return protectedTestConnection(connection);
        }),
      list: (clerkUserId) =>
        Effect.succeed(
          clerkUserId === "user_test_public_boundary"
            ? whatsAppConnections.map(protectedTestConnection)
            : [],
        ),
      loadForRename: ({ clerkUserId, publicId }) =>
        Effect.sync(() => {
          const connection = whatsAppConnections.find(
            (candidate) =>
              clerkUserId === "user_test_public_boundary" &&
              candidate.publicId === publicId,
          );
          return connection === undefined
            ? null
            : protectedTestConnection(connection);
        }),
      rename: ({ clerkUserId, publicId }) =>
        Effect.sync(() => {
          const connection = whatsAppConnections.find(
            (candidate) =>
              clerkUserId === "user_test_public_boundary" &&
              candidate.publicId === publicId,
          );
          if (connection === undefined) return null;
          connection.displayName =
            encryptedDisplayNames.get("20000000-0000-4000-8000-000000000018") ??
            connection.displayName;
          return protectedTestConnection(connection);
        }),
      prepareDeletion: () => Effect.die("not used"),
      finishDeletion: () => Effect.die("not used"),
      loadSetup: ({ clerkUserId, setupId }) =>
        Effect.sync(() => {
          if (clerkUserId !== "user_test_public_boundary") return null;
          const exists = [...connectionSetups.values()].some(
            ({ setup }) => setup.setupId === setupId,
          );
          if (!exists) return null;
          const connection = whatsAppConnections[0];
          if (connection !== undefined) {
            return {
              connection: protectedTestConnection(connection),
              outcome: "activated" as const,
            };
          }
          return {
            outcome: "provisioned" as const,
            setup: {
              accountKey: {
                ciphertext: "AQID",
                keyVersion: 1,
                kmsKeyId:
                  "arn:aws:kms:us-east-1:111122223333:key/test-content-root",
                personalAccountId: "10000000-0000-4000-8000-000000000018",
                version: 1 as const,
              },
              displayName: {
                ciphertext: {
                  ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                  keyVersion: 1,
                  nonce: "AQIDBAUGBwgJCgsM",
                  version: 1 as const,
                },
                fallback: null,
              },
              numberCiphertext: {
                ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                keyVersion: 1,
                nonce: "AQIDBAUGBwgJCgsM",
                version: 1 as const,
              },
              personalAccountId: "10000000-0000-4000-8000-000000000018",
              setupId,
              setupKey: {
                accountKeyVersion: 1,
                ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                connectionId: setupId,
                keyVersion: 1,
                nonce: "AQIDBAUGBwgJCgsM",
                personalAccountId: "10000000-0000-4000-8000-000000000018",
                version: 1 as const,
              },
              webhookIngressId: "30000000-0000-4000-8000-000000000018",
            },
          };
        }),
    }),
    Layer.succeed(WhatsAppConnectionProvider, {
      connect: () =>
        Effect.sync(() => {
          providerObservations.push("connectSession");
          providerConnectionState = "connecting";
          return {
            ok: true as const,
            value: {
              authority: "test-session-authority",
              connectionState: "connecting" as const,
              session: "wsl_0000000000000000000000000000000000000000000",
            },
          };
        }),
      disconnect: () =>
        Effect.sync(() => {
          providerObservations.push("disconnectSession");
          providerConnectionState = "disconnected";
          return {
            ok: true as const,
            value: {
              authority: "test-session-authority",
              connectionState: "disconnected" as const,
              session: "wsl_0000000000000000000000000000000000000000000",
            },
          };
        }),
      getQrCode: ({ session }) =>
        Effect.sync(() => {
          providerObservations.push("getQrCode");
          qrObservations.set(session, (qrObservations.get(session) ?? 0) + 1);
          return {
            ok: true as const,
            value: {
              expiresAt: null,
              image: new TextEncoder().encode(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>',
              ),
              state: "available" as const,
            },
          };
        }),
      reconcile: () =>
        Effect.sync(() => {
          providerObservations.push("reconcileSession");
          const session = "wsl_0000000000000000000000000000000000000000000";
          if (
            providerConnectionState === "connecting" &&
            (qrObservations.get(session) ?? 0) > 0
          ) {
            providerConnectionState = "connected";
          }
          return {
            ok: true as const,
            value: {
              outcome: "present" as const,
              session: {
                authority: "test-session-authority",
                connectionState: providerConnectionState,
                session,
              },
            },
          };
        }),
    }),
    Layer.succeed(RestoreSafeDeletion, {
      markers: {
        create: () => Effect.die("not used"),
        enumerate: () => Effect.succeed([]),
      },
      capsules: { create: () => Effect.die("not used") },
    }),
    Layer.succeed(EnvelopeEncryptionService, {
      createPersonalAccountKey: ({ accountId, keyVersion }) =>
        Effect.succeed({
          ciphertext: "AQID",
          keyVersion,
          kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/test-content-root",
          personalAccountId: accountId,
          version: 1 as const,
        }),
      createConnectionKey: ({ accountId, connectionId, keyVersion }) =>
        Effect.succeed({
          accountKeyVersion: 1,
          ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
          connectionId,
          keyVersion,
          nonce: "AQIDBAUGBwgJCgsM",
          personalAccountId: accountId,
          version: 1 as const,
        }),
      decrypt: ({ context }) =>
        context.fieldOrObjectPurpose === "whatsapp-number"
          ? Effect.succeed(new TextEncoder().encode("+15550123456"))
          : context.fieldOrObjectPurpose === "display-name"
            ? Effect.succeed(
                new TextEncoder().encode(
                  encryptedDisplayNames.get(context.recordId) ??
                    [...connectionSetups.values()].find(
                      ({ setup }) => setup.setupId === context.recordId,
                    )?.displayName ??
                    whatsAppConnections[0]?.displayName ??
                    "Test WhatsApp",
                ),
              )
            : context.fieldOrObjectPurpose === "provider-session-authority"
              ? Effect.succeed(
                  new TextEncoder().encode(
                    JSON.stringify({
                      sessionCredential: "test-session-credential",
                      webhookVerificationSecret: "test-webhook-secret",
                    }),
                  ),
                )
              : context.fieldOrObjectPurpose === "webhook-identity-key"
                ? Effect.succeed(new Uint8Array(32).fill(18))
                : context.fieldOrObjectPurpose === "message-search-key"
                  ? Effect.succeed(new Uint8Array(32).fill(19))
                  : context.fieldOrObjectPurpose === "original-request"
                    ? Effect.sync(() => {
                        const payload = encryptedWebhookPayloads.get(
                          context.recordId,
                        );
                        if (payload === undefined) {
                          throw new Error("missing encrypted test payload");
                        }
                        return payload.slice();
                      })
                    : Effect.die("not used"),
      decryptMany: () => Effect.die("not used"),
      encrypt: ({ context, plaintext }) =>
        Effect.sync(() => {
          if (
            context.entity === "webhook-event" &&
            context.fieldOrObjectPurpose === "original-request"
          ) {
            encryptedWebhookPayloads.set(context.recordId, plaintext.slice());
          }
          if (context.fieldOrObjectPurpose === "display-name") {
            encryptedDisplayNames.set(
              context.recordId,
              new TextDecoder().decode(plaintext),
            );
          }
          return {
            ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
            keyVersion: 1,
            nonce: "AQIDBAUGBwgJCgsM",
            version: 1 as const,
          };
        }),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: () => Effect.void,
    }),
    Layer.succeed(WebhookIngressPersistence, {
      resolve: (webhookIngressId) =>
        failure === "webhook-database"
          ? Effect.fail(new WebhookIngressPersistenceError())
          : Effect.succeed(
              webhookIngressId === "30000000-0000-4000-8000-000000000018"
                ? {
                    accountKey: {
                      ciphertext: "AQID",
                      keyVersion: 1,
                      kmsKeyId:
                        "arn:aws:kms:us-east-1:111122223333:key/test-content-root",
                      personalAccountId: "10000000-0000-4000-8000-000000000018",
                      version: 1 as const,
                    },
                    connectionKey: {
                      accountKeyVersion: 1,
                      ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                      connectionId: "20000000-0000-4000-8000-000000000018",
                      keyVersion: 1,
                      nonce: "AQIDBAUGBwgJCgsM",
                      personalAccountId: "10000000-0000-4000-8000-000000000018",
                      version: 1 as const,
                    },
                    personalAccountId: "10000000-0000-4000-8000-000000000018",
                    providerAuthority: {
                      ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                      keyVersion: 1,
                      nonce: "AQIDBAUGBwgJCgsM",
                      version: 1 as const,
                    },
                    whatsappConnectionId:
                      "20000000-0000-4000-8000-000000000018",
                  }
                : null,
            ),
    }),
    Layer.succeed(WebhookIngressClock, {
      now: Effect.succeed("2026-01-02T03:07:00.000Z"),
    }),
    Layer.succeed(WebhookIngressIdentifiers, {
      nextObjectId: Effect.sync(() => {
        nextWebhookObjectId += 1;
        return `40000000-0000-4000-8000-${String(nextWebhookObjectId).padStart(
          12,
          "0",
        )}`;
      }),
    }),
    Layer.succeed(WebhookIngressObjectStore, {
      put: (object) =>
        failure === "webhook-r2" || environment === undefined
          ? Effect.fail(new WebhookIngressObjectStoreError())
          : Effect.tryPromise({
              try: () =>
                environment.WEBHOOK_INGRESS.put(object.objectKey, object.body, {
                  customMetadata: { ...object.customMetadata },
                }).then(() => undefined),
              catch: () => new WebhookIngressObjectStoreError(),
            }),
    }),
    Layer.succeed(WebhookIngressQueue, {
      publish: (message) =>
        failure === "webhook-queue" || environment === undefined
          ? Effect.fail(new WebhookIngressQueueError())
          : Effect.tryPromise({
              try: async () => {
                await environment.INGESTION_QUEUE.send(message);
                publishedWebhookMessages.push(message);
              },
              catch: () => new WebhookIngressQueueError(),
            }),
    }),
    Layer.succeed(WebhookEventClock, {
      now: Effect.succeed("2026-01-02T03:07:01.000Z"),
    }),
    Layer.succeed(WebhookEventIdentifiers, {
      nextContactId: Effect.succeed("ctc_123456789012345678901"),
    }),
    Layer.succeed(WebhookEventRetrySchedule, {
      delaySeconds: () => Effect.succeed(10_123),
    }),
    Layer.succeed(WebhookEventObjectStore, {
      load: (objectId) =>
        environment === undefined
          ? Effect.fail(new WebhookEventObjectStoreError())
          : Effect.tryPromise({
              try: async () => {
                const object = await environment.WEBHOOK_INGRESS.get(
                  `webhook-events/${objectId}`,
                );
                if (object === null) return null;
                return {
                  body: new Uint8Array(await object.arrayBuffer()),
                  customMetadata: { ...(object.customMetadata ?? {}) },
                };
              },
              catch: () => new WebhookEventObjectStoreError(),
            }),
    }),
    Layer.succeed(WebhookRecoveryObjectStore, {
      list: (cursor) =>
        environment === undefined
          ? Effect.fail(new WebhookRecoveryObjectStoreError())
          : Effect.tryPromise({
              try: async () => {
                const listed = await environment.WEBHOOK_INGRESS.list({
                  ...(cursor === null ? {} : { cursor }),
                  include: ["customMetadata"],
                  limit: 100,
                  prefix: "webhook-events/",
                });
                return {
                  cursor: listed.truncated ? (listed.cursor ?? null) : null,
                  objects: listed.objects.map((object) => ({
                    customMetadata: { ...(object.customMetadata ?? {}) },
                    objectKey: object.key,
                    uploadedAt: object.uploaded.toISOString(),
                  })),
                };
              },
              catch: () => new WebhookRecoveryObjectStoreError(),
            }),
    }),
    Layer.succeed(WebhookRecoveryCheckpoint, {
      load:
        environment === undefined
          ? Effect.fail(new WebhookRecoveryCheckpointError())
          : Effect.tryPromise({
              try: () =>
                environment.OAUTH_KV.get("maintenance:webhook-recovery-cursor"),
              catch: () => new WebhookRecoveryCheckpointError(),
            }),
      save: (cursor) =>
        environment === undefined
          ? Effect.fail(new WebhookRecoveryCheckpointError())
          : Effect.tryPromise({
              try: () =>
                cursor === null
                  ? environment.OAUTH_KV.delete(
                      "maintenance:webhook-recovery-cursor",
                    )
                  : environment.OAUTH_KV.put(
                      "maintenance:webhook-recovery-cursor",
                      cursor,
                    ),
              catch: () => new WebhookRecoveryCheckpointError(),
            }),
    }),
    Layer.succeed(WebhookRecoveryPersistence, {
      filterUnclaimed: (messages) =>
        Effect.succeed(
          messages.filter(
            (message) => !claimedWebhookEvents.has(message.object_id),
          ),
        ),
    }),
    Layer.succeed(WebhookEventPersistence, {
      complete: () => Effect.void,
      deadLetter: (input) =>
        Effect.sync(() => {
          deadLetteredWebhookEvents.add(input.eventId);
          latestDeadLetteredWebhookEventId = input.eventId;
          return {
            incidentReference: webhookIncidentReference,
            outcome: "gap_recorded" as const,
          };
        }),
      prepare: (input) =>
        Effect.sync(() => {
          claimedWebhookEvents.add(input.eventId);
          return input.personalAccountId ===
            "10000000-0000-4000-8000-000000000018" &&
            input.whatsappConnectionId ===
              "20000000-0000-4000-8000-000000000018"
            ? {
                accountKey: {
                  ciphertext: "AQID",
                  keyVersion: 1,
                  kmsKeyId:
                    "arn:aws:kms:us-east-1:111122223333:key/test-content-root",
                  personalAccountId: input.personalAccountId,
                  version: 1 as const,
                },
                connectionKey: {
                  accountKeyVersion: 1,
                  ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                  connectionId: input.whatsappConnectionId,
                  keyVersion: 1,
                  nonce: "AQIDBAUGBwgJCgsM",
                  personalAccountId: input.personalAccountId,
                  version: 1 as const,
                },
                identityKey: {
                  ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                  keyVersion: 1,
                  nonce: "AQIDBAUGBwgJCgsM",
                  version: 1 as const,
                },
                messageSearchKey: {
                  ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
                  keyVersion: 1,
                  nonce: "AQIDBAUGBwgJCgsM",
                  version: 1 as const,
                },
              }
            : null;
        }),
      projectConnectionState: (input, compareVersions) =>
        Effect.tryPromise({
          try: async () => {
            if (claimedWebhookItems.has(input.itemIdentity)) {
              return "duplicate" as const;
            }
            claimedWebhookItems.add(input.itemIdentity);
            let apply = projectedConnectionStateVersion === null;
            if (
              input.evidence.version !== null &&
              projectedConnectionStateVersion !== null
            ) {
              const comparison = await compareVersions(
                input.evidence.version,
                projectedConnectionStateVersion,
              );
              apply =
                comparison === "after" ||
                (comparison === "equal" &&
                  input.receivedAt >
                    (projectedConnectionStateReceivedAt ?? ""));
            } else if (input.evidence.version === null) {
              apply = projectedConnectionStateVersion === null;
            }
            if (!apply) return "superseded" as const;
            const connection = whatsAppConnections[0];
            if (connection === undefined) {
              throw new Error("missing test WhatsApp Connection");
            }
            if (connection.state !== input.state) {
              connection.state = input.state;
              connection.stateChangedAt =
                input.evidence.occurredAt ?? input.receivedAt;
            }
            projectedConnectionStateVersion = input.evidence.version;
            projectedConnectionStateReceivedAt = input.receivedAt;
            return "applied" as const;
          },
          catch: () => new WebhookEventPersistenceError(),
        }),
      projectGroup: () => Effect.succeed("applied" as const),
      projectDirectoryContact: () => Effect.succeed("applied" as const),
      quarantine: () => Effect.void,
    }),
    Layer.succeed(WebhookReplayClock, {
      now: Effect.succeed("2026-01-03T00:00:01.000Z"),
    }),
    Layer.succeed(WebhookReplayPersistence, {
      complete: ({ requestId }) =>
        Effect.sync(() => {
          const attempt = webhookReplayAttempts.get(requestId);
          if (attempt === undefined) throw new Error("missing replay attempt");
          attempt.status = "dispatched";
        }),
      finalizeExpiredSource: ({ eventId }) =>
        Effect.sync(() => {
          claimedWebhookEvents.delete(eventId);
          deadLetteredWebhookEvents.delete(eventId);
          return true;
        }),
      listExpiredSources: ({ observedAt }) =>
        Effect.succeed(
          publishedWebhookMessages
            .filter(
              (message) =>
                deadLetteredWebhookEvents.has(message.object_id) &&
                Date.parse(message.received_at) + 7 * 24 * 60 * 60 * 1_000 <=
                  Date.parse(observedAt),
            )
            .map((message) => message.object_id),
        ),
      prepare: ({ request: input }) =>
        Effect.sync(() => {
          const existing = webhookReplayAttempts.get(input.request_id);
          if (existing !== undefined) {
            return {
              message: existing.message,
              outcome:
                existing.status === "dispatched"
                  ? ("already_dispatched" as const)
                  : ("pending" as const),
            };
          }
          const message = publishedWebhookMessages.find(
            (candidate) =>
              input.incident_reference === webhookIncidentReference &&
              candidate.object_id === latestDeadLetteredWebhookEventId,
          );
          if (message === undefined) {
            return { outcome: "source_unavailable" as const };
          }
          webhookReplayAttempts.set(input.request_id, {
            message,
            status: "pending",
          });
          return { message, outcome: "pending" as const };
        }),
    }),
    Layer.succeed(WebhookReplayQueue, {
      publish: (message) =>
        Effect.sync(() => {
          publishedWebhookMessages.push(message);
        }),
    }),
    Layer.succeed(WebhookSourceObjectStore, {
      delete: (eventId) =>
        environment === undefined
          ? Effect.void
          : Effect.promise(async () => {
              await environment.WEBHOOK_INGRESS.delete(
                `webhook-events/${eventId}`,
              );
              encryptedWebhookPayloads.delete(eventId);
            }),
    }),
  );
};

const selectedFailure = (request: Request): FailureTarget | undefined => {
  const value = request.headers.get("x-test-failure");
  return value === "identity" ||
    value === "provider" ||
    value === "webhook-database" ||
    value === "webhook-queue" ||
    value === "webhook-r2"
    ? value
    : undefined;
};

const worker = createPublicBoundaryWorker({
  browserOrigin,
  fallback: (request, environment) =>
    isRecipientExclusionRequest(request)
      ? createRecipientExclusionHandler(
          makeTestLayer(selectedFailure(request), environment),
          browserOrigin,
        )(request)
      : isMessageRetentionRequest(request)
        ? createMessageRetentionHandler(
            makeTestLayer(selectedFailure(request), environment),
            browserOrigin,
            [7, 30, 90],
          )(request)
        : new URL(request.url).pathname === "/test/webhook-queue"
          ? Promise.resolve(
              new Response(JSON.stringify(publishedWebhookMessages), {
                headers: {
                  "cache-control": "no-store",
                  "content-type": "application/json; charset=utf-8",
                },
              }),
            )
          : new URL(request.url).pathname === "/test/webhook-dead-letters"
            ? Promise.resolve(
                new Response(JSON.stringify([...deadLetteredWebhookEvents]), {
                  headers: {
                    "cache-control": "no-store",
                    "content-type": "application/json; charset=utf-8",
                  },
                }),
              )
            : new URL(request.url).pathname === "/test/webhook-replay-attempts"
              ? Promise.resolve(
                  new Response(
                    JSON.stringify(
                      [...webhookReplayAttempts.entries()].map(
                        ([requestId, attempt]) => ({
                          requestId,
                          status: attempt.status,
                        }),
                      ),
                    ),
                    {
                      headers: {
                        "cache-control": "no-store",
                        "content-type": "application/json; charset=utf-8",
                      },
                    },
                  ),
                )
              : new URL(request.url).pathname === "/test/provider-observations"
                ? Promise.resolve(
                    new Response(JSON.stringify(providerObservations), {
                      headers: {
                        "cache-control": "no-store",
                        "content-type": "application/json; charset=utf-8",
                      },
                    }),
                  )
                : createProductionHandler({
                    ...environment,
                    WEBHOOK_HYPERDRIVE: {
                      connectionString:
                        "postgresql://webhook-runtime@hyperdrive.test/database",
                    },
                  } as Env)(request),
  layerFor: (request, environment) =>
    makeTestLayer(selectedFailure(request), environment),
  provisioningLayer: makeTestLayer(undefined),
  webhookEventLayer: (environment) => makeTestLayer(undefined, environment),
  webhookRecoveryLayer: (environment) => makeTestLayer(undefined, environment),
  webhookReplayLayer: (environment) => makeTestLayer(undefined, environment),
});

export default worker;
