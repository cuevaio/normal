import type { AccountInsights } from "@whatsapp-mcp/db/account-insights";
import { Context, Data, Effect, type Layer } from "effect";
import {
  HumanIdentity,
  type HumanIdentityService,
} from "./auth/human-identity";
import { hasFailureTag } from "./failure-tag";
import { noStoreJsonResponse } from "./http-response";
import {
  SafeTelemetry,
  type SafeTelemetry as SafeTelemetryService,
} from "./services";

const ACCOUNT_INSIGHTS_PATH = "/v1/personal-account/insights";

export class AccountInsightsPersistenceError extends Data.TaggedError(
  "AccountInsightsPersistenceError",
) {}

export interface AccountInsightsPersistenceService {
  readonly read: (
    clerkUserId: string,
    observedAt: Date,
  ) => Effect.Effect<AccountInsights | null, AccountInsightsPersistenceError>;
}

export const AccountInsightsPersistence =
  Context.GenericTag<AccountInsightsPersistenceService>(
    "@whatsapp-mcp/api/AccountInsightsPersistence",
  );

export interface AccountInsightsClockService {
  readonly now: Effect.Effect<Date>;
}

export const AccountInsightsClock =
  Context.GenericTag<AccountInsightsClockService>(
    "@whatsapp-mcp/api/AccountInsightsClock",
  );

type AccountInsightsRequirements =
  | HumanIdentityService
  | SafeTelemetryService
  | AccountInsightsClockService
  | AccountInsightsPersistenceService;

const corsHeaders = (browserOrigin: string) => ({
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
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

export const encodeAccountInsights = (insights: AccountInsights) => ({
  authorizations: { active: insights.authorizations.active },
  connections: {
    connected: insights.connections.connected,
    needs_attention: insights.connections.needsAttention,
    total: insights.connections.total,
  },
  conversations: {
    active: insights.conversations.active,
    direct: insights.conversations.direct,
    group: insights.conversations.group,
    total: insights.conversations.total,
  },
  generated_at: insights.generatedAt.toISOString(),
  messages: {
    inbound: insights.messages.inbound,
    outbound: insights.messages.outbound,
    previous_inbound: insights.messages.previousInbound,
    previous_outbound: insights.messages.previousOutbound,
  },
  sends: {
    confirmed: insights.sends.confirmed,
    failed: insights.sends.failed,
    unknown: insights.sends.unknown,
  },
  series: insights.series.map((point) => ({
    date: point.date,
    inbound: point.inbound,
    outbound: point.outbound,
  })),
  window_days: insights.windowDays,
});

export const createAccountInsightsHandler =
  (
    layer: Layer.Layer<AccountInsightsRequirements, unknown>,
    browserOrigin: string,
  ) =>
  (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.pathname !== ACCOUNT_INSIGHTS_PATH ||
      request.headers.get("origin") !== browserOrigin
    ) {
      return Promise.resolve(notFound());
    }
    if (request.method === "OPTIONS") {
      return Promise.resolve(
        new Response(null, {
          headers: corsHeaders(browserOrigin),
          status: 204,
        }),
      );
    }
    if (request.method !== "GET") {
      return Promise.resolve(notFound(browserOrigin));
    }
    if ([...url.searchParams.keys()].length > 0) {
      return Promise.resolve(
        jsonResponse({ error: "invalid_query" }, 400, browserOrigin),
      );
    }

    return Effect.runPromise(
      Effect.gen(function* () {
        const identity = yield* HumanIdentity;
        const clerkUserId = yield* identity.verify(request);
        const clock = yield* AccountInsightsClock;
        const persistence = yield* AccountInsightsPersistence;
        const insights = yield* persistence.read(clerkUserId, yield* clock.now);
        if (insights === null)
          return yield* Effect.fail(new InvalidAccountInsightsOwner());
        const telemetry = yield* SafeTelemetry;
        yield* telemetry.emit({
          event: "account_insights.review.completed",
          inboundCount: insights.messages.inbound,
          outboundCount: insights.messages.outbound,
          service: "api",
          windowDays: insights.windowDays,
        });
        return insights;
      }).pipe(
        Effect.provide(layer),
        Effect.match({
          onFailure: (failure: unknown) =>
            hasFailureTag(
              failure,
              "InvalidHumanIdentity",
              "InvalidAccountInsightsOwner",
            )
              ? notFound(browserOrigin)
              : jsonResponse({ error: "unavailable" }, 503, browserOrigin),
          onSuccess: (insights) =>
            jsonResponse(encodeAccountInsights(insights), 200, browserOrigin),
        }),
      ),
    );
  };

class InvalidAccountInsightsOwner extends Data.TaggedError(
  "InvalidAccountInsightsOwner",
) {}

export const isAccountInsightsRequest = (request: Request): boolean =>
  new URL(request.url).pathname === ACCOUNT_INSIGHTS_PATH;
