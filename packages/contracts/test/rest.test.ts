import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  ApiKeyListContract,
  ApiKeyRevokeResponseContract,
  CreateApiKeyRequestContract,
  CreatedApiKeyContract,
} from "../src/api-key";
import {
  apiKeyManagementRouteRegistry,
  openApiDocument,
  restRouteRegistry,
} from "../src/openapi";
import { openApiInfoDescription } from "../src/openapi-guides";
import {
  decodeProblemDetails,
  decodeRestConnectionList,
  decodeRestContactList,
  decodeRestConversationList,
  decodeRestCreateSendOperation,
  decodeRestGroupList,
  decodeRestMessageList,
  decodeRestSearchMessagesList,
  decodeRestSearchMessagesRequest,
  decodeRestSendOperation,
  ProblemDetailsContract,
  parseRestStoredMediaPath,
  problemType,
  RestConnectionListContract,
  RestContactListContract,
  RestConversationListContract,
  RestCreateSendOperationContract,
  RestGroupListContract,
  RestMessageListContract,
  RestSearchMessagesListContract,
  RestSearchMessagesRequestContract,
  RestSendOperationContract,
} from "../src/rest";
import { serializedOpenApiDocument } from "../src/write-openapi";

const connectionId = "con_xxxxxxxxxxxxxxxxxxxxx";

const validList = {
  data: [
    {
      connection_id: connectionId,
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
} as const;

describe("REST contracts", () => {
  test("rejects excess collection properties and cross-type handles", () => {
    expect(decodeRestConnectionList(validList) as unknown).toEqual(validList);
    expect(() =>
      decodeRestConnectionList({
        ...validList,
        meta: { secret: "do-not-accept" },
      }),
    ).toThrow();
    expect(() =>
      decodeRestConnectionList({
        ...validList,
        data: [
          {
            ...validList.data[0],
            connection_id: "apk_123456789012345678901",
          },
        ],
      }),
    ).toThrow();
  });

  test("keeps Problem Details closed and snake_case", () => {
    const problem = {
      code: "invalid_credentials",
      detail: "The API Key is missing, malformed, expired, or revoked.",
      status: 401,
      title: "Invalid credentials",
      type: problemType("invalid_credentials"),
    } as const;
    expect(decodeProblemDetails(problem) as unknown).toEqual(problem);
    expect(() =>
      decodeProblemDetails({
        ...problem,
        authorization: "Bearer secret",
      }),
    ).toThrow();
    expect(
      Schema.encodeSync(ProblemDetailsContract.schema)(
        decodeProblemDetails(problem),
      ),
    ).toMatchObject({
      code: "invalid_credentials",
      status: 401,
    });
  });

  test("keeps Directory contact pages closed and suffix-only", () => {
    const contacts = {
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
    } as const;
    expect(decodeRestContactList(contacts) as unknown).toEqual(contacts);
    expect(() =>
      decodeRestContactList({
        ...contacts,
        data: [
          {
            ...contacts.data[0],
            phone_number: "+12025550199",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeRestContactList({
        ...contacts,
        data: [
          {
            ...contacts.data[0],
            contact_id: "con_xxxxxxxxxxxxxxxxxxxxx",
          },
        ],
      }),
    ).toThrow();
  });

  test("keeps Directory group pages closed and distinct from conversation handles", () => {
    const groups = {
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
    } as const;
    expect(decodeRestGroupList(groups) as unknown).toEqual(groups);
    expect(() =>
      decodeRestGroupList({
        ...groups,
        data: [
          {
            ...groups.data[0],
            conversation_id: "cvs_xxxxxxxxxxxxxxxxxxxxx",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeRestGroupList({
        ...groups,
        data: [
          {
            ...groups.data[0],
            group_id: "cvs_xxxxxxxxxxxxxxxxxxxxx",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeRestGroupList({
        ...groups,
        data: [
          {
            ...groups.data[0],
            group_id: "ctc_xxxxxxxxxxxxxxxxxxxxx",
          },
        ],
      }),
    ).toThrow();
  });

  test("keeps conversation pages closed without snippets, unread, or full phones", () => {
    const conversations = {
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
    } as const;
    expect(decodeRestConversationList(conversations) as unknown).toEqual(
      conversations,
    );
    expect(() =>
      decodeRestConversationList({
        ...conversations,
        data: [
          {
            ...conversations.data[0],
            phone: "+12025550199",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeRestConversationList({
        ...conversations,
        data: [
          {
            ...conversations.data[0],
            snippet: "secret",
            unread: true,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeRestConversationList({
        ...conversations,
        data: [
          {
            ...conversations.data[0],
            conversation_id: "ctc_xxxxxxxxxxxxxxxxxxxxx",
          },
        ],
      }),
    ).toThrow();
  });

  test("keeps message pages closed with complete text and authenticated media paths", () => {
    const messages = {
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
            cause: "health_check_failure",
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
    } as const;
    expect(decodeRestMessageList(messages) as unknown).toEqual(messages);
    expect(() =>
      decodeRestMessageList({
        ...messages,
        data: [
          {
            ...messages.data[0],
            text_truncated: true,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeRestMessageList({
        ...messages,
        data: [
          {
            ...messages.data[0],
            media: {
              ...messages.data[0].media,
              resource_uri:
                "whatsapp-media://connections/con_xxxxxxxxxxxxxxxxxxxxx/messages/msg_xxxxxxxxxxxxxxxxxxxxx/media/med_xxxxxxxxxxxxxxxxxxxxx",
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeRestMessageList({
        ...messages,
        data: [
          {
            ...messages.data[0],
            sender: {
              ...messages.data[0].sender,
              phone: "+12025550199",
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeRestMessageList({
        ...messages,
        data: [
          {
            ...messages.data[0],
            media: {
              ...messages.data[0].media,
              path: "https://media.example.test/photo.jpg",
            },
          },
        ],
      }),
    ).toThrow();
    expect(
      parseRestStoredMediaPath(
        "/v1/connections/con_xxxxxxxxxxxxxxxxxxxxx/messages/msg_xxxxxxxxxxxxxxxxxxxxx/media/med_xxxxxxxxxxxxxxxxxxxxx",
      ),
    ).toEqual({
      connectionId: "con_xxxxxxxxxxxxxxxxxxxxx",
      mediaId: "med_xxxxxxxxxxxxxxxxxxxxx",
      messageId: "msg_xxxxxxxxxxxxxxxxxxxxx",
    });
    expect(
      parseRestStoredMediaPath(
        "whatsapp-media://connections/con_xxxxxxxxxxxxxxxxxxxxx/messages/msg_xxxxxxxxxxxxxxxxxxxxx/media/med_xxxxxxxxxxxxxxxxxxxxx",
      ),
    ).toBeNull();
    expect(
      parseRestStoredMediaPath(
        "/v1/connections/con_xxxxxxxxxxxxxxxxxxxxx/messages/msg_xxxxxxxxxxxxxxxxxxxxx/media/med_xxxxxxxxxxxxxxxxxxxxx?download=1",
      ),
    ).toBeNull();
  });

  test("keeps private search request and result contracts closed", () => {
    const request = {
      conversation_id: "cvs_xxxxxxxxxxxxxxxxxxxxx",
      direction: "inbound",
      limit: 20,
      query: "invoice",
    } as const;
    expect(decodeRestSearchMessagesRequest(request) as unknown).toEqual(
      request,
    );
    expect(() =>
      decodeRestSearchMessagesRequest({
        ...request,
        snippet: "do-not-accept",
      }),
    ).toThrow();
    expect(() =>
      decodeRestSearchMessagesRequest({
        query: "invoice",
        conversation_id: "ctc_xxxxxxxxxxxxxxxxxxxxx",
      }),
    ).toThrow();
    expect(() =>
      decodeRestSearchMessagesRequest({
        query: "a".repeat(257),
      }),
    ).toThrow();

    const results = {
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
        gaps: [],
        history_start_reason: "retention_policy",
        history_starts_at: "2026-07-15T12:00:00.000Z",
        index_version: "v1",
        partial: false,
        partial_reasons: [],
        searchable_history_starts_at: "2026-07-15T12:00:00.000Z",
        size_limited: false,
      },
      pagination: {
        has_more: false,
        next_cursor: null,
      },
    } as const;
    expect(decodeRestSearchMessagesList(results) as unknown).toEqual(results);
    expect(() =>
      decodeRestSearchMessagesList({
        ...results,
        data: [
          {
            ...results.data[0],
            text_truncated: true,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeRestSearchMessagesList({
        ...results,
        data: [
          {
            ...results.data[0],
            resource_uri:
              "whatsapp-media://connections/con_xxxxxxxxxxxxxxxxxxxxx/messages/msg_xxxxxxxxxxxxxxxxxxxxx/media/med_xxxxxxxxxxxxxxxxxxxxx",
          },
        ],
      }),
    ).toThrow();
  });

  test("generates a complete OpenAPI 3.1 document with stable operation IDs", () => {
    expect(openApiDocument.openapi).toBe("3.1.0");
    expect(openApiDocument.info).toEqual(
      expect.objectContaining({
        description: openApiInfoDescription,
        title: "Normal API",
      }),
    );
    expect(apiKeyManagementRouteRegistry).toEqual([
      expect.objectContaining({
        method: "POST",
        operationId: "createApiKey",
        path: "/v1/api-keys",
      }),
      expect.objectContaining({
        method: "GET",
        operationId: "listApiKeys",
        path: "/v1/api-keys",
      }),
      expect.objectContaining({
        method: "DELETE",
        operationId: "revokeApiKey",
        path: "/v1/api-keys/{api_key_id}",
      }),
    ]);
    expect(restRouteRegistry).toEqual([
      expect.objectContaining({
        method: "GET",
        operationId: "listConnections",
        path: "/v1/connections",
        permission: "connections:read",
      }),
      expect.objectContaining({
        method: "GET",
        operationId: "listContacts",
        path: "/v1/connections/{connection_id}/contacts",
        permission: "directory:read",
      }),
      expect.objectContaining({
        method: "GET",
        operationId: "listGroups",
        path: "/v1/connections/{connection_id}/groups",
        permission: "directory:read",
      }),
      expect.objectContaining({
        method: "GET",
        operationId: "listConversations",
        path: "/v1/connections/{connection_id}/conversations",
        permission: "messages:read",
      }),
      expect.objectContaining({
        method: "GET",
        operationId: "listMessages",
        path: "/v1/connections/{connection_id}/conversations/{conversation_id}/messages",
        permission: "messages:read",
      }),
      expect.objectContaining({
        method: "POST",
        operationId: "searchMessages",
        path: "/v1/connections/{connection_id}/messages/search",
        permission: "messages:read",
      }),
      expect.objectContaining({
        method: "GET",
        operationId: "getStoredMedia",
        path: "/v1/connections/{connection_id}/messages/{message_id}/media/{media_id}",
        permission: "messages:read",
      }),
      expect.objectContaining({
        method: "POST",
        operationId: "createSendOperation",
        path: "/v1/connections/{connection_id}/send-operations",
        permission: "messages:send",
      }),
      expect.objectContaining({
        method: "GET",
        operationId: "getSendStatus",
        path: "/v1/connections/{connection_id}/send-operations/{send_operation_id}",
        permission: "messages:send",
      }),
    ]);
    const serialized = serializedOpenApiDocument();
    expect(serialized).toBe(`${JSON.stringify(openApiDocument, null, 2)}\n`);
    expect(serialized).toContain('"operationId": "createApiKey"');
    expect(serialized).toContain('"operationId": "listApiKeys"');
    expect(serialized).toContain('"operationId": "revokeApiKey"');
    expect(serialized).toContain('"operationId": "listConnections"');
    expect(serialized).toContain('"operationId": "listContacts"');
    expect(serialized).toContain('"operationId": "listGroups"');
    expect(serialized).toContain('"operationId": "listConversations"');
    expect(serialized).toContain('"operationId": "listMessages"');
    expect(serialized).toContain('"operationId": "searchMessages"');
    expect(serialized).toContain('"operationId": "getStoredMedia"');
    expect(serialized).toContain('"operationId": "createSendOperation"');
    expect(serialized).toContain('"operationId": "getSendStatus"');
    expect(serialized).toContain(
      "/v1/connections/{connection_id}/conversations/{conversation_id}/messages",
    );
    expect(serialized).toContain(
      "/v1/connections/{connection_id}/messages/search",
    );
    expect(serialized).toContain(
      "/v1/connections/{connection_id}/messages/{message_id}/media/{media_id}",
    );
    expect(serialized).toContain(
      "/v1/connections/{connection_id}/send-operations/{send_operation_id}",
    );
    expect(serialized).toContain(
      "/v1/connections/con_xxxxxxxxxxxxxxxxxxxxx/messages/msg_xxxxxxxxxxxxxxxxxxxxx/media/med_xxxxxxxxxxxxxxxxxxxxx",
    );
    expect(serialized).toContain("private, no-store");
    expect(serialized).toContain('"format": "binary"');
    expect(serialized).not.toContain("whatsapp-media://");
    expect(serialized).not.toContain("text_truncated");
    expect(serialized).toContain('"Idempotency-Key"');
    expect(serialized).toContain('"type": "http"');
    expect(serialized).toContain('"scheme": "bearer"');
    expect(serialized).toContain("con_xxxxxxxxxxxxxxxxxxxxx");
    expect(serialized).toContain("ctc_xxxxxxxxxxxxxxxxxxxxx");
    expect(serialized).toContain("grp_xxxxxxxxxxxxxxxxxxxxx");
    expect(serialized).toContain("cvs_xxxxxxxxxxxxxxxxxxxxx");
    expect(serialized).not.toMatch(
      /normal_apk_[A-Za-z0-9_-]{21}\.[A-Za-z0-9_-]+/u,
    );
    expect(serialized).not.toContain("confirmed");
    expect(serialized).not.toContain("+1555");
    expect(serialized).not.toContain("+12025550199");
    expect(serialized).not.toContain("tools/call");
    expect(serialized).not.toContain("structuredContent");
    expect(serialized).not.toContain("list_chats");
    expect(serialized).toContain('"clerkSession"');
    expect(serialized).toContain("/v1/api-keys/{api_key_id}");
    expect(serialized).toContain("Restore invalidation");
    expect(serialized).toContain("Problem Details");
    expect(serialized).toContain("Idempotency-Key");
    expect(serialized).toContain("Message History Window");
    expect(serialized).toContain("Recipient Exclusions");
    expect(serialized).not.toContain("cdn.jsdelivr.net");
    expect(serialized).not.toContain("proxy.scalar.com");
    const schemas = (
      openApiDocument.components as { schemas: Record<string, unknown> }
    ).schemas;
    expect(schemas.ConnectionList).toEqual(
      RestConnectionListContract.jsonSchema,
    );
    expect(schemas.ContactList).toEqual(RestContactListContract.jsonSchema);
    expect(schemas.ConversationList).toEqual(
      RestConversationListContract.jsonSchema,
    );
    expect(schemas.MessageList).toEqual(RestMessageListContract.jsonSchema);
    expect(schemas.SearchMessagesList).toEqual(
      RestSearchMessagesListContract.jsonSchema,
    );
    expect(schemas.SearchMessagesRequest).toEqual(
      RestSearchMessagesRequestContract.jsonSchema,
    );
    expect(schemas.CreateSendOperation).toEqual(
      RestCreateSendOperationContract.jsonSchema,
    );
    expect(schemas.GroupList).toEqual(RestGroupListContract.jsonSchema);
    expect(schemas.SendOperation).toEqual(RestSendOperationContract.jsonSchema);
    expect(schemas.ApiKeyList).toEqual(ApiKeyListContract.jsonSchema);
    expect(schemas.ApiKeyRevokeResponse).toEqual(
      ApiKeyRevokeResponseContract.jsonSchema,
    );
    expect(schemas.CreateApiKey).toEqual(
      CreateApiKeyRequestContract.jsonSchema,
    );
    expect(schemas.CreatedApiKey).toEqual(CreatedApiKeyContract.jsonSchema);
  });

  test("keeps the committed OpenAPI artifact identical to the generator", async () => {
    const artifact = await Bun.file(
      new URL("../../../apps/docs/public/openapi.json", import.meta.url),
    ).text();
    expect(artifact).toBe(serializedOpenApiDocument());
  });

  test("accepts exactly one supported Send Operation destination", () => {
    const created = {
      recipient_id: "ctc_xxxxxxxxxxxxxxxxxxxxx",
      text: " exact\ne\u0301 ",
    } as const;
    expect(decodeRestCreateSendOperation(created) as unknown).toEqual(created);
    expect(
      decodeRestCreateSendOperation({
        recipient_id: "grp_xxxxxxxxxxxxxxxxxxxxx",
        text: "hello",
      }) as unknown,
    ).toEqual({
      recipient_id: "grp_xxxxxxxxxxxxxxxxxxxxx",
      text: "hello",
    });
    expect(
      decodeRestCreateSendOperation({
        phone: "+12",
        text: "hello",
      }) as unknown,
    ).toEqual({ phone: "+12", text: "hello" });
    expect(
      decodeRestCreateSendOperation({
        username: "@jane_doe",
        text: "hello",
      }) as unknown,
    ).toEqual({ username: "@jane_doe", text: "hello" });
    expect(() =>
      decodeRestCreateSendOperation({
        ...created,
        confirmed: true,
      }),
    ).toThrow();
    expect(() =>
      decodeRestCreateSendOperation({
        ...created,
        conversation_id: "cvs_xxxxxxxxxxxxxxxxxxxxx",
      }),
    ).toThrow();
    expect(() =>
      decodeRestCreateSendOperation({
        phone: "15551234567",
        text: "hello",
      }),
    ).toThrow();
    expect(() =>
      decodeRestCreateSendOperation({
        username: "jane_doe",
        text: "hello",
      }),
    ).toThrow();
    expect(() =>
      decodeRestCreateSendOperation({
        recipient_id: created.recipient_id,
        phone: "+15551234567",
        text: "hello",
      }),
    ).toThrow();
    expect(() =>
      decodeRestCreateSendOperation({
        phone: "+15551234567",
        text: "hello",
        username: "@jane_doe",
      }),
    ).toThrow();
    expect(() =>
      decodeRestCreateSendOperation({
        recipient_id: "120363123456789012@g.us",
        text: "hello",
      }),
    ).toThrow();
    expect(() =>
      decodeRestCreateSendOperation({
        recipient_id: "cvs_xxxxxxxxxxxxxxxxxxxxx",
        text: "hello",
      }),
    ).toThrow();
    expect(() =>
      decodeRestCreateSendOperation({
        recipient_id: created.recipient_id,
        text: "   \n\t",
      }),
    ).toThrow();

    const receipt = {
      send_id: "snd_xxxxxxxxxxxxxxxxxxxxx",
      status: "unknown",
      created_at: "2026-08-17T12:00:00.000Z",
      status_changed_at: "2026-08-17T12:00:01.000Z",
      idempotent_replay: false,
    } as const;
    expect(decodeRestSendOperation(receipt) as unknown).toEqual(receipt);
    expect(() =>
      decodeRestSendOperation({
        ...receipt,
        text: "do-not-echo",
      }),
    ).toThrow();
  });
});
