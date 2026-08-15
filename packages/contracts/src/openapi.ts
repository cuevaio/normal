import type { API_KEY_PERMISSIONS } from "./api-key";
import { ProblemDetailsContract, RestConnectionListContract } from "./rest";

export const REST_API_VERSION = "1.0.0";

export interface RestRouteMetadata {
  readonly description: string;
  readonly method: "GET";
  readonly operationId: string;
  readonly path: "/v1/connections";
  readonly permission: (typeof API_KEY_PERMISSIONS)[number];
  readonly summary: string;
  readonly tags: readonly ["Connections"];
}

export const restRouteRegistry = [
  {
    description:
      "List the WhatsApp Connections explicitly selected for the calling API Key. Later Connections are never added automatically. Disconnected Connections remain visible so retained history can still be read through later endpoints.",
    method: "GET",
    operationId: "listConnections",
    path: "/v1/connections",
    permission: "connections:read",
    summary: "List selected WhatsApp Connections",
    tags: ["Connections"],
  },
] as const satisfies ReadonlyArray<RestRouteMetadata>;

const connectionListExample = {
  data: [
    {
      connection_id: "con_xxxxxxxxxxxxxxxxxxxxx",
      display_name: "Personal WhatsApp",
      number_last_four: "0000",
      state: "connected",
      state_changed_at: "2026-08-14T12:00:00.000Z",
    },
  ],
  pagination: {
    has_more: false,
    next_cursor: null,
  },
};

const problemExample = {
  code: "invalid_credentials",
  detail: "The API Key is missing, malformed, expired, or revoked.",
  status: 401,
  title: "Invalid credentials",
  type: "https://docs.normal.fast/problems/invalid_credentials",
};

const jsonSchema = (schema: {
  readonly jsonSchema: unknown;
}): Record<string, unknown> => schema.jsonSchema as Record<string, unknown>;

export const generateOpenApiDocument = (): Record<string, unknown> => ({
  openapi: "3.1.0",
  info: {
    description: [
      "Normal's public REST API for one User's server-side personal automations.",
      "",
      "Authenticate with `Authorization: Bearer <API Key>`. API Keys are server-side credentials: do not put them in browsers, mobile apps, query parameters, or cookies.",
      "",
      "Each key grants an explicit non-empty subset of `connections:read`, `directory:read`, `messages:read`, and `messages:send` over explicitly selected WhatsApp Connections. Send permission never implies Directory or Stored Message read permission.",
      "",
      "Errors use RFC 9457 Problem Details with a stable Normal `code`. Invalid credentials return 401, missing permission returns 403, and unknown, cross-tenant, deleted, or mismatched resources share a constant-shape 404.",
    ].join("\n"),
    title: "Normal API",
    version: REST_API_VERSION,
  },
  servers: [{ url: "https://api.normal.fast" }],
  security: [{ apiKey: [] }],
  tags: [
    {
      description:
        "WhatsApp Connections explicitly selected for the calling API Key.",
      name: "Connections",
    },
  ],
  paths: {
    "/v1/connections": {
      get: {
        description: restRouteRegistry[0].description,
        operationId: restRouteRegistry[0].operationId,
        responses: {
          "200": {
            content: {
              "application/json": {
                example: connectionListExample,
                schema: { $ref: "#/components/schemas/ConnectionList" },
              },
            },
            description: "Selected non-deleted WhatsApp Connections.",
          },
          "401": {
            content: {
              "application/problem+json": {
                example: problemExample,
                schema: { $ref: "#/components/schemas/ProblemDetails" },
              },
            },
            description:
              "The API Key is missing, malformed, expired, or revoked.",
          },
          "403": {
            content: {
              "application/problem+json": {
                schema: { $ref: "#/components/schemas/ProblemDetails" },
              },
            },
            description: "The API Key does not include `connections:read`.",
          },
          "429": {
            content: {
              "application/problem+json": {
                schema: { $ref: "#/components/schemas/ProblemDetails" },
              },
            },
            description:
              "Personal Account or API Key request quota is exhausted.",
          },
          "503": {
            content: {
              "application/problem+json": {
                schema: { $ref: "#/components/schemas/ProblemDetails" },
              },
            },
            description: "Authentication or audit authority is unavailable.",
          },
        },
        security: [{ apiKey: [] }],
        summary: restRouteRegistry[0].summary,
        tags: [...restRouteRegistry[0].tags],
        "x-normal-permission": restRouteRegistry[0].permission,
      },
    },
  },
  components: {
    schemas: {
      ConnectionList: jsonSchema(RestConnectionListContract),
      ProblemDetails: jsonSchema(ProblemDetailsContract),
    },
    securitySchemes: {
      apiKey: {
        bearerFormat: "API Key",
        description:
          "A `normal_apk_` split credential shown once at creation. Send it as `Authorization: Bearer <credential>`.",
        scheme: "bearer",
        type: "http",
      },
    },
  },
});

export const openApiDocument = generateOpenApiDocument();
