import type { API_KEY_PERMISSIONS } from "./api-key";
import {
  ProblemDetailsContract,
  RestConnectionListContract,
  RestCreateSendOperationContract,
  RestSendOperationContract,
} from "./rest";

export const REST_API_VERSION = "1.0.0";

export interface RestRouteMetadata {
  readonly description: string;
  readonly method: "GET" | "POST";
  readonly operationId: string;
  readonly path:
    | "/v1/connections"
    | "/v1/connections/{connection_id}/send-operations";
  readonly permission: (typeof API_KEY_PERMISSIONS)[number];
  readonly summary: string;
  readonly tags: readonly ["Connections"] | readonly ["Send Operations"];
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
  {
    description:
      "Create or exactly replay one text Send Operation for a known active `ctc_` or joined `grp_` recipient. Requires `Idempotency-Key`. Raw phone numbers, provider identifiers, conversation identifiers, and self-attested confirmation flags are not accepted. Exact replay returns the existing operation without resending. Failed and unknown post-boundary outcomes remain Send Operation resources.",
    method: "POST",
    operationId: "createSendOperation",
    path: "/v1/connections/{connection_id}/send-operations",
    permission: "messages:send",
    summary: "Create or replay a text Send Operation",
    tags: ["Send Operations"],
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

const sendOperationExample = {
  send_id: "snd_xxxxxxxxxxxxxxxxxxxxx",
  status: "processing",
  created_at: "2026-08-17T12:00:00.000Z",
  status_changed_at: "2026-08-17T12:00:00.000Z",
  idempotent_replay: false,
};

const createSendOperationExample = {
  recipient_id: "ctc_xxxxxxxxxxxxxxxxxxxxx",
  text: "Hello from a server-side automation.",
};

const problemResponse = (description: string) => ({
  content: {
    "application/problem+json": {
      schema: { $ref: "#/components/schemas/ProblemDetails" },
    },
  },
  description,
});

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
    {
      description:
        "Idempotent text Send Operations created by the calling API Key. Creating a Send Operation is the caller's explicit action; Client Confirmation is MCP-specific and is not a REST field.",
      name: "Send Operations",
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
    "/v1/connections/{connection_id}/send-operations": {
      post: {
        description: restRouteRegistry[1].description,
        operationId: restRouteRegistry[1].operationId,
        parameters: [
          {
            description:
              "WhatsApp Connection explicitly selected for the calling API Key.",
            in: "path",
            name: "connection_id",
            required: true,
            schema: { type: "string", pattern: "^con_[A-Za-z0-9_-]{21}$" },
          },
          {
            description:
              "Caller-generated NanoID-default-alphabet retry identity. Exact replay returns the existing Send Operation. A changed payload returns `idempotency_conflict`.",
            in: "header",
            name: "Idempotency-Key",
            required: true,
            schema: { type: "string", pattern: "^[A-Za-z0-9_-]{21}$" },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              example: createSendOperationExample,
              schema: { $ref: "#/components/schemas/CreateSendOperation" },
            },
          },
          required: true,
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                example: {
                  ...sendOperationExample,
                  idempotent_replay: true,
                },
                schema: { $ref: "#/components/schemas/SendOperation" },
              },
            },
            description:
              "Exact replay of an existing Send Operation. The provider is not called again.",
          },
          "201": {
            content: {
              "application/json": {
                example: sendOperationExample,
                schema: { $ref: "#/components/schemas/SendOperation" },
              },
            },
            description:
              "A new Send Operation after the durable provider-attempt boundary, including `failed` and `unknown`.",
          },
          "400": problemResponse(
            "The request body or `Idempotency-Key` is missing or invalid.",
          ),
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
          "403": problemResponse(
            "The API Key does not include `messages:send`.",
          ),
          "404": problemResponse(
            "The Connection, recipient, or originating grant relationship was not found.",
          ),
          "409": problemResponse(
            "The Idempotency-Key is bound to a different payload, or the Connection is not connected.",
          ),
          "429": problemResponse(
            "Personal Account or API Key request or send quota is exhausted.",
          ),
          "503": problemResponse(
            "Authentication or audit authority is unavailable.",
          ),
        },
        security: [{ apiKey: [] }],
        summary: restRouteRegistry[1].summary,
        tags: [...restRouteRegistry[1].tags],
        "x-normal-permission": restRouteRegistry[1].permission,
      },
    },
  },
  components: {
    schemas: {
      ConnectionList: jsonSchema(RestConnectionListContract),
      CreateSendOperation: jsonSchema(RestCreateSendOperationContract),
      ProblemDetails: jsonSchema(ProblemDetailsContract),
      SendOperation: jsonSchema(RestSendOperationContract),
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
