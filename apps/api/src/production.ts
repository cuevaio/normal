import { KMSClient } from "@aws-sdk/client-kms";
import { createClerkClient } from "@clerk/backend";
import { verifyWebhook } from "@clerk/backend/webhooks";
import { importCursorSigningKey } from "@whatsapp-mcp/contracts/cursor";
import {
  makeConnectionId,
  makeConnectionSetupId,
  makeContactId,
  makeConversationId,
  makeMessageId,
  makeSendId,
} from "@whatsapp-mcp/contracts/handles";
import type { ProviderControlService } from "@whatsapp-mcp/contracts/provider-control";
import { makePgApiKeyRepository } from "@whatsapp-mcp/db/api-key";
import {
  type ConnectionHealthRepository,
  makePgConnectionHealthRepository,
} from "@whatsapp-mcp/db/connection-health";
import { makePgConnectionSetupRepository } from "@whatsapp-mcp/db/connection-setup";
import { checkDatabaseReadiness } from "@whatsapp-mcp/db/connectivity";
import {
  type DirectoryRepository,
  makePgDirectoryRepository,
} from "@whatsapp-mcp/db/directory";
import {
  type GroupRepository,
  makePgGroupRepository,
} from "@whatsapp-mcp/db/group";
import { makePgMcpAuthorizationRepository } from "@whatsapp-mcp/db/mcp-authorization";
import { makePgMcpToolRepository } from "@whatsapp-mcp/db/mcp-tool";
import { makePgMessageRetentionRepository } from "@whatsapp-mcp/db/message-retention";
import { makePgMessageSearchRepository } from "@whatsapp-mcp/db/message-search";
import { makePgOnboardingProfileRepository } from "@whatsapp-mcp/db/onboarding-profile";
import {
  makePgPersonalAccountRepository,
  type PersonalAccountRepository,
} from "@whatsapp-mcp/db/personal-account";
import { makePgRecipientExclusionRepository } from "@whatsapp-mcp/db/recipient-exclusion";
import { withPgRequestConnectionScope } from "@whatsapp-mcp/db/request-connection";
import {
  type AtomicSendRepository,
  makePgAtomicSendRepositoryFromConnectionString,
} from "@whatsapp-mcp/db/send";
import {
  makePgStoredMediaRepository,
  type PendingStoredMediaCandidate,
} from "@whatsapp-mcp/db/stored-media";
import { makePgToolCallLogRepository } from "@whatsapp-mcp/db/tool-call-log";
import { makePgWhatsAppConnectionRepository } from "@whatsapp-mcp/db/whatsapp-connection";
import type { SessionAuthority } from "@whatsapp-mcp/wasender/control";
import { makeWasenderMediaRetrievalLayer } from "@whatsapp-mcp/wasender/media";
import {
  type DirectorySessionAuthority,
  MediaRetrieval,
  type MediaSource,
  makeWasenderSessionDirectory,
  type ProviderNeutralFailure,
  type WasenderIdentityProtectionKey,
} from "@whatsapp-mcp/wasender/session";
import { Config, ConfigProvider, Data, Effect, Layer, Redacted } from "effect";
import {
  ApiKeyClock,
  ApiKeyHmac,
  ApiKeyIdentifiers,
  ApiKeyPersistence,
  ApiKeyPersistenceError,
  createApiKeyManagementHandler,
  isApiKeyManagementRequest,
  makeApiKeyHmac,
  productionApiKeyIdentifiers,
} from "./api-key";
import { makeClerkHumanIdentity } from "./auth/clerk";
import { HumanIdentity } from "./auth/human-identity";
import { decodeBase64, encodeBase64, encodeBase64Url } from "./base64-url";
import { createCanaryHandler } from "./canary";
import {
  ConnectionHealthClock,
  ConnectionHealthPersistence,
  ConnectionHealthPersistenceError,
  reconcileConnectionHealth,
} from "./connection-health";
import {
  ConnectionSetupClock,
  ConnectionSetupIdentifiers,
  ConnectionSetupNumberTokens,
  createConnectionSetupHandler,
  isConnectionSetupRequest,
  makeConnectionSetupNumberTokens,
} from "./connection-setup";
import {
  ConnectionSetupCleanupClock,
  ConnectionSetupCleanupIdentifiers,
  connectionSetupCleanupMessage,
  handleConnectionSetupCleanupBatch,
  isConnectionSetupCleanupMessage,
} from "./connection-setup-cleanup";
import { makeConnectionSetupPersistenceLayers } from "./connection-setup-production";
import {
  ConnectionSetupProvisioningClock,
  ConnectionSetupProvisioningIdentifiers,
  ConnectionSetupProvisioningQueue,
  ConnectionSetupProvisioningQueueError,
  ConnectionSetupProvisioningWebhook,
  connectionSetupProvisioningMessage,
  handleConnectionSetupProvisioningBatch,
} from "./connection-setup-provisioning";
import {
  ContactReconciliationClock,
  ContactReconciliationIdentifiers,
  ContactReconciliationPersistence,
  ContactReconciliationPersistenceError,
  reconcileContacts,
} from "./contact-reconciliation";
import {
  type DeletionCapsuleWriteBucket,
  makeDeletionCapsuleWriter,
} from "./deletion/capsule";
import {
  makeConnectionDeletionActiveDataPurger,
  makeConnectionDeletionCleanupPersistence,
} from "./deletion/connection-cleanup";
import {
  type DeletionMarkerBucket,
  makeDeletionMarkerStore,
} from "./deletion/marker";
import {
  createDeploymentSmokeHandler,
  isDeploymentSmokeRequest,
} from "./deployment-smoke";
import {
  handleDeploymentSmokeMessages,
  makeProductionDeploymentSmoke,
} from "./deployment-smoke-production";
import {
  makeAwsDeletionCapsuleKmsWriter,
  makeAwsKmsKeyService,
} from "./encryption/aws-kms";
import {
  EnvelopeEncryptionService,
  makeEnvelopeEncryption,
} from "./encryption/envelope";
import {
  makeStoredMediaContainer,
  StoredMediaContainerService,
} from "./encryption/stored-media-container";
import {
  GroupDirectoryIdentifiers,
  GroupDirectoryPersistence,
  GroupDirectoryPersistenceError,
  GroupDirectoryProvider,
  makeGroupDirectoryId,
  reconcileGroupDirectory,
} from "./group-directory";
import {
  createMcpRequestHandler,
  McpCursorCodec,
  McpCursorSigning,
  McpToolClock,
  McpToolIdentifiers,
  McpToolPersistence,
  McpToolPersistenceError,
  makeMcpCursorCodec,
  SendTextMessage,
} from "./mcp";
import {
  createMcpAuthorizationConsentHandler,
  createMcpAuthorizationManagementHandler,
  isMcpAuthorizationConsentRequest,
  isMcpAuthorizationManagementRequest,
  McpAuthorizationClock,
  McpAuthorizationIdentifiers,
  McpAuthorizationPersistence,
  McpAuthorizationPersistenceError,
} from "./mcp-authorization";
import {
  createMessageRetentionHandler,
  isMessageRetentionRequest,
  MessageRetentionClock,
  MessageRetentionPersistence,
  MessageRetentionPersistenceError,
} from "./message-retention";
import {
  importMessageSearchIndexKey,
  messageSearchIndexesForText,
} from "./message-search-privacy";
import {
  accessAuthorizationFrom,
  createOAuthHandler,
  loadOAuthConfiguration,
} from "./oauth";
import {
  createOnboardingProfileHandler,
  isOnboardingProfileRequest,
  OnboardingProfileClock,
  OnboardingProfilePersistence,
  OnboardingProfilePersistenceError,
} from "./onboarding-profile";
import {
  createPersonalAccountHandler,
  isPersonalAccountRequest,
  PersonalAccountIdentifiers,
  PersonalAccountPersistence,
  PersonalAccountPersistenceError,
} from "./personal-account";
import {
  ClerkIdentityAdministration,
  ClerkWebhookVerification,
  createPersonalAccountDeletionHandler,
  isPersonalAccountDeletionRequest,
  PersonalAccountDeletionPersistence,
  PersonalAccountDeletionPersistenceError,
} from "./personal-account-deletion";
import { makeProviderControlLayers } from "./provider-control-production";
import {
  deriveRecipientJournalPrefix,
  makeRecipientJournalStore,
  type RecipientJournalBucket,
  readTransitions,
} from "./recipient/journal";
import {
  openRecipientRecords,
  openRecipientSearchIndex,
} from "./recipient-directory";
import {
  createRecipientExclusionHandler,
  isRecipientExclusionRequest,
  RecipientExclusionClock,
  RecipientExclusionPersistence,
  RecipientExclusionPersistenceError,
  type RecipientExclusionPersistenceService,
  RecipientTransitionJournal,
  type RecipientTransitionJournalService,
} from "./recipient-exclusion";
import {
  createRestHandler,
  isRestRequest,
  RestClock,
  RestIdentifiers,
  RestPersistence,
  RestPersistenceError,
} from "./rest";
import { serializeSafeTelemetry } from "./safe-telemetry";
import {
  importSendFingerprintKey,
  makeAtomicSendTextMessageService,
} from "./send-text-message";
import {
  ApplicationConfig,
  DatabaseReadiness,
  RestoreSafeDeletion,
  SafeTelemetry,
  type SafeTelemetryEvent,
} from "./services";
import { processStoredMedia } from "./stored-media-ingestion";
import {
  createToolCallLogHandler,
  isToolCallLogRequest,
  ToolCallLogClock,
  ToolCallLogPersistence,
  ToolCallLogPersistenceError,
} from "./tool-call-log";
import {
  handleWebhookDeadLetterBatch,
  handleWebhookEventBatch,
  isWebhookEventQueueMessage,
} from "./webhook-event";
import {
  createWebhookIngressHandler,
  isWebhookIngressRequest,
} from "./webhook-ingress";
import {
  makeWebhookEventProductionLayer,
  makeWebhookIngressProductionLayer,
  makeWebhookRecoveryProductionLayer,
  makeWebhookReplayProductionLayer,
} from "./webhook-production";
import { handleWebhookIngressSweep } from "./webhook-recovery";
import {
  handleWebhookReplayBatch,
  handleWebhookSourceRetention,
} from "./webhook-replay";
import {
  createWhatsAppConnectionHandler,
  deleteWhatsAppConnection,
  isWhatsAppConnectionRequest,
  WhatsAppConnectionClock,
  WhatsAppConnectionIdentifiers,
} from "./whatsapp-connection";
import { makeWhatsAppConnectionPersistenceLayer } from "./whatsapp-connection-production";

export interface ApiEnvironment {
  readonly AWS_ACCESS_KEY_ID?: string | undefined;
  readonly AWS_KMS_REGION?: string | undefined;
  readonly AWS_SECRET_ACCESS_KEY?: string | undefined;
  readonly AWS_SESSION_TOKEN?: string | undefined;
  readonly CLERK_API_AUDIENCE?: string | undefined;
  readonly CLERK_AUTHORIZED_PARTY?: string | undefined;
  readonly CLERK_ISSUER?: string | undefined;
  readonly CLERK_JWT_KEY?: string | undefined;
  readonly CLERK_SECRET_KEY?: string | undefined;
  readonly CLERK_WEBHOOK_SIGNING_SECRET?: string | undefined;
  readonly DELETION_CAPSULES?: unknown;
  readonly DELETION_MARKER_HMAC_SECRET?: string | undefined;
  readonly DELETION_MARKERS?: unknown;
  readonly RECIPIENT_TRANSITION_HMAC_SECRET?: string | undefined;
  readonly RECIPIENT_TRANSITIONS?: unknown;
  readonly DEPLOYMENT_ENVIRONMENT?: string | undefined;
  readonly HYPERDRIVE?:
    | {
        readonly connectionString: string;
      }
    | undefined;
  readonly CONNECTION_SETUP_PROVISIONING_QUEUE?: unknown;
  readonly KMS_CONTENT_ROOT_KEY_ARN?: string | undefined;
  readonly KMS_DELETION_COORDINATOR_KEY_ARN?: string | undefined;
  readonly MCP_REQUESTS_PER_HOUR?: string | undefined;
  readonly MCP_REQUESTS_PER_MINUTE?: string | undefined;
  readonly MESSAGE_RETENTION_DAY_OPTIONS?: string | undefined;
  readonly NEON_BRANCH_ID?: string | undefined;
  readonly READ_MESSAGE_RECORDS_PER_DAY?: string | undefined;
  readonly API_KEY_HMAC_SECRET?: string | undefined;
  readonly MCP_CURSOR_HMAC_SECRET?: string | undefined;
  readonly SEND_FINGERPRINT_HMAC_SECRET?: string | undefined;
  readonly SENDS_PER_DAY?: string | undefined;
  readonly SENDS_PER_MINUTE?: string | undefined;
  readonly SMOKE_CHECK_SECRET?: string | undefined;
  readonly INGESTION_QUEUE?: unknown;
  readonly OAUTH_ISSUER?: string | undefined;
  readonly OAUTH_KV?: unknown;
  readonly OAUTH_PROTOCOL_ENCRYPTION_KEY?: string | undefined;
  readonly OAUTH_RESOURCE?: string | undefined;
  readonly DECRYPTED_MEDIA_BYTES_PER_DAY?: string | undefined;
  readonly PROVIDER_CONTROL?: unknown;
  readonly STORED_MEDIA?: unknown;
  readonly WEBHOOK_INGRESS?: unknown;
  readonly WEBHOOK_HYPERDRIVE?:
    | {
        readonly connectionString: string;
      }
    | undefined;
  readonly WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET?: string | undefined;
}

const mcpRequestQuotaConfig = Config.all({
  dailyMediaByteLimit: Config.integer("DECRYPTED_MEDIA_BYTES_PER_DAY").pipe(
    Config.validate({
      message: "DECRYPTED_MEDIA_BYTES_PER_DAY must be a positive safe integer",
      validation: (value) => Number.isSafeInteger(value) && value > 0,
    }),
  ),
  dailyRecordLimit: Config.integer("READ_MESSAGE_RECORDS_PER_DAY").pipe(
    Config.validate({
      message: "READ_MESSAGE_RECORDS_PER_DAY must be a positive safe integer",
      validation: (value) => Number.isSafeInteger(value) && value > 0,
    }),
  ),
  hourLimit: Config.integer("MCP_REQUESTS_PER_HOUR").pipe(
    Config.validate({
      message: "MCP_REQUESTS_PER_HOUR must be a positive safe integer",
      validation: (value) => Number.isSafeInteger(value) && value > 0,
    }),
  ),
  minuteLimit: Config.integer("MCP_REQUESTS_PER_MINUTE").pipe(
    Config.validate({
      message: "MCP_REQUESTS_PER_MINUTE must be a positive safe integer",
      validation: (value) => Number.isSafeInteger(value) && value > 0,
    }),
  ),
}).pipe(
  Config.validate({
    message: "MCP_REQUESTS_PER_HOUR must be at least MCP_REQUESTS_PER_MINUTE",
    validation: ({ hourLimit, minuteLimit }) => hourLimit >= minuteLimit,
  }),
);

const apiKeyHmacSecret = Config.redacted("API_KEY_HMAC_SECRET").pipe(
  Config.validate({
    message: "API_KEY_HMAC_SECRET must be a 32-byte hex secret",
    validation: (value) => /^[a-f0-9]{64}$/iu.test(Redacted.value(value)),
  }),
);

const mcpCursorHmacSecret = Config.redacted("MCP_CURSOR_HMAC_SECRET").pipe(
  Config.validate({
    message: "MCP_CURSOR_HMAC_SECRET must be a 32-byte hex secret",
    validation: (value) => /^[a-f0-9]{64}$/iu.test(Redacted.value(value)),
  }),
);

const sendFingerprintHmacSecret = Config.redacted(
  "SEND_FINGERPRINT_HMAC_SECRET",
).pipe(
  Config.validate({
    message: "SEND_FINGERPRINT_HMAC_SECRET must be a 32-byte hex secret",
    validation: (value) => /^[a-f0-9]{64}$/iu.test(Redacted.value(value)),
  }),
);
const smokeCheckSecret = Config.redacted("SMOKE_CHECK_SECRET").pipe(
  Config.validate({
    message: "SMOKE_CHECK_SECRET must be a 32-byte hex secret",
    validation: (value) => /^[a-f0-9]{64}$/iu.test(Redacted.value(value)),
  }),
);
const sendQuotaConfig = Config.all({
  dailyLimit: Config.integer("SENDS_PER_DAY"),
  minuteLimit: Config.integer("SENDS_PER_MINUTE"),
}).pipe(
  Config.validate({
    message: "send quotas must be positive safe integers",
    validation: ({ dailyLimit, minuteLimit }) =>
      Number.isSafeInteger(dailyLimit) &&
      dailyLimit > 0 &&
      Number.isSafeInteger(minuteLimit) &&
      minuteLimit > 0,
  }),
);

const productionConfig = Config.all({
  apiKeyHmacSecret,
  environment: Config.literal(
    "development",
    "preview",
    "production",
  )("DEPLOYMENT_ENVIRONMENT"),
  mcpCursorHmacSecret,
  mcpRequestQuota: mcpRequestQuotaConfig,
  sendFingerprintHmacSecret,
  sendQuota: sendQuotaConfig,
  smokeCheckSecret,
});

const isExactHttpsOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === value
    );
  } catch {
    return false;
  }
};

const httpsOriginConfig = (name: string) =>
  Config.string(name).pipe(
    Config.validate({
      message: `${name} must be an exact HTTPS origin`,
      validation: isExactHttpsOrigin,
    }),
  );

const CLERK_RSA_SPKI_PREFIX = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA";
const CLERK_RSA_SPKI_SUFFIX = "IDAQAB";

class InvalidClerkJwtKey extends Data.TaggedError("InvalidClerkJwtKey") {}

const validateClerkJwtKey = (
  jwtKey: string,
): Effect.Effect<string, InvalidClerkJwtKey> =>
  Effect.tryPromise({
    try: async () => {
      const encoded = jwtKey
        .replace("-----BEGIN PUBLIC KEY-----", "")
        .replace("-----END PUBLIC KEY-----", "")
        .replace(/\s/g, "");
      if (
        !encoded.startsWith(CLERK_RSA_SPKI_PREFIX) ||
        !encoded.endsWith(CLERK_RSA_SPKI_SUFFIX)
      ) {
        throw new Error("invalid Clerk public key");
      }
      const decoded = decodeBase64(encoded);
      const key = await crypto.subtle.importKey(
        "spki",
        decoded,
        {
          hash: "SHA-256",
          name: "RSASSA-PKCS1-v1_5",
        },
        false,
        ["verify"],
      );
      if (
        key.algorithm.name !== "RSASSA-PKCS1-v1_5" ||
        !("modulusLength" in key.algorithm) ||
        key.algorithm.modulusLength !== 2_048
      ) {
        throw new Error("unsupported Clerk public key");
      }
      return jwtKey;
    },
    catch: () => new InvalidClerkJwtKey(),
  });

const clerkConfig = Config.all({
  audience: httpsOriginConfig("CLERK_API_AUDIENCE"),
  authorizedParty: httpsOriginConfig("CLERK_AUTHORIZED_PARTY"),
  issuer: httpsOriginConfig("CLERK_ISSUER"),
  jwtKey: Config.redacted("CLERK_JWT_KEY").pipe(
    Config.validate({
      message: "CLERK_JWT_KEY must be a PEM public key",
      validation: (value) =>
        Redacted.value(value).length <= 10_000 &&
        /^-----BEGIN PUBLIC KEY-----\n[\s\S]+\n-----END PUBLIC KEY-----$/.test(
          Redacted.value(value),
        ),
    }),
  ),
});

const contentRootKeyArn = Config.string("KMS_CONTENT_ROOT_KEY_ARN").pipe(
  Config.validate({
    message: "KMS_CONTENT_ROOT_KEY_ARN must identify a KMS key in us-east-1",
    validation: (value) =>
      /^arn:aws(?:-[a-z]+)?:kms:us-east-1:[0-9]{12}:key\/[A-Za-z0-9-]+$/.test(
        value,
      ),
  }),
);

const deletionCoordinatorKeyArn = Config.string(
  "KMS_DELETION_COORDINATOR_KEY_ARN",
).pipe(
  Config.validate({
    message:
      "KMS_DELETION_COORDINATOR_KEY_ARN must identify a KMS key in us-east-1",
    validation: (value) =>
      /^arn:aws(?:-[a-z]+)?:kms:us-east-1:[0-9]{12}:key\/[A-Za-z0-9-]+$/.test(
        value,
      ),
  }),
);

const deletionMarkerHmacSecret = Config.redacted(
  "DELETION_MARKER_HMAC_SECRET",
).pipe(
  Config.validate({
    message: "DELETION_MARKER_HMAC_SECRET must be a 32-byte hex secret",
    validation: (value) => /^[a-f0-9]{64}$/iu.test(Redacted.value(value)),
  }),
);

const recipientTransitionHmacSecret = Config.redacted(
  "RECIPIENT_TRANSITION_HMAC_SECRET",
).pipe(
  Config.validate({
    message: "RECIPIENT_TRANSITION_HMAC_SECRET must be a 32-byte hex secret",
    validation: (value) => /^[a-f0-9]{64}$/iu.test(Redacted.value(value)),
  }),
);

const whatsappNumberReservationHmacSecret = Config.redacted(
  "WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET",
).pipe(
  Config.validate({
    message:
      "WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET must be a 32-byte hex secret",
    validation: (value) => /^[a-f0-9]{64}$/iu.test(Redacted.value(value)),
  }),
);

const kmsConfig = Config.all({
  accessKeyId: Config.redacted("AWS_ACCESS_KEY_ID"),
  contentRootKeyArn,
  deletionCoordinatorKeyArn,
  region: Config.literal("us-east-1")("AWS_KMS_REGION"),
  secretAccessKey: Config.redacted("AWS_SECRET_ACCESS_KEY"),
  sessionToken: Config.redacted("AWS_SESSION_TOKEN"),
}).pipe(
  Config.validate({
    message: "Content and Deletion Capsule KMS keys must be distinct",
    validation: (config) =>
      config.contentRootKeyArn !== config.deletionCoordinatorKeyArn,
  }),
);

class MissingProviderControlBinding extends Data.TaggedError(
  "MissingProviderControlBinding",
) {}

class MissingCloudflareBinding extends Data.TaggedError(
  "MissingCloudflareBinding",
)<{ readonly binding: string }> {}

const hasMethods = (
  value: unknown,
  methods: ReadonlyArray<string>,
): value is Record<
  string,
  (...arguments_: ReadonlyArray<unknown>) => unknown
> =>
  typeof value === "object" &&
  value !== null &&
  methods.every(
    (method) =>
      typeof (value as Record<string, unknown>)[method] === "function",
  );

const validateCloudflareBindings = (
  environment: ApiEnvironment,
): Effect.Effect<void, MissingCloudflareBinding> => {
  const bindings = [
    [
      "CONNECTION_SETUP_PROVISIONING_QUEUE",
      environment.CONNECTION_SETUP_PROVISIONING_QUEUE,
      ["send", "sendBatch"],
    ],
    ["DELETION_CAPSULES", environment.DELETION_CAPSULES, ["get", "put"]],
    ["DELETION_MARKERS", environment.DELETION_MARKERS, ["get", "list", "put"]],
    ["INGESTION_QUEUE", environment.INGESTION_QUEUE, ["send"]],
    [
      "RECIPIENT_TRANSITIONS",
      environment.RECIPIENT_TRANSITIONS,
      ["get", "list", "put"],
    ],
    ["OAUTH_KV", environment.OAUTH_KV, ["delete", "get", "put"]],
    [
      "STORED_MEDIA",
      environment.STORED_MEDIA,
      ["createMultipartUpload", "delete", "get", "put"],
    ],
    [
      "WEBHOOK_INGRESS",
      environment.WEBHOOK_INGRESS,
      ["delete", "get", "list", "put"],
    ],
  ] as const;

  for (const [binding, value, methods] of bindings) {
    if (!hasMethods(value, methods)) {
      return Effect.fail(new MissingCloudflareBinding({ binding }));
    }
  }
  if (typeof environment.WEBHOOK_HYPERDRIVE?.connectionString !== "string") {
    return Effect.fail(
      new MissingCloudflareBinding({ binding: "WEBHOOK_HYPERDRIVE" }),
    );
  }

  return Effect.void;
};

const environmentConfigProvider = (environment: ApiEnvironment) =>
  ConfigProvider.fromMap(
    new Map(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  );

const configLayer = (environment: ApiEnvironment) =>
  Layer.effect(
    ApplicationConfig,
    productionConfig.pipe(
      Effect.flatMap((config) =>
        Effect.gen(function* () {
          if (
            !hasMethods(environment.PROVIDER_CONTROL, [
              "connectSession",
              "createSession",
              "deleteSession",
              "disconnectSession",
              "fetch",
              "getQrCode",
              "listSessions",
              "reconcileSession",
              "repairSessionConfiguration",
            ])
          ) {
            return yield* Effect.fail(new MissingProviderControlBinding());
          }
          yield* validateCloudflareBindings(environment);
          if (
            !/^sk_(?:test|live)_[A-Za-z0-9]{20,}$/u.test(
              environment.CLERK_SECRET_KEY ?? "",
            )
          ) {
            return yield* Effect.fail(
              new MissingCloudflareBinding({ binding: "CLERK_SECRET_KEY" }),
            );
          }
          if (
            !/^whsec_[A-Za-z0-9+/=_-]{20,}$/u.test(
              environment.CLERK_WEBHOOK_SIGNING_SECRET ?? "",
            )
          ) {
            return yield* Effect.fail(
              new MissingCloudflareBinding({
                binding: "CLERK_WEBHOOK_SIGNING_SECRET",
              }),
            );
          }
          return {
            ...config,
            service: "api" as const,
          };
        }),
      ),
      Effect.withConfigProvider(environmentConfigProvider(environment)),
    ),
  );

const encryptionLayer = (environment: ApiEnvironment) =>
  Layer.effect(
    EnvelopeEncryptionService,
    Config.all({
      application: productionConfig,
      kms: kmsConfig,
    }).pipe(
      Effect.map(({ application, kms }) => {
        const client = new KMSClient({
          credentials: {
            accessKeyId: Redacted.value(kms.accessKeyId),
            secretAccessKey: Redacted.value(kms.secretAccessKey),
            sessionToken: Redacted.value(kms.sessionToken),
          },
          region: kms.region,
        });
        return makeEnvelopeEncryption({
          contentRootKeyId: kms.contentRootKeyArn,
          environment: application.environment,
          kms: makeAwsKmsKeyService(client),
        });
      }),
      Effect.withConfigProvider(environmentConfigProvider(environment)),
    ),
  );

const humanIdentityLayer = (environment: ApiEnvironment) =>
  Layer.effect(
    HumanIdentity,
    clerkConfig.pipe(
      Effect.flatMap((config) =>
        validateClerkJwtKey(Redacted.value(config.jwtKey)).pipe(
          Effect.map((jwtKey) =>
            makeClerkHumanIdentity({
              ...config,
              jwtKey,
            }),
          ),
        ),
      ),
      Effect.withConfigProvider(environmentConfigProvider(environment)),
    ),
  );

const personalAccountPersistenceLayer = (environment: ApiEnvironment) =>
  Layer.succeed(PersonalAccountPersistence, {
    create: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgPersonalAccountRepository(connectionString).create(
            input,
          );
        },
        catch: () => new PersonalAccountPersistenceError(),
      }),
    resolve: (clerkUserId) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgPersonalAccountRepository(connectionString).resolve(
            clerkUserId,
          );
        },
        catch: () => new PersonalAccountPersistenceError(),
      }),
  });

const personalAccountDeletionLayer = (environment: ApiEnvironment) =>
  Layer.mergeAll(
    Layer.succeed(PersonalAccountDeletionPersistence, {
      finish: (input) =>
        Effect.tryPromise({
          try: () => {
            const connectionString = environment.HYPERDRIVE?.connectionString;
            if (typeof connectionString !== "string")
              throw new Error("database unavailable");
            return makePgPersonalAccountRepository(
              connectionString,
            ).finishDeletion(input);
          },
          catch: () => new PersonalAccountDeletionPersistenceError(),
        }),
      prepare: (input) =>
        Effect.tryPromise({
          try: () => {
            const connectionString = environment.HYPERDRIVE?.connectionString;
            if (typeof connectionString !== "string")
              throw new Error("database unavailable");
            return makePgPersonalAccountRepository(
              connectionString,
            ).prepareDeletion(input);
          },
          catch: () => new PersonalAccountDeletionPersistenceError(),
        }),
    }),
    Layer.succeed(ClerkIdentityAdministration, {
      deleteUser: (clerkUserId) =>
        Effect.tryPromise({
          try: async () => {
            await createClerkClient({
              secretKey: environment.CLERK_SECRET_KEY ?? "",
            }).users.deleteUser(clerkUserId);
          },
          catch: (cause) => cause,
        }),
    }),
    Layer.succeed(ClerkWebhookVerification, {
      verify: (request) =>
        Effect.tryPromise({
          try: async () => {
            const event = await verifyWebhook(request, {
              signingSecret: environment.CLERK_WEBHOOK_SIGNING_SECRET ?? "",
            });
            return event.type === "user.deleted" &&
              typeof event.data.id === "string"
              ? { clerkUserId: event.data.id, type: "user.deleted" as const }
              : { clerkUserId: "", type: "ignored" as const };
          },
          catch: (cause) => cause,
        }),
    }),
  );

const personalAccountIdentifiersLayer = Layer.succeed(
  PersonalAccountIdentifiers,
  {
    next: Effect.sync(() => crypto.randomUUID()),
  },
);

const messageRetentionLayer = (environment: ApiEnvironment) =>
  Layer.mergeAll(
    Layer.succeed(MessageRetentionClock, {
      now: Effect.sync(() => new Date().toISOString()),
    }),
    Layer.succeed(MessageRetentionPersistence, {
      get: (input) =>
        Effect.tryPromise({
          try: () => {
            const connectionString = environment.HYPERDRIVE?.connectionString;
            if (typeof connectionString !== "string")
              throw new Error("database unavailable");
            return makePgMessageRetentionRepository(
              connectionString,
            ).getForUser(input);
          },
          catch: () => new MessageRetentionPersistenceError(),
        }),
      update: (input) =>
        Effect.tryPromise({
          try: () => {
            const connectionString = environment.HYPERDRIVE?.connectionString;
            if (typeof connectionString !== "string")
              throw new Error("database unavailable");
            return makePgMessageRetentionRepository(
              connectionString,
            ).updateForUser(input);
          },
          catch: () => new MessageRetentionPersistenceError(),
        }),
    }),
  );

const onboardingProfileLayer = (environment: ApiEnvironment) =>
  Layer.mergeAll(
    Layer.succeed(OnboardingProfileClock, {
      now: Effect.sync(() => new Date().toISOString()),
    }),
    Layer.succeed(OnboardingProfilePersistence, {
      get: (input) =>
        Effect.tryPromise({
          try: () => {
            const connectionString = environment.HYPERDRIVE?.connectionString;
            if (typeof connectionString !== "string")
              throw new Error("database unavailable");
            return makePgOnboardingProfileRepository(
              connectionString,
            ).getForUser(input.clerkUserId);
          },
          catch: () => new OnboardingProfilePersistenceError(),
        }),
      upsert: (input) =>
        Effect.tryPromise({
          try: () => {
            const connectionString = environment.HYPERDRIVE?.connectionString;
            if (typeof connectionString !== "string")
              throw new Error("database unavailable");
            return makePgOnboardingProfileRepository(
              connectionString,
            ).upsertForUser(input);
          },
          catch: () => new OnboardingProfilePersistenceError(),
        }),
    }),
  );

const retentionDayOptions = (
  value: string | undefined,
): ReadonlyArray<number> => {
  if (value === undefined || !/^\d+(,\d+)*$/u.test(value))
    throw new Error("invalid MESSAGE_RETENTION_DAY_OPTIONS");
  const options = value.split(",").map(Number);
  if (
    options.some(
      (day, index) =>
        !Number.isSafeInteger(day) ||
        day < 1 ||
        day > 3650 ||
        (index > 0 && day <= (options[index - 1] ?? 0)),
    ) ||
    !options.includes(30)
  ) {
    throw new Error("invalid MESSAGE_RETENTION_DAY_OPTIONS");
  }
  return options;
};

const connectionSetupProvisioningQueueLayer = (environment: ApiEnvironment) =>
  Layer.succeed(ConnectionSetupProvisioningQueue, {
    enqueue: (setupId) =>
      Effect.tryPromise({
        try: async () => {
          const queue = environment.CONNECTION_SETUP_PROVISIONING_QUEUE;
          if (!hasMethods(queue, ["send"])) {
            throw new Error("Connection Setup provisioning Queue unavailable");
          }
          await (queue as Pick<Queue, "send">).send(
            connectionSetupProvisioningMessage(setupId),
          );
        },
        catch: () => new ConnectionSetupProvisioningQueueError(),
      }),
    enqueueCleanup: (setupId) =>
      Effect.tryPromise({
        try: async () => {
          const queue = environment.CONNECTION_SETUP_PROVISIONING_QUEUE;
          if (!hasMethods(queue, ["send"])) {
            throw new Error("Connection Setup cleanup Queue unavailable");
          }
          await (queue as Pick<Queue, "send">).send(
            connectionSetupCleanupMessage(setupId),
          );
        },
        catch: () => new ConnectionSetupProvisioningQueueError(),
      }),
  });

const connectionSetupIdentifiersLayer = Layer.succeed(
  ConnectionSetupIdentifiers,
  {
    next: Effect.sync(() => makeConnectionSetupId()),
  },
);

const connectionSetupClockLayer = Layer.succeed(ConnectionSetupClock, {
  now: Effect.sync(() => new Date().toISOString()),
});

const whatsAppConnectionRuntimeLayer = Layer.mergeAll(
  Layer.succeed(WhatsAppConnectionClock, {
    now: Effect.sync(() => new Date().toISOString()),
  }),
  Layer.succeed(WhatsAppConnectionIdentifiers, {
    nextConnectionId: Effect.sync(() => crypto.randomUUID()),
    nextLifecycleClaimId: Effect.sync(() => crypto.randomUUID()),
    nextPublicId: Effect.sync(() => makeConnectionId()),
    nextWebhookIdentityKey: Effect.sync(() =>
      crypto.getRandomValues(new Uint8Array(32)),
    ),
  }),
);

const connectionSetupNumberTokensLayer = (environment: ApiEnvironment) =>
  Layer.effect(
    ConnectionSetupNumberTokens,
    whatsappNumberReservationHmacSecret.pipe(
      Effect.map((secret) =>
        makeConnectionSetupNumberTokens(
          Uint8Array.from(
            Redacted.value(secret).match(/.{2}/gu) ?? [],
            (value) => Number.parseInt(value, 16),
          ),
        ),
      ),
      Effect.withConfigProvider(environmentConfigProvider(environment)),
    ),
  );

const mcpAuthorizationPersistenceLayer = (environment: ApiEnvironment) =>
  Layer.succeed(McpAuthorizationPersistence, {
    create: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpAuthorizationRepository(connectionString).create(
            input,
          );
        },
        catch: (cause) => {
          const wrapper =
            typeof cause === "object" && cause !== null
              ? (cause as { readonly cause?: unknown })
              : undefined;
          const candidate = wrapper?.cause ?? cause;
          const failure =
            typeof candidate === "object" && candidate !== null
              ? (candidate as {
                  readonly code?: unknown;
                  readonly constraint?: unknown;
                })
              : undefined;
          return new McpAuthorizationPersistenceError({
            ...(typeof failure?.code === "string" &&
            /^[0-9A-Z]{5}$/u.test(failure.code)
              ? { code: failure.code }
              : {}),
            ...(typeof failure?.constraint === "string" &&
            /^[a-z0-9_]{1,128}$/u.test(failure.constraint)
              ? { constraint: failure.constraint }
              : {}),
          });
        },
      }),
    isActive: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpAuthorizationRepository(connectionString).isActive(
            input,
          );
        },
        catch: () => new McpAuthorizationPersistenceError({}),
      }),
    listConnections: (clerkUserId) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpAuthorizationRepository(
            connectionString,
          ).listConnections(clerkUserId);
        },
        catch: () => new McpAuthorizationPersistenceError({}),
      }),
    list: (clerkUserId, observedAt) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpAuthorizationRepository(connectionString).list(
            clerkUserId,
            observedAt,
          );
        },
        catch: () => new McpAuthorizationPersistenceError({}),
      }),
    registerRefreshCredential: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpAuthorizationRepository(
            connectionString,
          ).registerRefreshCredential(input);
        },
        catch: () => new McpAuthorizationPersistenceError({}),
      }),
    rotateRefreshCredential: (input, issue) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpAuthorizationRepository(
            connectionString,
          ).rotateRefreshCredential(input, issue);
        },
        catch: () => new McpAuthorizationPersistenceError({}),
      }),
    revoke: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpAuthorizationRepository(connectionString).revoke(
            input,
          );
        },
        catch: () => new McpAuthorizationPersistenceError({}),
      }),
  });

const apiKeyPersistenceLayer = (environment: ApiEnvironment) =>
  Layer.succeed(ApiKeyPersistence, {
    authenticate: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgApiKeyRepository(connectionString).authenticate(input);
        },
        catch: () => new ApiKeyPersistenceError({}),
      }),
    create: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgApiKeyRepository(connectionString).create(input);
        },
        catch: () => new ApiKeyPersistenceError({}),
      }),
    list: (clerkUserId, observedAt) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgApiKeyRepository(connectionString).list(
            clerkUserId,
            observedAt,
          );
        },
        catch: () => new ApiKeyPersistenceError({}),
      }),
    revoke: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgApiKeyRepository(connectionString).revoke(input);
        },
        catch: () => new ApiKeyPersistenceError({}),
      }),
  });

const apiKeyRuntimeLayer = (environment: ApiEnvironment) =>
  Layer.mergeAll(
    Layer.succeed(ApiKeyClock, {
      now: Effect.sync(() => new Date()),
    }),
    Layer.succeed(ApiKeyIdentifiers, productionApiKeyIdentifiers),
    Layer.effect(
      ApiKeyHmac,
      apiKeyHmacSecret.pipe(
        Effect.map((secret) => makeApiKeyHmac(Redacted.value(secret))),
        Effect.withConfigProvider(environmentConfigProvider(environment)),
      ),
    ),
  );

const restPersistenceLayer = (environment: ApiEnvironment) =>
  Layer.mergeAll(
    Layer.succeed(RestClock, {
      now: Effect.sync(() => new Date()),
    }),
    Layer.succeed(RestIdentifiers, {
      nextAuditLogId: Effect.sync(() => crypto.randomUUID()),
    }),
    Layer.succeed(RestPersistence, {
      beginProtectedOperation: (input) =>
        Effect.tryPromise({
          try: () => {
            const connectionString = environment.HYPERDRIVE?.connectionString;
            if (typeof connectionString !== "string") {
              throw new Error("database unavailable");
            }
            return makePgMcpToolRepository(
              connectionString,
            ).beginProtectedOperation(input);
          },
          catch: () => new RestPersistenceError(),
        }),
      completeToolCall: (input) =>
        Effect.tryPromise({
          try: () => {
            const connectionString = environment.HYPERDRIVE?.connectionString;
            if (typeof connectionString !== "string") {
              throw new Error("database unavailable");
            }
            return makePgMcpToolRepository(connectionString).completeToolCall(
              input,
            );
          },
          catch: () => new RestPersistenceError(),
        }),
      listConnections: (input) =>
        Effect.tryPromise({
          try: () => {
            const connectionString = environment.HYPERDRIVE?.connectionString;
            if (typeof connectionString !== "string") {
              throw new Error("database unavailable");
            }
            return makePgMcpToolRepository(
              connectionString,
            ).listApiKeyConnections(input);
          },
          catch: () => new RestPersistenceError(),
        }),
    }),
  );

const mcpToolPersistenceLayer = (environment: ApiEnvironment) =>
  Layer.succeed(McpToolPersistence, {
    failStoredMediaRead: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string")
            throw new Error("database unavailable");
          return makePgMcpToolRepository(connectionString).failStoredMediaRead(
            input,
          );
        },
        catch: () => new McpToolPersistenceError(),
      }),
    reserveStoredMediaRead: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string")
            throw new Error("database unavailable");
          return makePgMcpToolRepository(
            connectionString,
          ).reserveStoredMediaRead(input);
        },
        catch: () => new McpToolPersistenceError(),
      }),
    beginToolCall: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpToolRepository(connectionString).beginToolCall(input);
        },
        catch: () => new McpToolPersistenceError(),
      }),
    completeToolCall: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpToolRepository(connectionString).completeToolCall(
            input,
          );
        },
        catch: () => new McpToolPersistenceError(),
      }),
    inspectAuthorization: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpToolRepository(connectionString).inspectAuthorization(
            input,
          );
        },
        catch: () => new McpToolPersistenceError(),
      }),
    listConnections: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpToolRepository(connectionString).listConnections(
            input,
          );
        },
        catch: () => new McpToolPersistenceError(),
      }),
    getSendStatus: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string")
            throw new Error("database unavailable");
          return makePgMcpToolRepository(connectionString).getSendStatus(input);
        },
        catch: () => new McpToolPersistenceError(),
      }),
    listChats: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string")
            throw new Error("database unavailable");
          return makePgMcpToolRepository(connectionString).listChats(input);
        },
        catch: () => new McpToolPersistenceError(),
      }),
    readMessages: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string")
            throw new Error("database unavailable");
          return makePgMcpToolRepository(connectionString).readMessages(input);
        },
        catch: () => new McpToolPersistenceError(),
      }),
    searchMessages: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string")
            throw new Error("database unavailable");
          return makePgMcpToolRepository(connectionString).searchMessages(
            input,
          );
        },
        catch: () => new McpToolPersistenceError(),
      }),
    completeMessageRecordRead: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string")
            throw new Error("database unavailable");
          return makePgMcpToolRepository(
            connectionString,
          ).completeMessageRecordRead(input);
        },
        catch: () => new McpToolPersistenceError(),
      }),
    listGroups: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpToolRepository(connectionString).listGroups(input);
        },
        catch: () => new McpToolPersistenceError(),
      }),
    loadGroupSearchMaterial: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpToolRepository(
            connectionString,
          ).loadGroupSearchMaterial(input);
        },
        catch: () => new McpToolPersistenceError(),
      }),
    loadContactReadMaterial: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpToolRepository(
            connectionString,
          ).loadContactReadMaterial(input);
        },
        catch: () => new McpToolPersistenceError(),
      }),
    listEncryptedContacts: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpToolRepository(
            connectionString,
          ).listEncryptedContacts(input);
        },
        catch: () => new McpToolPersistenceError(),
      }),
    rejectToolCall: (input) =>
      Effect.tryPromise({
        try: () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgMcpToolRepository(connectionString).rejectToolCall(
            input,
          );
        },
        catch: () => new McpToolPersistenceError(),
      }),
  });

const toolCallLogLayer = (environment: ApiEnvironment) =>
  Layer.mergeAll(
    Layer.succeed(ToolCallLogClock, {
      now: Effect.sync(() => new Date()),
    }),
    Layer.succeed(ToolCallLogPersistence, {
      list: (clerkUserId, observedAt, cursor) =>
        Effect.tryPromise({
          try: () => {
            const connectionString = environment.HYPERDRIVE?.connectionString;
            if (typeof connectionString !== "string") {
              throw new Error("database unavailable");
            }
            return makePgToolCallLogRepository(connectionString).listForUser(
              clerkUserId,
              observedAt,
              cursor,
              100,
            );
          },
          catch: () => new ToolCallLogPersistenceError(),
        }),
    }),
  );

const mcpToolRuntimeLayer = (environment: ApiEnvironment) =>
  Layer.mergeAll(
    Layer.succeed(McpToolClock, {
      now: Effect.sync(() => new Date()),
    }),
    Layer.succeed(McpToolIdentifiers, {
      nextAuditLogId: Effect.sync(() => crypto.randomUUID()),
    }),
    Layer.effect(
      McpCursorCodec,
      Effect.gen(function* () {
        const secret = environment.MCP_CURSOR_HMAC_SECRET;
        if (typeof secret !== "string" || !/^[a-f0-9]{64}$/u.test(secret)) {
          return yield* Effect.fail(
            new Error("MCP_CURSOR_HMAC_SECRET must be a 32-byte hex secret"),
          );
        }
        const key = yield* importCursorSigningKey(
          Uint8Array.from(secret.match(/../gu) ?? [], (byte) =>
            Number.parseInt(byte, 16),
          ),
        );
        return makeMcpCursorCodec(key);
      }),
    ),
  );

const atomicSendLayer = (environment: ApiEnvironment) =>
  Layer.effect(
    SendTextMessage,
    Effect.gen(function* () {
      const encryption = yield* EnvelopeEncryptionService;
      const safeTelemetry = yield* SafeTelemetry;
      const connectionString = environment.HYPERDRIVE?.connectionString;
      const fingerprintSecret = environment.SEND_FINGERPRINT_HMAC_SECRET;
      const sendDailyLimit = Number(environment.SENDS_PER_DAY);
      const sendPerMinuteLimit = Number(environment.SENDS_PER_MINUTE);
      const requestHourLimit = Number(environment.MCP_REQUESTS_PER_HOUR);
      const requestMinuteLimit = Number(environment.MCP_REQUESTS_PER_MINUTE);
      if (
        typeof fingerprintSecret !== "string" ||
        !Number.isSafeInteger(sendDailyLimit) ||
        sendDailyLimit < 1 ||
        !Number.isSafeInteger(sendPerMinuteLimit) ||
        sendPerMinuteLimit < 1 ||
        !Number.isSafeInteger(requestHourLimit) ||
        requestHourLimit < 1 ||
        !Number.isSafeInteger(requestMinuteLimit) ||
        requestMinuteLimit < 1
      ) {
        return yield* Effect.fail(
          new Error("atomic send configuration is invalid"),
        );
      }
      const fingerprintKey = yield* Effect.promise(() =>
        importSendFingerprintKey(fingerprintSecret),
      );
      return makeAtomicSendTextMessageService({
        encryption,
        fingerprintKey,
        hourRequestLimit: requestHourLimit,
        minuteRequestLimit: requestMinuteLimit,
        nextAuditLogId: () => crypto.randomUUID(),
        nextStoredMessage: () => ({
          conversationId: crypto.randomUUID(),
          conversationPublicId: makeConversationId(),
          messageId: crypto.randomUUID(),
          messagePublicId: makeMessageId(),
        }),
        nextSend: () => ({ id: crypto.randomUUID(), publicId: makeSendId() }),
        now: () => new Date(),
        repository: makePgAtomicSendRepositoryFromConnectionString(
          connectionString ?? "",
        ),
        sendDailyLimit,
        sendPerMinuteLimit,
        telemetry: (event) => {
          const providerEvent = event as {
            attemptCount: 0 | 1;
            durationMs: number;
            operationClass: "text-send";
            outcome:
              | "ambiguous"
              | "definitive_failure"
              | "identity_evidence"
              | "provider_acknowledgement";
            responseBytes: number | null;
          };
          Effect.runFork(
            safeTelemetry.emit({
              ...providerEvent,
              event: "provider.text_send.completed",
              service: "api",
            }),
          );
        },
      });
    }),
  );

const mcpCursorSigningLayer = (environment: ApiEnvironment) =>
  Layer.effect(
    McpCursorSigning,
    mcpCursorHmacSecret.pipe(
      Effect.withConfigProvider(environmentConfigProvider(environment)),
      Effect.flatMap((secret) =>
        importCursorSigningKey(
          Uint8Array.from(
            Redacted.value(secret).match(/.{2}/gu) ?? [],
            (value) => Number.parseInt(value, 16),
          ),
        ),
      ),
      Effect.map((key) => ({ key })),
    ),
  );

const randomBase64Url = (): string => {
  const value = new Uint8Array(32);
  crypto.getRandomValues(value);
  return encodeBase64Url(value);
};

const connectionSetupProvisioningRuntimeLayer = (environment: ApiEnvironment) =>
  Layer.mergeAll(
    Layer.succeed(ConnectionSetupProvisioningClock, {
      now: Effect.sync(() => new Date().toISOString()),
    }),
    Layer.succeed(ConnectionSetupProvisioningIdentifiers, {
      nextWorkerId: Effect.sync(() => `cspw_${randomBase64Url()}`),
    }),
    Layer.succeed(ConnectionSetupProvisioningWebhook, {
      urlFor: (webhookIngressId) =>
        Effect.sync(() => {
          if (
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              webhookIngressId,
            )
          ) {
            throw new Error("invalid webhook ingress identity");
          }
          return `${environment.OAUTH_ISSUER}/webhooks/wasender/${webhookIngressId}`;
        }),
    }),
  );

const connectionSetupCleanupRuntimeLayer = Layer.mergeAll(
  Layer.succeed(ConnectionSetupCleanupClock, {
    now: Effect.sync(() => new Date().toISOString()),
  }),
  Layer.succeed(ConnectionSetupCleanupIdentifiers, {
    nextWorkerId: Effect.sync(() => `cscw_${randomBase64Url()}`),
  }),
);

const mcpAuthorizationRuntimeLayer = Layer.mergeAll(
  Layer.succeed(McpAuthorizationClock, {
    now: Effect.sync(() => new Date()),
  }),
  Layer.succeed(McpAuthorizationIdentifiers, {
    authorizationId: Effect.sync(() => crypto.randomUUID()),
    oauthSubject: Effect.sync(randomBase64Url),
  }),
);

const deletionLayer = (environment: ApiEnvironment) =>
  Layer.effect(
    RestoreSafeDeletion,
    Config.all({
      application: productionConfig,
      hmacSecret: deletionMarkerHmacSecret,
      kms: kmsConfig,
    }).pipe(
      Effect.map(({ application, hmacSecret, kms }) => {
        const client = new KMSClient({
          credentials: {
            accessKeyId: Redacted.value(kms.accessKeyId),
            secretAccessKey: Redacted.value(kms.secretAccessKey),
            sessionToken: Redacted.value(kms.sessionToken),
          },
          region: kms.region,
        });
        return {
          capsules: makeDeletionCapsuleWriter({
            bucket: environment.DELETION_CAPSULES as DeletionCapsuleWriteBucket,
            environment: application.environment,
            keyId: kms.deletionCoordinatorKeyArn,
            kmsWriter: makeAwsDeletionCapsuleKmsWriter(client),
          }),
          markers: makeDeletionMarkerStore({
            bucket: environment.DELETION_MARKERS as DeletionMarkerBucket,
            environment: application.environment,
            hmacSecret,
          }),
        };
      }),
      Effect.withConfigProvider(environmentConfigProvider(environment)),
    ),
  );

const recipientExclusionLayer = (environment: ApiEnvironment) =>
  Layer.mergeAll(
    Layer.succeed(RecipientExclusionClock, {
      now: Effect.sync(() => new Date().toISOString()),
    }),
    Layer.effect(
      RecipientTransitionJournal,
      Config.all({
        application: productionConfig,
        hmacSecret: recipientTransitionHmacSecret,
      }).pipe(
        Effect.map(({ application, hmacSecret }) => {
          const store = makeRecipientJournalStore({
            bucket: environment.RECIPIENT_TRANSITIONS as RecipientJournalBucket,
            environment: application.environment,
            hmacSecret,
          });
          return {
            append: (input) =>
              store.append(input).pipe(
                Effect.mapError(() => new RecipientExclusionPersistenceError()),
                Effect.asVoid,
              ),
          } satisfies RecipientTransitionJournalService;
        }),
        Effect.withConfigProvider(environmentConfigProvider(environment)),
      ),
    ),
    Layer.effect(
      RecipientExclusionPersistence,
      Effect.gen(function* () {
        const encryption = yield* EnvelopeEncryptionService;
        const repository = () => {
          const connectionString = environment.HYPERDRIVE?.connectionString;
          if (typeof connectionString !== "string") {
            throw new Error("database unavailable");
          }
          return makePgRecipientExclusionRepository(connectionString);
        };
        return {
          finalize: (input) =>
            Effect.tryPromise({
              try: () => repository().finalizeTransition(input),
              catch: () => new RecipientExclusionPersistenceError(),
            }),
          list: (input) =>
            Effect.tryPromise({
              try: async () => {
                const client = repository();
                const material = await client.loadDirectoryMaterial({
                  clerkUserId: input.clerkUserId,
                  connectionPublicId: input.connectionPublicId,
                  kind: input.kind,
                  observedAt: new Date().toISOString(),
                });
                if (material === null) return null;
                return { client, material };
              },
              catch: () => new RecipientExclusionPersistenceError(),
            }).pipe(
              Effect.flatMap((loaded) =>
                loaded === null
                  ? Effect.succeed(null)
                  : openRecipientSearchIndex({
                      encryption,
                      kind: input.kind,
                      material: loaded.material,
                      search: input.search,
                    }).pipe(
                      Effect.flatMap((searchIndex) =>
                        Effect.tryPromise({
                          try: async () => ({
                            material: loaded.material,
                            recipients:
                              await loaded.client.listEncryptedRecipients({
                                clerkUserId: input.clerkUserId,
                                connectionPublicId: input.connectionPublicId,
                                cursorPublicId: input.cursorPublicId,
                                kind: input.kind,
                                limit: input.limit,
                                searchIndex,
                              }),
                          }),
                          catch: () => new RecipientExclusionPersistenceError(),
                        }),
                      ),
                    ),
              ),
            ),
          open: (input) => openRecipientRecords({ ...input, encryption }),
          prepare: (input) =>
            Effect.tryPromise({
              try: () => repository().prepareTransition(input),
              catch: () => new RecipientExclusionPersistenceError(),
            }),
        } satisfies RecipientExclusionPersistenceService;
      }),
    ),
  ).pipe(Layer.provide(encryptionLayer(environment)));

// A transition that was prepared but never acknowledged is completed here, so
// a crash between the Neon prepare and the journal append cannot leave a rule
// in an uncertain state. Only counts reach telemetry.
const recoverPreparedRecipientTransitions = async (
  environment: ApiEnvironment,
  connectionString: string,
  observedAt: string,
) => {
  const journal = await Effect.runPromise(
    Config.all({
      application: productionConfig,
      hmacSecret: recipientTransitionHmacSecret,
    }).pipe(
      Effect.map(({ application, hmacSecret }) =>
        makeRecipientJournalStore({
          bucket: environment.RECIPIENT_TRANSITIONS as RecipientJournalBucket,
          environment: application.environment,
          hmacSecret,
        }),
      ),
      Effect.withConfigProvider(environmentConfigProvider(environment)),
    ),
  );
  const repository = makePgRecipientExclusionRepository(connectionString);
  const pending = await repository.listPendingTransitions({
    limit: 100,
    observedAt,
  });
  let recoveredCount = 0;
  for (const transition of pending) {
    await Effect.runPromise(
      journal.append({
        connectionId: transition.whatsappConnectionId,
        effectiveAt: transition.effectiveAt,
        excluded: transition.excluded,
        purgeCutoffAt: transition.purgeCutoffAt,
        recipientKind: transition.recipientKind,
        recipientLocator: transition.recipientLocator,
        transitionId: transition.transitionId,
      }),
    );
    await repository.finalizeTransition({
      clerkUserId: transition.clerkUserId,
      connectionPublicId: transition.connectionPublicId,
      observedAt,
      recipientPublicId: transition.recipientPublicId,
      transitionId: transition.transitionId,
    });
    recoveredCount += 1;
  }
  if (recoveredCount > 0) {
    Effect.runSync(
      safeTelemetry.emit({
        event: "recipient_exclusion.recovery.completed",
        outcome: "success",
        recoveredCount,
        service: "api",
      }),
    );
  }
};

// A WhatsApp Recipient Exclusion whose recipient was absent from a restored
// snapshot is reapplied as soon as the WhatsApp Directory projects that
// recipient again. The scan runs only while restore recorded unresolved
// journal evidence, and only over recipients projected since that restore.
const recoverJournaledRecipientExclusions = async (
  environment: ApiEnvironment,
  connectionString: string,
  observedAt: string,
) => {
  const repository = makePgRecipientExclusionRepository(connectionString);
  const unresolved = new Set(
    await repository.listUnresolvedJournalPrefixes(1000),
  );
  if (unresolved.size === 0) return;
  const since = await repository.latestRestoreCompletedAt();
  if (since === null) return;
  const journal = await Effect.runPromise(
    Config.all({
      application: productionConfig,
      hmacSecret: recipientTransitionHmacSecret,
    }).pipe(
      Effect.map(({ application, hmacSecret }) => ({
        bucket: environment.RECIPIENT_TRANSITIONS as RecipientJournalBucket,
        environment: application.environment,
        hmacSecret,
      })),
      Effect.withConfigProvider(environmentConfigProvider(environment)),
    ),
  );
  let cursorKey: string | null = null;
  let recoveredCount = 0;
  for (;;) {
    const candidates = await repository.listRecipientsWithoutExclusion({
      cursorKey,
      limit: 500,
      since,
    });
    for (const candidate of candidates) {
      const prefix = await deriveRecipientJournalPrefix(
        journal.environment,
        journal.hmacSecret,
        candidate.whatsappConnectionId,
        candidate.recipientKind,
        candidate.recipientLocator,
      );
      if (!unresolved.has(prefix)) continue;
      for (const transition of await readTransitions(journal.bucket, prefix)) {
        await repository.replayTransition({
          ...candidate,
          ...transition,
          observedAt,
        });
      }
      await repository.resolveJournalPrefix(prefix);
      unresolved.delete(prefix);
      recoveredCount += 1;
    }
    if (candidates.length < 500) break;
    const last = candidates.at(-1);
    if (last === undefined || last.scanKey === cursorKey) break;
    cursorKey = last.scanKey;
  }
  if (recoveredCount > 0) {
    Effect.runSync(
      safeTelemetry.emit({
        event: "recipient_exclusion.recovery.completed",
        outcome: "success",
        recoveredCount,
        service: "api",
      }),
    );
  }
};

const safeTelemetry = {
  emit: (event: SafeTelemetryEvent) =>
    Effect.sync(() => console.info(serializeSafeTelemetry(event))).pipe(
      Effect.withSpan("telemetry.emit"),
    ),
} satisfies SafeTelemetry;

const telemetryLayer = Layer.succeed(SafeTelemetry, safeTelemetry);

const storedMediaContainerLayer = (environment: ApiEnvironment) =>
  Layer.effect(
    StoredMediaContainerService,
    Config.all({
      application: productionConfig,
      kms: kmsConfig,
    }).pipe(
      Effect.flatMap(({ application, kms }) => {
        if (
          !hasMethods(environment.STORED_MEDIA, [
            "createMultipartUpload",
            "get",
          ])
        ) {
          return Effect.fail(
            new MissingCloudflareBinding({ binding: "STORED_MEDIA" }),
          );
        }
        const client = new KMSClient({
          credentials: {
            accessKeyId: Redacted.value(kms.accessKeyId),
            secretAccessKey: Redacted.value(kms.secretAccessKey),
            sessionToken: Redacted.value(kms.sessionToken),
          },
          region: kms.region,
        });
        return Effect.succeed(
          makeStoredMediaContainer({
            bucket: environment.STORED_MEDIA as Pick<
              R2Bucket,
              "createMultipartUpload" | "get"
            >,
            encryption: makeEnvelopeEncryption({
              contentRootKeyId: kms.contentRootKeyArn,
              environment: application.environment,
              kms: makeAwsKmsKeyService(client),
            }),
            environment: application.environment,
            telemetry: (event) => {
              Effect.runSync(safeTelemetry.emit(event));
            },
          }),
        );
      }),
      Effect.withConfigProvider(environmentConfigProvider(environment)),
    ),
  );

class MissingHyperdriveBinding extends Data.TaggedError(
  "MissingHyperdriveBinding",
) {}

const databaseLayer = (environment: ApiEnvironment) =>
  Layer.succeed(DatabaseReadiness, {
    check:
      typeof environment.HYPERDRIVE?.connectionString === "string"
        ? Effect.tryPromise({
            try: () =>
              checkDatabaseReadiness(
                environment.HYPERDRIVE?.connectionString ?? "",
                environment.NEON_BRANCH_ID,
                environment.DEPLOYMENT_ENVIRONMENT === "development",
              ),
            catch: (cause) => cause,
          })
        : Effect.fail(new MissingHyperdriveBinding()),
  });

const unavailable = (): Response =>
  new Response(JSON.stringify({ service: "api", status: "unavailable" }), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status: 503,
  });

export const createProductionHandler = (environment: ApiEnvironment) => {
  const providerControlLayers = makeProviderControlLayers(
    environment.PROVIDER_CONTROL as ProviderControlService,
  );
  const connectionSetupPersistenceLayers =
    makeConnectionSetupPersistenceLayers(environment);
  const sendLayer = atomicSendLayer(environment).pipe(
    Layer.provide(Layer.merge(encryptionLayer(environment), telemetryLayer)),
  );
  const layer = Layer.mergeAll(
    configLayer(environment),
    databaseLayer(environment),
    telemetryLayer,
    encryptionLayer(environment),
    deletionLayer(environment),
    storedMediaContainerLayer(environment),
    humanIdentityLayer(environment),
    personalAccountPersistenceLayer(environment),
    personalAccountDeletionLayer(environment),
    personalAccountIdentifiersLayer,
    connectionSetupPersistenceLayers.setup,
    connectionSetupPersistenceLayers.provisioning,
    providerControlLayers.connectionSetupProvisioning,
    connectionSetupProvisioningQueueLayer(environment),
    connectionSetupProvisioningRuntimeLayer(environment),
    connectionSetupIdentifiersLayer,
    connectionSetupClockLayer,
    connectionSetupNumberTokensLayer(environment),
    makeWhatsAppConnectionPersistenceLayer(environment),
    providerControlLayers.whatsAppConnection,
    whatsAppConnectionRuntimeLayer,
    mcpAuthorizationPersistenceLayer(environment),
    mcpAuthorizationRuntimeLayer,
    apiKeyPersistenceLayer(environment),
    apiKeyRuntimeLayer(environment),
    restPersistenceLayer(environment),
    messageRetentionLayer(environment),
    onboardingProfileLayer(environment),
    recipientExclusionLayer(environment),
    makeWebhookIngressProductionLayer(environment),
    mcpToolPersistenceLayer(environment),
    mcpToolRuntimeLayer(environment),
    toolCallLogLayer(environment),
    sendLayer,
    mcpCursorSigningLayer(environment),
  );
  const handler = createCanaryHandler(layer);
  const deploymentSmokeHandler = createDeploymentSmokeHandler(
    makeProductionDeploymentSmoke(environment),
  );
  const personalAccountHandler = createPersonalAccountHandler(
    layer,
    environment.CLERK_AUTHORIZED_PARTY ?? "",
  );
  const personalAccountDeletionHandler = createPersonalAccountDeletionHandler({
    browserOrigin: environment.CLERK_AUTHORIZED_PARTY ?? "",
    deleteConnection: (clerkUserId, publicId, requestedAt) =>
      deleteWhatsAppConnection(clerkUserId, publicId, requestedAt).pipe(
        Effect.provide(layer),
        Effect.asVoid,
      ),
    layer,
  });
  const connectionSetupHandler = createConnectionSetupHandler(
    layer,
    environment.CLERK_AUTHORIZED_PARTY ?? "",
  );
  const mcpAuthorizationManagementHandler =
    createMcpAuthorizationManagementHandler(
      layer,
      environment.CLERK_AUTHORIZED_PARTY ?? "",
    );
  const apiKeyManagementHandler = createApiKeyManagementHandler(
    layer,
    environment.CLERK_AUTHORIZED_PARTY ?? "",
  );
  const toolCallLogHandler = createToolCallLogHandler(
    layer,
    environment.CLERK_AUTHORIZED_PARTY ?? "",
  );
  const whatsAppConnectionHandler = createWhatsAppConnectionHandler(
    layer,
    environment.CLERK_AUTHORIZED_PARTY ?? "",
  );
  const messageRetentionHandler = createMessageRetentionHandler(
    layer,
    environment.CLERK_AUTHORIZED_PARTY ?? "",
    retentionDayOptions(environment.MESSAGE_RETENTION_DAY_OPTIONS),
  );
  const onboardingProfileHandler = createOnboardingProfileHandler(
    layer,
    environment.CLERK_AUTHORIZED_PARTY ?? "",
  );
  const recipientExclusionHandler = createRecipientExclusionHandler(
    layer,
    environment.CLERK_AUTHORIZED_PARTY ?? "",
  );
  const webhookIngressHandler = createWebhookIngressHandler(layer);
  const oauthConfiguration = Effect.runPromise(
    loadOAuthConfiguration(environment as unknown as Record<string, unknown>),
  );
  const mcpRequestQuota = Effect.runPromise(
    mcpRequestQuotaConfig.pipe(
      Effect.withConfigProvider(environmentConfigProvider(environment)),
    ),
  );
  return async (
    request: Request,
    context?: ExecutionContext,
  ): Promise<Response> => {
    try {
      const path = new URL(request.url).pathname;
      if (!(request.method === "GET" && path === "/health")) {
        if (!environment.NEON_BRANCH_ID)
          throw new Error("Neon branch identity unavailable");
        await checkDatabaseReadiness(
          environment.HYPERDRIVE?.connectionString ?? "",
          environment.NEON_BRANCH_ID,
          environment.DEPLOYMENT_ENVIRONMENT === "development",
        );
      }
      if (isWebhookIngressRequest(request)) {
        return webhookIngressHandler(request);
      }
      if (isDeploymentSmokeRequest(request)) {
        return deploymentSmokeHandler(request);
      }
      if (isPersonalAccountDeletionRequest(request)) {
        return personalAccountDeletionHandler(request);
      }
      const [configuration, requestQuota] = await Promise.all([
        oauthConfiguration,
        mcpRequestQuota,
      ]);
      const consentHandler = createMcpAuthorizationConsentHandler({
        browserOrigin: environment.CLERK_AUTHORIZED_PARTY ?? "",
        configuration,
        kv: environment.OAUTH_KV as Parameters<
          typeof createMcpAuthorizationConsentHandler
        >[0]["kv"],
        layer,
        telemetry: (event) => {
          Effect.runSync(safeTelemetry.emit(event));
        },
      });
      const applicationHandler = async (
        nextRequest: Request,
        nextEnvironment: Parameters<
          Parameters<typeof createOAuthHandler>[0]["applicationHandler"]
        >[1],
        nextContext: ExecutionContext,
      ): Promise<Response> => {
        if (
          nextRequest.method === "POST" &&
          new URL(nextRequest.url).pathname === "/mcp"
        ) {
          const authorization = accessAuthorizationFrom(nextContext);
          if (authorization === null) {
            return new Response(JSON.stringify({ error: "invalid_token" }), {
              headers: {
                "cache-control": "no-store",
                "content-type": "application/json; charset=utf-8",
                "www-authenticate": 'Bearer error="invalid_token"',
              },
              status: 401,
            });
          }
          return withPgRequestConnectionScope(() =>
            createMcpRequestHandler({
              browserOrigin: environment.CLERK_AUTHORIZED_PARTY ?? "",
              hourLimit: requestQuota.hourLimit,
              layer,
              minuteLimit: requestQuota.minuteLimit,
              readMessageDailyRecordLimit: requestQuota.dailyRecordLimit,
              storedMediaDailyByteLimit: requestQuota.dailyMediaByteLimit,
              resourceUrl: configuration.resource,
            })(
              nextRequest,
              nextEnvironment,
              context ?? nextContext,
              authorization,
            ),
          );
        }
        if (
          isMcpAuthorizationConsentRequest(nextRequest) &&
          nextEnvironment.OAUTH_PROVIDER
        ) {
          return consentHandler(nextRequest, nextEnvironment.OAUTH_PROVIDER);
        }
        if (isConnectionSetupRequest(nextRequest)) {
          return connectionSetupHandler(nextRequest);
        }
        if (isMcpAuthorizationManagementRequest(nextRequest)) {
          return mcpAuthorizationManagementHandler(nextRequest);
        }
        if (isApiKeyManagementRequest(nextRequest)) {
          return apiKeyManagementHandler(nextRequest);
        }
        if (isRestRequest(nextRequest)) {
          return createRestHandler(layer, {
            hourLimit: requestQuota.hourLimit,
            keyHourLimit: requestQuota.hourLimit,
            keyMinuteLimit: requestQuota.minuteLimit,
            minuteLimit: requestQuota.minuteLimit,
          })(nextRequest);
        }
        if (isToolCallLogRequest(nextRequest)) {
          return toolCallLogHandler(nextRequest);
        }
        if (isWhatsAppConnectionRequest(nextRequest)) {
          return whatsAppConnectionHandler(nextRequest);
        }
        if (isRecipientExclusionRequest(nextRequest)) {
          return recipientExclusionHandler(nextRequest);
        }
        if (isMessageRetentionRequest(nextRequest)) {
          return messageRetentionHandler(nextRequest);
        }
        if (isOnboardingProfileRequest(nextRequest)) {
          return onboardingProfileHandler(nextRequest);
        }
        if (isPersonalAccountRequest(nextRequest)) {
          return personalAccountHandler(nextRequest);
        }
        return handler(nextRequest);
      };
      const oauthHandler = createOAuthHandler({
        applicationHandler,
        configuration,
        environment: environment as Parameters<
          typeof createOAuthHandler
        >[0]["environment"],
        isAuthorizationActive: async (input) => {
          try {
            return await Effect.runPromise(
              Effect.gen(function* () {
                const clock = yield* McpAuthorizationClock;
                const persistence = yield* McpAuthorizationPersistence;
                return yield* persistence.isActive({
                  ...input,
                  observedAt: yield* clock.now,
                });
              }).pipe(Effect.provide(layer)),
            );
          } catch {
            return false;
          }
        },
        refreshCredentials: {
          register: (input) =>
            Effect.runPromise(
              Effect.gen(function* () {
                const persistence = yield* McpAuthorizationPersistence;
                return yield* persistence.registerRefreshCredential(input);
              }).pipe(Effect.provide(layer)),
            ),
          rotate: (input, issue) =>
            Effect.runPromise(
              Effect.gen(function* () {
                const persistence = yield* McpAuthorizationPersistence;
                return yield* persistence.rotateRefreshCredential(input, issue);
              }).pipe(Effect.provide(layer)),
            ),
        },
        telemetry: (event) => {
          Effect.runSync(safeTelemetry.emit(event));
        },
      });
      return await oauthHandler(
        request,
        context ??
          ({
            passThroughOnException: () => undefined,
            waitUntil: () => undefined,
          } as unknown as ExecutionContext),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          errorMessage:
            error instanceof Error ? error.message.slice(0, 500) : "unknown",
          errorName: error instanceof Error ? error.name : typeof error,
          event: "request.unavailable",
          service: "api",
        }),
      );
      return unavailable();
    }
  };
};

const provisioningQueueName = (environment: ApiEnvironment): string | null => {
  const deploymentEnvironment = environment.DEPLOYMENT_ENVIRONMENT;
  if (
    deploymentEnvironment !== "development" &&
    deploymentEnvironment !== "preview" &&
    deploymentEnvironment !== "production"
  ) {
    return null;
  }
  const suffix =
    deploymentEnvironment === "production" ? "" : `-${deploymentEnvironment}`;
  return `whatsapp-mcp-connection-setup-provisioning${suffix}`;
};

const ingestionQueueName = (environment: ApiEnvironment): string | null => {
  const deploymentEnvironment = environment.DEPLOYMENT_ENVIRONMENT;
  if (
    deploymentEnvironment !== "development" &&
    deploymentEnvironment !== "preview" &&
    deploymentEnvironment !== "production"
  ) {
    return null;
  }
  const suffix =
    deploymentEnvironment === "production" ? "" : `-${deploymentEnvironment}`;
  return `whatsapp-mcp-ingestion${suffix}`;
};

const deadLetterQueueName = (environment: ApiEnvironment): string | null => {
  const deploymentEnvironment = environment.DEPLOYMENT_ENVIRONMENT;
  if (
    deploymentEnvironment !== "development" &&
    deploymentEnvironment !== "preview" &&
    deploymentEnvironment !== "production"
  ) {
    return null;
  }
  const suffix =
    deploymentEnvironment === "production" ? "" : `-${deploymentEnvironment}`;
  return `whatsapp-mcp-ingestion-dlq${suffix}`;
};

const replayQueueName = (environment: ApiEnvironment): string | null => {
  const deploymentEnvironment = environment.DEPLOYMENT_ENVIRONMENT;
  if (
    deploymentEnvironment !== "development" &&
    deploymentEnvironment !== "preview" &&
    deploymentEnvironment !== "production"
  ) {
    return null;
  }
  const suffix =
    deploymentEnvironment === "production" ? "" : `-${deploymentEnvironment}`;
  return `whatsapp-mcp-ingestion-replay${suffix}`;
};

export const createProductionQueueHandler =
  (environment: ApiEnvironment) =>
  async (batch: MessageBatch): Promise<void> => {
    const providerControlLayers = makeProviderControlLayers(
      environment.PROVIDER_CONTROL as ProviderControlService,
    );
    const connectionSetupPersistenceLayers =
      makeConnectionSetupPersistenceLayers(environment);
    if (!environment.NEON_BRANCH_ID)
      throw new Error("Neon branch identity unavailable");
    await checkDatabaseReadiness(
      environment.HYPERDRIVE?.connectionString ?? "",
      environment.NEON_BRANCH_ID,
      environment.DEPLOYMENT_ENVIRONMENT === "development",
    );
    if (batch.queue === replayQueueName(environment)) {
      const layer = Layer.mergeAll(
        telemetryLayer,
        makeWebhookReplayProductionLayer(environment),
      );
      await handleWebhookReplayBatch(batch, layer);
      return;
    }
    if (batch.queue === deadLetterQueueName(environment)) {
      const layer = Layer.mergeAll(
        encryptionLayer(environment),
        telemetryLayer,
        makeWebhookEventProductionLayer(environment),
      );
      await handleWebhookDeadLetterBatch(batch, layer);
      return;
    }
    if (batch.queue === ingestionQueueName(environment)) {
      const ingestionBatch = await handleDeploymentSmokeMessages(
        batch,
        environment,
      );
      if (ingestionBatch.messages.length === 0) return;
      const connectionString = environment.HYPERDRIVE?.connectionString;
      if (typeof connectionString !== "string") {
        throw new Error("message-search key installation unavailable");
      }
      const searchRepository = makePgMessageSearchRepository(connectionString);
      const seenConnections = new Set<string>();
      for (const queued of ingestionBatch.messages) {
        if (!isWebhookEventQueueMessage(queued.body)) continue;
        const candidate = {
          personalAccountId: queued.body.personal_account_id,
          whatsappConnectionId: queued.body.whatsapp_connection_id,
        };
        const identity = `${candidate.personalAccountId}:${candidate.whatsappConnectionId}`;
        if (seenConnections.has(identity)) continue;
        seenConnections.add(identity);
        await ensureMessageSearchKey(
          environment,
          searchRepository,
          candidate,
          new Date().toISOString(),
        );
      }
      const layer = Layer.mergeAll(
        encryptionLayer(environment),
        telemetryLayer,
        makeWebhookEventProductionLayer(environment),
      );
      await handleWebhookEventBatch(ingestionBatch, layer);
      return;
    }
    if (batch.queue !== provisioningQueueName(environment)) {
      for (const message of batch.messages) {
        message.retry({ delaySeconds: 30 });
      }
      return;
    }
    const cleanupMessages = batch.messages.filter((message) =>
      isConnectionSetupCleanupMessage(message.body),
    );
    const provisioningMessages = batch.messages.filter(
      (message) => !isConnectionSetupCleanupMessage(message.body),
    );
    if (cleanupMessages.length > 0) {
      const cleanupLayer = Layer.mergeAll(
        telemetryLayer,
        connectionSetupPersistenceLayers.cleanup,
        providerControlLayers.connectionSetupCleanup,
        connectionSetupCleanupRuntimeLayer,
      );
      await handleConnectionSetupCleanupBatch(
        { ...batch, messages: cleanupMessages },
        cleanupLayer,
      );
    }
    if (provisioningMessages.length > 0) {
      const provisioningLayer = Layer.mergeAll(
        encryptionLayer(environment),
        telemetryLayer,
        connectionSetupPersistenceLayers.provisioning,
        providerControlLayers.connectionSetupProvisioning,
        connectionSetupProvisioningRuntimeLayer(environment),
      );
      await handleConnectionSetupProvisioningBatch(
        { ...batch, messages: provisioningMessages },
        provisioningLayer,
      );
    }
  };

interface ConnectionSetupScheduledRepository {
  readonly expire: ReturnType<typeof makePgConnectionSetupRepository>["expire"];
  readonly listCleanupCandidates: ReturnType<
    typeof makePgConnectionSetupRepository
  >["listCleanupCandidates"];
  readonly listProvisioningCandidates: ReturnType<
    typeof makePgConnectionSetupRepository
  >["listProvisioningCandidates"];
}

interface ConnectionHealthScheduledRepository
  extends Pick<ConnectionHealthRepository, "claim" | "finish"> {}

const storedMediaSessionAuthority = (
  plaintext: Uint8Array,
): SessionAuthority => {
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("sessionCredential" in parsed) ||
    typeof parsed.sessionCredential !== "string" ||
    !/^[\x21-\x7e]{1,4096}$/u.test(parsed.sessionCredential)
  )
    throw new Error("invalid Stored Media provider authority");
  return Redacted.make(parsed.sessionCredential) as SessionAuthority;
};

const processProductionStoredMedia = async (
  environment: ApiEnvironment,
  candidate: PendingStoredMediaCandidate,
): Promise<void> => {
  if (
    !hasMethods(environment.STORED_MEDIA, [
      "createMultipartUpload",
      "delete",
      "get",
    ])
  )
    throw new Error("Stored Media object storage unavailable");
  const repository = makePgStoredMediaRepository(
    environment.HYPERDRIVE?.connectionString ?? "",
  );
  const baseLayer = Layer.mergeAll(
    encryptionLayer(environment),
    storedMediaContainerLayer(environment),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const encryption = yield* EnvelopeEncryptionService;
      const container = yield* StoredMediaContainerService;
      const authorityBytes = yield* encryption.decrypt({
        accountKey: candidate.accountKey,
        connectionKey: candidate.connectionKey,
        ciphertext: candidate.authority,
        context: {
          accountId: candidate.personalAccountId,
          connectionId: candidate.whatsappConnectionId,
          entity: "whatsapp-connection",
          fieldOrObjectPurpose: "provider-session-authority",
          recordId: candidate.whatsappConnectionId,
        },
      });
      const sourceBytes = yield* encryption.decrypt({
        accountKey: candidate.accountKey,
        connectionKey: candidate.connectionKey,
        ciphertext: candidate.source,
        context: {
          accountId: candidate.personalAccountId,
          connectionId: candidate.whatsappConnectionId,
          entity: "stored-media",
          fieldOrObjectPurpose: "provider-source",
          recordId: candidate.id,
        },
      });
      let authority: SessionAuthority;
      try {
        authority = storedMediaSessionAuthority(authorityBytes);
      } finally {
        authorityBytes.fill(0);
      }
      let source: MediaSource;
      try {
        source = Redacted.make(
          new TextDecoder().decode(sourceBytes),
        ) as MediaSource;
      } finally {
        sourceBytes.fill(0);
      }
      const retrieval = yield* MediaRetrieval.pipe(
        Effect.provide(
          makeWasenderMediaRetrievalLayer({ sessionAuthority: authority }),
        ),
      );
      yield* Effect.promise(() =>
        processStoredMedia({
          container,
          deleteObject: (objectKey) =>
            (environment.STORED_MEDIA as Pick<R2Bucket, "delete">)
              .delete(objectKey)
              .catch(() =>
                repository.enqueueObjectDeletion({
                  objectKey,
                  personalAccountId: candidate.personalAccountId,
                }),
              ),
          encryption,
          input: {
            accountKey: candidate.accountKey,
            connectionKey: candidate.connectionKey,
            id: candidate.id,
            mediaType: candidate.mediaType,
            objectKey: `media/${crypto.randomUUID()}`,
            personalAccountId: candidate.personalAccountId,
            source,
            whatsappConnectionId: candidate.whatsappConnectionId,
          },
          persistence: repository,
          retrieval,
        }),
      );
    }).pipe(Effect.provide(baseLayer)),
  );
};

const unavailableDirectoryFailure = (): ProviderNeutralFailure => ({
  _tag: "ProviderNeutralFailure",
  code: "invalid_response",
  operation: "safe-read",
  retryAfterMs: null,
  retryDecision: "do_not_retry",
});

const sessionDirectoryAuthority = (
  authority: Redacted.Redacted<string>,
): DirectorySessionAuthority => {
  const parsed = JSON.parse(Redacted.value(authority)) as unknown;
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

const groupDirectoryLayer = (environment: ApiEnvironment) =>
  Layer.mergeAll(
    Layer.succeed(GroupDirectoryIdentifiers, {
      nextGroup: Effect.sync(makeGroupDirectoryId),
    }),
    Layer.succeed(GroupDirectoryPersistence, {
      fail: (input) =>
        Effect.tryPromise({
          try: () => {
            const connectionString = environment.HYPERDRIVE?.connectionString;
            if (typeof connectionString !== "string") {
              throw new Error("database unavailable");
            }
            return makePgGroupRepository(connectionString).fail(input);
          },
          catch: () => new GroupDirectoryPersistenceError(),
        }),
      reconcile: (input) =>
        Effect.tryPromise({
          try: () => {
            const connectionString = environment.HYPERDRIVE?.connectionString;
            if (typeof connectionString !== "string") {
              throw new Error("database unavailable");
            }
            return makePgGroupRepository(connectionString).reconcile(input);
          },
          catch: () => new GroupDirectoryPersistenceError(),
        }),
    }),
    Layer.succeed(GroupDirectoryProvider, {
      read: ({ authority, identityKey }) =>
        Effect.try({
          try: () =>
            makeWasenderSessionDirectory({
              authority: sessionDirectoryAuthority(authority),
              identityKey: identityKey as WasenderIdentityProtectionKey,
              emitTelemetry: (event) => {
                Effect.runSync(
                  safeTelemetry.emit({
                    attemptCount: event.attempts,
                    durationMs: event.durationMs,
                    event: "provider.directory.completed",
                    operation: event.operation,
                    outcome: event.outcome,
                    responseBytes: event.responseBytes,
                    service: "api",
                  }),
                );
              },
            }),
          catch: unavailableDirectoryFailure,
        }).pipe(Effect.flatMap((directory) => directory.readGroups())),
    }),
  );

const ensureMessageSearchKey = async (
  environment: ApiEnvironment,
  repository: ReturnType<typeof makePgMessageSearchRepository>,
  candidate: {
    readonly personalAccountId: string;
    readonly whatsappConnectionId: string;
  },
  installedAt: string,
): Promise<void> => {
  const material = await repository.loadEncryptionMaterial(candidate);
  if (material === null || material.messageSearchKey !== null) return;
  await Effect.runPromise(
    Effect.gen(function* () {
      const encryption = yield* EnvelopeEncryptionService;
      const accountKey = {
        ciphertext: encodeBase64(material.accountKey.ciphertext),
        keyVersion: material.accountKey.keyVersion,
        kmsKeyId: material.accountKey.kmsKeyId,
        personalAccountId: candidate.personalAccountId,
        version: 1 as const,
      };
      const connectionKey = {
        accountKeyVersion: material.connectionKey.accountKeyVersion,
        ciphertext: encodeBase64(material.connectionKey.ciphertext),
        connectionId: candidate.whatsappConnectionId,
        keyVersion: material.connectionKey.keyVersion,
        nonce: encodeBase64(material.connectionKey.nonce),
        personalAccountId: candidate.personalAccountId,
        version: 1 as const,
      };
      const plaintext = crypto.getRandomValues(new Uint8Array(32));
      const protectedKey = yield* Effect.acquireUseRelease(
        Effect.succeed(plaintext),
        (bytes) =>
          encryption.encrypt({
            accountKey,
            connectionKey,
            context: {
              accountId: candidate.personalAccountId,
              connectionId: candidate.whatsappConnectionId,
              entity: "whatsapp-connection",
              fieldOrObjectPurpose: "message-search-key",
              recordId: candidate.whatsappConnectionId,
            },
            plaintext: bytes,
          }),
        (bytes) => Effect.sync(() => bytes.fill(0)),
      );
      yield* Effect.tryPromise(() =>
        repository.installKey({
          installedAt,
          key: {
            ciphertext: decodeBase64(protectedKey.ciphertext),
            keyVersion: protectedKey.keyVersion,
            nonce: decodeBase64(protectedKey.nonce),
            version: 1,
          },
          ...candidate,
        }),
      );
    }).pipe(Effect.provide(encryptionLayer(environment))),
  );
};

const runMessageSearchBackfill = async (
  environment: ApiEnvironment,
  connectionString: string,
  observedAt: string,
): Promise<void> => {
  const repository = makePgMessageSearchRepository(connectionString);
  const connections = await repository.listPendingConnections(5);
  for (const candidate of connections) {
    await ensureMessageSearchKey(
      environment,
      repository,
      candidate,
      observedAt,
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const encryption = yield* EnvelopeEncryptionService;
        const material = yield* Effect.tryPromise(() =>
          repository.loadEncryptionMaterial(candidate),
        );
        if (material === null) return;
        const accountKey = {
          ciphertext: encodeBase64(material.accountKey.ciphertext),
          keyVersion: material.accountKey.keyVersion,
          kmsKeyId: material.accountKey.kmsKeyId,
          personalAccountId: candidate.personalAccountId,
          version: 1 as const,
        };
        const connectionKey = {
          accountKeyVersion: material.connectionKey.accountKeyVersion,
          ciphertext: encodeBase64(material.connectionKey.ciphertext),
          connectionId: candidate.whatsappConnectionId,
          keyVersion: material.connectionKey.keyVersion,
          nonce: encodeBase64(material.connectionKey.nonce),
          personalAccountId: candidate.personalAccountId,
          version: 1 as const,
        };
        if (material.messageSearchKey === null) return;
        const keyEnvelope = material.messageSearchKey;
        const searchKeyBytes = yield* encryption.decrypt({
          accountKey,
          connectionKey,
          ciphertext: {
            ciphertext: encodeBase64(keyEnvelope.ciphertext),
            keyVersion: keyEnvelope.keyVersion,
            nonce: encodeBase64(keyEnvelope.nonce),
            version: 1,
          },
          context: {
            accountId: candidate.personalAccountId,
            connectionId: candidate.whatsappConnectionId,
            entity: "whatsapp-connection",
            fieldOrObjectPurpose: "message-search-key",
            recordId: candidate.whatsappConnectionId,
          },
        });
        yield* Effect.acquireUseRelease(
          Effect.succeed(searchKeyBytes),
          (keyBytes) =>
            Effect.gen(function* () {
              const searchKey = yield* importMessageSearchIndexKey(keyBytes);
              const batch = yield* Effect.tryPromise(() =>
                repository.loadCandidates({ ...candidate, limit: 100 }),
              );
              const plaintexts = yield* encryption.decryptMany({
                accountKey,
                connectionKey,
                items: batch.candidates.map((item) => ({
                  ciphertext: {
                    ciphertext: encodeBase64(item.content.ciphertext),
                    keyVersion: item.content.keyVersion,
                    nonce: encodeBase64(item.content.nonce),
                    version: 1,
                  },
                  context: {
                    accountId: candidate.personalAccountId,
                    connectionId: candidate.whatsappConnectionId,
                    entity: "stored-message",
                    fieldOrObjectPurpose: "content",
                    recordId: item.messageIdentity,
                  },
                })),
              });
              const indexed = yield* Effect.acquireUseRelease(
                Effect.succeed(plaintexts),
                (values) =>
                  Effect.forEach(batch.candidates, (item, index) =>
                    Effect.gen(function* () {
                      const value = values[index];
                      if (value === undefined)
                        return yield* Effect.fail(
                          new Error("missing backfill plaintext"),
                        );
                      const content = JSON.parse(
                        new TextDecoder("utf-8", {
                          fatal: true,
                          ignoreBOM: false,
                        }).decode(value),
                      ) as { readonly text?: unknown };
                      if (
                        content === null ||
                        (content.text !== null &&
                          typeof content.text !== "string")
                      )
                        return yield* Effect.fail(
                          new Error("invalid backfill plaintext"),
                        );
                      const tokens = yield* messageSearchIndexesForText(
                        searchKey,
                        candidate.whatsappConnectionId,
                        (content.text as string | null) ?? "",
                      );
                      return {
                        messageId: item.messageId,
                        sentAt: item.sentAt,
                        tokens,
                      };
                    }),
                  ),
                (values) =>
                  Effect.sync(() => {
                    for (const value of values) value.fill(0);
                  }),
              );
              yield* Effect.tryPromise(() =>
                repository.commitBatch({
                  committedAt: observedAt,
                  ...candidate,
                  tokens: indexed,
                }),
              );
            }),
          (bytes) => Effect.sync(() => bytes.fill(0)),
        );
      }).pipe(Effect.provide(encryptionLayer(environment))),
    );
  }
};

export const createProductionScheduledHandler =
  (
    environment: ApiEnvironment,
    dependencies: {
      readonly makeConnectionHealthRepository?: (
        connectionString: string,
      ) => ConnectionHealthScheduledRepository;
      readonly makeDirectoryRepository?: (
        connectionString: string,
      ) => Pick<
        DirectoryRepository,
        | "claimContactReconciliations"
        | "failContactReconciliation"
        | "finishContactReconciliation"
      >;
      readonly makeGroupRepository?: (
        connectionString: string,
      ) => Pick<GroupRepository, "claim">;
      readonly makePersonalAccountRepository?: (
        connectionString: string,
      ) => Pick<
        PersonalAccountRepository,
        | "listDeletionPurgeCandidates"
        | "purgeDeletion"
        | "purgeExpiredDeletionRecords"
      >;
      readonly makeRepository?: (
        connectionString: string,
      ) => ConnectionSetupScheduledRepository;
      readonly makeSendRepository?: (
        connectionString: string,
      ) => Pick<AtomicSendRepository, "expireLeases">;
      readonly listPendingStoredMedia?: (
        limit: number,
      ) => Promise<ReadonlyArray<PendingStoredMediaCandidate>>;
      readonly processPendingStoredMedia?: (
        candidate: PendingStoredMediaCandidate,
      ) => Promise<void>;
      readonly purgeExcludedRecipientHistory?: (
        observedAt: string,
        limit: number,
      ) => Promise<number>;
      readonly recoverRecipientExclusions?: (
        observedAt: string,
      ) => Promise<void>;
      readonly purgeExpiredMessages?: (
        observedAt: string,
        limit: number,
      ) => Promise<number>;
      readonly purgeExpiredToolCallLogs?: (limit: number) => Promise<number>;
      readonly purgePersonalAccounts?: (observedAt: string) => Promise<void>;
      readonly now?: () => string;
      readonly retainWebhookSources?: (observedAt: string) => Promise<void>;
      readonly runMessageSearchBackfill?: (observedAt: string) => Promise<void>;
      readonly sweepWebhookIngress?: (observedAt: string) => Promise<void>;
    } = {},
  ) =>
  async (controller: ScheduledController): Promise<void> => {
    if (!environment.NEON_BRANCH_ID)
      throw new Error("Neon branch identity unavailable");
    await checkDatabaseReadiness(
      environment.HYPERDRIVE?.connectionString ?? "",
      environment.NEON_BRANCH_ID,
      environment.DEPLOYMENT_ENVIRONMENT === "development",
    );
    if (controller.cron === "0 * * * *") {
      const connectionString = environment.HYPERDRIVE?.connectionString;
      if (typeof connectionString !== "string") {
        throw new Error("group Directory reconciliation unavailable");
      }
      const repository = (
        dependencies.makeGroupRepository ?? makePgGroupRepository
      )(connectionString);
      const claimedAt = new Date(controller.scheduledTime).toISOString();
      const layer = Layer.mergeAll(
        encryptionLayer(environment),
        telemetryLayer,
        groupDirectoryLayer(environment),
      );
      while (true) {
        const candidates = await repository.claim({
          claimedAt,
          limit: 100,
        });
        await Promise.all(
          candidates.map((candidate) =>
            Effect.runPromise(
              reconcileGroupDirectory(candidate, claimedAt).pipe(
                Effect.provide(layer),
              ),
            ),
          ),
        );
        if (candidates.length < 100) break;
      }
      const observedAt = new Date(controller.scheduledTime).toISOString();
      await (
        dependencies.retainWebhookSources ??
        ((value) =>
          handleWebhookSourceRetention(
            value,
            Layer.mergeAll(
              telemetryLayer,
              makeWebhookReplayProductionLayer(environment),
            ),
          ))
      )(observedAt);
      let purgedCount = 0;
      while (true) {
        const count = await (
          dependencies.purgeExpiredMessages ??
          ((value, limit) =>
            makePgMessageRetentionRepository(connectionString).purgeExpired(
              value,
              limit,
            ))
        )(observedAt, 500);
        purgedCount += count;
        if (count < 500) break;
      }
      Effect.runSync(
        safeTelemetry.emit({
          event: "message_retention.purge.completed",
          purgedCount,
          service: "api",
        }),
      );
      await (
        dependencies.recoverRecipientExclusions ??
        (dependencies.makeGroupRepository === undefined
          ? (value) =>
              recoverJournaledRecipientExclusions(
                environment,
                connectionString,
                value,
              )
          : async () => undefined)
      )(observedAt);
      let removedCount = 0;
      while (true) {
        const count = await (
          dependencies.purgeExcludedRecipientHistory ??
          (dependencies.makeGroupRepository === undefined
            ? (value, limit) =>
                makePgRecipientExclusionRepository(
                  connectionString,
                ).purgeExcludedHistory({ limit, observedAt: value })
            : async () => 0)
        )(observedAt, 500);
        removedCount += count;
        if (count < 500) break;
      }
      Effect.runSync(
        safeTelemetry.emit({
          event: "recipient_exclusion.cleanup.completed",
          outcome: "success",
          removedCount,
          service: "api",
        }),
      );
      try {
        await (
          dependencies.runMessageSearchBackfill ??
          (dependencies.makeGroupRepository === undefined
            ? (value) =>
                runMessageSearchBackfill(environment, connectionString, value)
            : async () => undefined)
        )(observedAt);
        Effect.runSync(
          safeTelemetry.emit({
            event: "message_search.backfill.completed",
            outcome: "success",
            service: "api",
          }),
        );
      } catch {
        // Backfill is recoverable; irreversible deletion maintenance must continue.
        Effect.runSync(
          safeTelemetry.emit({
            event: "message_search.backfill.completed",
            outcome: "failed",
            service: "api",
          }),
        );
      }
      while (true) {
        const count = await (
          dependencies.purgeExpiredToolCallLogs ??
          ((limit) =>
            makePgToolCallLogRepository(connectionString).purgeExpired(limit))
        )(500);
        if (count < 500) break;
      }
      await (
        dependencies.purgePersonalAccounts ??
        (async (value) => {
          const accountRepository = (
            dependencies.makePersonalAccountRepository ??
            makePgPersonalAccountRepository
          )(connectionString);
          while (true) {
            const candidates =
              await accountRepository.listDeletionPurgeCandidates({
                limit: 100,
                observedAt: value,
              });
            await Promise.all(
              candidates.map((candidate) => {
                if (candidate.deadlineRisk) {
                  Effect.runSync(
                    safeTelemetry.emit({
                      deadlineAt: candidate.deadlineAt,
                      event: "personal_account.deletion.deadline_risk",
                      marker: candidate.deletionMarkerId,
                      service: "api",
                    }),
                  );
                }
                return accountRepository.purgeDeletion({
                  completedAt: value,
                  deletionMarkerId: candidate.deletionMarkerId,
                });
              }),
            );
            if (candidates.length < 100) break;
          }
          while (
            (await accountRepository.purgeExpiredDeletionRecords(500)) === 500
          ) {
            // Drain bounded expiry batches.
          }
        })
      )(observedAt);
      return;
    }
    if (controller.cron === "*/5 * * * *") {
      const connectionString = environment.HYPERDRIVE?.connectionString;
      if (
        typeof connectionString !== "string" ||
        typeof environment.OAUTH_ISSUER !== "string" ||
        !hasMethods(environment.PROVIDER_CONTROL, [
          "reconcileSession",
          "repairSessionConfiguration",
        ])
      ) {
        throw new Error("Connection health reconciliation unavailable");
      }
      const repository = (
        dependencies.makeConnectionHealthRepository ??
        makePgConnectionHealthRepository
      )(connectionString);
      const now = dependencies.now ?? (() => new Date().toISOString());
      const layer = Layer.mergeAll(
        telemetryLayer,
        Layer.succeed(ConnectionHealthClock, {
          now: Effect.sync(now),
        }),
        Layer.succeed(ConnectionHealthPersistence, {
          finish: (input) =>
            Effect.tryPromise({
              try: () => repository.finish(input),
              catch: () => new ConnectionHealthPersistenceError(),
            }),
        }),
        makeProviderControlLayers(
          environment.PROVIDER_CONTROL as unknown as ProviderControlService,
        ).connectionHealth,
      );
      const claimedAt = now();
      while (true) {
        const candidates = await repository.claim({
          claimedAt,
          limit: 100,
        });
        await Promise.all(
          candidates.map((candidate) =>
            Effect.runPromise(
              reconcileConnectionHealth(
                candidate,
                environment.OAUTH_ISSUER as string,
              ).pipe(Effect.provide(layer)),
            ),
          ),
        );
        if (candidates.length < 100) break;
      }
      const directoryFactory =
        dependencies.makeDirectoryRepository ??
        (dependencies.makeConnectionHealthRepository === undefined
          ? makePgDirectoryRepository
          : null);
      if (directoryFactory === null) return;
      const directoryRepository = directoryFactory(connectionString);
      const directoryLayer = Layer.mergeAll(
        encryptionLayer(environment),
        telemetryLayer,
        Layer.succeed(ContactReconciliationClock, {
          now: Effect.sync(now),
        }),
        Layer.succeed(ContactReconciliationIdentifiers, {
          nextContactId: Effect.sync(() => makeContactId()),
        }),
        Layer.succeed(ContactReconciliationPersistence, {
          fail: (input) =>
            Effect.tryPromise({
              try: async () => {
                if (
                  !(await directoryRepository.failContactReconciliation(input))
                ) {
                  throw new Error("stale contact reconciliation failure");
                }
              },
              catch: () => new ContactReconciliationPersistenceError(),
            }),
          finish: (input) =>
            Effect.tryPromise({
              try: async () => {
                if (
                  !(await directoryRepository.finishContactReconciliation(
                    input,
                  ))
                ) {
                  throw new Error("stale contact reconciliation completion");
                }
              },
              catch: () => new ContactReconciliationPersistenceError(),
            }),
        }),
      );
      const directoryClaimedAt = now();
      while (true) {
        const directoryCandidates =
          await directoryRepository.claimContactReconciliations({
            claimedAt: directoryClaimedAt,
            limit: 100,
          });
        await Promise.all(
          directoryCandidates.map((candidate) =>
            Effect.runPromise(
              reconcileContacts(candidate).pipe(Effect.provide(directoryLayer)),
            ),
          ),
        );
        if (directoryCandidates.length < 100) break;
      }
      return;
    }
    if (controller.cron !== "* * * * *") return;
    const connectionString = environment.HYPERDRIVE?.connectionString;
    const queue = environment.CONNECTION_SETUP_PROVISIONING_QUEUE;
    if (
      typeof connectionString !== "string" ||
      !hasMethods(queue, ["sendBatch"])
    ) {
      throw new Error("Connection Setup provisioning recovery unavailable");
    }
    const repository = (
      dependencies.makeRepository ?? makePgConnectionSetupRepository
    )(connectionString);
    const observedAt = new Date(controller.scheduledTime).toISOString();
    const expiredSendCount = await (
      dependencies.makeSendRepository ??
      makePgAtomicSendRepositoryFromConnectionString
    )(connectionString).expireLeases(new Date(observedAt));
    const pendingMedia = await (
      dependencies.listPendingStoredMedia ??
      (dependencies.makeRepository === undefined
        ? (limit) =>
            makePgStoredMediaRepository(connectionString).listPending(limit)
        : async () => [])
    )(10);
    if (dependencies.makeRepository === undefined) {
      await recoverPreparedRecipientTransitions(
        environment,
        connectionString,
        observedAt,
      );
      const storedMediaRepository =
        makePgStoredMediaRepository(connectionString);
      const objectDeletions =
        await storedMediaRepository.listObjectDeletions(100);
      if (!hasMethods(environment.STORED_MEDIA, ["delete"]))
        throw new Error("Stored Media deletion unavailable");
      await Promise.all(
        objectDeletions.map(async (deletion) => {
          await (environment.STORED_MEDIA as Pick<R2Bucket, "delete">).delete(
            deletion.objectKey,
          );
          await storedMediaRepository.finishObjectDeletion(deletion);
        }),
      );
      const connectionDeletionRepository =
        makePgWhatsAppConnectionRepository(connectionString);
      const deletionMarkers =
        await connectionDeletionRepository.listDeletionPurgeCandidates({
          limit: 100,
          observedAt,
        });
      const purgeConnection = makeConnectionDeletionActiveDataPurger({
        clock: () => observedAt,
        persistence: makeConnectionDeletionCleanupPersistence(
          connectionDeletionRepository,
          (input) =>
            storedMediaRepository.finishObjectDeletion({
              objectKey: input.objectKey,
              personalAccountId: input.personalAccountId,
            }),
        ),
        storedMedia: {
          delete: (key) =>
            (environment.STORED_MEDIA as Pick<R2Bucket, "delete">).delete(key),
        },
        webhookSources: {
          delete: (key) =>
            (environment.WEBHOOK_INGRESS as Pick<R2Bucket, "delete">).delete(
              key,
            ),
        },
      });
      await Promise.all(
        deletionMarkers.map((candidate) => {
          if (candidate.deadlineRisk) {
            Effect.runSync(
              safeTelemetry.emit({
                deadlineAt: candidate.deadlineAt,
                event: "whatsapp_connection.deletion.deadline_risk",
                marker: candidate.deletionMarkerId,
                service: "api",
              }),
            );
          }
          return Effect.runPromise(
            purgeConnection({ deletionMarkerId: candidate.deletionMarkerId }),
          );
        }),
      );
    }
    await Promise.all(
      pendingMedia.map((candidate) =>
        (
          dependencies.processPendingStoredMedia ??
          ((value) => processProductionStoredMedia(environment, value))
        )(candidate),
      ),
    );
    Effect.runSync(
      safeTelemetry.emit({
        event: "send.dispatch_lease.sweep_completed",
        expiredCount: expiredSendCount,
        service: "api",
      }),
    );
    let webhookRecoveryFailure: unknown;
    try {
      await (
        dependencies.sweepWebhookIngress ??
        ((value) =>
          handleWebhookIngressSweep(
            value,
            Layer.mergeAll(
              telemetryLayer,
              makeWebhookRecoveryProductionLayer(environment),
            ),
          ))
      )(observedAt);
    } catch (error) {
      webhookRecoveryFailure = error;
    }
    const expired = await repository.expire({
      limit: 100,
      observedAt,
    });
    const cleanupCandidates = await repository.listCleanupCandidates({
      limit: 100,
      observedAt,
    });
    const provisioningCandidates = await repository.listProvisioningCandidates({
      limit: 100,
      observedAt,
    });
    if (cleanupCandidates.length > 0) {
      await (queue as Pick<Queue, "sendBatch">).sendBatch(
        cleanupCandidates.map((setupId) => ({
          body: connectionSetupCleanupMessage(setupId),
        })),
      );
    }
    if (provisioningCandidates.length > 0) {
      await (queue as Pick<Queue, "sendBatch">).sendBatch(
        provisioningCandidates.map((setupId) => ({
          body: connectionSetupProvisioningMessage(setupId),
        })),
      );
    }
    Effect.runSync(
      safeTelemetry.emit({
        candidateCount: provisioningCandidates.length,
        event: "connection_setup.provision.recovery_enqueued",
        service: "api",
      }),
    );
    Effect.runSync(
      safeTelemetry.emit({
        candidateCount: cleanupCandidates.length,
        event: "connection_setup.cleanup.recovery_enqueued",
        expiredCount: expired.length,
        service: "api",
      }),
    );
    if (webhookRecoveryFailure !== undefined) {
      throw webhookRecoveryFailure;
    }
  };
