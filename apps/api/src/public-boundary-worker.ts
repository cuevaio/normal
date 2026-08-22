import type { Layer } from "effect";
import {
  type AccountInsightsClockService,
  type AccountInsightsPersistenceService,
  createAccountInsightsHandler,
  isAccountInsightsRequest,
} from "./account-insights";
import {
  type ActivityLogClockService,
  type ActivityLogPersistenceService,
  createActivityLogHandler,
  isActivityLogRequest,
} from "./activity-log";
import {
  type ApiKeyClockService,
  type ApiKeyHmacService,
  type ApiKeyIdentifiersService,
  type ApiKeyPersistenceService,
  createApiKeyManagementHandler,
  isApiKeyManagementRequest,
} from "./api-key";
import {
  type ConnectionSetupRequirements,
  createConnectionSetupHandler,
  isConnectionSetupRequest,
} from "./connection-setup";
import {
  type ConnectionSetupProvisioningRequirements,
  handleConnectionSetupProvisioningBatch,
  isConnectionSetupProvisioningMessage,
} from "./connection-setup-provisioning";
import type { EnvelopeEncryption } from "./encryption/envelope";
import type { StoredMediaContainer } from "./encryption/stored-media-container";
import { noStoreJsonResponse } from "./http-response";
import type { SendTextMessageService } from "./mcp";
import {
  createMcpAuthorizationManagementHandler,
  isMcpAuthorizationManagementRequest,
  type McpAuthorizationClockService,
  type McpAuthorizationPersistenceService,
} from "./mcp-authorization";
import {
  createOnboardingProfileHandler,
  isOnboardingProfileRequest,
  type OnboardingProfileClockService,
  type OnboardingProfilePersistenceService,
} from "./onboarding-profile";
import {
  createPersonalAccountHandler,
  isPersonalAccountRequest,
  type PersonalAccountRequirements,
} from "./personal-account";
import {
  type BoundaryClock,
  type BoundaryIdentifiers,
  type BoundaryIdentity,
  type BoundaryProvider,
  type BoundaryResource,
  createPublicBoundaryHandler,
} from "./public-boundary";
import {
  createRestHandler,
  isRestRequest,
  type RestClockService,
  type RestCursorCodecService,
  type RestIdentifiersService,
  type RestPersistenceService,
} from "./rest";
import type { SafeTelemetry as SafeTelemetryService } from "./services";
import {
  handleWebhookDeadLetterBatch,
  handleWebhookEventBatch,
  type WebhookEventRequirements,
} from "./webhook-event";
import {
  createWebhookIngressHandler,
  isWebhookIngressRequest,
  type WebhookIngressRequirements,
} from "./webhook-ingress";
import {
  handleWebhookIngressSweep,
  type WebhookRecoveryRequirements,
} from "./webhook-recovery";
import {
  handleWebhookReplayBatch,
  handleWebhookSourceRetention,
  type WebhookReplayRequirements,
  type WebhookSourceRetentionRequirements,
} from "./webhook-replay";
import {
  createWhatsAppConnectionHandler,
  isWhatsAppConnectionRequest,
  type WhatsAppConnectionRequirements,
} from "./whatsapp-connection";
import { createWorker } from "./worker";

type BoundaryRequirements =
  | BoundaryClock
  | BoundaryIdentifiers
  | BoundaryIdentity
  | BoundaryProvider
  | BoundaryResource;
type PublicBoundaryRequirements =
  | ApiKeyClockService
  | ApiKeyHmacService
  | ApiKeyIdentifiersService
  | ApiKeyPersistenceService
  | BoundaryRequirements
  | ConnectionSetupRequirements
  | EnvelopeEncryption
  | McpAuthorizationClockService
  | McpAuthorizationPersistenceService
  | OnboardingProfileClockService
  | OnboardingProfilePersistenceService
  | PersonalAccountRequirements
  | RestClockService
  | RestCursorCodecService
  | RestIdentifiersService
  | RestPersistenceService
  | SafeTelemetryService
  | SendTextMessageService
  | StoredMediaContainer
  | AccountInsightsClockService
  | AccountInsightsPersistenceService
  | ActivityLogClockService
  | ActivityLogPersistenceService
  | WebhookIngressRequirements
  | WhatsAppConnectionRequirements;

export interface PublicBoundaryEnvironment {
  readonly INGESTION_QUEUE: Queue;
  readonly OAUTH_KV: KVNamespace;
  readonly PROVIDER_CONTROL: Fetcher;
  readonly WEBHOOK_INGRESS: R2Bucket;
}

export interface PublicBoundaryWorkerOptions {
  readonly browserOrigin: string;
  readonly fallback: (
    request: Request,
    environment: PublicBoundaryEnvironment,
  ) => Promise<Response>;
  readonly layerFor: (
    request: Request,
    environment: PublicBoundaryEnvironment,
  ) => Layer.Layer<PublicBoundaryRequirements>;
  readonly provisioningLayer: Layer.Layer<ConnectionSetupProvisioningRequirements>;
  readonly webhookEventLayer: (
    environment: PublicBoundaryEnvironment,
  ) => Layer.Layer<WebhookEventRequirements>;
  readonly webhookRecoveryLayer: (
    environment: PublicBoundaryEnvironment,
  ) => Layer.Layer<WebhookRecoveryRequirements>;
  readonly webhookReplayLayer: (
    environment: PublicBoundaryEnvironment,
  ) => Layer.Layer<
    WebhookReplayRequirements | WebhookSourceRetentionRequirements
  >;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  noStoreJsonResponse(body, status);

const bindingResponse = async (
  environment: PublicBoundaryEnvironment,
): Promise<Response> => {
  await environment.OAUTH_KV.put("public-boundary:kv", "stored");
  await environment.WEBHOOK_INGRESS.put("public-boundary/r2", "stored");
  await environment.INGESTION_QUEUE.send({
    object_id: "evt_public_boundary",
  });
  const providerControl = await environment.PROVIDER_CONTROL.fetch(
    "https://provider-control.internal/health",
  );

  return jsonResponse({
    kv: "stored",
    provider_control: providerControl.ok ? "ok" : "unavailable",
    queue: "published",
    r2: "stored",
  });
};

/**
 * Public Worker behavior exercised by the boundary suite. The test
 * composition root supplies only external Effect services; HTTP dispatch,
 * binding calls, Queue acknowledgement, and scheduled work remain here.
 */
export const createPublicBoundaryWorker = (
  options: PublicBoundaryWorkerOptions,
): ExportedHandler<PublicBoundaryEnvironment> =>
  createWorker<PublicBoundaryEnvironment>({
    async fetch(
      request: Request,
      environment: PublicBoundaryEnvironment,
      _context: ExecutionContext,
    ): Promise<Response> {
      const path = new URL(request.url).pathname;

      if (request.method === "GET" && path === "/test/bindings") {
        return bindingResponse(environment);
      }

      if (isWebhookIngressRequest(request)) {
        return createWebhookIngressHandler(
          options.layerFor(request, environment),
        )(request);
      }

      if (isPersonalAccountRequest(request)) {
        return createPersonalAccountHandler(
          options.layerFor(request, environment),
          options.browserOrigin,
        )(request);
      }

      if (isOnboardingProfileRequest(request)) {
        return createOnboardingProfileHandler(
          options.layerFor(request, environment),
          options.browserOrigin,
        )(request);
      }

      if (isConnectionSetupRequest(request)) {
        return createConnectionSetupHandler(
          options.layerFor(request, environment),
          options.browserOrigin,
        )(request);
      }

      if (isMcpAuthorizationManagementRequest(request)) {
        return createMcpAuthorizationManagementHandler(
          options.layerFor(request, environment),
          options.browserOrigin,
        )(request);
      }

      if (isApiKeyManagementRequest(request)) {
        return createApiKeyManagementHandler(
          options.layerFor(request, environment),
          options.browserOrigin,
        )(request);
      }

      if (isRestRequest(request)) {
        return createRestHandler(options.layerFor(request, environment), {
          dailyRecordLimit: 10_000,
          hourLimit: 60,
          keyHourLimit: 60,
          keyMinuteLimit: 20,
          minuteLimit: 20,
        })(request);
      }

      if (isActivityLogRequest(request)) {
        return createActivityLogHandler(
          options.layerFor(request, environment),
          options.browserOrigin,
        )(request);
      }

      if (isAccountInsightsRequest(request)) {
        return createAccountInsightsHandler(
          options.layerFor(request, environment),
          options.browserOrigin,
        )(request);
      }

      if (isWhatsAppConnectionRequest(request)) {
        return createWhatsAppConnectionHandler(
          options.layerFor(request, environment),
          options.browserOrigin,
        )(request);
      }

      if (
        request.method === "OPTIONS" ||
        (request.method === "GET" &&
          (path === "/test/ready" ||
            path === "/v1/personal-account" ||
            path === "/oauth/authorize" ||
            path === "/mcp/resources/protected")) ||
        (request.method === "POST" && path === "/mcp")
      ) {
        return createPublicBoundaryHandler(
          options.layerFor(request, environment),
          options.browserOrigin,
        )(request);
      }

      return options.fallback(request, environment);
    },

    async queue(
      batch: MessageBatch,
      environment: PublicBoundaryEnvironment,
      _context: ExecutionContext,
    ): Promise<void> {
      if (
        /^whatsapp-mcp-ingestion-replay(?:-(?:development|preview))?$/u.test(
          batch.queue,
        )
      ) {
        return handleWebhookReplayBatch(
          batch,
          options.webhookReplayLayer(environment),
        );
      }
      if (
        /^whatsapp-mcp-ingestion-dlq(?:-(?:development|preview))?$/u.test(
          batch.queue,
        )
      ) {
        return handleWebhookDeadLetterBatch(
          batch,
          options.webhookEventLayer(environment),
        );
      }
      if (
        /^whatsapp-mcp-ingestion(?:-(?:development|preview))?$/u.test(
          batch.queue,
        )
      ) {
        return handleWebhookEventBatch(
          batch,
          options.webhookEventLayer(environment),
        );
      }
      if (
        batch.messages.length > 0 &&
        batch.messages.every((message) =>
          isConnectionSetupProvisioningMessage(message.body),
        )
      ) {
        return handleConnectionSetupProvisioningBatch(
          batch,
          options.provisioningLayer,
        );
      }
      for (const message of batch.messages) {
        await environment.OAUTH_KV.put(
          `queue:${message.id}`,
          JSON.stringify(message.body),
        );
        message.ack();
      }
    },

    async scheduled(
      controller: ScheduledController,
      environment: PublicBoundaryEnvironment,
      _context: ExecutionContext,
    ): Promise<void> {
      if (controller.cron === "* * * * *") {
        await handleWebhookIngressSweep(
          new Date(controller.scheduledTime).toISOString(),
          options.webhookRecoveryLayer(environment),
        );
      }
      if (controller.cron === "0 * * * *") {
        await handleWebhookSourceRetention(
          new Date(controller.scheduledTime).toISOString(),
          options.webhookReplayLayer(environment),
        );
      }
      await environment.OAUTH_KV.put(
        "scheduled:last",
        new Date(controller.scheduledTime).toISOString(),
      );
      const response = await environment.PROVIDER_CONTROL.fetch(
        "https://provider-control.internal/health",
      );
      await environment.OAUTH_KV.put(
        "scheduled:provider-control",
        response.ok ? "ok" : "unavailable",
      );
    },
  });
