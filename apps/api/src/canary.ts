import type {
  HealthResponse,
  ReadinessResponse,
} from "@whatsapp-mcp/contracts/health";
import { Effect, type Layer } from "effect";
import { noStoreJsonResponse } from "./http-response";
import {
  ApplicationConfig,
  DatabaseReadiness,
  type HttpCompletedEvent,
  SafeTelemetry,
} from "./services";

const jsonResponse = (body: unknown, status: number): Response =>
  noStoreJsonResponse(body, status);

const canaryProgram = (
  request: Request,
  options: { readonly databaseAlreadyChecked?: boolean },
) =>
  Effect.gen(function* () {
    const config = yield* ApplicationConfig;
    const database = yield* DatabaseReadiness;
    const telemetry = yield* SafeTelemetry;
    const path = new URL(request.url).pathname;
    const isHealth = request.method === "GET" && path === "/health";
    const isReady = request.method === "GET" && path === "/ready";

    if (!isHealth && options.databaseAlreadyChecked !== true) {
      yield* database.check;
    }

    const response = isHealth
      ? jsonResponse(
          {
            service: "api",
            status: "ok",
          } satisfies HealthResponse,
          200,
        )
      : isReady
        ? jsonResponse(
            {
              service: "api",
              status: "ready",
            } satisfies ReadinessResponse,
            200,
          )
        : jsonResponse({ error: "not_found" }, 404);

    const event: HttpCompletedEvent = {
      event: "http.request.completed",
      method: request.method,
      route: isHealth ? "health" : isReady ? "ready" : "unmatched",
      service: config.service,
      status: response.status,
    };
    yield* telemetry.emit(event);

    return response;
  });

export const createCanaryHandler =
  (
    layer: Layer.Layer<
      ApplicationConfig | DatabaseReadiness | SafeTelemetry,
      unknown
    >,
    options: { readonly databaseAlreadyChecked?: boolean } = {},
  ) =>
  (request: Request): Promise<Response> =>
    Effect.runPromise(
      canaryProgram(request, options).pipe(Effect.provide(layer)),
    );
