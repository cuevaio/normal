import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { openApiDocument, restRouteRegistry } from "../src/openapi";
import {
  decodeProblemDetails,
  decodeRestConnectionList,
  decodeRestContactList,
  decodeRestConversationList,
  decodeRestCreateSendOperation,
  decodeRestSendOperation,
  ProblemDetailsContract,
  problemType,
  RestConnectionListContract,
  RestContactListContract,
  RestConversationListContract,
  RestCreateSendOperationContract,
  RestSendOperationContract,
} from "../src/rest";

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

  test("generates a partial OpenAPI 3.1 document with stable operation IDs", () => {
    expect(openApiDocument.openapi).toBe("3.1.0");
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
        operationId: "listConversations",
        path: "/v1/connections/{connection_id}/conversations",
        permission: "messages:read",
      }),
      expect.objectContaining({
        method: "POST",
        operationId: "createSendOperation",
        path: "/v1/connections/{connection_id}/send-operations",
        permission: "messages:send",
      }),
    ]);
    const serialized = JSON.stringify(openApiDocument);
    expect(serialized).toContain('"operationId":"listConnections"');
    expect(serialized).toContain('"operationId":"listContacts"');
    expect(serialized).toContain('"operationId":"listConversations"');
    expect(serialized).toContain('"operationId":"createSendOperation"');
    expect(serialized).toContain('"Idempotency-Key"');
    expect(serialized).toContain('"type":"http"');
    expect(serialized).toContain('"scheme":"bearer"');
    expect(serialized).toContain("con_xxxxxxxxxxxxxxxxxxxxx");
    expect(serialized).toContain("ctc_xxxxxxxxxxxxxxxxxxxxx");
    expect(serialized).toContain("cvs_xxxxxxxxxxxxxxxxxxxxx");
    expect(serialized).not.toMatch(
      /normal_apk_[A-Za-z0-9_-]{21}\.[A-Za-z0-9_-]+/u,
    );
    expect(serialized).not.toContain("confirmed");
    expect(serialized).not.toContain("+1555");
    expect(serialized).not.toContain("+12025550199");
    expect(serialized).not.toContain("list_chats");
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
    expect(schemas.CreateSendOperation).toEqual(
      RestCreateSendOperationContract.jsonSchema,
    );
    expect(schemas.SendOperation).toEqual(RestSendOperationContract.jsonSchema);
  });

  test("rejects excess Send Operation properties and unaccepted destinations", () => {
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
        recipient_id: "+15551234567",
        text: "hello",
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
