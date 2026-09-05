import {
  makeWasenderSessionLifecycle,
  SessionLifecycle,
  type WasenderLifecycleTelemetryEvent,
} from "@whatsapp-mcp/wasender/control";
import { Config, ConfigProvider, Effect, Layer, Redacted } from "effect";
import { createCanaryHandler } from "./canary";
import { makeProviderControlRpc } from "./rpc";
import {
  ApplicationConfig,
  type HttpCompletedEvent,
  SafeTelemetry,
} from "./services";

export interface ProviderControlEnvironment {
  readonly DEPLOYMENT_ENVIRONMENT?: string | undefined;
  readonly WASENDER_API_CREDENTIAL?: string | undefined;
  readonly WASENDER_REFERENCE_SECRET?: string | undefined;
}

const productionConfig = Config.all({
  environment: Config.literal(
    "development",
    "preview",
    "production",
  )("DEPLOYMENT_ENVIRONMENT"),
});

const isProviderApiCredential = (value: string) =>
  /^[\x21-\x7e]{1,4096}$/u.test(value) &&
  !/replace|example|placeholder/iu.test(value);

const providerApiCredential = Config.redacted("WASENDER_API_CREDENTIAL").pipe(
  Config.validate({
    message: "WASENDER_API_CREDENTIAL must be a non-placeholder credential",
    validation: (value) => isProviderApiCredential(Redacted.value(value)),
  }),
);

const providerReferenceSecret = Config.redacted(
  "WASENDER_REFERENCE_SECRET",
).pipe(
  Config.validate({
    message: "WASENDER_REFERENCE_SECRET must be a 32-byte hex secret",
    validation: (value) => /^[0-9a-f]{64}$/iu.test(Redacted.value(value)),
  }),
);

const environmentConfigProvider = (environment: ProviderControlEnvironment) =>
  ConfigProvider.fromMap(
    new Map(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  );

const applicationConfigEffect = (environment: ProviderControlEnvironment) =>
  productionConfig.pipe(
    Effect.map((config) => ({
      ...config,
      service: "provider-control" as const,
    })),
    Effect.withConfigProvider(environmentConfigProvider(environment)),
  );

const configLayer = (environment: ProviderControlEnvironment) =>
  Layer.effect(ApplicationConfig, applicationConfigEffect(environment));

const providerTelemetry = (event: WasenderLifecycleTelemetryEvent) =>
  console.info(
    JSON.stringify({
      ...event,
      event: "provider.call.completed",
      service: "provider-control",
    }),
  );

const sessionLifecycleLayer = (environment: ProviderControlEnvironment) =>
  Layer.effect(SessionLifecycle, sessionLifecycleEffect(environment));

const sessionLifecycleEffect = (environment: ProviderControlEnvironment) =>
  Config.all({
    credential: providerApiCredential,
    referenceSecret: providerReferenceSecret,
  }).pipe(
    Effect.map((config) =>
      makeWasenderSessionLifecycle(config, {
        telemetry: providerTelemetry,
      }),
    ),
    Effect.withConfigProvider(environmentConfigProvider(environment)),
  );

const telemetryLayer = Layer.succeed(SafeTelemetry, {
  emit: (event: HttpCompletedEvent) =>
    Effect.sync(() => console.info(JSON.stringify(event))).pipe(
      Effect.withSpan("telemetry.emit"),
    ),
});

const unavailable = (): Response =>
  new Response(
    JSON.stringify({
      service: "provider-control",
      status: "unavailable",
    }),
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
      status: 503,
    },
  );

export const createProductionHandler = (
  environment: ProviderControlEnvironment,
) => {
  const handler = createCanaryHandler(
    Layer.mergeAll(
      configLayer(environment),
      sessionLifecycleLayer(environment),
      telemetryLayer,
    ),
  );

  return async (request: Request): Promise<Response> => {
    try {
      return await handler(request);
    } catch {
      console.error(
        JSON.stringify({
          event: "configuration.invalid",
          service: "provider-control",
        }),
      );
      return unavailable();
    }
  };
};

export const createProductionRpc = (environment: ProviderControlEnvironment) =>
  makeProviderControlRpc({
    loadLifecycle: () =>
      Effect.runPromise(
        applicationConfigEffect(environment).pipe(
          Effect.flatMap(() => sessionLifecycleEffect(environment)),
        ),
      ),
    telemetry: (event) => console.info(JSON.stringify(event)),
  });
