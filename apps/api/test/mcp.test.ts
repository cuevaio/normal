import { importCursorSigningKey } from "@whatsapp-mcp/contracts/cursor";
import { ConnectionId } from "@whatsapp-mcp/contracts/handles";
import type {
  BeginProtectedOperationResult,
  McpToolChatPage,
  McpToolGroupPage,
  McpToolMessagePage,
  McpToolMessageSearchPage,
} from "@whatsapp-mcp/db/mcp-tool";
import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import { EnvelopeEncryptionService } from "../src/encryption/envelope";
import { StoredMediaContainerService } from "../src/encryption/stored-media-container";
import type { SendTextMessageResult } from "../src/mcp";
import {
  createMcpRequestHandler,
  McpCursorCodec,
  McpCursorSigning,
  McpToolClock,
  McpToolIdentifiers,
  McpToolPersistence,
  McpToolPersistenceError,
  makeMcpCursorCodec,
  SendTextMessage,
} from "../src/mcp";
import type { SafeTelemetryEvent } from "../src/services";
import { SafeTelemetry } from "../src/services";

const authorization = {
  authorizationId: "40000000-0000-4000-8000-000000000030",
  clientId: "approved-client",
  oauthSubject: "A".repeat(43),
} as const;
const defaultCursorSigningKey = await Effect.runPromise(
  importCursorSigningKey(new Uint8Array(32).fill(17)),
);

const jsonRpcRequest = (
  method: string,
  params?: unknown,
  protocolVersion = "2026-07-28",
) => {
  const parameters =
    typeof params === "object" && params !== null
      ? (params as Record<string, unknown>)
      : {};
  const name = parameters.name;
  const resourceName = parameters.uri;
  return new Request("https://api.example.test/mcp", {
    body: JSON.stringify({
      id: "request-1",
      jsonrpc: "2.0",
      method,
      params: {
        ...parameters,
        ...(protocolVersion === "2026-07-28"
          ? {
              _meta: {
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/protocolVersion": protocolVersion,
              },
            }
          : {}),
      },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      host: "api.example.test",
      "mcp-method": method,
      ...(typeof name === "string"
        ? { "mcp-name": name }
        : typeof resourceName === "string"
          ? { "mcp-name": resourceName }
          : {}),
      "mcp-protocol-version": protocolVersion,
    },
    method: "POST",
  });
};

const executionContext = {
  passThroughOnException: () => undefined,
  waitUntil: () => undefined,
} as unknown as ExecutionContext;

const responseJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(text);
  }
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  return JSON.parse(data ?? "");
};

const responseMessages = async (
  response: Response,
): Promise<Array<Record<string, unknown>>> => {
  const text = await response.text();
  const payloads = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)) as unknown)
    : [JSON.parse(text) as unknown];
  return payloads
    .flatMap((payload) => (Array.isArray(payload) ? payload : [payload]))
    .filter(
      (payload): payload is Record<string, unknown> =>
        typeof payload === "object" && payload !== null,
    );
};

const makeHarness = (
  overrides: {
    readonly beginResult?: BeginProtectedOperationResult;
    readonly chatPage?: McpToolChatPage;
    readonly contactPage?: {
      readonly asOf: string;
      readonly partial: boolean;
      readonly snapshotObservedAt: string | null;
      readonly stale: boolean;
    };
    readonly failBegin?: boolean;
    readonly failComplete?: boolean;
    readonly failInspect?: boolean;
    readonly failReject?: boolean;
    readonly scopes?: ReadonlyArray<
      "connections:read" | "directory:read" | "messages:read" | "messages:send"
    >;
    readonly groupPage?: McpToolGroupPage | null;
    readonly messagePage?: McpToolMessagePage;
    readonly messageSearchPage?: McpToolMessageSearchPage;
    readonly messageSearchHasMore?: boolean;
    readonly cursorKey?: CryptoKey;
    readonly sendResult?: SendTextMessageResult;
    readonly sendStatusNotFound?: boolean;
    readonly tombstone?: boolean;
    readonly mediaRead?: "not_found" | "ready";
  } = {},
) => {
  const observations: Array<string> = [];
  const telemetry: Array<SafeTelemetryEvent> = [];
  const beginTargets: Array<{
    readonly connectionPublicId: string | null;
    readonly sendPublicId: string | null;
    readonly toolName: string;
  }> = [];
  const contactQueries: Array<{
    readonly searchIndex: string | null;
    readonly searchKind: "name" | "phone" | null;
  }> = [];
  const messageSearchQueries: Array<ReadonlyArray<string> | null> = [];
  const layer = Layer.mergeAll(
    Layer.succeed(McpToolClock, {
      now: Effect.succeed(new Date("2026-07-31T12:00:00.000Z")),
    }),
    Layer.succeed(McpToolIdentifiers, {
      nextAuditLogId: Effect.succeed("50000000-0000-4000-8000-000000000030"),
    }),
    Layer.succeed(McpCursorCodec, {
      decode: (input) => {
        if (overrides.cursorKey !== undefined) {
          return makeMcpCursorCodec(overrides.cursorKey).decode(input);
        }
        try {
          return Effect.succeed(
            JSON.parse(atob(input.cursor)) as [string, string],
          );
        } catch {
          return Effect.fail({ _tag: "InvalidCursorError" } as never);
        }
      },
      encode: (input) =>
        overrides.cursorKey === undefined
          ? Effect.succeed(btoa(JSON.stringify(input.boundary)))
          : makeMcpCursorCodec(overrides.cursorKey).encode(input),
    }),
    Layer.succeed(EnvelopeEncryptionService, {
      createConnectionKey: () => Effect.die("not used"),
      createPersonalAccountKey: () => Effect.die("not used"),
      decrypt: ({ ciphertext }) =>
        Effect.succeed(
          Uint8Array.from(atob(ciphertext.ciphertext), (value) =>
            value.charCodeAt(0),
          ),
        ),
      decryptMany: ({ items }) => {
        observations.push("decrypt-many");
        return Effect.succeed(
          items.map(({ ciphertext }) =>
            Uint8Array.from(atob(ciphertext.ciphertext), (value) =>
              value.charCodeAt(0),
            ),
          ),
        );
      },
      encrypt: () => Effect.die("not used"),
    }),
    Layer.succeed(StoredMediaContainerService, {
      read: () => {
        observations.push("decrypt-media-object");
        return Effect.succeed(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("protected bytes"));
              controller.close();
            },
          }),
        );
      },
      write: () => Effect.die("not used"),
    }),
    Layer.succeed(SendTextMessage, {
      send: () =>
        Effect.succeed(
          overrides.sendResult ?? {
            outcome: "receipt" as const,
            receipt: {
              send_id: "snd_123456789012345678901" as never,
              status: "accepted" as const,
              created_at: "2026-08-03T12:00:00.000Z" as never,
              status_changed_at: "2026-08-03T12:00:01.000Z" as never,
              idempotent_replay: false,
            },
          },
        ),
    }),
    Layer.succeed(McpToolPersistence, {
      failStoredMediaRead: () => {
        observations.push("fail-media-read");
        return Effect.void;
      },
      beginProtectedOperation: (input) => {
        observations.push("begin");
        beginTargets.push({
          connectionPublicId: input.connectionPublicId ?? null,
          sendPublicId: input.sendPublicId ?? null,
          toolName: input.operationName,
        });
        if (overrides.failBegin) {
          return Effect.fail(new McpToolPersistenceError());
        }
        if (overrides.beginResult !== undefined) {
          return Effect.succeed(overrides.beginResult);
        }
        const requiredScope =
          input.operationName === "list_connections"
            ? "connections:read"
            : input.operationName === "get_send_status"
              ? "messages:send"
              : input.operationName === "list_chats" ||
                  input.operationName === "read_messages" ||
                  input.operationName === "search_messages"
                ? "messages:read"
                : "directory:read";
        if (
          overrides.scopes !== undefined &&
          !overrides.scopes.includes(requiredScope)
        ) {
          return Effect.succeed({
            auditLogId: "50000000-0000-4000-8000-000000000030",
            outcome: "authorization_denied" as const,
          });
        }
        return Effect.succeed({
          auditLogId: "50000000-0000-4000-8000-000000000030",
          outcome: "started" as const,
        });
      },
      completeProtectedOperation: () => {
        observations.push("complete");
        return overrides.failComplete
          ? Effect.fail(new McpToolPersistenceError())
          : Effect.void;
      },
      completeMessageRecordRead: (input) => {
        observations.push(`complete-message-read:${input.resultCount}`);
        return Effect.succeed({ outcome: "success" as const });
      },
      getSendStatus: () =>
        Effect.succeed(
          overrides.sendStatusNotFound
            ? null
            : {
                createdAt: "2026-08-03T12:00:00.000Z",
                publicId: "snd_123456789012345678901",
                status: "delivered" as const,
                statusChangedAt: "2026-08-03T12:01:00.000Z",
              },
        ),
      inspectAuthorization: () =>
        overrides.failInspect
          ? Effect.fail(new McpToolPersistenceError())
          : Effect.succeed({
              scopes: overrides.scopes ?? ["connections:read"],
            }),
      reserveStoredMediaRead: () => {
        observations.push("reserve-media-read");
        if (overrides.mediaRead !== "ready") return Effect.succeed(null);
        return Effect.succeed({
          accountKey: {
            ciphertext: "AQI=",
            keyVersion: 1,
            kmsKeyId: "kms-content-root",
            personalAccountId: "10000000-0000-4000-8000-000000000030",
            version: 1 as const,
          },
          connectionKey: {
            accountKeyVersion: 1,
            ciphertext: "AQI=",
            connectionId: "20000000-0000-4000-8000-000000000030",
            keyVersion: 1,
            nonce: "AQIDBAUGBwgJCgsM",
            personalAccountId: "10000000-0000-4000-8000-000000000030",
            version: 1 as const,
          },
          mediaId: "30000000-0000-4000-8000-000000000030",
          metadata: {
            ciphertext: btoa(
              JSON.stringify({
                fileName: "../unsafe\r\nname.jpg",
                mimeType: "image/jpeg",
              }),
            ),
            keyVersion: 1,
            nonce: "AQIDBAUGBwgJCgsM",
            version: 1 as const,
          },
          objectKey: "stored-media/opaque-object",
          plaintextSizeBytes: 15,
        });
      },
      loadGroupSearchMaterial: () => {
        observations.push("load-group-search-material");
        return Effect.succeed({
          accountKey: {
            ciphertext: "AQID",
            keyVersion: 1,
            kmsKeyId:
              "arn:aws:kms:us-east-1:111122223333:key/test-content-root",
            personalAccountId: "10000000-0000-4000-8000-000000000039",
            version: 1 as const,
          },
          connectionKey: {
            accountKeyVersion: 1,
            ciphertext: "AQID",
            connectionId: "20000000-0000-4000-8000-000000000039",
            keyVersion: 1,
            nonce: "AQIDBAUGBwgJCgsM",
            personalAccountId: "10000000-0000-4000-8000-000000000039",
            version: 1 as const,
          },
          identityKey: {
            ciphertext: btoa(
              String.fromCharCode(...new Uint8Array(32).fill(39)),
            ),
            keyVersion: 1,
            nonce: "AQIDBAUGBwgJCgsM",
            version: 1 as const,
          },
        });
      },
      listConnections: () => {
        observations.push("list");
        return Effect.succeed([
          {
            accountKey: {
              ciphertext: "AQID",
              keyVersion: 1,
              kmsKeyId: "kms-content-root",
              personalAccountId: "10000000-0000-4000-8000-000000000039",
              version: 1 as const,
            },
            connectionId: "20000000-0000-4000-8000-000000000039",
            connectionKey: {
              accountKeyVersion: 1,
              ciphertext: "AQID",
              connectionId: "20000000-0000-4000-8000-000000000039",
              keyVersion: 1,
              nonce: "AQIDBAUGBwgJCgsM",
              personalAccountId: "10000000-0000-4000-8000-000000000039",
              version: 1 as const,
            },
            displayName: {
              ciphertext: btoa("Personal WhatsApp"),
              keyVersion: 1,
              nonce: "AQIDBAUGBwgJCgsM",
              version: 1 as const,
            },
            displayNameFallback: null,
            numberLastFour: "1234",
            publicId: "con_123456789012345678901",
            state: "connected" as const,
            stateChangedAt: "2026-07-30T12:00:00.000Z",
          },
        ]);
      },
      listChats: () => {
        observations.push("list-chats");
        return Effect.succeed(
          overrides.chatPage ?? {
            accountKey: {
              ciphertext: "AQI=",
              keyVersion: 1,
              kmsKeyId: "kms-content-root",
              personalAccountId: "10000000-0000-4000-8000-000000000030",
              version: 1,
            },
            asOf: "2026-07-31T12:00:00.000Z",
            chats: [],
            connectionKey: {
              accountKeyVersion: 1,
              ciphertext: "AQI=",
              connectionId: "20000000-0000-4000-8000-000000000030",
              keyVersion: 1,
              nonce: "AQIDBAUGBwgJCgsM",
              personalAccountId: "10000000-0000-4000-8000-000000000030",
              version: 1,
            },
            partial: false,
            stale: false,
          },
        );
      },
      readMessages: () => {
        observations.push("read-messages");
        return Effect.succeed({
          outcome: "success" as const,
          page: overrides.messagePage ?? {
            accountKey: {
              ciphertext: "AQI=",
              keyVersion: 1,
              kmsKeyId: "kms-content-root",
              personalAccountId: "10000000-0000-4000-8000-000000000030",
              version: 1 as const,
            },
            connectionKey: {
              accountKeyVersion: 1,
              ciphertext: "AQI=",
              connectionId: "20000000-0000-4000-8000-000000000030",
              keyVersion: 1,
              nonce: "AQIDBAUGBwgJCgsM",
              personalAccountId: "10000000-0000-4000-8000-000000000030",
              version: 1 as const,
            },
            conversation: {
              kind: "direct" as const,
              publicId: "cvs_123456789012345678901",
              recipientId: "ctc_123456789012345678901",
            },
            messages: overrides.tombstone
              ? [
                  {
                    publicId: "msg_333333333333333333333",
                    messageIdentity: `wi1_${"C".repeat(43)}`,
                    sentAt: "2026-07-31T11:59:30.000Z",
                    direction: "inbound" as const,
                    conversationKind: "direct" as const,
                    contentType: "unknown" as const,
                    content: null,
                    editedAt: null,
                    deleted: true,
                    sender: null,
                  },
                ]
              : [
                  {
                    publicId: "msg_222222222222222222222",
                    messageIdentity: `wi1_${"B".repeat(43)}`,
                    sentAt: "2026-07-31T11:59:00.000Z",
                    direction: "inbound" as const,
                    conversationKind: "direct" as const,
                    contentType: "text" as const,
                    content: {
                      ciphertext: btoa(
                        JSON.stringify({ text: "newest", mediaSource: null }),
                      ),
                      keyVersion: 1,
                      nonce: "AQIDBAUGBwgJCgsM",
                      version: 1 as const,
                    },
                    sender: {
                      displayName: {
                        ciphertext: btoa("Ada"),
                        keyVersion: 1,
                        nonce: "AQIDBAUGBwgJCgsM",
                        version: 1 as const,
                      },
                      phone: {
                        ciphertext: btoa("+15550199"),
                        keyVersion: 1,
                        nonce: "AQIDBAUGBwgJCgsM",
                        version: 1 as const,
                      },
                      recordId: `di1_${"B".repeat(43)}`,
                    },
                  },
                  {
                    publicId: "msg_111111111111111111111",
                    messageIdentity: `wi1_${"A".repeat(43)}`,
                    sentAt: "2026-07-31T11:58:00.000Z",
                    direction: "outbound" as const,
                    conversationKind: "direct" as const,
                    contentType: "text" as const,
                    content: {
                      ciphertext: btoa(
                        JSON.stringify({ text: "older", mediaSource: null }),
                      ),
                      keyVersion: 1,
                      nonce: "AQIDBAUGBwgJCgsM",
                      version: 1 as const,
                    },
                    sender: null,
                  },
                ],
            hasOlder: true,
            sizeLimited: false,
            historyStartsAt: "2026-07-01T00:00:00.000Z",
            historyStartReason: "retention_policy" as const,
            gaps: [
              {
                startsAt: "2026-07-15T00:00:00.000Z",
                endsAt: null,
                cause: "processing_failure" as const,
              },
            ],
          },
        });
      },
      searchMessages: (input) => {
        messageSearchQueries.push(input.searchTokens);
        const page = overrides.messageSearchPage ?? {
          accountKey: {
            ciphertext: "AQI=",
            keyVersion: 1,
            kmsKeyId: "kms-content-root",
            personalAccountId: "10000000-0000-4000-8000-000000000030",
            version: 1 as const,
          },
          connectionKey: {
            accountKeyVersion: 1,
            ciphertext: "AQI=",
            connectionId: "20000000-0000-4000-8000-000000000030",
            keyVersion: 1,
            nonce: "AQIDBAUGBwgJCgsM",
            personalAccountId: "10000000-0000-4000-8000-000000000030",
            version: 1 as const,
          },
          messageSearchKey: {
            ciphertext: btoa(
              String.fromCharCode(...new Uint8Array(32).fill(7)),
            ),
            keyVersion: 1,
            nonce: "AQIDBAUGBwgJCgsM",
            version: 1 as const,
          },
          messages:
            input.searchTokens === null
              ? []
              : [
                  {
                    publicId: "msg_222222222222222222222",
                    messageIdentity: `wi1_${"B".repeat(43)}`,
                    conversationPublicId: "cvs_123456789012345678901",
                    sentAt: "2026-07-31T11:59:00.000Z",
                    direction: "inbound" as const,
                    contentType: "text" as const,
                    content: {
                      ciphertext: btoa(
                        JSON.stringify({
                          text: "INVOICE, flight confirmation",
                        }),
                      ),
                      keyVersion: 1,
                      nonce: "AQIDBAUGBwgJCgsM",
                      version: 1 as const,
                    },
                    editedAt: null,
                  },
                ],
          hasMore: overrides.messageSearchHasMore ?? false,
          sizeLimited: false,
          coverage: {
            historyStartsAt: "2026-07-01T00:00:00.000Z",
            historyStartReason: "retention_policy" as const,
            searchableHistoryStartsAt: "2026-07-10T00:00:00.000Z",
            backfillComplete: false,
            gaps: [
              {
                startsAt: "2026-07-12T03:00:00.000Z",
                endsAt: "2026-07-12T03:08:00.000Z",
                cause: "connection_unavailable" as const,
              },
            ],
          },
        };
        return Effect.succeed(page);
      },
      listGroups: (input) => {
        observations.push("list-groups");
        if (input.searchIndex !== null) {
          expect(input.searchIndex).toMatch(/^gi1_[A-Za-z0-9_-]{43}$/u);
        }
        return Effect.succeed(
          overrides.groupPage === undefined
            ? {
                accountKey: {
                  ciphertext: "AQID",
                  keyVersion: 1,
                  kmsKeyId:
                    "arn:aws:kms:us-east-1:111122223333:key/test-content-root",
                  personalAccountId: "10000000-0000-4000-8000-000000000039",
                  version: 1 as const,
                },
                asOf: "2026-07-31T11:59:00.000Z",
                connectionKey: {
                  accountKeyVersion: 1,
                  ciphertext: "AQID",
                  connectionId: "20000000-0000-4000-8000-000000000039",
                  keyVersion: 1,
                  nonce: "AQIDBAUGBwgJCgsM",
                  personalAccountId: "10000000-0000-4000-8000-000000000039",
                  version: 1 as const,
                },
                groups: [
                  {
                    displayName: {
                      ciphertext: btoa("Family"),
                      keyVersion: 1,
                      nonce: "AQIDBAUGBwgJCgsM",
                      version: 1 as const,
                    },
                    id: "30000000-0000-4000-8000-000000000039",
                    publicId: "grp_AAAAAAAAAAAAAAAAAAAAA",
                  },
                  {
                    displayName: {
                      ciphertext: btoa("Family"),
                      keyVersion: 1,
                      nonce: "AQIDBAUGBwgJCgsM",
                      version: 1 as const,
                    },
                    id: "30000000-0000-4000-8000-000000000040",
                    publicId: "grp_aaaaaaaaaaaaaaaaaaaaa",
                  },
                ],
                partial: false,
                stale: false,
              }
            : overrides.groupPage,
        );
      },
      loadContactReadMaterial: () => {
        observations.push("material");
        return Effect.succeed({
          accountKey: {
            ciphertext: "AQI=",
            keyVersion: 1,
            kmsKeyId: "kms-content-root",
            personalAccountId: "10000000-0000-4000-8000-000000000030",
            version: 1 as const,
          },
          asOf: "2026-07-30T12:00:00.000Z",
          connectionKey: {
            accountKeyVersion: 1,
            ciphertext: "AQI=",
            connectionId: "20000000-0000-4000-8000-000000000030",
            keyVersion: 1,
            nonce: "AQIDBAUGBwgJCgsM",
            personalAccountId: "10000000-0000-4000-8000-000000000030",
            version: 1 as const,
          },
          identityKey: {
            ciphertext: btoa(
              String.fromCharCode(...new Uint8Array(32).fill(7)),
            ),
            keyVersion: 1,
            nonce: "AQIDBAUGBwgJCgsM",
            version: 1 as const,
          },
          partial: false,
          personalAccountId: "10000000-0000-4000-8000-000000000030",
          stale: false,
          whatsappConnectionId: "20000000-0000-4000-8000-000000000030",
        });
      },
      listEncryptedContacts: (input) => {
        observations.push("contacts");
        contactQueries.push({
          searchIndex: input.searchIndex,
          searchKind: input.searchKind,
        });
        const encrypted = (value: string) => ({
          ciphertext: btoa(value),
          keyVersion: 1,
          nonce: "AQIDBAUGBwgJCgsM",
          version: 1 as const,
        });
        const contacts = [
          {
            conversationPublicId: null,
            displayNameCiphertext: encrypted("Grace"),
            displayNameSort: "grace",
            phoneCiphertext: null,
            providerIdentityIndex: `di1_${"g".repeat(43)}`,
            publicId: "ctc_123456789012345678902",
          },
          {
            conversationPublicId: (overrides.scopes ?? []).includes(
              "messages:read",
            )
              ? "cvs_123456789012345678901"
              : null,
            displayNameCiphertext: encrypted("Ada"),
            displayNameSort: "ada",
            phoneCiphertext: encrypted("+15550199"),
            providerIdentityIndex: `di1_${"a".repeat(43)}`,
            publicId: "ctc_123456789012345678901",
          },
        ].sort((left, right) =>
          left.displayNameSort.localeCompare(right.displayNameSort),
        );
        return Effect.succeed({
          ...(overrides.contactPage ?? {
            asOf: "2026-07-30T12:00:00.000Z",
            partial: false,
            snapshotObservedAt: "2026-07-30T12:00:00.000Z",
            stale: false,
          }),
          contacts: contacts
            .filter((contact) =>
              input.searchKind === "phone"
                ? contact.displayNameSort === "ada"
                : input.searchKind === "name"
                  ? contact.displayNameSort === "grace"
                  : true,
            )
            .filter(
              (contact) =>
                input.cursorDisplayNameSort === null ||
                contact.displayNameSort > input.cursorDisplayNameSort ||
                (contact.displayNameSort === input.cursorDisplayNameSort &&
                  contact.publicId > (input.cursorPublicId ?? "")),
            )
            .slice(0, input.limit),
        });
      },
      rejectProtectedOperation: (input) => {
        observations.push("reject");
        if (overrides.failReject) {
          return Effect.fail(new McpToolPersistenceError());
        }
        const requiredScope =
          input.operationName === "list_connections"
            ? "connections:read"
            : input.operationName === "search_messages"
              ? "messages:read"
              : "directory:read";
        return Effect.succeed(
          overrides.scopes !== undefined &&
            !overrides.scopes.includes(requiredScope)
            ? ("authorization_denied" as const)
            : ("rejected" as const),
        );
      },
    }),
    Layer.succeed(McpCursorSigning, {
      key: overrides.cursorKey ?? defaultCursorSigningKey,
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) =>
        Effect.sync(() => {
          telemetry.push(event);
        }),
    }),
  );

  return {
    beginTargets,
    handler: createMcpRequestHandler({
      browserOrigin: "https://app.example.test",
      hourLimit: 10,
      layer,
      minuteLimit: 2,
      resourceUrl: "https://api.example.test/mcp",
    }),
    observations,
    contactQueries,
    messageSearchQueries,
    telemetry,
  };
};

describe("stateless MCP list_connections boundary", () => {
  const scopeMatrix = Array.from({ length: 16 }, (_, mask) => {
    const scopes = (
      [
        "connections:read",
        "directory:read",
        "messages:read",
        "messages:send",
      ] as const
    ).filter((_, index) => (mask & (1 << index)) !== 0);
    return [scopes.join("+") || "no scopes", scopes] as const;
  });

  test.each(scopeMatrix)(
    "enforces discovery and direct handlers for %s",
    async (_label, scopes) => {
      const tools = [
        {
          arguments: {},
          name: "list_connections",
          scope: "connections:read",
        },
        {
          arguments: { connection_id: "con_123456789012345678901" },
          name: "list_groups",
          scope: "directory:read",
        },
        {
          arguments: { connection_id: "con_123456789012345678901" },
          name: "list_contacts",
          scope: "directory:read",
        },
        {
          arguments: { connection_id: "con_123456789012345678901" },
          name: "list_chats",
          scope: "messages:read",
        },
        {
          arguments: {
            connection_id: "con_123456789012345678901",
            conversation_id: "cvs_123456789012345678901",
          },
          name: "read_messages",
          scope: "messages:read",
        },
        {
          arguments: {
            connection_id: "con_123456789012345678901",
            query: "invoice",
          },
          name: "search_messages",
          scope: "messages:read",
        },
        {
          arguments: {
            connection_id: "con_123456789012345678901",
            idempotency_key: "123456789012345678901",
            recipient_id: "ctc_123456789012345678901",
            text: "known recipient",
          },
          name: "send_text_message",
          scope: "messages:send",
        },
        {
          arguments: {
            connection_id: "con_123456789012345678901",
            send_id: "snd_123456789012345678901",
          },
          name: "get_send_status",
          scope: "messages:send",
        },
      ] as const;
      const harness = makeHarness({
        scopes,
        ...(!scopes.includes("messages:send")
          ? {
              sendResult: {
                outcome: "authorization_denied" as const,
              },
            }
          : {}),
      });
      const discovery = (await (
        await harness.handler(
          jsonRpcRequest("tools/list"),
          {},
          executionContext,
          authorization,
        )
      ).json()) as { result: { tools: Array<{ name: string }> } };
      expect(new Set(discovery.result.tools.map((tool) => tool.name))).toEqual(
        new Set(
          tools
            .filter((tool) => scopes.includes(tool.scope))
            .map((tool) => tool.name),
        ),
      );

      for (const tool of tools) {
        const result = (await (
          await harness.handler(
            jsonRpcRequest("tools/call", {
              arguments: tool.arguments,
              name: tool.name,
            }),
            {},
            executionContext,
            authorization,
          )
        ).json()) as {
          result: { structuredContent?: { error_code?: string } };
        };
        if (scopes.includes(tool.scope)) {
          expect(result.result.structuredContent?.error_code).not.toBe(
            "authorization_denied",
          );
        } else {
          expect(result.result.structuredContent?.error_code, tool.name).toBe(
            "authorization_denied",
          );
        }
      }
    },
  );

  test("scope-filters discovery and publishes closed exact schemas", async () => {
    const permitted = makeHarness();
    const response = await permitted.handler(
      jsonRpcRequest("tools/list"),
      {},
      executionContext,
      authorization,
    );
    const body = (await response.json()) as {
      result: {
        tools: Array<{
          inputSchema: Record<string, unknown>;
          name: string;
          outputSchema: Record<string, unknown>;
        }>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.result.tools).toHaveLength(1);
    expect(body.result.tools[0]).toMatchObject({
      name: "list_connections",
      inputSchema: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
      outputSchema: {
        additionalProperties: false,
        type: "object",
      },
    });

    const omitted = makeHarness({ scopes: ["messages:read"] });
    const omittedResponse = await omitted.handler(
      jsonRpcRequest("tools/list"),
      {},
      executionContext,
      authorization,
    );
    expect(await omittedResponse.json()).toMatchObject({
      result: {
        tools: [
          { name: "list_chats" },
          { name: "read_messages" },
          { name: "search_messages" },
        ],
      },
    });
  });

  test("scope-filters discovery in a legacy-stateless JSON-RPC batch", async () => {
    const harness = makeHarness({ scopes: ["messages:read"] });
    const request = new Request("https://api.example.test/mcp", {
      body: JSON.stringify([
        {
          id: "request-1",
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
        },
      ]),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        host: "api.example.test",
        "mcp-protocol-version": "2025-06-18",
      },
      method: "POST",
    });
    const response = await harness.handler(
      request,
      {},
      executionContext,
      authorization,
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toMatchObject({
      result: {
        tools: [
          { name: "list_chats" },
          { name: "read_messages" },
          { name: "search_messages" },
        ],
      },
    });
  });

  test("audits a direct call in a scope-filtered legacy batch", async () => {
    const harness = makeHarness({ scopes: ["messages:read"] });
    const request = new Request("https://api.example.test/mcp", {
      body: JSON.stringify([
        {
          id: "discovery-request",
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
        },
        {
          id: "call-request",
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: {}, name: "list_connections" },
        },
      ]),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        host: "api.example.test",
        "mcp-protocol-version": "2025-06-18",
      },
      method: "POST",
    });
    const response = await harness.handler(
      request,
      {},
      executionContext,
      authorization,
    );
    const messages = await responseMessages(response);

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "discovery-request",
          result: expect.objectContaining({
            tools: [
              expect.objectContaining({ name: "list_chats" }),
              expect.objectContaining({ name: "read_messages" }),
              expect.objectContaining({ name: "search_messages" }),
            ],
          }),
        }),
        expect.objectContaining({
          id: "call-request",
          result: expect.objectContaining({
            isError: true,
            structuredContent: expect.objectContaining({
              error_code: "authorization_denied",
            }),
          }),
        }),
      ]),
    );
    expect(harness.observations).toEqual(["begin"]);
  });

  test("audits before reading and returns structured/text parity without provider data", async () => {
    const harness = makeHarness();
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {},
        name: "list_connections",
      }),
      {},
      executionContext,
      authorization,
    );
    const body = (await response.json()) as {
      result: {
        content: Array<{ text: string; type: string }>;
        structuredContent: unknown;
      };
    };

    expect(response.status).toBe(200);
    expect(harness.observations).toEqual(["begin", "list", "complete"]);
    expect(body.result.structuredContent).toEqual({
      connections: [
        {
          connection_id: "con_123456789012345678901",
          display_name: "Personal WhatsApp",
          number_last_four: "1234",
          state: "connected",
          state_changed_at: "2026-07-30T12:00:00.000Z",
        },
      ],
    });
    expect(body.result.content).toEqual([
      {
        text: JSON.stringify(body.result.structuredContent),
        type: "text",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("provider");
    expect(harness.telemetry).toEqual([
      {
        event: "mcp.tool_call.completed",
        outcome: "success",
        resultCount: 1,
        service: "api",
        tool: "list_connections",
      },
    ]);
  });

  test("fails closed with a safe execution error when initial audit is unavailable", async () => {
    const harness = makeHarness({ failBegin: true });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {},
        name: "list_connections",
      }),
      {},
      executionContext,
      authorization,
    );

    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error_code: "audit_unavailable",
          retryable: true,
        },
      },
    });
    expect(harness.observations).toEqual(["begin"]);
    expect(harness.telemetry).toEqual([
      {
        event: "mcp.tool_call.completed",
        outcome: "audit_unavailable",
        service: "api",
        tool: "list_connections",
      },
    ]);
  });

  test("enters the audited handler before authorization discovery on a direct call", async () => {
    const harness = makeHarness({ failBegin: true, failInspect: true });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {},
        name: "list_connections",
      }),
      {},
      executionContext,
      authorization,
    );

    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error_code: "audit_unavailable",
          retryable: true,
        },
      },
    });
    expect(harness.observations).toEqual(["begin"]);
  });

  test("audits and rechecks scope when an omitted tool is invoked directly", async () => {
    const harness = makeHarness({ scopes: ["messages:send"] });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {},
        name: "list_connections",
      }),
      {},
      executionContext,
      authorization,
    );

    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error_code: "authorization_denied",
          retryable: false,
        },
      },
    });
    expect(harness.observations).toEqual(["begin"]);
  });

  test("maps an authoritative quota rejection to stable retry and reset details", async () => {
    const harness = makeHarness({
      beginResult: {
        auditLogId: "50000000-0000-4000-8000-000000000030",
        outcome: "rate_limited",
        resetsAt: new Date("2026-07-31T12:00:30.000Z"),
        retryAfterSeconds: 30,
      },
    });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {},
        name: "list_connections",
      }),
      {},
      executionContext,
      authorization,
    );
    const body = (await response.json()) as {
      result: {
        content: Array<{ text: string; type: string }>;
        structuredContent: unknown;
      };
    };

    expect(body.result.structuredContent).toEqual({
      error_code: "rate_limited",
      message: "The request quota is exhausted.",
      resets_at: "2026-07-31T12:00:30.000Z",
      retry_after_seconds: 30,
      retryable: true,
    });
    expect(body.result.content).toEqual([
      {
        text: JSON.stringify(body.result.structuredContent),
        type: "text",
      },
    ]);
    expect(harness.observations).toEqual(["begin"]);
  });

  test("does not release Connection metadata when audit completion fails", async () => {
    const harness = makeHarness({ failComplete: true });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {},
        name: "list_connections",
      }),
      {},
      executionContext,
      authorization,
    );
    const serialized = JSON.stringify(await response.json());

    expect(serialized).toContain("audit_unavailable");
    expect(serialized).not.toContain("con_123456789012345678901");
    expect(harness.observations).toEqual(["begin", "list", "complete"]);
  });

  test("discovers both directory tools and returns deterministic suffix-only contact pages", async () => {
    const harness = makeHarness({ scopes: ["directory:read"] });
    const discovery = await harness.handler(
      jsonRpcRequest("tools/list"),
      {},
      executionContext,
      authorization,
    );
    const discoveryBody = (await discovery.json()) as {
      result: {
        tools: Array<{
          inputSchema: Record<string, unknown>;
          name: string;
          outputSchema: Record<string, unknown>;
        }>;
      };
    };
    expect(discoveryBody.result.tools.map(({ name }) => name)).toEqual([
      "list_groups",
      "list_contacts",
    ]);
    expect(
      discoveryBody.result.tools.find(({ name }) => name === "list_contacts"),
    ).toMatchObject({
      inputSchema: expect.objectContaining({ additionalProperties: false }),
      outputSchema: expect.objectContaining({ additionalProperties: false }),
    });

    const first = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {
          connection_id: "con_123456789012345678901",
          limit: 1,
        },
        name: "list_contacts",
      }),
      {},
      executionContext,
      authorization,
    );
    const firstBody = (await first.json()) as {
      result: { structuredContent: Record<string, unknown> };
    };
    expect(firstBody.result.structuredContent).toEqual({
      as_of: "2026-07-30T12:00:00.000Z",
      contacts: [
        {
          contact_id: "ctc_123456789012345678901",
          conversation_id: null,
          display_name: "Ada",
          phone_last_four: "0199",
        },
      ],
      has_more: true,
      next_cursor: expect.any(String),
      partial: false,
      stale: true,
    });
    expect(JSON.stringify(firstBody)).not.toContain("+15550199");
    expect(harness.observations).toEqual([
      "begin",
      "material",
      "contacts",
      "complete",
    ]);

    const second = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {
          connection_id: "con_123456789012345678901",
          cursor: firstBody.result.structuredContent.next_cursor,
          limit: 1,
        },
        name: "list_contacts",
      }),
      {},
      executionContext,
      authorization,
    );
    expect(await second.json()).toMatchObject({
      result: {
        structuredContent: {
          contacts: [
            {
              contact_id: "ctc_123456789012345678902",
              display_name: "Grace",
              phone_last_four: null,
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      },
    });
  });

  test("searches by normalized name prefix and exact E.164 without exposing query material", async () => {
    const harness = makeHarness({ scopes: ["directory:read"] });
    const requests = [
      { search: "  GRA  ", expectedName: "Grace", kind: "name" },
      { search: "+15550199", expectedName: "Ada", kind: "phone" },
    ] as const;

    for (const request of requests) {
      const response = await harness.handler(
        jsonRpcRequest("tools/call", {
          arguments: {
            connection_id: "con_123456789012345678901",
            search: request.search,
          },
          name: "list_contacts",
        }),
        {},
        executionContext,
        authorization,
      );
      const body = await response.json();
      expect(body).toMatchObject({
        result: {
          structuredContent: {
            contacts: [{ display_name: request.expectedName }],
          },
        },
      });
      expect(JSON.stringify(body)).not.toContain(request.search);
      expect(harness.contactQueries.at(-1)).toEqual({
        searchIndex: expect.stringMatching(/^di1_[A-Za-z0-9_-]{43}$/u),
        searchKind: request.kind,
      });
    }

    expect(harness.contactQueries[0]?.searchIndex).not.toBe(
      harness.contactQueries[1]?.searchIndex,
    );
    expect(JSON.stringify(harness.telemetry)).not.toContain("+15550199");
  });

  test("binds contact search cursors to the exact normalized query", async () => {
    const cursorKey = await Effect.runPromise(
      importCursorSigningKey(new Uint8Array(32).fill(17)),
    );
    const harness = makeHarness({ cursorKey, scopes: ["directory:read"] });
    const cursor = await Effect.runPromise(
      makeMcpCursorCodec(cursorKey).encode({
        boundary: ["grace", "ctc_123456789012345678902"],
        context: {
          authorizationId: authorization.authorizationId,
          connectionId: ConnectionId.make("con_123456789012345678901"),
          filters: { search: "gra" },
          pageSize: 1,
          sortVersion: "contacts-v1",
          tool: "list_contacts",
        },
        expiresAtEpochSeconds: 1_785_499_200,
      }),
    );

    const replay = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {
          connection_id: "con_123456789012345678901",
          cursor,
          limit: 1,
          search: "grace",
        },
        name: "list_contacts",
      }),
      {},
      executionContext,
      authorization,
    );
    expect(await replay.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: { error_code: "invalid_cursor" },
      },
    });
  });

  test("keeps provider reconciliation staleness visible when webhooks advance as_of", async () => {
    const harness = makeHarness({
      contactPage: {
        asOf: "2026-07-31T12:00:00.000Z",
        partial: false,
        snapshotObservedAt: "2026-07-31T11:40:00.000Z",
        stale: false,
      },
      scopes: ["directory:read"],
    });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: { connection_id: "con_123456789012345678901" },
        name: "list_contacts",
      }),
      {},
      executionContext,
      authorization,
    );

    expect(await response.json()).toMatchObject({
      result: {
        structuredContent: {
          as_of: "2026-07-31T12:00:00.000Z",
          stale: true,
        },
      },
    });
  });

  test("audits invalid cursors without reserving request quota", async () => {
    const harness = makeHarness({ scopes: ["directory:read"] });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {
          connection_id: "con_123456789012345678901",
          cursor: "not-a-cursor",
        },
        name: "list_contacts",
      }),
      {},
      executionContext,
      authorization,
    );

    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: { error_code: "invalid_cursor" },
      },
    });
    expect(harness.observations).toEqual(["reject"]);
  });

  test("audits direct list_contacts calls and withholds Directory data when completion fails", async () => {
    const unauthorized = makeHarness({ scopes: ["connections:read"] });
    const denied = await unauthorized.handler(
      jsonRpcRequest("tools/call", {
        arguments: { connection_id: "con_123456789012345678901" },
        name: "list_contacts",
      }),
      {},
      executionContext,
      authorization,
    );
    expect(await denied.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: { error_code: "authorization_denied" },
      },
    });
    expect(unauthorized.observations).toEqual(["begin"]);

    const unavailable = makeHarness({
      failComplete: true,
      scopes: ["directory:read"],
    });
    const response = await unavailable.handler(
      jsonRpcRequest("tools/call", {
        arguments: { connection_id: "con_123456789012345678901" },
        name: "list_contacts",
      }),
      {},
      executionContext,
      authorization,
    );
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain("audit_unavailable");
    expect(serialized).not.toContain("Ada");
  });

  test("supports the legacy-stateless 2025 protocol lane", async () => {
    const harness = makeHarness();
    const request = jsonRpcRequest("tools/list", undefined, "2025-06-18");
    const response = await harness.handler(
      request,
      {},
      executionContext,
      authorization,
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toMatchObject({
      result: {
        tools: [{ name: "list_connections" }],
      },
    });
  });
});

describe("stateless MCP list_groups boundary", () => {
  test("scope-filters discovery to directory tools", async () => {
    const harness = makeHarness({ scopes: ["directory:read"] });
    const response = await harness.handler(
      jsonRpcRequest("tools/list"),
      {},
      executionContext,
      authorization,
    );
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };

    expect(body.result.tools.map(({ name }) => name)).toEqual([
      "list_groups",
      "list_contacts",
    ]);
  });

  test("distinguishes group recipient handles from conversation handles in discovery", async () => {
    const harness = makeHarness({
      scopes: ["directory:read", "messages:read", "messages:send"],
    });
    const response = await harness.handler(
      jsonRpcRequest("tools/list"),
      {},
      executionContext,
      authorization,
    );
    const body = (await response.json()) as {
      result: {
        tools: Array<{ description?: string; name: string }>;
      };
    };
    const descriptions = Object.fromEntries(
      body.result.tools.map(({ description, name }) => [name, description]),
    );

    expect(descriptions.list_groups).toContain(
      "group_id cannot be used as read_messages.conversation_id",
    );
    expect(descriptions.list_chats).toContain(
      "Do not page through this tool when the User names a contact",
    );
    expect(descriptions.read_messages).toContain(
      "recipient_id can be passed directly to send_text_message",
    );
    expect(descriptions.list_contacts).toContain(
      "do not use search_messages to locate a person",
    );
    expect(descriptions.send_text_message).toContain(
      "idempotency_key of exactly 21 characters",
    );
  });

  test("audits before decrypting and returns normalized prefix results without provider data", async () => {
    const harness = makeHarness({ scopes: ["directory:read"] });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {
          connection_id: "con_123456789012345678939",
          search: "fam",
        },
        name: "list_groups",
      }),
      {},
      executionContext,
      authorization,
    );
    const body = (await response.json()) as {
      result: {
        content: Array<{ text: string; type: string }>;
        structuredContent: unknown;
      };
    };

    expect(harness.observations).toEqual([
      "begin",
      "load-group-search-material",
      "list-groups",
      "complete",
    ]);
    expect(body.result.structuredContent).toEqual({
      groups: [
        {
          display_name: "Family",
          group_id: "grp_AAAAAAAAAAAAAAAAAAAAA",
        },
        {
          display_name: "Family",
          group_id: "grp_aaaaaaaaaaaaaaaaaaaaa",
        },
      ],
      has_more: false,
      next_cursor: null,
      as_of: "2026-07-31T11:59:00.000Z",
      stale: false,
      partial: false,
    });
    expect(body.result.content[0]?.text).toBe(
      JSON.stringify(body.result.structuredContent),
    );
    expect(JSON.stringify(body)).not.toContain("provider");
  });

  test("returns authorization-bound keyset pages and rejects changed filters", async () => {
    const key = await Effect.runPromise(
      importCursorSigningKey(new Uint8Array(32).fill(39)),
    );
    const harness = makeHarness({
      cursorKey: key,
      scopes: ["directory:read"],
    });
    const first = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {
          connection_id: "con_123456789012345678939",
          limit: 1,
        },
        name: "list_groups",
      }),
      {},
      executionContext,
      authorization,
    );
    const firstBody = (await first.json()) as {
      result: {
        structuredContent: {
          groups: Array<{ group_id: string }>;
          has_more: boolean;
          next_cursor: string;
        };
      };
    };
    expect(firstBody.result.structuredContent).toMatchObject({
      groups: [{ group_id: "grp_AAAAAAAAAAAAAAAAAAAAA" }],
      has_more: true,
    });

    const second = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {
          connection_id: "con_123456789012345678939",
          cursor: firstBody.result.structuredContent.next_cursor,
          limit: 1,
        },
        name: "list_groups",
      }),
      {},
      executionContext,
      authorization,
    );
    expect(await second.json()).toMatchObject({
      result: {
        structuredContent: {
          groups: [{ group_id: "grp_aaaaaaaaaaaaaaaaaaaaa" }],
          has_more: false,
          next_cursor: null,
        },
      },
    });

    const mismatch = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {
          connection_id: "con_123456789012345678939",
          cursor: firstBody.result.structuredContent.next_cursor,
          limit: 1,
          search: "wor",
        },
        name: "list_groups",
      }),
      {},
      executionContext,
      authorization,
    );
    expect(await mismatch.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: { error_code: "invalid_cursor" },
      },
    });
  });
});

describe("list_chats MCP boundary", () => {
  test("decrypts all chat metadata in one batch", async () => {
    const encrypted = (value: string) => ({
      ciphertext: btoa(value),
      keyVersion: 1,
      nonce: "AQIDBAUGBwgJCgsM",
      version: 1 as const,
    });
    const harness = makeHarness({
      scopes: ["messages:read"],
      chatPage: {
        accountKey: {
          ciphertext: "AQI=",
          keyVersion: 1,
          kmsKeyId: "kms-content-root",
          personalAccountId: "10000000-0000-4000-8000-000000000030",
          version: 1,
        },
        connectionKey: {
          accountKeyVersion: 1,
          ciphertext: "AQI=",
          connectionId: "20000000-0000-4000-8000-000000000030",
          keyVersion: 1,
          nonce: "AQIDBAUGBwgJCgsM",
          personalAccountId: "10000000-0000-4000-8000-000000000030",
          version: 1,
        },
        chats: [
          {
            conversationId: "cvs_111111111111111111111",
            displayName: encrypted("Ada"),
            displayNameEntity: "directory-contact",
            displayNameRecordId: "contact-one",
            kind: "direct",
            lastActivityAt: "2026-07-31T11:59:00.000Z",
            lastActivityDirection: "inbound",
            phone: encrypted("+15550123456"),
            recipientId: "ctc_111111111111111111111",
          },
          {
            conversationId: "cvs_222222222222222222222",
            displayName: null,
            displayNameEntity: "whatsapp-group",
            displayNameRecordId: "group-two",
            kind: "group",
            lastActivityAt: "2026-07-31T11:58:00.000Z",
            lastActivityDirection: "outbound",
            phone: null,
            recipientId: "grp_222222222222222222222",
          },
        ],
        asOf: "2026-07-31T12:00:00.000Z",
        partial: false,
        stale: false,
      },
    });

    const body = (await (
      await harness.handler(
        jsonRpcRequest("tools/call", {
          name: "list_chats",
          arguments: { connection_id: "con_123456789012345678901" },
        }),
        {},
        executionContext,
        authorization,
      )
    ).json()) as {
      result: {
        structuredContent: {
          chats: Array<{
            display_name: string | null;
            phone: string | null;
            phone_last_four: string | null;
          }>;
        };
      };
    };

    expect(body.result.structuredContent.chats).toMatchObject([
      {
        display_name: "Ada",
        phone: "+15550123456",
        phone_last_four: "3456",
      },
      { display_name: null, phone: null, phone_last_four: null },
    ]);
    expect(
      harness.observations.filter((value) => value === "decrypt-many"),
    ).toHaveLength(1);
  });
});

describe("search_messages MCP boundary", () => {
  test("normalizes exact terms, verifies plaintext, exposes partial coverage, and binds cursors without query material", async () => {
    const cursorKey = await Effect.runPromise(
      importCursorSigningKey(new Uint8Array(32).fill(19)),
    );
    const harness = makeHarness({
      cursorKey,
      messageSearchHasMore: true,
      scopes: ["messages:read"],
    });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        arguments: {
          connection_id: "con_123456789012345678901",
          query: "confirmation INVOICE!",
          limit: 1,
        },
        name: "search_messages",
      }),
      {},
      executionContext,
      authorization,
    );
    const body = (await responseJson(response)) as {
      result: { structuredContent: Record<string, unknown> };
    };
    expect(body.result.structuredContent).toMatchObject({
      messages: [
        {
          message_id: "msg_222222222222222222222",
          text: "INVOICE, flight confirmation",
        },
      ],
      has_more: true,
      coverage: {
        backfill_complete: false,
        partial: true,
        partial_reasons: ["index_backfill", "ingestion_gap"],
      },
    });
    expect(harness.observations.indexOf("begin")).toBeLessThan(
      harness.observations.indexOf("decrypt-many"),
    );
    expect(harness.messageSearchQueries[0]).toBeNull();
    expect(harness.messageSearchQueries[1]).toHaveLength(2);
    expect(JSON.stringify(harness.messageSearchQueries)).not.toContain(
      "invoice",
    );

    const cursor = body.result.structuredContent.next_cursor as string;
    const rejected = (await responseJson(
      await harness.handler(
        jsonRpcRequest("tools/call", {
          arguments: {
            connection_id: "con_123456789012345678901",
            query: "different",
            limit: 1,
            cursor,
          },
          name: "search_messages",
        }),
        {},
        executionContext,
        authorization,
      ),
    )) as { result: { structuredContent: { error_code: string } } };
    expect(rejected.result.structuredContent.error_code).toBe("invalid_cursor");
  });
});

describe("read_messages MCP boundary", () => {
  test("returns Deleted Message Tombstones without content while retaining the record", async () => {
    const harness = makeHarness({ scopes: ["messages:read"], tombstone: true });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        name: "read_messages",
        arguments: {
          connection_id: "con_123456789012345678901",
          conversation_id: "cvs_123456789012345678901",
          limit: 20,
        },
      }),
      {},
      executionContext,
      authorization,
    );
    const body = (await response.json()) as {
      result: {
        structuredContent: { messages: Array<Record<string, unknown>> };
      };
    };
    expect(body.result.structuredContent.messages).toEqual([
      expect.objectContaining({
        message_id: "msg_333333333333333333333",
        text: null,
        text_total_utf8_bytes: null,
        edited_at: null,
        deleted: true,
        media: null,
      }),
    ]);
  });

  test("returns newest selection chronologically with bound older traversal metadata", async () => {
    const harness = makeHarness({ scopes: ["messages:read"] });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        name: "read_messages",
        arguments: {
          connection_id: "con_123456789012345678901",
          conversation_id: "cvs_123456789012345678901",
          limit: 2,
        },
      }),
      {},
      executionContext,
      authorization,
    );
    const body = (await response.json()) as {
      result: { structuredContent: Record<string, unknown> };
    };
    expect(body.result.structuredContent).toMatchObject({
      conversation_id: "cvs_123456789012345678901",
      kind: "direct",
      recipient_id: "ctc_123456789012345678901",
      messages: [
        {
          message_id: "msg_111111111111111111111",
          text: "older",
          direction: "outbound",
          sender: { kind: "self" },
          media: null,
        },
        {
          message_id: "msg_222222222222222222222",
          text: "newest",
          direction: "inbound",
          sender: {
            kind: "contact",
            display_name: "Ada",
            phone_last_four: "0199",
          },
          media: null,
        },
      ],
      has_older: true,
      history_start_reason: "retention_policy",
      gaps: [{ cause: "processing_failure", ends_at: null }],
    });
    expect(body.result.structuredContent.older_cursor).toEqual(
      expect.any(String),
    );
    expect(harness.observations).toContain("read-messages");
    expect(
      harness.observations.filter((value) => value === "decrypt-many"),
    ).toHaveLength(1);
  });

  test("decrypts message content and image metadata in one batch", async () => {
    const encrypted = (value: unknown) => ({
      ciphertext: btoa(JSON.stringify(value)),
      keyVersion: 1,
      nonce: "AQIDBAUGBwgJCgsM",
      version: 1 as const,
    });
    const harness = makeHarness({
      scopes: ["messages:read"],
      messagePage: {
        accountKey: {
          ciphertext: "AQI=",
          keyVersion: 1,
          kmsKeyId: "kms-content-root",
          personalAccountId: "10000000-0000-4000-8000-000000000030",
          version: 1,
        },
        connectionKey: {
          accountKeyVersion: 1,
          ciphertext: "AQI=",
          connectionId: "20000000-0000-4000-8000-000000000030",
          keyVersion: 1,
          nonce: "AQIDBAUGBwgJCgsM",
          personalAccountId: "10000000-0000-4000-8000-000000000030",
          version: 1,
        },
        conversation: {
          kind: "direct",
          publicId: "cvs_123456789012345678901",
          recipientId: "ctc_123456789012345678901",
        },
        messages: [
          {
            publicId: "msg_444444444444444444444",
            messageIdentity: `wi1_${"D".repeat(43)}`,
            sentAt: "2026-07-31T11:59:00.000Z",
            direction: "inbound",
            conversationKind: "direct",
            contentType: "image",
            content: encrypted({ text: "caption", mediaSource: null }),
            sender: null,
            media: {
              id: "30000000-0000-4000-8000-000000000044",
              publicId: "med_444444444444444444444",
              state: "ready",
              plaintextSizeBytes: 1024,
              metadata: encrypted({
                fileName: "photo.jpg",
                mimeType: "image/jpeg",
              }),
            },
          },
        ],
        hasOlder: false,
        sizeLimited: false,
        historyStartsAt: "2026-07-01T00:00:00.000Z",
        historyStartReason: "retention_policy",
        gaps: [],
      },
    });

    const body = (await (
      await harness.handler(
        jsonRpcRequest("tools/call", {
          name: "read_messages",
          arguments: {
            connection_id: "con_123456789012345678901",
            conversation_id: "cvs_123456789012345678901",
            limit: 20,
          },
        }),
        {},
        executionContext,
        authorization,
      )
    ).json()) as {
      result: {
        structuredContent: {
          messages: Array<{
            media: { file_name: string; mime_type: string } | null;
            text: string | null;
          }>;
        };
      };
    };

    expect(body.result.structuredContent.messages).toMatchObject([
      {
        text: "caption",
        media: { file_name: "photo.jpg", mime_type: "image/jpeg" },
      },
    ]);
    expect(
      harness.observations.filter((value) => value === "decrypt-many"),
    ).toHaveLength(1);
  });

  test("is discovered only with messages:read", async () => {
    const harness = makeHarness({ scopes: ["messages:read"] });
    const body = (await (
      await harness.handler(
        jsonRpcRequest("tools/list"),
        {},
        executionContext,
        authorization,
      )
    ).json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "list_chats",
      "read_messages",
      "search_messages",
    ]);
  });

  test("reduces complete records to the 32 KiB target and cursors from the oldest returned record", async () => {
    const message = (suffix: string, text: string, sentAt: string) => ({
      publicId: `msg_${suffix.repeat(21)}`,
      messageIdentity: `wi1_${suffix.repeat(43)}`,
      sentAt,
      direction: "inbound" as const,
      conversationKind: "direct" as const,
      contentType: "text" as const,
      content: {
        ciphertext: btoa(JSON.stringify({ text, mediaSource: null })),
        keyVersion: 1,
        nonce: "AQIDBAUGBwgJCgsM",
        version: 1 as const,
      },
      sender: null,
    });
    const harness = makeHarness({
      scopes: ["messages:read"],
      messagePage: {
        accountKey: {
          ciphertext: "AQI=",
          keyVersion: 1,
          kmsKeyId: "kms-content-root",
          personalAccountId: "10000000-0000-4000-8000-000000000030",
          version: 1,
        },
        connectionKey: {
          accountKeyVersion: 1,
          ciphertext: "AQI=",
          connectionId: "20000000-0000-4000-8000-000000000030",
          keyVersion: 1,
          nonce: "AQIDBAUGBwgJCgsM",
          personalAccountId: "10000000-0000-4000-8000-000000000030",
          version: 1,
        },
        conversation: {
          kind: "direct",
          publicId: "cvs_123456789012345678901",
          recipientId: "ctc_123456789012345678901",
        },
        messages: [
          message("3", "a".repeat(16_000), "2026-07-31T11:59:00.000Z"),
          message("2", "b".repeat(16_000), "2026-07-31T11:58:00.000Z"),
          message("1", "c".repeat(16_000), "2026-07-31T11:57:00.000Z"),
        ],
        hasOlder: false,
        sizeLimited: false,
        historyStartsAt: "2026-07-01T00:00:00.000Z",
        historyStartReason: "retention_policy",
        gaps: [],
      },
    });
    const body = (await (
      await harness.handler(
        jsonRpcRequest("tools/call", {
          name: "read_messages",
          arguments: {
            connection_id: "con_123456789012345678901",
            conversation_id: "cvs_123456789012345678901",
            limit: 3,
          },
        }),
        {},
        executionContext,
        authorization,
      )
    ).json()) as {
      result: {
        structuredContent: {
          messages: unknown[];
          older_cursor: string;
          size_limited: boolean;
        };
        content: Array<{ text: string }>;
      };
    };
    expect(
      new TextEncoder().encode(body.result.content[0]?.text).byteLength,
    ).toBeLessThanOrEqual(32_768);
    expect(body.result.structuredContent.messages).toHaveLength(1);
    expect(body.result.structuredContent.size_limited).toBe(true);
    expect(
      JSON.parse(atob(body.result.structuredContent.older_cursor)),
    ).toEqual(["2026-07-31T11:59:00.000Z", "msg_333333333333333333333"]);
    expect(harness.observations).toContain("complete-message-read:1");
  });

  test("Unicode-safely truncates one oversized record under 64 KiB with the full UTF-8 count", async () => {
    const text = `${"e\u0301😀".repeat(20_000)}tail`;
    const source = new TextEncoder().encode(JSON.stringify({ text }));
    let binary = "";
    for (let offset = 0; offset < source.byteLength; offset += 0x8000)
      binary += String.fromCharCode(
        ...source.subarray(offset, offset + 0x8000),
      );
    const encoded = btoa(binary);
    const oversized = makeHarness({
      scopes: ["messages:read"],
      messagePage: {
        accountKey: {
          ciphertext: "AQI=",
          keyVersion: 1,
          kmsKeyId: "kms-content-root",
          personalAccountId: "10000000-0000-4000-8000-000000000030",
          version: 1,
        },
        connectionKey: {
          accountKeyVersion: 1,
          ciphertext: "AQI=",
          connectionId: "20000000-0000-4000-8000-000000000030",
          keyVersion: 1,
          nonce: "AQIDBAUGBwgJCgsM",
          personalAccountId: "10000000-0000-4000-8000-000000000030",
          version: 1,
        },
        conversation: {
          kind: "direct",
          publicId: "cvs_123456789012345678901",
          recipientId: "ctc_123456789012345678901",
        },
        messages: [
          {
            publicId: "msg_111111111111111111111",
            messageIdentity: `wi1_${"A".repeat(43)}`,
            sentAt: "2026-07-31T11:59:00.000Z",
            direction: "inbound",
            conversationKind: "direct",
            contentType: "text",
            content: {
              ciphertext: encoded,
              keyVersion: 1,
              nonce: "AQIDBAUGBwgJCgsM",
              version: 1,
            },
            sender: null,
          },
        ],
        hasOlder: false,
        sizeLimited: false,
        historyStartsAt: "2026-07-01T00:00:00.000Z",
        historyStartReason: "retention_policy",
        gaps: [],
      },
    });
    const body = (await (
      await oversized.handler(
        jsonRpcRequest("tools/call", {
          name: "read_messages",
          arguments: {
            connection_id: "con_123456789012345678901",
            conversation_id: "cvs_123456789012345678901",
            limit: 1,
          },
        }),
        {},
        executionContext,
        authorization,
      )
    ).json()) as {
      result: {
        structuredContent: {
          messages: Array<{
            text: string;
            text_truncated: boolean;
            text_total_utf8_bytes: number;
          }>;
        };
        content: Array<{ text: string }>;
      };
    };
    const returned = body.result.structuredContent.messages[0];
    expect(returned).toBeDefined();
    if (returned === undefined) throw new Error("expected one message");
    expect(
      new TextEncoder().encode(body.result.content[0]?.text).byteLength,
    ).toBeLessThanOrEqual(65_536);
    expect(returned.text_truncated).toBe(true);
    expect(returned.text_total_utf8_bytes).toBe(
      new TextEncoder().encode(text).byteLength,
    );
    expect(() =>
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        new TextEncoder().encode(returned.text),
      ),
    ).not.toThrow();
    expect(text.startsWith(returned.text)).toBe(true);
  });
});

describe("Stored Media MCP resource boundary", () => {
  const uri =
    "whatsapp-media://connections/con_123456789012345678901/messages/msg_111111111111111111111/media/med_222222222222222222222";

  test("discovers the non-listable template only with messages:read", async () => {
    const allowed = makeHarness({ scopes: ["messages:read"] });
    const templates = (await (
      await allowed.handler(
        jsonRpcRequest("resources/templates/list"),
        {},
        executionContext,
        authorization,
      )
    ).json()) as { result: { resourceTemplates: unknown[] } };
    expect(templates.result.resourceTemplates).toEqual([
      expect.objectContaining({
        uriTemplate:
          "whatsapp-media://connections/{connection_id}/messages/{message_id}/media/{media_id}",
      }),
    ]);
    const resources = (await (
      await allowed.handler(
        jsonRpcRequest("resources/list"),
        {},
        executionContext,
        authorization,
      )
    ).json()) as { result: { resources: unknown[] } };
    expect(resources.result.resources).toEqual([]);

    const denied = makeHarness({ scopes: ["connections:read"] });
    const hidden = (await (
      await denied.handler(
        jsonRpcRequest("resources/templates/list"),
        {},
        executionContext,
        authorization,
      )
    ).json()) as { error: { code: number } };
    expect(hidden.error.code).toBe(-32601);
  });

  test("reserves the full bytes before decrypting and returns a private attachment", async () => {
    const harness = makeHarness({
      mediaRead: "ready",
      scopes: ["messages:read"],
    });
    const body = (await (
      await harness.handler(
        jsonRpcRequest("resources/read", { uri }),
        {},
        executionContext,
        authorization,
      )
    ).json()) as {
      result: {
        cacheScope: string;
        contents: Array<{
          _meta: Record<string, unknown>;
          blob: string;
          mimeType: string;
        }>;
        ttlMs: number;
      };
    };
    expect(body.result).toMatchObject({ cacheScope: "private", ttlMs: 0 });
    expect(body.result.contents).toEqual([
      expect.objectContaining({
        blob: btoa("protected bytes"),
        mimeType: "image/jpeg",
        _meta: { filename: "unsafe name.jpg" },
      }),
    ]);
    expect(harness.observations.indexOf("reserve-media-read")).toBeLessThan(
      harness.observations.indexOf("decrypt-media-object"),
    );
  });

  test("releases reserved bytes when the protected read fails before response", async () => {
    const harness = makeHarness({
      failComplete: true,
      mediaRead: "ready",
      scopes: ["messages:read"],
    });
    const body = (await (
      await harness.handler(
        jsonRpcRequest("resources/read", { uri }),
        {},
        executionContext,
        authorization,
      )
    ).json()) as { error: { code: number; message: string } };
    expect(body.error).toMatchObject({
      code: -32602,
      message: "Resource not found",
    });
    expect(harness.observations).toContain("fail-media-read");
  });

  test.each([
    "whatsapp-media://connections/con_123456789012345678901/messages/msg_111111111111111111111/media/med_222222222222222222222/extra",
    `${uri}?download=1`,
    `${uri}#fragment`,
    uri.replace("msg_111111111111111111111", "%2e%2e"),
    uri,
  ])(
    "uses one not-found boundary for unavailable URI %s",
    async (candidate) => {
      const harness = makeHarness({ scopes: ["messages:read"] });
      const body = (await (
        await harness.handler(
          jsonRpcRequest("resources/read", { uri: candidate }),
          {},
          executionContext,
          authorization,
        )
      ).json()) as { error: { code: number; message: string } };
      expect(body.error).toMatchObject({
        code: -32602,
        message: "Resource not found",
      });
    },
  );
});

describe("atomic send_text_message MCP boundary", () => {
  test("is discovered only with send scope and advertises exact confirmation metadata", async () => {
    const harness = makeHarness({ scopes: ["messages:send"] });
    const response = await harness.handler(
      jsonRpcRequest("tools/list"),
      {},
      executionContext,
      authorization,
    );
    const body = (await response.json()) as { result: { tools: unknown[] } };
    expect(body.result.tools).toEqual([
      expect.objectContaining({
        name: "send_text_message",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        _meta: { "anthropic/requiresUserInteraction": true },
      }),
      expect.objectContaining({
        name: "get_send_status",
        annotations: { readOnlyHint: true },
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain("confirmed");

    const omitted = makeHarness({ scopes: ["connections:read"] });
    const omittedBody = (await (
      await omitted.handler(
        jsonRpcRequest("tools/list"),
        {},
        executionContext,
        authorization,
      )
    ).json()) as { result: { tools: Array<{ name: string }> } };
    expect(omittedBody.result.tools.map((tool) => tool.name)).not.toContain(
      "send_text_message",
    );
  });

  test("preserves exact valid text and returns only a compact receipt", async () => {
    const harness = makeHarness({ scopes: ["messages:send"] });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        name: "send_text_message",
        arguments: {
          connection_id: "con_123456789012345678901",
          recipient_id: "ctc_123456789012345678901",
          text: "  e\u0301\n ",
          idempotency_key: "123456789012345678901",
        },
      }),
      {},
      executionContext,
      authorization,
    );
    expect(await response.json()).toMatchObject({
      result: {
        structuredContent: {
          send_id: "snd_123456789012345678901",
          status: "accepted",
          idempotent_replay: false,
        },
      },
    });
  });

  test("extends the request lifetime before the send service completes", async () => {
    const deferredOperations: Array<Promise<unknown>> = [];
    const context = {
      passThroughOnException: () => undefined,
      waitUntil: (operation: Promise<unknown>) => {
        deferredOperations.push(operation);
      },
    } as unknown as ExecutionContext;
    const harness = makeHarness({ scopes: ["messages:send"] });

    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        name: "send_text_message",
        arguments: {
          connection_id: "con_123456789012345678901",
          recipient_id: "grp_123456789012345678901",
          text: "slow group",
          idempotency_key: "123456789012345678901",
        },
      }),
      {},
      context,
      authorization,
    );

    expect(response.status).toBe(200);
    expect(deferredOperations).toHaveLength(1);
    await expect(deferredOperations[0]).resolves.toBeUndefined();
  });

  test("reads a locally converged status and shares one not-found boundary", async () => {
    const harness = makeHarness({ scopes: ["messages:send"] });
    const call = (sendStatusNotFound = false) =>
      (sendStatusNotFound
        ? makeHarness({ scopes: ["messages:send"], sendStatusNotFound })
        : harness
      ).handler(
        jsonRpcRequest("tools/call", {
          name: "get_send_status",
          arguments: {
            connection_id: "con_123456789012345678901",
            send_id: "snd_123456789012345678901",
          },
        }),
        {},
        executionContext,
        authorization,
      );
    expect(await (await call()).json()).toMatchObject({
      result: { structuredContent: { status: "delivered" } },
    });
    expect(harness.beginTargets).toEqual([
      {
        connectionPublicId: "con_123456789012345678901",
        sendPublicId: "snd_123456789012345678901",
        toolName: "get_send_status",
      },
    ]);
    expect(await (await call(true)).json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: { error_code: "send_not_found", retryable: false },
      },
    });
  });

  test("returns changed-input idempotency reuse as a non-retryable conflict", async () => {
    const harness = makeHarness({
      scopes: ["messages:send"],
      sendResult: { outcome: "idempotency_conflict" },
    });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        name: "send_text_message",
        arguments: {
          connection_id: "con_123456789012345678901",
          recipient_id: "ctc_123456789012345678902",
          text: "changed exact bytes",
          idempotency_key: "123456789012345678901",
        },
      }),
      {},
      executionContext,
      authorization,
    );

    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error_code: "idempotency_conflict",
          retryable: false,
        },
      },
    });
    expect(harness.telemetry).toContainEqual({
      event: "mcp.tool_call.completed",
      outcome: "execution_error",
      service: "api",
      tool: "send_text_message",
    });
  });

  test("accepts 4096 astral Unicode scalar values", async () => {
    const harness = makeHarness({ scopes: ["messages:send"] });
    const response = await harness.handler(
      jsonRpcRequest("tools/call", {
        name: "send_text_message",
        arguments: {
          connection_id: "con_123456789012345678901",
          recipient_id: "ctc_123456789012345678901",
          text: "😀".repeat(4_096),
          idempotency_key: "123456789012345678901",
        },
      }),
      {},
      executionContext,
      authorization,
    );
    expect(await response.json()).toMatchObject({
      result: { structuredContent: { status: "accepted" } },
    });
  });

  test.each(["", " \n\t", "x".repeat(4_097)])(
    "rejects invalid exact text before the send service: %j",
    async (text) => {
      const harness = makeHarness({ scopes: ["messages:send"] });
      const response = await harness.handler(
        jsonRpcRequest("tools/call", {
          name: "send_text_message",
          arguments: {
            connection_id: "con_123456789012345678901",
            recipient_id: "ctc_123456789012345678901",
            text,
            idempotency_key: "123456789012345678901",
          },
        }),
        {},
        executionContext,
        authorization,
      );
      expect(await response.json()).toMatchObject({
        result: { isError: true },
      });
    },
  );
});
