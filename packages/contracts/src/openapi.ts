import type { API_KEY_PERMISSIONS } from "./api-key";
import {
  ProblemDetailsContract,
  RestConnectionListContract,
  RestContactListContract,
  RestConversationListContract,
} from "./rest";

export const REST_API_VERSION = "1.0.0";

export interface RestRouteMetadata {
  readonly description: string;
  readonly method: "GET";
  readonly operationId: string;
  readonly path:
    | "/v1/connections"
    | "/v1/connections/{connection_id}/contacts"
    | "/v1/connections/{connection_id}/conversations";
  readonly permission: (typeof API_KEY_PERMISSIONS)[number];
  readonly summary: string;
  readonly tags:
    | readonly ["Connections"]
    | readonly ["Conversations"]
    | readonly ["Directory"];
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
      "Page active Directory contacts for one explicitly selected WhatsApp Connection. Search accepts a display-name prefix of at least three characters or one exact E.164 number. Responses include projection freshness and never return a full phone number. Cursors bind the calling API Key, this operation, the Connection, normalized filters, limit, and sort version, and expire after 15 minutes.",
    method: "GET",
    operationId: "listContacts",
    path: "/v1/connections/{connection_id}/contacts",
    permission: "directory:read",
    summary: "Page Directory contacts",
    tags: ["Directory"],
  },
  {
    description:
      "Page WhatsApp Conversations with observed Stored Message activity for one explicitly selected WhatsApp Connection. Filter by `kind` (`all`, `direct`, or `group`; default `all`). Results sort by Conversation Activity descending, then conversation handle. Responses include Directory freshness and never return snippets, unread state, provider fields, or a full phone number. Cursors bind the calling API Key, this operation, the Connection, kind filter, limit, and sort version, and expire after 15 minutes.",
    method: "GET",
    operationId: "listConversations",
    path: "/v1/connections/{connection_id}/conversations",
    permission: "messages:read",
    summary: "Page WhatsApp Conversations",
    tags: ["Conversations"],
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

const contactListExample = {
  data: [
    {
      contact_id: "ctc_xxxxxxxxxxxxxxxxxxxxx",
      conversation_id: null,
      display_name: "Ada",
      phone_last_four: "0199",
    },
  ],
  meta: {
    as_of: "2026-08-14T12:00:00.000Z",
    partial: false,
    stale: false,
  },
  pagination: {
    has_more: false,
    next_cursor: null,
  },
};

const conversationListExample = {
  data: [
    {
      conversation_id: "cvs_xxxxxxxxxxxxxxxxxxxxx",
      display_name: "Ada",
      kind: "direct",
      last_activity_at: "2026-08-14T11:59:00.000Z",
      last_activity_direction: "inbound",
      phone_last_four: "0199",
      recipient_id: "ctc_xxxxxxxxxxxxxxxxxxxxx",
    },
  ],
  meta: {
    as_of: "2026-08-14T12:00:00.000Z",
    partial: false,
    stale: false,
  },
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
    {
      description:
        "WhatsApp Directory contacts and groups for one selected WhatsApp Connection.",
      name: "Directory",
    },
    {
      description:
        "WhatsApp Conversations with observed Stored Message activity for one selected WhatsApp Connection.",
      name: "Conversations",
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
    "/v1/connections/{connection_id}/contacts": {
      get: {
        description: restRouteRegistry[1].description,
        operationId: restRouteRegistry[1].operationId,
        parameters: [
          {
            description:
              "Opaque handle of the explicitly selected WhatsApp Connection.",
            in: "path",
            name: "connection_id",
            required: true,
            schema: { type: "string", pattern: "^con_[A-Za-z0-9_-]{21}$" },
          },
          {
            description:
              "Display-name prefix of at least three characters, or one exact E.164 number beginning with `+`.",
            in: "query",
            name: "search",
            required: false,
            schema: { type: "string" },
          },
          {
            description: "Page size from 1 through 50. Defaults to 20.",
            in: "query",
            name: "limit",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
          {
            description:
              "Opaque REST cursor from a prior call with identical bound inputs.",
            in: "query",
            name: "cursor",
            required: false,
            schema: { type: "string", minLength: 1, maxLength: 4096 },
          },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                example: contactListExample,
                schema: { $ref: "#/components/schemas/ContactList" },
              },
            },
            description: "A page of active Directory contacts.",
          },
          "400": {
            content: {
              "application/problem+json": {
                schema: { $ref: "#/components/schemas/ProblemDetails" },
              },
            },
            description:
              "The cursor is expired, tampered, bound to another grant or query, or an MCP cursor.",
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
            description: "The API Key does not include `directory:read`.",
          },
          "404": {
            content: {
              "application/problem+json": {
                schema: { $ref: "#/components/schemas/ProblemDetails" },
              },
            },
            description:
              "The WhatsApp Connection is unknown, unselected, deleted, or not visible to this key.",
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
        summary: restRouteRegistry[1].summary,
        tags: [...restRouteRegistry[1].tags],
        "x-normal-permission": restRouteRegistry[1].permission,
      },
    },
    "/v1/connections/{connection_id}/conversations": {
      get: {
        description: restRouteRegistry[2].description,
        operationId: restRouteRegistry[2].operationId,
        parameters: [
          {
            description:
              "Opaque handle of the explicitly selected WhatsApp Connection.",
            in: "path",
            name: "connection_id",
            required: true,
            schema: { type: "string", pattern: "^con_[A-Za-z0-9_-]{21}$" },
          },
          {
            description:
              "Conversation kind filter. Defaults to `all`. Results still include only conversations with observed Stored Message activity.",
            in: "query",
            name: "kind",
            required: false,
            schema: {
              type: "string",
              enum: ["all", "direct", "group"],
              default: "all",
            },
          },
          {
            description: "Page size from 1 through 50. Defaults to 20.",
            in: "query",
            name: "limit",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
          {
            description:
              "Opaque REST cursor from a prior call with identical bound inputs.",
            in: "query",
            name: "cursor",
            required: false,
            schema: { type: "string", minLength: 1, maxLength: 4096 },
          },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                example: conversationListExample,
                schema: { $ref: "#/components/schemas/ConversationList" },
              },
            },
            description:
              "A page of WhatsApp Conversations with observed Stored Message activity.",
          },
          "400": {
            content: {
              "application/problem+json": {
                schema: { $ref: "#/components/schemas/ProblemDetails" },
              },
            },
            description:
              "The cursor is expired, tampered, bound to another grant or query, or an MCP cursor.",
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
            description: "The API Key does not include `messages:read`.",
          },
          "404": {
            content: {
              "application/problem+json": {
                schema: { $ref: "#/components/schemas/ProblemDetails" },
              },
            },
            description:
              "The WhatsApp Connection is unknown, unselected, deleted, or not visible to this key.",
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
        summary: restRouteRegistry[2].summary,
        tags: [...restRouteRegistry[2].tags],
        "x-normal-permission": restRouteRegistry[2].permission,
      },
    },
  },
  components: {
    schemas: {
      ConnectionList: jsonSchema(RestConnectionListContract),
      ContactList: jsonSchema(RestContactListContract),
      ConversationList: jsonSchema(RestConversationListContract),
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
