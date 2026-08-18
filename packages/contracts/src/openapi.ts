import type { API_KEY_PERMISSIONS } from "./api-key";
import {
  ProblemDetailsContract,
  RestConnectionListContract,
  RestContactListContract,
  RestConversationListContract,
  RestCreateSendOperationContract,
  RestGroupListContract,
  RestMessageListContract,
  RestSendOperationContract,
} from "./rest";

export const REST_API_VERSION = "1.0.0";

export interface RestRouteMetadata {
  readonly description: string;
  readonly method: "GET" | "POST";
  readonly operationId: string;
  readonly path:
    | "/v1/connections"
    | "/v1/connections/{connection_id}/contacts"
    | "/v1/connections/{connection_id}/groups"
    | "/v1/connections/{connection_id}/conversations"
    | "/v1/connections/{connection_id}/conversations/{conversation_id}/messages"
    | "/v1/connections/{connection_id}/messages/{message_id}/media/{media_id}"
    | "/v1/connections/{connection_id}/send-operations";
  readonly permission: (typeof API_KEY_PERMISSIONS)[number];
  readonly summary: string;
  readonly tags:
    | readonly ["Connections"]
    | readonly ["Conversations"]
    | readonly ["Directory"]
    | readonly ["Messages"]
    | readonly ["Send Operations"];
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
      "Page currently joined WhatsApp groups for one explicitly selected WhatsApp Connection. Search accepts a display-name prefix of three to 64 characters. Responses include projection freshness and never return a roster, description, or provider identifier. `group_id` is a WhatsApp Recipient handle and cannot be used as a WhatsApp Conversation handle. Cursors bind the calling API Key, this operation, the Connection, normalized filters, limit, and sort version, and expire after 15 minutes.",
    method: "GET",
    operationId: "listGroups",
    path: "/v1/connections/{connection_id}/groups",
    permission: "directory:read",
    summary: "Page joined WhatsApp groups",
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
  {
    description:
      "Page complete retained Stored Messages for one WhatsApp Conversation owned by an explicitly selected WhatsApp Connection. The newest page is selected first; records inside each page are chronological. The REST cursor supports deterministic older traversal and binds the calling API Key, this operation, the Connection, conversation, limit, and sort version for 15 minutes. Responses include complete retained text, Deleted Message Tombstones, sender metadata, the Message History Window, and intersecting Ingestion Gaps. The encoded JSON response never exceeds 1 MiB: the server returns fewer records rather than truncating or splitting a Stored Message. Eligible Stored Media is represented by an authenticated nested path, never an MCP URI or public URL.",
    method: "GET",
    operationId: "listMessages",
    path: "/v1/connections/{connection_id}/conversations/{conversation_id}/messages",
    permission: "messages:read",
    summary: "Page complete Stored Messages",
    tags: ["Messages"],
  },
  {
    description:
      "Read one eligible Stored Media object for an explicitly selected WhatsApp Connection. The nested path is authenticated, non-listable, and never a public, provider, R2, or presigned URL. v1 returns the complete object after Activity Log admission and full verified-byte quota reservation. Ready media larger than 16 MiB, non-ready media, unknown or mismatched handles, Recipient Exclusions, and unauthorized grants share one constant-shape 404. Range, chunk, and alternate download URLs are not provided.",
    method: "GET",
    operationId: "getStoredMedia",
    path: "/v1/connections/{connection_id}/messages/{message_id}/media/{media_id}",
    permission: "messages:read",
    summary: "Read authenticated Stored Media",
    tags: ["Messages"],
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

const groupListExample = {
  data: [
    {
      group_id: "grp_xxxxxxxxxxxxxxxxxxxxx",
      display_name: "Family",
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

const messageListExample = {
  data: [
    {
      content_type: "image",
      deleted: false,
      direction: "inbound",
      edited_at: null,
      media: {
        file_name: "photo.jpg",
        media_id: "med_xxxxxxxxxxxxxxxxxxxxx",
        mime_type: "image/jpeg",
        path: "/v1/connections/con_xxxxxxxxxxxxxxxxxxxxx/messages/msg_xxxxxxxxxxxxxxxxxxxxx/media/med_xxxxxxxxxxxxxxxxxxxxx",
        size_bytes: 245123,
        state: "ready",
        type: "image",
        unavailable_reason: null,
      },
      message_id: "msg_xxxxxxxxxxxxxxxxxxxxx",
      sender: {
        display_name: "Ada",
        kind: "contact",
        phone_last_four: "0199",
      },
      sent_at: "2026-08-14T11:58:00.000Z",
      text: "A caption",
    },
  ],
  meta: {
    conversation_id: "cvs_xxxxxxxxxxxxxxxxxxxxx",
    gaps: [
      {
        cause: "connection_unavailable",
        ends_at: "2026-08-14T11:08:00.000Z",
        starts_at: "2026-08-14T11:00:00.000Z",
      },
    ],
    history_start_reason: "retention_policy",
    history_starts_at: "2026-07-15T12:00:00.000Z",
    kind: "direct",
    recipient_id: "ctc_xxxxxxxxxxxxxxxxxxxxx",
    size_limited: false,
  },
  pagination: {
    has_more: true,
    next_cursor: "opaque-rest-cursor",
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
        "WhatsApp Directory contacts and groups for one selected WhatsApp Connection.",
      name: "Directory",
    },
    {
      description:
        "WhatsApp Conversations with observed Stored Message activity for one selected WhatsApp Connection.",
      name: "Conversations",
    },
    {
      description:
        "Complete retained Stored Messages for one WhatsApp Conversation. REST pages are not constrained by MCP's duplicated-text response cap.",
      name: "Messages",
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
    "/v1/connections/{connection_id}/groups": {
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
              "Group display-name prefix of three to 64 characters after normalization.",
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
                example: groupListExample,
                schema: { $ref: "#/components/schemas/GroupList" },
              },
            },
            description: "A page of currently joined WhatsApp groups.",
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
        summary: restRouteRegistry[2].summary,
        tags: [...restRouteRegistry[2].tags],
        "x-normal-permission": restRouteRegistry[2].permission,
      },
    },
    "/v1/connections/{connection_id}/conversations": {
      get: {
        description: restRouteRegistry[3].description,
        operationId: restRouteRegistry[3].operationId,
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
        summary: restRouteRegistry[3].summary,
        tags: [...restRouteRegistry[3].tags],
        "x-normal-permission": restRouteRegistry[3].permission,
      },
    },
    "/v1/connections/{connection_id}/conversations/{conversation_id}/messages":
      {
        get: {
          description: restRouteRegistry[4].description,
          operationId: restRouteRegistry[4].operationId,
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
                "Opaque handle of a WhatsApp Conversation owned by that Connection.",
              in: "path",
              name: "conversation_id",
              required: true,
              schema: { type: "string", pattern: "^cvs_[A-Za-z0-9_-]{21}$" },
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
                "Opaque REST cursor from a prior call with identical bound inputs. Traverses older Stored Messages.",
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
                  example: messageListExample,
                  schema: { $ref: "#/components/schemas/MessageList" },
                },
              },
              description:
                "A chronological page of complete retained Stored Messages, newest page first.",
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
                "The WhatsApp Connection or Conversation is unknown, unselected, deleted, excluded, or not visible to this key.",
            },
            "429": {
              content: {
                "application/problem+json": {
                  schema: { $ref: "#/components/schemas/ProblemDetails" },
                },
              },
              description:
                "Personal Account request or returned-record quota is exhausted.",
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
          summary: restRouteRegistry[4].summary,
          tags: [...restRouteRegistry[4].tags],
          "x-normal-permission": restRouteRegistry[4].permission,
        },
      },
    "/v1/connections/{connection_id}/messages/{message_id}/media/{media_id}": {
      get: {
        description: restRouteRegistry[5].description,
        operationId: restRouteRegistry[5].operationId,
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
              "Opaque handle of the Stored Message that owns the Stored Media.",
            in: "path",
            name: "message_id",
            required: true,
            schema: { type: "string", pattern: "^msg_[A-Za-z0-9_-]{21}$" },
          },
          {
            description: "Opaque handle of the Stored Media object.",
            in: "path",
            name: "media_id",
            required: true,
            schema: { type: "string", pattern: "^med_[A-Za-z0-9_-]{21}$" },
          },
        ],
        responses: {
          "200": {
            content: {
              "*/*": {
                schema: { type: "string", format: "binary" },
              },
            },
            description:
              "Ready Stored Media no larger than 16 MiB, returned with the normalized MIME type, a sanitized optional filename, and private no-store caching.",
            headers: {
              "Cache-Control": {
                description:
                  "Protected media is private and must not be stored.",
                schema: { type: "string", const: "private, no-store" },
              },
              "Content-Disposition": {
                description:
                  "`attachment` with a sanitized filename when one is available.",
                schema: { type: "string" },
              },
              "Content-Type": {
                description: "Normalized MIME type of the Stored Media.",
                schema: { type: "string" },
              },
            },
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
              "The Connection, Stored Message, or Stored Media is unknown, unselected, deleted, excluded, mismatched, not ready, or larger than 16 MiB.",
          },
          "429": {
            content: {
              "application/problem+json": {
                schema: { $ref: "#/components/schemas/ProblemDetails" },
              },
            },
            description:
              "Personal Account request or decrypted-media-byte quota is exhausted.",
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
        summary: restRouteRegistry[5].summary,
        tags: [...restRouteRegistry[5].tags],
        "x-normal-permission": restRouteRegistry[5].permission,
      },
    },
    "/v1/connections/{connection_id}/send-operations": {
      post: {
        description: restRouteRegistry[6].description,
        operationId: restRouteRegistry[6].operationId,
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
        summary: restRouteRegistry[6].summary,
        tags: [...restRouteRegistry[6].tags],
        "x-normal-permission": restRouteRegistry[6].permission,
      },
    },
  },
  components: {
    schemas: {
      ConnectionList: jsonSchema(RestConnectionListContract),
      ContactList: jsonSchema(RestContactListContract),
      ConversationList: jsonSchema(RestConversationListContract),
      CreateSendOperation: jsonSchema(RestCreateSendOperationContract),
      GroupList: jsonSchema(RestGroupListContract),
      MessageList: jsonSchema(RestMessageListContract),
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
