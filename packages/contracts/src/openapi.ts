import type { API_KEY_PERMISSIONS } from "./api-key";
import {
  ApiKeyListContract,
  ApiKeyRevokeResponseContract,
  CreateApiKeyRequestContract,
  CreatedApiKeyContract,
} from "./api-key";
import { openApiInfoDescription } from "./openapi-guides";
import {
  ProblemDetailsContract,
  RestConnectionListContract,
  RestContactListContract,
  RestConversationListContract,
  RestCreateSendOperationContract,
  RestGroupListContract,
  RestMessageListContract,
  RestSearchMessagesListContract,
  RestSearchMessagesRequestContract,
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
    | "/v1/connections/{connection_id}/messages/search"
    | "/v1/connections/{connection_id}/messages/{message_id}/media/{media_id}"
    | "/v1/connections/{connection_id}/send-operations"
    | "/v1/connections/{connection_id}/send-operations/{send_operation_id}";
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
      "Search retained Stored Messages by exact normalized words in one explicitly selected WhatsApp Connection. The closed POST body is the only place query terms may appear. Terms never enter the URL, Activity Logs, telemetry, Problem Details, or the REST cursor. The cursor binds a keyed digest of the normalized terms, this API Key, operation, Connection, optional conversation, direction, time range, limit, and sort version for 15 minutes. Results reuse keyed exact-word indexes and plaintext verification, include search coverage and intersecting Ingestion Gaps, and contain no Stored Media. Search remains capped at 20 records. The encoded JSON response never exceeds 1 MiB: the server returns fewer complete records rather than truncating text.",
    method: "POST",
    operationId: "searchMessages",
    path: "/v1/connections/{connection_id}/messages/search",
    permission: "messages:read",
    summary: "Search Stored Messages privately",
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
  {
    description:
      "Read local Send Status for one Send Operation created by the same still-active API Key. Requires current `messages:send` and the selected WhatsApp Connection. Replacement, separately authorized, expired, revoked, cross-Connection, deleted, and unknown handles share one constant-shape 404. The read is local: it never calls the provider or implies delivery beyond current evidence. Request quota and Activity Log admission apply; send quota does not.",
    method: "GET",
    operationId: "getSendStatus",
    path: "/v1/connections/{connection_id}/send-operations/{send_operation_id}",
    permission: "messages:send",
    summary: "Read originating Send Status",
    tags: ["Send Operations"],
  },
] as const satisfies ReadonlyArray<RestRouteMetadata>;

export interface ApiKeyManagementRouteMetadata {
  readonly description: string;
  readonly method: "DELETE" | "GET" | "POST";
  readonly operationId: string;
  readonly path: "/v1/api-keys" | "/v1/api-keys/{api_key_id}";
  readonly summary: string;
  readonly tags: readonly ["API Keys"];
}

export const apiKeyManagementRouteRegistry = [
  {
    description:
      "Create one named API Key for a signed-in User. Requires the exact web Origin, a Clerk bearer token, and first-factor verification within five minutes. The plaintext `normal_apk_` credential is returned only in this response. Grants are immutable after creation.",
    method: "POST",
    operationId: "createApiKey",
    path: "/v1/api-keys",
    summary: "Create an API Key",
    tags: ["API Keys"],
  },
  {
    description:
      "List safe API Key metadata retained within the 90-day history window. Plaintext credentials are never redisplayed. Requires an active signed-in session and the exact web Origin.",
    method: "GET",
    operationId: "listApiKeys",
    path: "/v1/api-keys",
    summary: "List API Key metadata",
    tags: ["API Keys"],
  },
  {
    description:
      "Permanently revoke one API Key owned by the signed-in User. Revocation is idempotent, clears the credential digest immediately, and takes effect on the next request. Requires an active signed-in session and the exact web Origin.",
    method: "DELETE",
    operationId: "revokeApiKey",
    path: "/v1/api-keys/{api_key_id}",
    summary: "Revoke an API Key",
    tags: ["API Keys"],
  },
] as const satisfies ReadonlyArray<ApiKeyManagementRouteMetadata>;

export const documentedRouteRegistries = {
  apiKeyManagement: apiKeyManagementRouteRegistry,
  rest: restRouteRegistry,
} as const;

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

const searchMessagesRequestExample = {
  query: "invoice",
  limit: 20,
};

const searchMessagesListExample = {
  data: [
    {
      content_type: "text",
      conversation_id: "cvs_xxxxxxxxxxxxxxxxxxxxx",
      direction: "inbound",
      edited_at: null,
      message_id: "msg_xxxxxxxxxxxxxxxxxxxxx",
      sent_at: "2026-08-14T11:58:00.000Z",
      text: "The invoice is attached.",
    },
  ],
  meta: {
    backfill_complete: true,
    gaps: [
      {
        cause: "connection_unavailable",
        ends_at: "2026-08-14T11:08:00.000Z",
        starts_at: "2026-08-14T11:00:00.000Z",
      },
    ],
    history_start_reason: "retention_policy",
    history_starts_at: "2026-07-15T12:00:00.000Z",
    index_version: "v1",
    partial: true,
    partial_reasons: ["ingestion_gap"],
    searchable_history_starts_at: "2026-07-15T12:00:00.000Z",
    size_limited: false,
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

const apiKeySummaryExample = {
  connection_ids: ["con_xxxxxxxxxxxxxxxxxxxxx"],
  created_at: "2026-08-14T12:00:00.000Z",
  credential_hint: "normal_apk_xxxxxxxxxxxxxxxxxxxxx.…wxyz",
  expires_at: null,
  id: "apk_xxxxxxxxxxxxxxxxxxxxx",
  last_used_at: null,
  name: "Nightly backup",
  permissions: ["connections:read", "directory:read"],
  revoked_at: null,
  state: "active",
};

const createdApiKeyExample = {
  ...apiKeySummaryExample,
  credential: "normal_apk_<public-handle>.<secret-shown-once>",
};

const apiKeyListExample = {
  api_keys: [apiKeySummaryExample],
};

const apiKeyRevokeExample = {
  api_key: {
    id: "apk_xxxxxxxxxxxxxxxxxxxxx",
    revoked_at: "2026-08-14T13:00:00.000Z",
    state: "revoked",
  },
};

const createApiKeyExample = {
  connection_ids: ["con_xxxxxxxxxxxxxxxxxxxxx"],
  name: "Nightly backup",
  permissions: ["connections:read", "directory:read"],
};

const managementErrorExample = {
  error: "not_found",
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

const managementJsonResponse = (description: string, schemaRef: string) => ({
  content: {
    "application/json": {
      schema: { $ref: schemaRef },
    },
  },
  description,
});

export const generateOpenApiDocument = (): Record<string, unknown> => ({
  openapi: "3.1.0",
  info: {
    description: openApiInfoDescription,
    title: "Normal API",
    version: REST_API_VERSION,
  },
  servers: [{ url: "https://api.normal.fast" }],
  security: [{ apiKey: [] }],
  tags: [
    {
      description:
        "Signed-in product routes for creating, listing, and revoking API Keys. They require a Clerk bearer token and the exact web Origin. They are not authenticated with an API Key and must not be called from a server-side automation.",
      name: "API Keys",
    },
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
        "Complete retained Stored Messages, private exact-word search, and authenticated Stored Media for one selected WhatsApp Connection. REST pages are not constrained by MCP's duplicated-text response cap. Search terms are accepted only in a closed POST body.",
      name: "Messages",
    },
    {
      description:
        "Idempotent text Send Operations created by the calling API Key. Creating a Send Operation is the caller's explicit action; Client Confirmation is MCP-specific and is not a REST field.",
      name: "Send Operations",
    },
  ],
  paths: {
    "/v1/api-keys": {
      get: {
        description: apiKeyManagementRouteRegistry[1].description,
        operationId: apiKeyManagementRouteRegistry[1].operationId,
        responses: {
          "200": {
            content: {
              "application/json": {
                example: apiKeyListExample,
                schema: { $ref: "#/components/schemas/ApiKeyList" },
              },
            },
            description:
              "Safe metadata for active, expired, and recently revoked API Keys.",
          },
          "404": {
            content: {
              "application/json": {
                example: managementErrorExample,
                schema: { $ref: "#/components/schemas/ManagementError" },
              },
            },
            description: "The signed-in session is missing or invalid.",
          },
          "503": managementJsonResponse(
            "Identity or persistence authority is unavailable.",
            "#/components/schemas/ManagementError",
          ),
        },
        security: [{ clerkSession: [] }],
        summary: apiKeyManagementRouteRegistry[1].summary,
        tags: [...apiKeyManagementRouteRegistry[1].tags],
      },
      post: {
        description: apiKeyManagementRouteRegistry[0].description,
        operationId: apiKeyManagementRouteRegistry[0].operationId,
        requestBody: {
          content: {
            "application/json": {
              example: createApiKeyExample,
              schema: { $ref: "#/components/schemas/CreateApiKey" },
            },
          },
          required: true,
        },
        responses: {
          "201": {
            content: {
              "application/json": {
                example: createdApiKeyExample,
                schema: { $ref: "#/components/schemas/CreatedApiKey" },
              },
            },
            description:
              "The API Key was created. The `credential` field is the only plaintext copy.",
          },
          "400": managementJsonResponse(
            "The body is invalid, the name is not unique among active keys, the selected Connections are not owned, or the active-key limit is reached.",
            "#/components/schemas/ManagementError",
          ),
          "403": {
            content: {
              "application/json": {
                example: {
                  clerk_error: {
                    metadata: {
                      reverification: {
                        afterMinutes: 5,
                        level: "first_factor",
                      },
                    },
                    reason: "reverification-error",
                    type: "forbidden",
                  },
                },
                schema: { $ref: "#/components/schemas/ReverificationRequired" },
              },
            },
            description:
              "First-factor verification is older than five minutes or missing.",
          },
          "404": managementJsonResponse(
            "The signed-in session is missing or invalid.",
            "#/components/schemas/ManagementError",
          ),
          "503": managementJsonResponse(
            "Identity or persistence authority is unavailable.",
            "#/components/schemas/ManagementError",
          ),
        },
        security: [{ clerkSession: [] }],
        summary: apiKeyManagementRouteRegistry[0].summary,
        tags: [...apiKeyManagementRouteRegistry[0].tags],
      },
    },
    "/v1/api-keys/{api_key_id}": {
      delete: {
        description: apiKeyManagementRouteRegistry[2].description,
        operationId: apiKeyManagementRouteRegistry[2].operationId,
        parameters: [
          {
            description: "Opaque `apk_` handle of the API Key to revoke.",
            in: "path",
            name: "api_key_id",
            required: true,
            schema: { type: "string", pattern: "^apk_[A-Za-z0-9_-]{21}$" },
          },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                example: apiKeyRevokeExample,
                schema: { $ref: "#/components/schemas/ApiKeyRevokeResponse" },
              },
            },
            description:
              "The API Key is revoked and its digest is cleared. Repeating the call for an already revoked key owned by the User also succeeds.",
          },
          "404": managementJsonResponse(
            "The signed-in session is missing or the handle is unknown to this User.",
            "#/components/schemas/ManagementError",
          ),
          "503": managementJsonResponse(
            "Identity or persistence authority is unavailable.",
            "#/components/schemas/ManagementError",
          ),
        },
        security: [{ clerkSession: [] }],
        summary: apiKeyManagementRouteRegistry[2].summary,
        tags: [...apiKeyManagementRouteRegistry[2].tags],
      },
    },
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
    "/v1/connections/{connection_id}/messages/search": {
      post: {
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
        ],
        requestBody: {
          content: {
            "application/json": {
              example: searchMessagesRequestExample,
              schema: { $ref: "#/components/schemas/SearchMessagesRequest" },
            },
          },
          required: true,
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                example: searchMessagesListExample,
                schema: { $ref: "#/components/schemas/SearchMessagesList" },
              },
            },
            description:
              "A newest-first page of exact-word matches with search coverage and intersecting Ingestion Gaps.",
          },
          "400": {
            content: {
              "application/problem+json": {
                schema: { $ref: "#/components/schemas/ProblemDetails" },
              },
            },
            description:
              "The body is closed and invalid, the query has no valid terms, time bounds are inverted, or the cursor is expired, tampered, bound to another grant or query, or an MCP cursor.",
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
        summary: restRouteRegistry[5].summary,
        tags: [...restRouteRegistry[5].tags],
        "x-normal-permission": restRouteRegistry[5].permission,
      },
    },
    "/v1/connections/{connection_id}/messages/{message_id}/media/{media_id}": {
      get: {
        description: restRouteRegistry[6].description,
        operationId: restRouteRegistry[6].operationId,
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
        summary: restRouteRegistry[6].summary,
        tags: [...restRouteRegistry[6].tags],
        "x-normal-permission": restRouteRegistry[6].permission,
      },
    },
    "/v1/connections/{connection_id}/send-operations": {
      post: {
        description: restRouteRegistry[7].description,
        operationId: restRouteRegistry[7].operationId,
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
        summary: restRouteRegistry[7].summary,
        tags: [...restRouteRegistry[7].tags],
        "x-normal-permission": restRouteRegistry[7].permission,
      },
    },
    "/v1/connections/{connection_id}/send-operations/{send_operation_id}": {
      get: {
        description: restRouteRegistry[8].description,
        operationId: restRouteRegistry[8].operationId,
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
              "Send Operation created by the calling still-active API Key.",
            in: "path",
            name: "send_operation_id",
            required: true,
            schema: { type: "string", pattern: "^snd_[A-Za-z0-9_-]{21}$" },
          },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                example: sendOperationExample,
                schema: { $ref: "#/components/schemas/SendOperation" },
              },
            },
            description:
              "Current local Send Status. `idempotent_replay` is false because this is a status read, not a create replay.",
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
          "403": problemResponse(
            "The API Key does not include `messages:send`.",
          ),
          "404": problemResponse(
            "The Send Operation, Connection, or originating grant relationship was not found.",
          ),
          "429": problemResponse(
            "Personal Account or API Key request quota is exhausted.",
          ),
          "503": problemResponse(
            "Authentication or audit authority is unavailable.",
          ),
        },
        security: [{ apiKey: [] }],
        summary: restRouteRegistry[8].summary,
        tags: [...restRouteRegistry[8].tags],
        "x-normal-permission": restRouteRegistry[8].permission,
      },
    },
  },
  components: {
    schemas: {
      ApiKeyList: jsonSchema(ApiKeyListContract),
      ApiKeyRevokeResponse: jsonSchema(ApiKeyRevokeResponseContract),
      ConnectionList: jsonSchema(RestConnectionListContract),
      ContactList: jsonSchema(RestContactListContract),
      ConversationList: jsonSchema(RestConversationListContract),
      CreateApiKey: jsonSchema(CreateApiKeyRequestContract),
      CreateSendOperation: jsonSchema(RestCreateSendOperationContract),
      CreatedApiKey: jsonSchema(CreatedApiKeyContract),
      GroupList: jsonSchema(RestGroupListContract),
      ManagementError: {
        additionalProperties: false,
        properties: {
          error: { type: "string", minLength: 1 },
        },
        required: ["error"],
        type: "object",
      },
      MessageList: jsonSchema(RestMessageListContract),
      ProblemDetails: jsonSchema(ProblemDetailsContract),
      SearchMessagesList: jsonSchema(RestSearchMessagesListContract),
      SearchMessagesRequest: jsonSchema(RestSearchMessagesRequestContract),
      ReverificationRequired: {
        additionalProperties: false,
        properties: {
          clerk_error: {
            additionalProperties: false,
            properties: {
              metadata: {
                additionalProperties: false,
                properties: {
                  reverification: {
                    additionalProperties: false,
                    properties: {
                      afterMinutes: { type: "integer", const: 5 },
                      level: { type: "string", const: "first_factor" },
                    },
                    required: ["afterMinutes", "level"],
                    type: "object",
                  },
                },
                required: ["reverification"],
                type: "object",
              },
              reason: { type: "string", const: "reverification-error" },
              type: { type: "string", const: "forbidden" },
            },
            required: ["metadata", "reason", "type"],
            type: "object",
          },
        },
        required: ["clerk_error"],
        type: "object",
      },
      SendOperation: jsonSchema(RestSendOperationContract),
    },
    securitySchemes: {
      apiKey: {
        bearerFormat: "API Key",
        description:
          "A `normal_apk_` split credential shown once at creation. Send it as `Authorization: Bearer <credential>` from a server. Never place it in a browser, query parameter, or cookie.",
        scheme: "bearer",
        type: "http",
      },
      clerkSession: {
        bearerFormat: "Clerk JWT",
        description:
          "Signed-in product session for API Key management. Requires the exact configured web Origin and a Clerk bearer token. Creation also requires first-factor verification within five minutes. Server-side automations must not call these routes.",
        scheme: "bearer",
        type: "http",
      },
    },
  },
});

export const openApiDocument = generateOpenApiDocument();
