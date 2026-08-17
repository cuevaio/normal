import {
  and,
  asc,
  eq,
  gt,
  gte,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { makeDatabase, makeQueryConnection } from "./database";
import type { McpAuthorizationScope } from "./mcp-authorization";
import { withPgRequestConnection } from "./request-connection";
import {
  activityLogsInApp,
  apiKeyConnectionsInApp,
  apiKeysInApp,
  ingestionGapsInApp,
  mcpAuthorizationConnectionsInApp,
  mcpAuthorizationsInApp,
  personalAccountsInApp,
  sendOperationsInApp,
  whatsappConnectionsInApp,
  whatsappGroupsInApp,
} from "./schema";

export interface McpToolConnection {
  readonly query: <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    text: string,
    values?: Array<unknown>,
  ) => Promise<{ readonly rows: Array<Row> }>;
}

export interface McpToolConnectionProvider {
  readonly withConnection: <Value>(
    use: (connection: McpToolConnection) => Promise<Value>,
  ) => Promise<Value>;
}

export interface McpAccessAuthorization {
  readonly authorizationId: string;
  readonly clientId?: string | undefined;
  readonly oauthSubject: string;
}

export interface McpToolConnectionRecord {
  readonly accountKey: AccountKeyEnvelope | null;
  readonly connectionId: string;
  readonly connectionKey: ConnectionKeyEnvelope | null;
  readonly displayName: McpToolDirectoryCiphertext | null;
  readonly displayNameFallback: string | null;
  readonly numberLastFour: string | null;
  readonly publicId: string;
  readonly state:
    | "connected"
    | "connecting"
    | "disconnected"
    | "reconnect_required"
    | "degraded";
  readonly stateChangedAt: string;
}

export type McpToolName =
  | "list_connections"
  | "list_contacts"
  | "list_groups"
  | "send_text_message"
  | "get_send_status"
  | "list_chats"
  | "read_messages"
  | "search_messages";

export interface McpStoredMediaReadMaterial {
  readonly accountKey: McpToolMessagePage["accountKey"];
  readonly connectionKey: McpToolMessagePage["connectionKey"];
  readonly mediaId: string;
  readonly metadata: McpToolDirectoryCiphertext;
  readonly objectKey: string;
  readonly plaintextSizeBytes: number;
}

export interface McpToolMessageRecord {
  readonly publicId: string;
  readonly messageIdentity: string;
  readonly sentAt: string;
  readonly direction: "inbound" | "outbound";
  readonly conversationKind: "direct" | "group";
  readonly contentType:
    | "audio"
    | "document"
    | "image"
    | "sticker"
    | "text"
    | "unknown"
    | "video";
  readonly content: McpToolDirectoryCiphertext | null;
  readonly editedAt?: string | null;
  readonly deleted?: boolean;
  readonly sender: {
    readonly displayName: McpToolDirectoryCiphertext | null;
    readonly phone: McpToolDirectoryCiphertext | null;
    readonly recordId: string;
  } | null;
  readonly media?: {
    readonly id: string;
    readonly publicId: string;
    readonly state: "failed" | "pending" | "ready" | "rejected";
    readonly plaintextSizeBytes: number | null;
    readonly metadata: McpToolDirectoryCiphertext | null;
  } | null;
}
export interface McpToolSendStatusRecord {
  readonly createdAt: string;
  readonly publicId: string;
  readonly status:
    | "processing"
    | "accepted"
    | "sent"
    | "delivered"
    | "read"
    | "failed"
    | "unknown";
  readonly statusChangedAt: string;
}
export interface McpToolMessagePage {
  readonly accountKey: AccountKeyEnvelope;
  readonly connectionKey: ConnectionKeyEnvelope;
  readonly conversation: {
    readonly kind: "direct" | "group";
    readonly publicId: string;
    readonly recipientId: string;
  };
  readonly messages: ReadonlyArray<McpToolMessageRecord>;
  readonly hasOlder: boolean;
  readonly sizeLimited: boolean;
  readonly historyStartsAt: string;
  readonly historyStartReason: "connection_started" | "retention_policy";
  readonly gaps: ReadonlyArray<{
    readonly startsAt: string;
    readonly endsAt: string | null;
    readonly cause:
      | "connection_unavailable"
      | "webhook_configuration"
      | "ingress_failure"
      | "processing_failure"
      | "restore_loss";
  }>;
}

export interface McpToolMessageSearchPage {
  readonly accountKey: AccountKeyEnvelope;
  readonly connectionKey: ConnectionKeyEnvelope;
  readonly messageSearchKey: McpToolDirectoryCiphertext;
  readonly messages: ReadonlyArray<
    Omit<
      Pick<
        McpToolMessageRecord,
        | "content"
        | "contentType"
        | "direction"
        | "editedAt"
        | "messageIdentity"
        | "publicId"
        | "sentAt"
      >,
      "content"
    > & {
      readonly content: McpToolDirectoryCiphertext;
      readonly conversationPublicId: string;
    }
  >;
  readonly hasMore: boolean;
  readonly sizeLimited: boolean;
  readonly coverage: {
    readonly historyStartsAt: string;
    readonly historyStartReason: "connection_started" | "retention_policy";
    readonly searchableHistoryStartsAt: string | null;
    readonly backfillComplete: boolean;
    readonly gaps: McpToolMessagePage["gaps"];
  };
}

export interface McpToolChatRecord {
  readonly conversationId: string;
  readonly kind: "direct" | "group";
  readonly recipientId: string;
  readonly displayName: McpToolDirectoryCiphertext | null;
  readonly displayNameRecordId: string;
  readonly displayNameEntity: "directory-contact" | "whatsapp-group";
  readonly phone: McpToolDirectoryCiphertext | null;
  readonly lastActivityAt: string;
  readonly lastActivityDirection: "inbound" | "outbound";
}
export interface McpToolChatPage {
  readonly accountKey: AccountKeyEnvelope | null;
  readonly connectionKey: ConnectionKeyEnvelope | null;
  readonly chats: ReadonlyArray<McpToolChatRecord>;
  readonly asOf: string;
  readonly stale: boolean;
  readonly partial: boolean;
}

export interface McpToolGroupRecord {
  readonly displayName: {
    readonly ciphertext: string;
    readonly keyVersion: number;
    readonly nonce: string;
    readonly version: 1;
  } | null;
  readonly id: string;
  readonly publicId: string;
}

export interface McpToolGroupPage {
  readonly accountKey: {
    readonly ciphertext: string;
    readonly keyVersion: number;
    readonly kmsKeyId: string;
    readonly personalAccountId: string;
    readonly version: 1;
  };
  readonly asOf: string;
  readonly connectionKey: {
    readonly accountKeyVersion: number;
    readonly ciphertext: string;
    readonly connectionId: string;
    readonly keyVersion: number;
    readonly nonce: string;
    readonly personalAccountId: string;
    readonly version: 1;
  };
  readonly groups: ReadonlyArray<McpToolGroupRecord>;
  readonly partial: boolean;
  readonly stale: boolean;
}

export interface McpToolGroupSearchMaterial {
  readonly accountKey: McpToolGroupPage["accountKey"];
  readonly connectionKey: McpToolGroupPage["connectionKey"];
  readonly identityKey: {
    readonly ciphertext: string;
    readonly keyVersion: number;
    readonly nonce: string;
    readonly version: 1;
  };
}

interface AccountKeyEnvelope {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly kmsKeyId: string;
  readonly personalAccountId: string;
  readonly version: 1;
}

interface ConnectionKeyEnvelope {
  readonly accountKeyVersion: number;
  readonly ciphertext: string;
  readonly connectionId: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly personalAccountId: string;
  readonly version: 1;
}

export interface McpToolDirectoryCiphertext {
  readonly ciphertext: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly version: 1;
}

export interface McpToolContactReadMaterial {
  readonly accountKey: AccountKeyEnvelope;
  readonly asOf: string;
  readonly connectionKey: ConnectionKeyEnvelope;
  readonly identityKey: McpToolDirectoryCiphertext;
  readonly partial: boolean;
  readonly personalAccountId: string;
  readonly stale: boolean;
  readonly whatsappConnectionId: string;
}

export interface McpToolEncryptedContactRecord {
  readonly conversationPublicId: string | null;
  readonly displayNameCiphertext: McpToolDirectoryCiphertext | null;
  readonly displayNameSort: string;
  readonly phoneCiphertext: McpToolDirectoryCiphertext | null;
  readonly providerIdentityIndex: string;
  readonly publicId: string;
}

export interface McpToolEncryptedContactPage {
  readonly asOf: string;
  readonly contacts: ReadonlyArray<McpToolEncryptedContactRecord>;
  readonly partial: boolean;
  readonly snapshotObservedAt: string | null;
  readonly stale: boolean;
}

export type RejectProtectedOperationResult =
  | "authorization_denied"
  | "rejected";

export type BeginProtectedOperationResult =
  | {
      readonly auditLogId: string;
      readonly outcome: "started" | "authorization_denied";
    }
  | {
      readonly auditLogId: string;
      readonly outcome: "rate_limited";
      readonly resetsAt: Date;
      readonly retryAfterSeconds: number;
    };

export interface ApiKeyActivityPrincipal {
  readonly grantId: string;
  readonly name: string;
  readonly publicId: string;
}

export type SendGrantIdentity =
  | {
      readonly kind: "mcp";
      readonly authorization: McpAccessAuthorization;
    }
  | {
      readonly kind: "api";
      readonly apiKey: ApiKeyActivityPrincipal & {
        readonly personalAccountId: string;
        readonly permissions: ReadonlyArray<string>;
      };
    };

export const mcpSendGrant = (
  authorization: McpAccessAuthorization,
): Extract<SendGrantIdentity, { kind: "mcp" }> => ({
  kind: "mcp",
  authorization,
});

export const apiSendGrant = (
  apiKey: Extract<SendGrantIdentity, { kind: "api" }>["apiKey"],
): Extract<SendGrantIdentity, { kind: "api" }> => ({
  kind: "api",
  apiKey,
});

export type BeginProtectedOperationInput = {
  readonly auditLogId: string;
  readonly connectionPublicId?: string;
  readonly hourLimit: number;
  readonly minuteLimit: number;
  readonly observedAt: Date;
  readonly operationName: string;
  readonly sendPublicId?: string;
} & (
  | {
      readonly channel: "mcp";
      readonly authorization: McpAccessAuthorization;
      readonly operationName: McpToolName;
    }
  | {
      readonly channel: "api";
      readonly apiKey: ApiKeyActivityPrincipal;
      readonly keyHourLimit: number;
      readonly keyMinuteLimit: number;
      readonly operationName: string;
      readonly permissions?: ReadonlyArray<string>;
      readonly personalAccountId: string;
      readonly requiredPermission?: string;
    }
);

export interface McpToolRepository {
  readonly failStoredMediaRead: (input: {
    readonly auditLogId: string;
    readonly completedAt: Date;
    readonly errorCode: string;
  }) => Promise<void>;
  readonly reserveStoredMediaRead: (
    input: McpAccessAuthorization & {
      readonly auditLogId: string;
      readonly connectionPublicId: string;
      readonly dailyByteLimit: number;
      readonly mediaPublicId: string;
      readonly messagePublicId: string;
      readonly observedAt: Date;
    },
  ) => Promise<McpStoredMediaReadMaterial | null>;
  readonly beginProtectedOperation: (
    input: BeginProtectedOperationInput,
  ) => Promise<BeginProtectedOperationResult>;
  readonly completeProtectedOperation: (input: {
    readonly auditLogId: string;
    readonly completedAt: Date;
    readonly errorCode: string | null;
    readonly outcome: "authorization_denied" | "execution_error" | "success";
    readonly resultCount: number | null;
  }) => Promise<void>;
  readonly inspectAuthorization: (
    input: McpAccessAuthorization & { readonly observedAt: Date },
  ) => Promise<{
    readonly scopes: ReadonlyArray<McpAuthorizationScope>;
  } | null>;
  readonly listConnections: (
    input: McpAccessAuthorization & {
      readonly authorizationContextEstablished?: true;
      readonly observedAt: Date;
    },
  ) => Promise<ReadonlyArray<McpToolConnectionRecord> | null>;
  readonly listApiKeyConnections: (input: {
    readonly apiKeyGrantId: string;
    readonly observedAt: Date;
    readonly personalAccountId: string;
  }) => Promise<ReadonlyArray<McpToolConnectionRecord> | null>;
  readonly getSendStatus: (input: {
    readonly connectionPublicId: string;
    readonly grant: SendGrantIdentity;
    readonly observedAt: Date;
    readonly sendPublicId: string;
  }) => Promise<McpToolSendStatusRecord | null>;
  readonly listGroups: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly observedAt: Date;
      readonly searchIndex: string | null;
    },
  ) => Promise<McpToolGroupPage | null>;
  readonly listChats: (
    input: McpAccessAuthorization & {
      readonly authorizationContextEstablished?: true;
      readonly connectionPublicId: string;
      readonly cursorActivityAt: string | null;
      readonly cursorPublicId: string | null;
      readonly kind: "all" | "direct" | "group";
      readonly limit: number;
      readonly observedAt: Date;
    },
  ) => Promise<McpToolChatPage | null>;
  readonly readMessages: (
    input: McpAccessAuthorization & {
      readonly auditLogId: string;
      readonly authorizationContextEstablished?: true;
      readonly connectionPublicId: string;
      readonly conversationPublicId: string;
      readonly cursorSentAt: string | null;
      readonly cursorPublicId: string | null;
      readonly dailyRecordLimit: number;
      readonly limit: number;
      readonly observedAt: Date;
    },
  ) => Promise<
    | { readonly outcome: "success"; readonly page: McpToolMessagePage }
    | { readonly outcome: "record_quota_exhausted"; readonly resetsAt: Date }
    | null
  >;
  readonly searchMessages: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly conversationPublicId: string | null;
      readonly cursorSentAt: string | null;
      readonly cursorPublicId: string | null;
      readonly direction: "all" | "inbound" | "outbound";
      readonly after: string | null;
      readonly before: string | null;
      readonly limit: number;
      readonly observedAt: Date;
      readonly searchTokens: ReadonlyArray<string> | null;
    },
  ) => Promise<McpToolMessageSearchPage | null>;
  readonly completeMessageRecordRead: (
    input: McpAccessAuthorization & {
      readonly auditLogId: string;
      readonly authorizationContextEstablished?: true;
      readonly dailyRecordLimit: number;
      readonly observedAt: Date;
      readonly resultCount: number;
    },
  ) => Promise<
    | { readonly outcome: "success" }
    | { readonly outcome: "record_quota_exhausted"; readonly resetsAt: Date }
  >;
  readonly loadGroupSearchMaterial: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly observedAt: Date;
    },
  ) => Promise<McpToolGroupSearchMaterial | null>;
  readonly loadContactReadMaterial: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly observedAt: Date;
    },
  ) => Promise<McpToolContactReadMaterial | null>;
  readonly listEncryptedContacts: (
    input: McpAccessAuthorization & {
      readonly connectionPublicId: string;
      readonly cursorDisplayNameSort: string | null;
      readonly cursorPublicId: string | null;
      readonly limit: number;
      readonly observedAt: Date;
      readonly searchIndex: string | null;
      readonly searchKind: "name" | "phone" | null;
    },
  ) => Promise<McpToolEncryptedContactPage | null>;
  readonly loadApiKeyContactReadMaterial: (input: {
    readonly apiKeyGrantId: string;
    readonly connectionPublicId: string;
    readonly observedAt: Date;
    readonly personalAccountId: string;
    readonly permissions: ReadonlyArray<string>;
  }) => Promise<McpToolContactReadMaterial | null>;
  readonly listApiKeyEncryptedContacts: (input: {
    readonly apiKeyGrantId: string;
    readonly connectionPublicId: string;
    readonly cursorDisplayNameSort: string | null;
    readonly cursorPublicId: string | null;
    readonly limit: number;
    readonly observedAt: Date;
    readonly permissions: ReadonlyArray<string>;
    readonly personalAccountId: string;
    readonly searchIndex: string | null;
    readonly searchKind: "name" | "phone" | null;
  }) => Promise<McpToolEncryptedContactPage | null>;
  readonly loadApiKeyGroupSearchMaterial: (input: {
    readonly apiKeyGrantId: string;
    readonly connectionPublicId: string;
    readonly observedAt: Date;
    readonly personalAccountId: string;
    readonly permissions: ReadonlyArray<string>;
  }) => Promise<McpToolGroupSearchMaterial | null>;
  readonly listApiKeyGroups: (input: {
    readonly apiKeyGrantId: string;
    readonly connectionPublicId: string;
    readonly observedAt: Date;
    readonly permissions: ReadonlyArray<string>;
    readonly personalAccountId: string;
    readonly searchIndex: string | null;
  }) => Promise<McpToolGroupPage | null>;
  readonly listApiKeyChats: (input: {
    readonly apiKeyGrantId: string;
    readonly connectionPublicId: string;
    readonly cursorActivityAt: string | null;
    readonly cursorPublicId: string | null;
    readonly kind: "all" | "direct" | "group";
    readonly limit: number;
    readonly observedAt: Date;
    readonly permissions: ReadonlyArray<string>;
    readonly personalAccountId: string;
  }) => Promise<McpToolChatPage | null>;
  readonly readApiKeyMessages: (input: {
    readonly apiKeyGrantId: string;
    readonly connectionPublicId: string;
    readonly conversationPublicId: string;
    readonly cursorPublicId: string | null;
    readonly cursorSentAt: string | null;
    readonly limit: number;
    readonly observedAt: Date;
    readonly permissions: ReadonlyArray<string>;
    readonly personalAccountId: string;
  }) => Promise<McpToolMessagePage | null>;
  readonly completeApiKeyMessageRecordRead: (input: {
    readonly apiKeyGrantId: string;
    readonly auditLogId: string;
    readonly dailyRecordLimit: number;
    readonly observedAt: Date;
    readonly personalAccountId: string;
    readonly resultCount: number;
  }) => Promise<
    | { readonly outcome: "success" }
    | { readonly outcome: "record_quota_exhausted"; readonly resetsAt: Date }
  >;
  readonly rejectProtectedOperation: (
    input: {
      readonly auditLogId: string;
      readonly connectionPublicId?: string;
      readonly errorCode: string;
      readonly observedAt: Date;
      readonly operationName: string;
    } & (
      | {
          readonly channel: "mcp";
          readonly authorization: McpAccessAuthorization;
        }
      | {
          readonly channel: "api";
          readonly apiKey: ApiKeyActivityPrincipal;
          readonly permissions?: ReadonlyArray<string>;
          readonly personalAccountId: string;
          readonly requiredPermission?: string;
        }
    ),
  ) => Promise<RejectProtectedOperationResult>;
}

const withTransaction = async <Value>(
  connection: McpToolConnection,
  use: () => Promise<Value>,
): Promise<Value> => {
  await connection.query("BEGIN");
  try {
    const value = await use();
    await connection.query("COMMIT");
    return value;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  }
};

const timestamp = (value: unknown): Date | null => {
  const parsed =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : null;
  return parsed !== null && Number.isFinite(parsed.valueOf()) ? parsed : null;
};

const timestampString = (value: unknown): string | null =>
  timestamp(value)?.toISOString() ?? null;

const requiredString = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("invalid text value");
  return value;
};

const bytes = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return new Uint8Array(value);
  }
  return null;
};

const base64 = (value: Uint8Array): string =>
  Buffer.from(value).toString("base64");

const positiveInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;

const persistedCiphertext = (
  row: Record<string, unknown>,
  prefix: string,
): McpToolDirectoryCiphertext | null => {
  const version = positiveInteger(row[`${prefix}_ciphertext_version`]);
  const keyVersion = positiveInteger(row[`${prefix}_key_version`]);
  const nonce = bytes(row[`${prefix}_nonce`]);
  const ciphertext = bytes(row[`${prefix}_ciphertext`]);
  return version === 1 &&
    keyVersion !== null &&
    nonce !== null &&
    ciphertext !== null
    ? {
        ciphertext: base64(ciphertext),
        keyVersion,
        nonce: base64(nonce),
        version: 1,
      }
    : null;
};

interface ParsedGroupKeyMaterial {
  readonly accountKey: McpToolGroupPage["accountKey"];
  readonly connectionKey: McpToolGroupPage["connectionKey"];
}

interface ParsedGroupMaterial extends ParsedGroupKeyMaterial {
  readonly asOf: string;
  readonly partial: boolean;
  readonly stale: boolean;
}

const parseGroupKeyMaterial = (
  row: Record<string, unknown> | undefined,
): ParsedGroupKeyMaterial | null => {
  if (row === undefined) return null;
  const personalAccountId = row.personal_account_id;
  const connectionId = row.connection_id;
  const accountVersion = positiveInteger(row.account_key_version);
  const accountCiphertext = bytes(row.account_key_ciphertext);
  const connectionAccountVersion = positiveInteger(
    row.connection_key_account_version,
  );
  const connectionVersion = positiveInteger(row.connection_key_version);
  const connectionNonce = bytes(row.connection_key_nonce);
  const connectionCiphertext = bytes(row.connection_key_ciphertext);
  if (
    typeof personalAccountId !== "string" ||
    typeof connectionId !== "string" ||
    typeof row.account_kms_key_id !== "string" ||
    accountVersion === null ||
    accountCiphertext === null ||
    connectionAccountVersion === null ||
    connectionVersion === null ||
    connectionNonce === null ||
    connectionCiphertext === null
  ) {
    throw new Error("invalid MCP group key material");
  }
  return {
    accountKey: {
      ciphertext: base64(accountCiphertext),
      keyVersion: accountVersion,
      kmsKeyId: row.account_kms_key_id,
      personalAccountId,
      version: 1,
    },
    connectionKey: {
      accountKeyVersion: connectionAccountVersion,
      ciphertext: base64(connectionCiphertext),
      connectionId,
      keyVersion: connectionVersion,
      nonce: base64(connectionNonce),
      personalAccountId,
      version: 1,
    },
  };
};

const parseGroupMaterial = (
  row: Record<string, unknown> | undefined,
): ParsedGroupMaterial | null => {
  const keyMaterial = parseGroupKeyMaterial(row);
  if (keyMaterial === null || row === undefined) return null;
  const asOf = timestampString(row.as_of ?? row.connection_created_at);
  if (
    asOf === null ||
    typeof row.stale !== "boolean" ||
    typeof row.partial !== "boolean"
  ) {
    throw new Error("invalid MCP group projection material");
  }
  return {
    ...keyMaterial,
    asOf,
    partial: row.partial,
    stale: row.stale,
  };
};

const parseGroupSearchMaterial = (
  row: Record<string, unknown> | undefined,
): McpToolGroupSearchMaterial | null => {
  const keyMaterial = parseGroupKeyMaterial(row);
  if (keyMaterial === null || row === undefined) return null;
  const identityVersion = positiveInteger(row.identity_ciphertext_version);
  const identityKeyVersion = positiveInteger(row.identity_key_version);
  const identityNonce = bytes(row.identity_nonce);
  const identityCiphertext = bytes(row.identity_ciphertext);
  if (
    identityVersion !== 1 ||
    identityKeyVersion === null ||
    identityNonce === null ||
    identityCiphertext === null
  ) {
    throw new Error("invalid MCP group search material");
  }
  return {
    ...keyMaterial,
    identityKey: {
      ciphertext: base64(identityCiphertext),
      keyVersion: identityKeyVersion,
      nonce: base64(identityNonce),
      version: 1,
    },
  };
};

const loadGroupProjectionMaterial = async (
  connection: McpToolConnection,
  input: McpAccessAuthorization & {
    readonly connectionPublicId: string;
    readonly observedAt: Date;
  },
): Promise<ParsedGroupMaterial | null> => {
  const db = makeDatabase(connection);
  const material = await db.execute<Record<string, unknown>>(sql`
    SELECT * FROM public.load_mcp_group_projection_material(
      ${input.authorizationId}, ${input.oauthSubject}, ${input.clientId ?? null},
      ${input.observedAt}, ${input.connectionPublicId}
    )
  `);
  const parsed = parseGroupMaterial(material[0]);
  if (parsed === null) return null;
  const freshness = await db.execute<Record<string, unknown>>(sql`SELECT
       CASE
         WHEN states.snapshot_observed_at IS NULL THEN true
         ELSE public.directory_projection_stale(
           states.personal_account_id,
           states.whatsapp_connection_id,
            ${input.observedAt},
           states.snapshot_observed_at,
           states.stale
         )
       END AS stale,
       CASE
         WHEN states.snapshot_observed_at IS NULL THEN true
         ELSE public.directory_projection_partial(
           states.personal_account_id,
           states.whatsapp_connection_id,
           states.snapshot_observed_at,
           states.partial,
           states.retention_limited
         )
       END AS partial
     FROM public.whatsapp_group_directory_states AS states
     WHERE states.personal_account_id = ${parsed.accountKey.personalAccountId}
       AND states.whatsapp_connection_id = ${parsed.connectionKey.connectionId}`);
  const row = freshness[0];
  if (row === undefined) return { ...parsed, partial: true, stale: true };
  if (typeof row.stale !== "boolean" || typeof row.partial !== "boolean") {
    throw new Error("invalid MCP group projection freshness");
  }
  return { ...parsed, partial: row.partial, stale: row.stale };
};

const mapStoredMessageRow = (
  message: Record<string, unknown>,
): McpToolMessageRecord => {
  const directoryCiphertext = (
    prefix: "sender_display" | "sender_phone",
  ): McpToolDirectoryCiphertext | null => {
    const ciphertext = bytes(message[`${prefix}_ciphertext`]);
    const nonce = bytes(message[`${prefix}_nonce`]);
    const version = positiveInteger(message[`${prefix}_version`]);
    const keyVersion = positiveInteger(message[`${prefix}_key_version`]);
    if (
      ciphertext === null &&
      nonce === null &&
      version === null &&
      keyVersion === null
    )
      return null;
    if (
      ciphertext === null ||
      nonce?.byteLength !== 12 ||
      version !== 1 ||
      keyVersion === null
    )
      throw new Error("invalid message sender ciphertext");
    return {
      ciphertext: base64(ciphertext),
      keyVersion,
      nonce: base64(nonce),
      version: 1,
    };
  };
  const sentAt = timestampString(message.sent_at);
  const ciphertext = bytes(message.content_ciphertext);
  const nonce = bytes(message.content_nonce);
  const keyVersion = positiveInteger(message.content_key_version);
  const editedAt =
    message.edited_at === null ? null : timestampString(message.edited_at);
  const deleted = timestamp(message.deleted_at) !== null;
  const mediaState = message.media_state;
  const mediaCiphertext = bytes(message.metadata_ciphertext);
  const mediaNonce = bytes(message.metadata_nonce);
  const mediaKeyVersion = positiveInteger(message.metadata_key_version);
  const senderRecordId = message.sender_record_id;
  const sender =
    message.direction === "inbound" &&
    message.kind === "direct" &&
    typeof senderRecordId === "string"
      ? {
          displayName: directoryCiphertext("sender_display"),
          phone: directoryCiphertext("sender_phone"),
          recordId: senderRecordId,
        }
      : null;
  const media =
    mediaState === null || mediaState === undefined
      ? null
      : typeof message.media_id === "string" &&
          typeof message.media_public_id === "string" &&
          (mediaState === "pending" ||
            mediaState === "ready" ||
            mediaState === "rejected" ||
            mediaState === "failed")
        ? {
            id: message.media_id,
            publicId: message.media_public_id,
            state: mediaState as "failed" | "pending" | "ready" | "rejected",
            plaintextSizeBytes:
              message.plaintext_size_bytes === null
                ? null
                : Number(message.plaintext_size_bytes),
            metadata:
              mediaState === "ready" &&
              message.metadata_ciphertext_version === 1 &&
              mediaCiphertext !== null &&
              mediaNonce !== null &&
              mediaKeyVersion !== null
                ? {
                    ciphertext: base64(mediaCiphertext),
                    keyVersion: mediaKeyVersion,
                    nonce: base64(mediaNonce),
                    version: 1 as const,
                  }
                : null,
          }
        : (() => {
            throw new Error("invalid Stored Media");
          })();
  if (
    typeof message.public_id !== "string" ||
    typeof message.message_identity !== "string" ||
    sentAt === null ||
    (message.direction !== "inbound" && message.direction !== "outbound") ||
    (message.kind !== "direct" && message.kind !== "group") ||
    (!deleted &&
      (typeof message.content_type !== "string" ||
        ![
          "audio",
          "document",
          "image",
          "sticker",
          "text",
          "unknown",
          "video",
        ].includes(message.content_type))) ||
    (!deleted && message.content_ciphertext_version !== 1) ||
    (!deleted &&
      (ciphertext === null || nonce === null || keyVersion === null)) ||
    (message.edited_at !== null && editedAt === null)
  )
    throw new Error("invalid Stored Message");
  return {
    publicId: message.public_id,
    messageIdentity: message.message_identity,
    sentAt,
    direction: message.direction,
    conversationKind: message.kind,
    contentType: deleted
      ? "unknown"
      : (message.content_type as McpToolMessageRecord["contentType"]),
    content: deleted
      ? null
      : {
          ciphertext: base64(ciphertext as Uint8Array),
          keyVersion: keyVersion as number,
          nonce: base64(nonce as Uint8Array),
          version: 1,
        },
    editedAt,
    deleted,
    sender,
    media,
  };
};

const selectStoredMessageRows = (
  input: {
    readonly conversationPublicId: string;
    readonly cursorPublicId: string | null;
    readonly cursorSentAt: string | null;
    readonly historyStart: Date;
    readonly limit: number;
  },
  accountId: string,
  connectionId: string,
) => sql`
           SELECT messages.public_id, messages.message_identity, messages.sent_at, messages.direction,
             messages.content_type, messages.content_ciphertext_version, messages.content_key_version,
             messages.content_nonce, messages.content_ciphertext, messages.edited_at,
             messages.deleted_at, conversations.kind, media.id AS media_id, media.public_id AS media_public_id,
             media.state AS media_state, media.plaintext_size_bytes,
             media.metadata_ciphertext_version,media.metadata_key_version,
             media.metadata_nonce,media.metadata_ciphertext,
             sender.provider_identity_index AS sender_record_id,
             sender.display_name_ciphertext_version AS sender_display_version,
             sender.display_name_key_version AS sender_display_key_version,
             sender.display_name_nonce AS sender_display_nonce,
             sender.display_name_ciphertext AS sender_display_ciphertext,
             sender.phone_ciphertext_version AS sender_phone_version,
             sender.phone_key_version AS sender_phone_key_version,
             sender.phone_nonce AS sender_phone_nonce,
             sender.phone_ciphertext AS sender_phone_ciphertext
           FROM public.stored_messages messages
           JOIN public.whatsapp_conversations conversations ON conversations.personal_account_id=messages.personal_account_id AND conversations.whatsapp_connection_id=messages.whatsapp_connection_id AND conversations.id=messages.conversation_id
           LEFT JOIN public.stored_media media ON media.personal_account_id=messages.personal_account_id
             AND media.whatsapp_connection_id=messages.whatsapp_connection_id AND media.stored_message_id=messages.id
           LEFT JOIN public.directory_contacts sender ON messages.direction='inbound'
             AND conversations.kind='direct'
             AND sender.personal_account_id=messages.personal_account_id
             AND sender.whatsapp_connection_id=messages.whatsapp_connection_id
             AND sender.provider_identity_index=conversations.recipient_locator
           WHERE messages.personal_account_id=${accountId}
             AND messages.whatsapp_connection_id=${connectionId}
             AND messages.content_expired_at IS NULL
             AND conversations.public_id=${input.conversationPublicId}
             AND messages.sent_at >= ${input.historyStart}
             AND (${input.cursorSentAt}::timestamptz IS NULL
               OR messages.sent_at < ${input.cursorSentAt}
               OR (messages.sent_at=${input.cursorSentAt}
                 AND messages.public_id < ${input.cursorPublicId}))
           ORDER BY messages.sent_at DESC, messages.public_id DESC
            LIMIT ${input.limit + 1}`;

const takeMessageRows = (
  rows: ReadonlyArray<Record<string, unknown>>,
  limit: number,
  ciphertextBudget: number | null,
): {
  readonly hasOlder: boolean;
  readonly messages: ReadonlyArray<McpToolMessageRecord>;
  readonly sizeLimited: boolean;
} => {
  const candidateRows = rows.slice(0, limit);
  const returnedRows: Array<Record<string, unknown>> = [];
  let encryptedBytes = 0;
  for (const candidate of candidateRows) {
    const ciphertext = bytes(candidate.content_ciphertext);
    if (ciphertext === null && candidate.deleted_at === null)
      throw new Error("invalid Stored Message ciphertext");
    if (
      ciphertextBudget !== null &&
      returnedRows.length > 0 &&
      encryptedBytes + (ciphertext?.byteLength ?? 0) > ciphertextBudget
    )
      break;
    returnedRows.push(candidate);
    encryptedBytes += ciphertext?.byteLength ?? 0;
  }
  return {
    hasOlder:
      rows.length > candidateRows.length ||
      returnedRows.length < candidateRows.length,
    messages: returnedRows.map(mapStoredMessageRow),
    sizeLimited:
      ciphertextBudget !== null &&
      (returnedRows.length < candidateRows.length ||
        encryptedBytes > ciphertextBudget),
  };
};

const loadIntersectingGaps = async (
  db: ReturnType<typeof makeDatabase>,
  input: {
    readonly accountId: string;
    readonly connectionId: string;
    readonly historyStart: Date;
    readonly newest: string;
  },
): Promise<McpToolMessagePage["gaps"]> => {
  const gapsResult = await db
    .select({
      starts_at: ingestionGapsInApp.startsAt,
      ends_at: ingestionGapsInApp.endsAt,
      cause: ingestionGapsInApp.cause,
    })
    .from(ingestionGapsInApp)
    .where(
      and(
        eq(ingestionGapsInApp.personalAccountId, input.accountId),
        eq(ingestionGapsInApp.whatsappConnectionId, input.connectionId),
        lte(ingestionGapsInApp.startsAt, input.newest),
        or(
          isNull(ingestionGapsInApp.endsAt),
          gte(ingestionGapsInApp.endsAt, input.historyStart.toISOString()),
        ),
      ),
    )
    .orderBy(asc(ingestionGapsInApp.startsAt), asc(ingestionGapsInApp.id));
  return gapsResult.map((gap) => {
    const startsAt = timestampString(gap.starts_at);
    const endsAt = gap.ends_at === null ? null : timestampString(gap.ends_at);
    if (
      startsAt === null ||
      (gap.ends_at !== null && endsAt === null) ||
      typeof gap.cause !== "string"
    )
      throw new Error("invalid Ingestion Gap");
    return {
      startsAt,
      endsAt,
      cause: gap.cause as McpToolMessagePage["gaps"][number]["cause"],
    };
  });
};

const historyWindow = (
  connectionStarted: Date,
  retentionDays: number | null,
  observedAt: Date,
): {
  readonly historyStart: Date;
  readonly historyStartReason: McpToolMessagePage["historyStartReason"];
} => {
  const retentionStart =
    retentionDays === null
      ? connectionStarted
      : new Date(observedAt.valueOf() - retentionDays * 86_400_000);
  const historyStart =
    retentionStart > connectionStarted ? retentionStart : connectionStarted;
  return {
    historyStart,
    historyStartReason:
      retentionDays !== null &&
      historyStart.valueOf() === retentionStart.valueOf()
        ? "retention_policy"
        : "connection_started",
  };
};

const encryptedGroupRecords = (
  persistedGroups: ReadonlyArray<{
    readonly display_name_ciphertext: unknown;
    readonly display_name_ciphertext_version: unknown;
    readonly display_name_key_version: unknown;
    readonly display_name_nonce: unknown;
    readonly id: unknown;
    readonly public_id: unknown;
  }>,
): ReadonlyArray<McpToolGroupRecord> =>
  persistedGroups.map((group) => {
    const id = group.id;
    const publicId = group.public_id;
    const ciphertext = bytes(group.display_name_ciphertext);
    const nonce = bytes(group.display_name_nonce);
    const version = positiveInteger(group.display_name_ciphertext_version);
    const keyVersion = positiveInteger(group.display_name_key_version);
    if (
      typeof id !== "string" ||
      typeof publicId !== "string" ||
      !/^grp_[A-Za-z0-9_-]{21}$/u.test(publicId)
    ) {
      throw new Error("invalid persisted WhatsApp group");
    }
    if (
      ciphertext === null &&
      nonce === null &&
      version === null &&
      keyVersion === null
    ) {
      return { displayName: null, id, publicId };
    }
    if (
      ciphertext === null ||
      nonce === null ||
      version !== 1 ||
      keyVersion === null
    ) {
      throw new Error("invalid encrypted WhatsApp group display name");
    }
    return {
      displayName: {
        ciphertext: base64(ciphertext),
        keyVersion,
        nonce: base64(nonce),
        version: 1 as const,
      },
      id,
      publicId,
    };
  });

const loadGroupIndexMaterial = async (
  connection: McpToolConnection,
  input: McpAccessAuthorization & {
    readonly connectionPublicId: string;
    readonly observedAt: Date;
  },
): Promise<McpToolGroupSearchMaterial | null> => {
  const material = await makeDatabase(connection).execute<
    Record<string, unknown>
  >(
    sql`
      SELECT * FROM public.load_mcp_group_search_material(
        ${input.authorizationId}, ${input.oauthSubject}, ${input.clientId ?? null},
        ${input.observedAt}, ${input.connectionPublicId}
      )
    `,
  );
  return parseGroupSearchMaterial(material[0]);
};

const encodeBase64 = (value: Uint8Array): string =>
  Buffer.from(value).toString("base64");

interface ContactMaterialRow extends Record<string, unknown> {
  readonly account_key_ciphertext: unknown;
  readonly account_key_version: unknown;
  readonly account_kms_key_id: unknown;
  readonly connection_key_account_version: unknown;
  readonly connection_key_ciphertext: unknown;
  readonly connection_key_nonce: unknown;
  readonly connection_key_version: unknown;
  readonly identity_ciphertext: unknown;
  readonly identity_ciphertext_version: unknown;
  readonly identity_key_version: unknown;
  readonly identity_nonce: unknown;
  readonly personal_account_id: unknown;
  readonly projection_as_of: unknown;
  readonly projection_partial: unknown;
  readonly projection_stale: unknown;
  readonly whatsapp_connection_id: unknown;
}

const contactReadMaterial = (
  row: ContactMaterialRow | undefined,
): McpToolContactReadMaterial | null => {
  if (row === undefined) return null;
  const accountCiphertext = bytes(row.account_key_ciphertext);
  const accountVersion = positiveInteger(row.account_key_version);
  const connectionAccountVersion = positiveInteger(
    row.connection_key_account_version,
  );
  const connectionCiphertext = bytes(row.connection_key_ciphertext);
  const connectionNonce = bytes(row.connection_key_nonce);
  const connectionVersion = positiveInteger(row.connection_key_version);
  const identityCiphertext = bytes(row.identity_ciphertext);
  const identityNonce = bytes(row.identity_nonce);
  const identityVersion = positiveInteger(row.identity_key_version);
  const asOf = timestampString(row.projection_as_of);
  if (
    typeof row.personal_account_id !== "string" ||
    typeof row.whatsapp_connection_id !== "string" ||
    typeof row.account_kms_key_id !== "string" ||
    row.account_kms_key_id.length === 0 ||
    accountCiphertext === null ||
    accountVersion === null ||
    connectionAccountVersion === null ||
    connectionCiphertext === null ||
    connectionNonce?.byteLength !== 12 ||
    connectionVersion === null ||
    row.identity_ciphertext_version !== 1 ||
    identityCiphertext === null ||
    identityNonce?.byteLength !== 12 ||
    identityVersion === null ||
    typeof row.projection_stale !== "boolean" ||
    typeof row.projection_partial !== "boolean" ||
    asOf === null
  ) {
    throw new Error("invalid MCP Directory read material");
  }
  return {
    accountKey: {
      ciphertext: encodeBase64(accountCiphertext),
      keyVersion: accountVersion,
      kmsKeyId: row.account_kms_key_id,
      personalAccountId: row.personal_account_id,
      version: 1,
    },
    asOf,
    connectionKey: {
      accountKeyVersion: connectionAccountVersion,
      ciphertext: encodeBase64(connectionCiphertext),
      connectionId: row.whatsapp_connection_id,
      keyVersion: connectionVersion,
      nonce: encodeBase64(connectionNonce),
      personalAccountId: row.personal_account_id,
      version: 1,
    },
    identityKey: {
      ciphertext: encodeBase64(identityCiphertext),
      keyVersion: identityVersion,
      nonce: encodeBase64(identityNonce),
      version: 1,
    },
    partial: row.projection_partial,
    personalAccountId: row.personal_account_id,
    stale: row.projection_stale,
    whatsappConnectionId: row.whatsapp_connection_id,
  };
};

const enterAuthorizationContext = async (
  connection: McpToolConnection,
  input: McpAccessAuthorization,
  transactionLocal = false,
): Promise<string | null> => {
  const db = makeDatabase(connection);
  const result = await db.execute<{
    personal_account_id: unknown;
  }>(sql`
    WITH authorized AS MATERIALIZED (
      SELECT public.bootstrap_mcp_tool_call(
        ${input.authorizationId}, ${input.oauthSubject}, ${input.clientId ?? null}
      ) AS personal_account_id
    ), context AS MATERIALIZED (
      SELECT set_config(
        'public.personal_account_id',
        COALESCE((SELECT personal_account_id::text FROM authorized), ''),
        ${transactionLocal}
      )
    )
    SELECT authorized.personal_account_id
    FROM authorized
    CROSS JOIN context
  `);
  const personalAccountId = result[0]?.personal_account_id;
  return typeof personalAccountId === "string" ? personalAccountId : null;
};

const authorizationScopes = (
  value: unknown,
): ReadonlyArray<McpAuthorizationScope> | null => {
  if (!Array.isArray(value)) return null;
  const validScopes = new Set<McpAuthorizationScope>([
    "connections:read",
    "directory:read",
    "messages:read",
    "messages:send",
  ]);
  return value.every(
    (scope): scope is McpAuthorizationScope =>
      typeof scope === "string" &&
      validScopes.has(scope as McpAuthorizationScope),
  )
    ? value
    : null;
};

const loadAuthorizationScopes = async (
  connection: McpToolConnection,
  input: McpAccessAuthorization & { readonly observedAt: Date },
): Promise<ReadonlyArray<McpAuthorizationScope> | null> => {
  const db = makeDatabase(connection);
  const result = await db.execute<{ scopes: unknown }>(sql`
    WITH active AS MATERIALIZED (
      SELECT public.bootstrap_active_mcp_tool_call(
        ${input.authorizationId}, ${input.oauthSubject},
        ${input.clientId ?? null}, ${input.observedAt}
      ) AS personal_account_id
    )
    SELECT authorizations.scopes
    FROM active
    JOIN public.mcp_authorizations authorizations
      ON authorizations.id = ${input.authorizationId}
     AND authorizations.personal_account_id = active.personal_account_id
     AND authorizations.oauth_subject = ${input.oauthSubject}
     AND (
       ${input.clientId ?? null}::text IS NULL
       OR authorizations.client_id = ${input.clientId ?? null}
     )
  `);
  return authorizationScopes(result[0]?.scopes);
};

const insertActivityLog = (
  connection: McpToolConnection,
  input: {
    readonly apiKey?: ApiKeyActivityPrincipal | undefined;
    readonly auditLogId: string;
    readonly authorizationId: string | null;
    readonly channel?: "api" | "mcp";
    readonly completed: boolean;
    readonly connectionPublicId?: string | undefined;
    readonly errorCode: string | null;
    readonly observedAt: Date;
    readonly outcome:
      | "started"
      | "rate_limited"
      | "authorization_denied"
      | "execution_error";
    readonly personalAccountId: string;
    readonly quotaReserved: boolean;
    readonly sendPublicId?: string | undefined;
    readonly toolName: string;
  },
) =>
  makeDatabase(connection)
    .insert(activityLogsInApp)
    .values({
      id: input.auditLogId,
      personalAccountId: input.personalAccountId,
      mcpAuthorizationId: input.authorizationId,
      channel: input.channel ?? "mcp",
      apiKeyId: input.apiKey?.grantId ?? null,
      apiKeyPublicId: input.apiKey?.publicId ?? null,
      apiKeyName: input.apiKey?.name ?? null,
      toolName: input.toolName,
      startedAt: input.observedAt.toISOString(),
      completedAt: input.completed ? input.observedAt.toISOString() : null,
      outcome: input.outcome,
      errorCode: input.errorCode,
      resultCount: null,
      latencyMs: input.completed ? 0 : null,
      quotaReserved: input.quotaReserved,
      expiresAt: new Date(
        input.observedAt.valueOf() + 90 * 86_400_000,
      ).toISOString(),
      connectionPublicId: input.connectionPublicId ?? null,
      sendPublicId: input.sendPublicId ?? null,
    });

const enterAccountContext = async (
  connection: McpToolConnection,
  personalAccountId: string,
): Promise<string | null> => {
  const db = makeDatabase(connection);
  await db.execute(
    sql`SELECT set_config('public.personal_account_id', ${personalAccountId}, true)`,
  );
  const account = await db
    .select({ id: personalAccountsInApp.id })
    .from(personalAccountsInApp)
    .where(
      and(
        eq(personalAccountsInApp.id, personalAccountId),
        eq(personalAccountsInApp.state, "active"),
      ),
    );
  return account[0]?.id ?? null;
};

const loadGrantedConnections = async (
  connection: McpToolConnection,
  grant:
    | { readonly kind: "api"; readonly apiKeyId: string }
    | { readonly kind: "mcp"; readonly authorizationId: string },
): Promise<ReadonlyArray<McpToolConnectionRecord>> => {
  const db = makeDatabase(connection);
  const selectedTable =
    grant.kind === "api"
      ? sql`public.api_key_connections`
      : sql`public.mcp_authorization_connections`;
  const grantPredicate =
    grant.kind === "api"
      ? sql`selected.api_key_id = ${grant.apiKeyId}`
      : sql`selected.mcp_authorization_id = ${grant.authorizationId}`;
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT
      account_keys.ciphertext AS account_key_ciphertext,
      account_keys.key_version AS account_key_version,
      account_keys.kms_key_id AS account_kms_key_id,
      connections.id AS connection_id,
      connection_keys.account_key_version AS connection_key_account_version,
      connection_keys.ciphertext AS connection_key_ciphertext,
      connection_keys.nonce AS connection_key_nonce,
      connection_keys.key_version AS connection_key_version,
      connections.display_name_ciphertext AS display_name_ciphertext,
      connections.display_name_ciphertext_version AS display_name_ciphertext_version,
      connections.display_name_fallback AS display_name_fallback,
      connections.display_name_key_version AS display_name_key_version,
      connections.display_name_nonce AS display_name_nonce,
      connections.personal_account_id AS personal_account_id,
      connections.number_suffix AS number_last_four,
      connections.public_id AS public_id,
      connections.state AS state,
      connections.state_changed_at AS state_changed_at
    FROM ${selectedTable} AS selected
    JOIN public.whatsapp_connections AS connections
      ON connections.personal_account_id = selected.personal_account_id
     AND connections.id = selected.whatsapp_connection_id
    LEFT JOIN public.personal_account_key_envelopes AS account_keys
      ON account_keys.personal_account_id = connections.personal_account_id
     AND account_keys.unavailable_at IS NULL
    LEFT JOIN public.whatsapp_connection_key_envelopes AS connection_keys
      ON connection_keys.personal_account_id = connections.personal_account_id
     AND connection_keys.whatsapp_connection_id = connections.id
     AND connection_keys.unavailable_at IS NULL
    WHERE ${grantPredicate}
      AND connections.state <> 'deleting'
    ORDER BY connections.created_at, connections.public_id
  `);
  return result.map((row) => {
    const state = row.state;
    const stateChangedAt = timestampString(row.state_changed_at);
    const accountCiphertext = bytes(row.account_key_ciphertext);
    const accountVersion = positiveInteger(row.account_key_version);
    const connectionKeyCiphertext = bytes(row.connection_key_ciphertext);
    const connectionKeyNonce = bytes(row.connection_key_nonce);
    const connectionKeyVersion = positiveInteger(row.connection_key_version);
    const connectionKeyAccountVersion = positiveInteger(
      row.connection_key_account_version,
    );
    const displayName = persistedCiphertext(row, "display_name");
    const displayNameFallback =
      typeof row.display_name_fallback === "string"
        ? row.display_name_fallback
        : null;
    const hasEncryptedName = displayName !== null;
    const hasEncryptionMaterial =
      accountCiphertext !== null &&
      accountVersion !== null &&
      typeof row.account_kms_key_id === "string" &&
      connectionKeyCiphertext !== null &&
      connectionKeyNonce !== null &&
      connectionKeyVersion !== null &&
      connectionKeyAccountVersion !== null;
    if (
      typeof row.personal_account_id !== "string" ||
      typeof row.connection_id !== "string" ||
      hasEncryptedName === (displayNameFallback !== null) ||
      (hasEncryptedName && !hasEncryptionMaterial) ||
      (row.number_last_four !== null &&
        (typeof row.number_last_four !== "string" ||
          !/^[0-9]{4}$/u.test(row.number_last_four))) ||
      typeof row.public_id !== "string" ||
      !/^con_[A-Za-z0-9_-]{21}$/u.test(row.public_id) ||
      (state !== "connected" &&
        state !== "connecting" &&
        state !== "disconnected" &&
        state !== "reconnect_required" &&
        state !== "degraded") ||
      stateChangedAt === null
    ) {
      throw new Error("invalid persisted WhatsApp Connection");
    }
    return {
      accountKey: hasEncryptedName
        ? {
            ciphertext: base64(accountCiphertext as Uint8Array),
            keyVersion: accountVersion as number,
            kmsKeyId: row.account_kms_key_id as string,
            personalAccountId: row.personal_account_id,
            version: 1 as const,
          }
        : null,
      connectionId: row.connection_id,
      connectionKey: hasEncryptedName
        ? {
            accountKeyVersion: connectionKeyAccountVersion as number,
            ciphertext: base64(connectionKeyCiphertext as Uint8Array),
            connectionId: row.connection_id,
            keyVersion: connectionKeyVersion as number,
            nonce: base64(connectionKeyNonce as Uint8Array),
            personalAccountId: row.personal_account_id,
            version: 1 as const,
          }
        : null,
      displayName,
      displayNameFallback,
      numberLastFour: row.number_last_four,
      publicId: row.public_id,
      state,
      stateChangedAt,
    };
  });
};

const requestQuotaExhausted = (
  starts: ReadonlyArray<Date>,
  observedAt: Date,
  minuteLimit: number,
  hourLimit: number,
): Date | null => {
  const minuteFloor = new Date(observedAt.valueOf() - 60_000);
  const minuteStarts = starts.filter((value) => value > minuteFloor);
  const exhaustedResets: Array<Date> = [];
  if (minuteStarts.length >= minuteLimit) {
    exhaustedResets.push(
      new Date(
        (minuteStarts[minuteStarts.length - minuteLimit] as Date).valueOf() +
          60_000,
      ),
    );
  }
  if (starts.length >= hourLimit) {
    exhaustedResets.push(
      new Date(
        (starts[starts.length - hourLimit] as Date).valueOf() + 3_600_000,
      ),
    );
  }
  return exhaustedResets.length === 0
    ? null
    : new Date(Math.max(...exhaustedResets.map((value) => value.valueOf())));
};

const parseReservedStarts = (
  rows: ReadonlyArray<{ readonly started_at: unknown }>,
): Array<Date> => {
  const starts = rows.map(({ started_at }) => timestamp(started_at));
  if (starts.includes(null)) {
    throw new Error("invalid Activity Log timestamp");
  }
  return starts as Array<Date>;
};

const lockAccountAndListReservedStarts = async (
  connection: McpToolConnection,
  personalAccountId: string,
  observedAt: Date,
) => {
  const db = makeDatabase(connection);
  const locked = await db
    .select({ id: personalAccountsInApp.id })
    .from(personalAccountsInApp)
    .where(
      and(
        eq(personalAccountsInApp.id, personalAccountId),
        eq(personalAccountsInApp.state, "active"),
      ),
    )
    .for("update");
  if (locked.length !== 1) {
    return null;
  }
  return db.execute<{
    api_key_id: unknown;
    started_at: unknown;
  }>(sql`
    SELECT logs.started_at, logs.api_key_id
    FROM public.tool_call_logs logs
    WHERE logs.personal_account_id = ${personalAccountId}
      AND logs.quota_reserved = true
      AND logs.started_at > ${observedAt}::timestamptz - interval '1 hour'
    ORDER BY logs.started_at, logs.id
  `);
};

const requiredScope = (toolName: McpToolName): McpAuthorizationScope =>
  toolName === "list_connections"
    ? "connections:read"
    : toolName === "send_text_message" || toolName === "get_send_status"
      ? "messages:send"
      : toolName === "list_chats"
        ? "messages:read"
        : toolName === "read_messages" || toolName === "search_messages"
          ? "messages:read"
          : "directory:read";

type BeginMcpProtectedOperationInput = McpAccessAuthorization & {
  readonly auditLogId: string;
  readonly connectionPublicId?: string;
  readonly hourLimit: number;
  readonly minuteLimit: number;
  readonly observedAt: Date;
  readonly sendPublicId?: string;
  readonly operationName: McpToolName;
};

type RejectMcpProtectedOperationInput = McpAccessAuthorization & {
  readonly auditLogId: string;
  readonly connectionPublicId?: string;
  readonly errorCode: string;
  readonly observedAt: Date;
  readonly sendPublicId?: string;
  readonly operationName:
    | "list_connections"
    | "list_contacts"
    | "search_messages";
};

const beginMcpProtectedOperation = (
  provider: McpToolConnectionProvider,
  input: BeginMcpProtectedOperationInput,
): Promise<BeginProtectedOperationResult> =>
  provider.withConnection((connection) =>
    withTransaction(connection, async () => {
      if (
        !Number.isSafeInteger(input.minuteLimit) ||
        input.minuteLimit < 1 ||
        !Number.isSafeInteger(input.hourLimit) ||
        input.hourLimit < input.minuteLimit
      ) {
        throw new Error("invalid MCP request quota");
      }
      const personalAccountId = await enterAuthorizationContext(
        connection,
        input,
      );
      if (personalAccountId === null) {
        return {
          auditLogId: input.auditLogId,
          outcome: "authorization_denied" as const,
        };
      }
      const scopes = await loadAuthorizationScopes(connection, input);
      if (
        scopes === null ||
        !scopes.includes(requiredScope(input.operationName))
      ) {
        await insertActivityLog(connection, {
          auditLogId: input.auditLogId,
          authorizationId: input.authorizationId,
          completed: true,
          connectionPublicId: input.connectionPublicId,
          errorCode: "authorization_denied",
          observedAt: input.observedAt,
          outcome: "authorization_denied",
          personalAccountId,
          quotaReserved: false,
          sendPublicId: input.sendPublicId,
          toolName: input.operationName,
        });
        return {
          auditLogId: input.auditLogId,
          outcome: "authorization_denied" as const,
        };
      }

      const recent = await lockAccountAndListReservedStarts(
        connection,
        personalAccountId,
        input.observedAt,
      );
      if (recent === null) {
        return {
          auditLogId: input.auditLogId,
          outcome: "authorization_denied" as const,
        };
      }
      const starts = parseReservedStarts(recent);
      const resetsAt = requestQuotaExhausted(
        starts,
        input.observedAt,
        input.minuteLimit,
        input.hourLimit,
      );
      if (resetsAt !== null) {
        await insertActivityLog(connection, {
          auditLogId: input.auditLogId,
          authorizationId: input.authorizationId,
          completed: true,
          connectionPublicId: input.connectionPublicId,
          errorCode: "rate_limited",
          observedAt: input.observedAt,
          outcome: "rate_limited",
          personalAccountId,
          quotaReserved: false,
          sendPublicId: input.sendPublicId,
          toolName: input.operationName,
        });
        return {
          auditLogId: input.auditLogId,
          outcome: "rate_limited" as const,
          resetsAt,
          retryAfterSeconds: Math.max(
            0,
            Math.ceil(
              (resetsAt.valueOf() - input.observedAt.valueOf()) / 1_000,
            ),
          ),
        };
      }

      await insertActivityLog(connection, {
        auditLogId: input.auditLogId,
        authorizationId: input.authorizationId,
        completed: false,
        connectionPublicId: input.connectionPublicId,
        errorCode: null,
        observedAt: input.observedAt,
        outcome: "started",
        personalAccountId,
        quotaReserved: true,
        sendPublicId: input.sendPublicId,
        toolName: input.operationName,
      });
      return {
        auditLogId: input.auditLogId,
        outcome: "started" as const,
      };
    }),
  );

const rejectMcpProtectedOperation = (
  provider: McpToolConnectionProvider,
  input: RejectMcpProtectedOperationInput,
): Promise<RejectProtectedOperationResult> =>
  provider.withConnection((connection) =>
    withTransaction(connection, async () => {
      const personalAccountId = await enterAuthorizationContext(
        connection,
        input,
      );
      if (personalAccountId === null) return "authorization_denied" as const;
      const scopes = await loadAuthorizationScopes(connection, input);
      if (
        scopes === null ||
        !scopes.includes(requiredScope(input.operationName))
      ) {
        await insertActivityLog(connection, {
          auditLogId: input.auditLogId,
          authorizationId: input.authorizationId,
          completed: true,
          connectionPublicId: input.connectionPublicId,
          errorCode: "authorization_denied",
          observedAt: input.observedAt,
          outcome: "authorization_denied",
          personalAccountId,
          quotaReserved: false,
          sendPublicId: input.sendPublicId,
          toolName: input.operationName,
        });
        return "authorization_denied" as const;
      }
      await insertActivityLog(connection, {
        auditLogId: input.auditLogId,
        authorizationId: input.authorizationId,
        completed: true,
        connectionPublicId: input.connectionPublicId,
        errorCode: input.errorCode,
        observedAt: input.observedAt,
        outcome: "execution_error",
        personalAccountId,
        quotaReserved: false,
        sendPublicId: input.sendPublicId,
        toolName: input.operationName,
      });
      return "rejected" as const;
    }),
  );

export const makeMcpToolRepository = (
  provider: McpToolConnectionProvider,
): McpToolRepository => ({
  failStoredMediaRead: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        const loaded = await db.execute<{
          personal_account_id: unknown;
        }>(sql`SELECT public.bootstrap_tool_call_log(${input.auditLogId})
             AS personal_account_id`);
        const personalAccountId = loaded[0]?.personal_account_id;
        if (typeof personalAccountId !== "string")
          throw new Error("Activity Log unavailable");
        await db.execute(
          sql`SELECT set_config('public.personal_account_id', ${personalAccountId}, true)`,
        );
        const updated = await db
          .update(activityLogsInApp)
          .set({
            completedAt: input.completedAt.toISOString(),
            outcome: "execution_error",
            errorCode: input.errorCode,
            resultCount: 0,
            mediaBytesReserved: 0,
            latencyMs: sql`GREATEST(0, floor(extract(epoch FROM (${input.completedAt}::timestamptz - ${activityLogsInApp.startedAt})) * 1000)::integer)`,
          })
          .where(
            and(
              eq(activityLogsInApp.id, input.auditLogId),
              eq(activityLogsInApp.toolName, "read_stored_media"),
              eq(activityLogsInApp.outcome, "started"),
            ),
          )
          .returning({ id: activityLogsInApp.id });
        if (updated.length !== 1)
          throw new Error("Stored Media Activity Log unavailable");
      }),
    ),
  reserveStoredMediaRead: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if (
          !Number.isSafeInteger(input.dailyByteLimit) ||
          input.dailyByteLimit < 1
        )
          throw new Error("invalid Stored Media byte quota");
        const accountId = await enterAuthorizationContext(connection, input);
        if (accountId === null) return null;
        const scopes = await loadAuthorizationScopes(connection, input);
        if (scopes === null || !scopes.includes("messages:read")) return null;
        await db
          .select({ id: personalAccountsInApp.id })
          .from(personalAccountsInApp)
          .where(eq(personalAccountsInApp.id, accountId))
          .for("update");
        const loaded = await db.execute<Record<string, unknown>>(sql`
          SELECT * FROM public.load_protected_stored_media(
            ${input.authorizationId}, ${input.connectionPublicId},
            ${input.messagePublicId}, ${input.mediaPublicId}
          )
        `);
        const row = loaded[0];
        const size = Number(row?.plaintext_size_bytes);
        const used = await db
          .select({
            used: sql<unknown>`COALESCE(sum(${activityLogsInApp.mediaBytesReserved}), 0)`,
          })
          .from(activityLogsInApp)
          .where(
            and(
              eq(activityLogsInApp.personalAccountId, accountId),
              gte(
                activityLogsInApp.startedAt,
                sql`date_trunc('day', ${input.observedAt}::timestamptz)`,
              ),
              lt(
                activityLogsInApp.startedAt,
                sql`date_trunc('day', ${input.observedAt}::timestamptz) + interval '1 day'`,
              ),
            ),
          );
        if (
          row === undefined ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          Number(used[0]?.used ?? 0) + size > input.dailyByteLimit
        )
          return null;
        await insertActivityLog(connection, {
          auditLogId: input.auditLogId,
          authorizationId: input.authorizationId,
          completed: false,
          connectionPublicId: input.connectionPublicId,
          errorCode: null,
          observedAt: input.observedAt,
          outcome: "started",
          personalAccountId: accountId,
          quotaReserved: true,
          toolName: "read_stored_media",
        });
        await db
          .update(activityLogsInApp)
          .set({ mediaBytesReserved: size })
          .where(eq(activityLogsInApp.id, input.auditLogId));
        const accountCiphertext = bytes(row.account_key_ciphertext);
        const connectionCiphertext = bytes(row.connection_key_ciphertext);
        const connectionNonce = bytes(row.connection_key_nonce);
        const metadataCiphertext = bytes(row.metadata_ciphertext);
        const metadataNonce = bytes(row.metadata_nonce);
        if (
          typeof row.media_id !== "string" ||
          typeof row.object_key !== "string" ||
          typeof row.connection_id !== "string" ||
          typeof row.kms_key_id !== "string" ||
          accountCiphertext === null ||
          connectionCiphertext === null ||
          connectionNonce === null ||
          metadataCiphertext === null ||
          metadataNonce === null
        )
          throw new Error("invalid Stored Media read material");
        return {
          accountKey: {
            ciphertext: base64(accountCiphertext),
            keyVersion: Number(row.account_key_version),
            kmsKeyId: row.kms_key_id,
            personalAccountId: accountId,
            version: 1,
          },
          connectionKey: {
            accountKeyVersion: Number(row.connection_account_key_version),
            ciphertext: base64(connectionCiphertext),
            connectionId: row.connection_id,
            keyVersion: Number(row.connection_key_version),
            nonce: base64(connectionNonce),
            personalAccountId: accountId,
            version: 1,
          },
          mediaId: row.media_id,
          metadata: {
            ciphertext: base64(metadataCiphertext),
            keyVersion: Number(row.metadata_key_version),
            nonce: base64(metadataNonce),
            version: 1,
          },
          objectKey: row.object_key,
          plaintextSizeBytes: size,
        };
      }),
    ),
  inspectAuthorization: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if ((await enterAuthorizationContext(connection, input)) === null) {
          return null;
        }
        const scopes = await loadAuthorizationScopes(connection, input);
        return scopes === null ? null : { scopes };
      }),
    ),
  beginProtectedOperation: (input) =>
    input.channel === "mcp"
      ? beginMcpProtectedOperation(provider, {
          ...input.authorization,
          auditLogId: input.auditLogId,
          hourLimit: input.hourLimit,
          minuteLimit: input.minuteLimit,
          observedAt: input.observedAt,
          operationName: input.operationName,
          ...(input.connectionPublicId === undefined
            ? {}
            : { connectionPublicId: input.connectionPublicId }),
          ...(input.sendPublicId === undefined
            ? {}
            : { sendPublicId: input.sendPublicId }),
        })
      : provider.withConnection((connection) =>
          withTransaction(connection, async () => {
            if (
              !Number.isSafeInteger(input.minuteLimit) ||
              input.minuteLimit < 1 ||
              !Number.isSafeInteger(input.hourLimit) ||
              input.hourLimit < input.minuteLimit ||
              !Number.isSafeInteger(input.keyMinuteLimit) ||
              input.keyMinuteLimit < 1 ||
              !Number.isSafeInteger(input.keyHourLimit) ||
              input.keyHourLimit < input.keyMinuteLimit
            ) {
              throw new Error("invalid API request quota");
            }
            const apiKeyName = input.apiKey.name.trim();
            if (
              apiKeyName.length < 1 ||
              apiKeyName.length > 64 ||
              !/^apk_[A-Za-z0-9_-]{21}$/u.test(input.apiKey.publicId) ||
              !/^[a-z][a-z0-9_]{0,63}$/u.test(input.operationName)
            ) {
              throw new Error("invalid API Activity Log principal");
            }
            const personalAccountId = await enterAccountContext(
              connection,
              input.personalAccountId,
            );
            if (personalAccountId === null) {
              return {
                auditLogId: input.auditLogId,
                outcome: "authorization_denied" as const,
              };
            }
            if (
              input.requiredPermission !== undefined &&
              !(input.permissions ?? []).includes(input.requiredPermission)
            ) {
              const apiKey = { ...input.apiKey, name: apiKeyName };
              await insertActivityLog(connection, {
                apiKey,
                auditLogId: input.auditLogId,
                authorizationId: null,
                channel: "api",
                completed: true,
                connectionPublicId: input.connectionPublicId,
                errorCode: "authorization_denied",
                observedAt: input.observedAt,
                outcome: "authorization_denied",
                personalAccountId,
                quotaReserved: false,
                sendPublicId: input.sendPublicId,
                toolName: input.operationName,
              });
              return {
                auditLogId: input.auditLogId,
                outcome: "authorization_denied" as const,
              };
            }

            const recent = await lockAccountAndListReservedStarts(
              connection,
              personalAccountId,
              input.observedAt,
            );
            if (recent === null) {
              return {
                auditLogId: input.auditLogId,
                outcome: "authorization_denied" as const,
              };
            }
            const accountStarts = parseReservedStarts(recent);
            const keyStarts = parseReservedStarts(
              recent.filter((row) => row.api_key_id === input.apiKey.grantId),
            );
            const resetsAt = [
              requestQuotaExhausted(
                accountStarts,
                input.observedAt,
                input.minuteLimit,
                input.hourLimit,
              ),
              requestQuotaExhausted(
                keyStarts,
                input.observedAt,
                input.keyMinuteLimit,
                input.keyHourLimit,
              ),
            ].reduce<Date | null>((latest, candidate) => {
              if (candidate === null) return latest;
              if (latest === null) return candidate;
              return candidate.valueOf() > latest.valueOf()
                ? candidate
                : latest;
            }, null);
            const apiKey = { ...input.apiKey, name: apiKeyName };
            if (resetsAt !== null) {
              await insertActivityLog(connection, {
                apiKey,
                auditLogId: input.auditLogId,
                authorizationId: null,
                channel: "api",
                completed: true,
                connectionPublicId: input.connectionPublicId,
                errorCode: "rate_limited",
                observedAt: input.observedAt,
                outcome: "rate_limited",
                personalAccountId,
                quotaReserved: false,
                sendPublicId: input.sendPublicId,
                toolName: input.operationName,
              });
              return {
                auditLogId: input.auditLogId,
                outcome: "rate_limited" as const,
                resetsAt,
                retryAfterSeconds: Math.max(
                  0,
                  Math.ceil(
                    (resetsAt.valueOf() - input.observedAt.valueOf()) / 1_000,
                  ),
                ),
              };
            }

            await insertActivityLog(connection, {
              apiKey,
              auditLogId: input.auditLogId,
              authorizationId: null,
              channel: "api",
              completed: false,
              connectionPublicId: input.connectionPublicId,
              errorCode: null,
              observedAt: input.observedAt,
              outcome: "started",
              personalAccountId,
              quotaReserved: true,
              sendPublicId: input.sendPublicId,
              toolName: input.operationName,
            });
            return {
              auditLogId: input.auditLogId,
              outcome: "started" as const,
            };
          }),
        ),
  listConnections: (input) =>
    provider.withConnection((connection) =>
      (async () => {
        if (
          input.authorizationContextEstablished !== true &&
          (await enterAuthorizationContext(connection, input)) === null
        ) {
          return null;
        }
        const scopes = await loadAuthorizationScopes(connection, input);
        if (scopes === null || !scopes.includes("connections:read")) {
          return null;
        }
        return loadGrantedConnections(connection, {
          authorizationId: input.authorizationId,
          kind: "mcp",
        });
      })(),
    ),
  listApiKeyConnections: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if (
          (await enterAccountContext(connection, input.personalAccountId)) ===
          null
        ) {
          return null;
        }
        const db = makeDatabase(connection);
        const grants = await db
          .select({
            expiresAt: apiKeysInApp.expiresAt,
            permissions: apiKeysInApp.permissions,
            state: apiKeysInApp.state,
          })
          .from(apiKeysInApp)
          .where(eq(apiKeysInApp.id, input.apiKeyGrantId));
        const grant = grants[0];
        if (
          grant === undefined ||
          grant.state !== "active" ||
          (grant.expiresAt !== null &&
            new Date(grant.expiresAt) <= input.observedAt) ||
          !grant.permissions.includes("connections:read")
        ) {
          return null;
        }
        return loadGrantedConnections(connection, {
          apiKeyId: input.apiKeyGrantId,
          kind: "api",
        });
      }),
    ),
  getSendStatus: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if (input.grant.kind === "mcp") {
          if (
            (await enterAuthorizationContext(
              connection,
              input.grant.authorization,
            )) === null
          )
            return null;
        } else if (
          (await enterAccountContext(
            connection,
            input.grant.apiKey.personalAccountId,
          )) === null
        ) {
          return null;
        }
        const result =
          input.grant.kind === "mcp"
            ? await db
                .select({
                  public_id: sendOperationsInApp.publicId,
                  status: sendOperationsInApp.status,
                  created_at: sendOperationsInApp.createdAt,
                  status_changed_at: sendOperationsInApp.statusChangedAt,
                })
                .from(sendOperationsInApp)
                .innerJoin(
                  whatsappConnectionsInApp,
                  and(
                    eq(
                      whatsappConnectionsInApp.personalAccountId,
                      sendOperationsInApp.personalAccountId,
                    ),
                    eq(
                      whatsappConnectionsInApp.id,
                      sendOperationsInApp.whatsappConnectionId,
                    ),
                  ),
                )
                .innerJoin(
                  mcpAuthorizationsInApp,
                  and(
                    eq(
                      mcpAuthorizationsInApp.personalAccountId,
                      sendOperationsInApp.personalAccountId,
                    ),
                    eq(
                      mcpAuthorizationsInApp.id,
                      sendOperationsInApp.mcpAuthorizationId,
                    ),
                  ),
                )
                .innerJoin(
                  mcpAuthorizationConnectionsInApp,
                  and(
                    eq(
                      mcpAuthorizationConnectionsInApp.personalAccountId,
                      sendOperationsInApp.personalAccountId,
                    ),
                    eq(
                      mcpAuthorizationConnectionsInApp.mcpAuthorizationId,
                      mcpAuthorizationsInApp.id,
                    ),
                    eq(
                      mcpAuthorizationConnectionsInApp.whatsappConnectionId,
                      whatsappConnectionsInApp.id,
                    ),
                  ),
                )
                .where(
                  and(
                    eq(sendOperationsInApp.grantType, "mcp"),
                    eq(
                      sendOperationsInApp.mcpAuthorizationId,
                      input.grant.authorization.authorizationId,
                    ),
                    eq(sendOperationsInApp.publicId, input.sendPublicId),
                    eq(
                      whatsappConnectionsInApp.publicId,
                      input.connectionPublicId,
                    ),
                    gt(
                      sendOperationsInApp.expiresAt,
                      input.observedAt.toISOString(),
                    ),
                    ne(whatsappConnectionsInApp.state, "deleting"),
                    sql`${"messages:send"} = ANY(${mcpAuthorizationsInApp.scopes})`,
                  ),
                )
            : await db
                .select({
                  public_id: sendOperationsInApp.publicId,
                  status: sendOperationsInApp.status,
                  created_at: sendOperationsInApp.createdAt,
                  status_changed_at: sendOperationsInApp.statusChangedAt,
                })
                .from(sendOperationsInApp)
                .innerJoin(
                  whatsappConnectionsInApp,
                  and(
                    eq(
                      whatsappConnectionsInApp.personalAccountId,
                      sendOperationsInApp.personalAccountId,
                    ),
                    eq(
                      whatsappConnectionsInApp.id,
                      sendOperationsInApp.whatsappConnectionId,
                    ),
                  ),
                )
                .innerJoin(
                  apiKeysInApp,
                  and(
                    eq(
                      apiKeysInApp.personalAccountId,
                      sendOperationsInApp.personalAccountId,
                    ),
                    eq(apiKeysInApp.id, sendOperationsInApp.apiKeyId),
                  ),
                )
                .innerJoin(
                  apiKeyConnectionsInApp,
                  and(
                    eq(
                      apiKeyConnectionsInApp.personalAccountId,
                      sendOperationsInApp.personalAccountId,
                    ),
                    eq(apiKeyConnectionsInApp.apiKeyId, apiKeysInApp.id),
                    eq(
                      apiKeyConnectionsInApp.whatsappConnectionId,
                      whatsappConnectionsInApp.id,
                    ),
                  ),
                )
                .where(
                  and(
                    eq(sendOperationsInApp.grantType, "api"),
                    eq(
                      sendOperationsInApp.apiKeyId,
                      input.grant.apiKey.grantId,
                    ),
                    eq(sendOperationsInApp.publicId, input.sendPublicId),
                    eq(
                      whatsappConnectionsInApp.publicId,
                      input.connectionPublicId,
                    ),
                    gt(
                      sendOperationsInApp.expiresAt,
                      input.observedAt.toISOString(),
                    ),
                    ne(whatsappConnectionsInApp.state, "deleting"),
                    eq(apiKeysInApp.state, "active"),
                    sql`${"messages:send"} = ANY(${apiKeysInApp.permissions})`,
                    or(
                      isNull(apiKeysInApp.expiresAt),
                      gt(
                        apiKeysInApp.expiresAt,
                        input.observedAt.toISOString(),
                      ),
                    ),
                  ),
                );
        const row = result[0];
        if (row === undefined) return null;
        return {
          createdAt:
            timestampString(row.created_at) ??
            (() => {
              throw new Error("invalid send timestamp");
            })(),
          publicId: requiredString(row.public_id),
          status: requiredString(
            row.status,
          ) as McpToolSendStatusRecord["status"],
          statusChangedAt:
            timestampString(row.status_changed_at) ??
            (() => {
              throw new Error("invalid send timestamp");
            })(),
        };
      }),
    ),
  listChats: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if (
          !/^con_[A-Za-z0-9_-]{21}$/u.test(input.connectionPublicId) ||
          !Number.isSafeInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 51 ||
          (input.cursorActivityAt === null) !==
            (input.cursorPublicId === null) ||
          (input.cursorPublicId !== null &&
            !/^cvs_[A-Za-z0-9_-]{21}$/u.test(input.cursorPublicId))
        ) {
          throw new Error("invalid MCP chat query");
        }
        if ((await enterAuthorizationContext(connection, input, true)) === null)
          return null;
        const result = await db.execute<Record<string, unknown>>(sql`
          WITH projection AS MATERIALIZED (
            SELECT
              connections.personal_account_id,
              connections.id AS connection_id,
              connections.created_at AS connection_created_at,
              greatest(
                coalesce(contacts.as_of, connections.created_at),
                coalesce(groups.as_of, connections.created_at)
              ) AS as_of,
              (coalesce(contacts.stale, true)
                OR coalesce(groups.stale, true)) AS stale,
              (coalesce(contacts.partial, true)
                OR coalesce(groups.partial, true)) AS partial,
              (
                SELECT conversations.public_id
                FROM public.whatsapp_conversations conversations
                WHERE conversations.personal_account_id =
                    connections.personal_account_id
                  AND conversations.whatsapp_connection_id = connections.id
                ORDER BY conversations.created_at
                LIMIT 1
              ) AS conversation_public_id
            FROM public.mcp_authorizations authorizations
            JOIN public.mcp_authorization_connections selected
              ON selected.personal_account_id =
                  authorizations.personal_account_id
             AND selected.mcp_authorization_id = authorizations.id
            JOIN public.whatsapp_connections connections
              ON connections.personal_account_id = selected.personal_account_id
             AND connections.id = selected.whatsapp_connection_id
            LEFT JOIN public.directory_contact_projections contacts
              ON contacts.personal_account_id = connections.personal_account_id
             AND contacts.whatsapp_connection_id = connections.id
            LEFT JOIN public.whatsapp_group_directory_states groups
              ON groups.personal_account_id = connections.personal_account_id
             AND groups.whatsapp_connection_id = connections.id
            WHERE authorizations.id = ${input.authorizationId}
              AND authorizations.oauth_subject = ${input.oauthSubject}
              AND (
                ${input.clientId ?? null}::text IS NULL
                OR authorizations.client_id = ${input.clientId ?? null}
              )
              AND authorizations.personal_account_id =
                public.bootstrap_active_mcp_tool_call(
                  ${input.authorizationId}, ${input.oauthSubject},
                  ${input.clientId ?? null}, ${input.observedAt}
                )
              AND 'messages:read' = ANY(authorizations.scopes)
              AND connections.public_id = ${input.connectionPublicId}
              AND connections.state <> 'deleting'
          ), material AS MATERIALIZED (
            SELECT read_material.*
            FROM projection
            CROSS JOIN LATERAL public.load_mcp_message_read_material(
              ${input.authorizationId}, ${input.oauthSubject},
              ${input.clientId ?? null}, ${input.observedAt},
              ${input.connectionPublicId}, projection.conversation_public_id
            ) read_material
            WHERE projection.conversation_public_id IS NOT NULL
          ), chats AS MATERIALIZED (
            SELECT
              conversations.public_id,
              conversations.kind,
              coalesce(
                contacts.public_id,
                groups.public_id,
                conversations.recipient_public_id
              ) AS recipient_public_id,
              conversations.last_activity_at,
              conversations.last_activity_direction,
              coalesce(
                contacts.provider_identity_index,
                groups.id::text,
                conversations.recipient_public_id
              ) AS recipient_record_id,
              coalesce(
                contacts.display_name_ciphertext_version,
                groups.display_name_ciphertext_version
              ) AS display_version,
              coalesce(
                contacts.display_name_key_version,
                groups.display_name_key_version
              ) AS display_key_version,
              coalesce(
                contacts.display_name_nonce,
                groups.display_name_nonce
              ) AS display_nonce,
              coalesce(
                contacts.display_name_ciphertext,
                groups.display_name_ciphertext
              ) AS display_ciphertext,
              contacts.phone_ciphertext_version AS phone_version,
              contacts.phone_key_version,
              contacts.phone_nonce,
              contacts.phone_ciphertext
            FROM projection
            JOIN public.whatsapp_conversations conversations
              ON conversations.personal_account_id =
                  projection.personal_account_id
             AND conversations.whatsapp_connection_id =
                  projection.connection_id
            LEFT JOIN public.directory_contacts contacts
              ON conversations.kind = 'direct'
             AND contacts.personal_account_id =
                  conversations.personal_account_id
             AND contacts.whatsapp_connection_id =
                  conversations.whatsapp_connection_id
             AND contacts.provider_identity_index =
                  conversations.recipient_locator
            LEFT JOIN public.whatsapp_groups groups
              ON conversations.kind = 'group'
             AND groups.personal_account_id =
                  conversations.personal_account_id
             AND groups.whatsapp_connection_id =
                  conversations.whatsapp_connection_id
             AND groups.provider_locator = conversations.recipient_locator
            WHERE NOT public.whatsapp_recipient_excluded(
                conversations.personal_account_id,
                conversations.whatsapp_connection_id,
                CASE WHEN conversations.kind = 'group' THEN 'group' ELSE 'contact' END,
                conversations.recipient_locator
              )
              AND EXISTS (
              SELECT 1
              FROM public.stored_messages retained
              WHERE retained.personal_account_id =
                  conversations.personal_account_id
                AND retained.whatsapp_connection_id =
                  conversations.whatsapp_connection_id
                AND retained.conversation_id = conversations.id
                AND retained.content_expired_at IS NULL
            )
              AND (${input.kind} = 'all' OR conversations.kind = ${input.kind})
              AND (
                ${input.cursorActivityAt}::timestamptz IS NULL
                OR conversations.last_activity_at < ${input.cursorActivityAt}
                OR (
                  conversations.last_activity_at = ${input.cursorActivityAt}
                  AND conversations.public_id > ${input.cursorPublicId}
                )
              )
            ORDER BY conversations.last_activity_at DESC,
              conversations.public_id
            LIMIT ${input.limit}
          )
          SELECT
            projection.personal_account_id AS projection_personal_account_id,
            projection.connection_id AS projection_connection_id,
            projection.connection_created_at,
            projection.as_of AS projection_as_of,
            projection.stale AS projection_stale,
            projection.partial AS projection_partial,
            material.*,
            chats.*
          FROM projection
          LEFT JOIN material ON true
          LEFT JOIN chats ON true
          ORDER BY chats.last_activity_at DESC, chats.public_id
        `);
        const projection = result[0];
        const personalAccountId = projection?.projection_personal_account_id;
        const connectionId = projection?.projection_connection_id;
        const asOf = timestampString(
          projection?.projection_as_of ?? projection?.connection_created_at,
        );
        if (
          typeof personalAccountId !== "string" ||
          typeof connectionId !== "string" ||
          asOf === null ||
          typeof projection?.projection_stale !== "boolean" ||
          typeof projection.projection_partial !== "boolean"
        ) {
          return null;
        }
        const keyMaterial = parseGroupKeyMaterial(projection);
        const rows = result.filter((row) => typeof row.public_id === "string");
        const encrypted = (
          row: Record<string, unknown>,
          prefix: "display" | "phone",
        ): McpToolDirectoryCiphertext | null => {
          const ciphertext = bytes(row[`${prefix}_ciphertext`]);
          const nonce = bytes(row[`${prefix}_nonce`]);
          const version = positiveInteger(row[`${prefix}_version`]);
          const keyVersion = positiveInteger(
            row[
              prefix === "display" ? "display_key_version" : "phone_key_version"
            ],
          );
          if (
            ciphertext === null &&
            nonce === null &&
            version === null &&
            keyVersion === null
          )
            return null;
          if (
            ciphertext === null ||
            nonce === null ||
            version !== 1 ||
            keyVersion === null
          )
            throw new Error("invalid chat metadata ciphertext");
          return {
            ciphertext: base64(ciphertext),
            nonce: base64(nonce),
            keyVersion,
            version: 1,
          };
        };
        return {
          accountKey: keyMaterial?.accountKey ?? null,
          asOf,
          connectionKey: keyMaterial?.connectionKey ?? null,
          partial: projection.projection_partial,
          stale: projection.projection_stale,
          chats: rows.map((row) => {
            const activity = timestampString(row.last_activity_at);
            if (
              typeof row.public_id !== "string" ||
              typeof row.recipient_public_id !== "string" ||
              typeof row.recipient_record_id !== "string" ||
              activity === null ||
              (row.kind !== "direct" && row.kind !== "group") ||
              (row.last_activity_direction !== "inbound" &&
                row.last_activity_direction !== "outbound")
            )
              throw new Error("invalid WhatsApp Conversation");
            return {
              conversationId: row.public_id,
              kind: row.kind,
              recipientId: row.recipient_public_id,
              displayName: encrypted(row, "display"),
              displayNameRecordId: row.recipient_record_id,
              displayNameEntity:
                row.kind === "direct" ? "directory-contact" : "whatsapp-group",
              phone: encrypted(row, "phone"),
              lastActivityAt: activity,
              lastActivityDirection: row.last_activity_direction,
            };
          }),
        };
      }),
    ),
  readMessages: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if (
          !/^con_[A-Za-z0-9_-]{21}$/u.test(input.connectionPublicId) ||
          !/^cvs_[A-Za-z0-9_-]{21}$/u.test(input.conversationPublicId) ||
          !Number.isSafeInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 51 ||
          !Number.isSafeInteger(input.dailyRecordLimit) ||
          input.dailyRecordLimit < 1 ||
          (input.cursorSentAt === null) !== (input.cursorPublicId === null) ||
          (input.cursorPublicId !== null &&
            !/^msg_[A-Za-z0-9_-]{21}$/u.test(input.cursorPublicId))
        )
          throw new Error("invalid MCP message query");
        if ((await enterAuthorizationContext(connection, input, true)) === null)
          return null;
        const materialResult = await db.execute<Record<string, unknown>>(sql`
          WITH read_material AS MATERIALIZED (
            SELECT * FROM public.load_mcp_message_read_material(
              ${input.authorizationId}, ${input.oauthSubject}, ${input.clientId ?? null},
              ${input.observedAt}, ${input.connectionPublicId},
              ${input.conversationPublicId}
            )
          )
          SELECT read_material.*,
            conversations.public_id AS conversation_public_id,
            conversations.kind AS conversation_kind,
            coalesce(
              contacts.public_id,
              groups.public_id,
              conversations.recipient_public_id
            ) AS recipient_public_id
          FROM read_material
          JOIN public.whatsapp_conversations AS conversations
            ON conversations.personal_account_id = read_material.personal_account_id
           AND conversations.whatsapp_connection_id = read_material.connection_id
           AND conversations.public_id = ${input.conversationPublicId}
          LEFT JOIN public.directory_contacts AS contacts
            ON conversations.kind = 'direct'
           AND contacts.personal_account_id = conversations.personal_account_id
           AND contacts.whatsapp_connection_id = conversations.whatsapp_connection_id
           AND contacts.provider_identity_index = conversations.recipient_locator
          LEFT JOIN public.whatsapp_groups AS groups
            ON conversations.kind = 'group'
           AND groups.personal_account_id = conversations.personal_account_id
           AND groups.whatsapp_connection_id = conversations.whatsapp_connection_id
           AND groups.provider_locator = conversations.recipient_locator
        `);
        const row = materialResult[0];
        const accountId =
          typeof row?.personal_account_id === "string"
            ? row.personal_account_id
            : null;
        const connectionId =
          typeof row?.connection_id === "string" ? row.connection_id : null;
        const materialRow = row;
        const accountCiphertext = bytes(materialRow?.account_key_ciphertext);
        const accountKeyVersion = positiveInteger(
          materialRow?.account_key_version,
        );
        const connectionAccountKeyVersion = positiveInteger(
          materialRow?.connection_key_account_version,
        );
        const connectionCiphertext = bytes(
          materialRow?.connection_key_ciphertext,
        );
        const connectionKeyVersion = positiveInteger(
          materialRow?.connection_key_version,
        );
        const connectionNonce = bytes(materialRow?.connection_key_nonce);
        const material =
          accountId === null ||
          connectionId === null ||
          typeof materialRow?.account_kms_key_id !== "string" ||
          accountCiphertext === null ||
          accountKeyVersion === null ||
          connectionAccountKeyVersion === null ||
          connectionCiphertext === null ||
          connectionKeyVersion === null ||
          connectionNonce?.byteLength !== 12
            ? null
            : {
                accountKey: {
                  ciphertext: base64(accountCiphertext),
                  keyVersion: accountKeyVersion,
                  kmsKeyId: materialRow.account_kms_key_id,
                  personalAccountId: accountId,
                  version: 1 as const,
                },
                connectionKey: {
                  accountKeyVersion: connectionAccountKeyVersion,
                  ciphertext: base64(connectionCiphertext),
                  connectionId,
                  keyVersion: connectionKeyVersion,
                  nonce: base64(connectionNonce),
                  personalAccountId: accountId,
                  version: 1 as const,
                },
              };
        const connectionStarted = timestamp(row?.connection_created_at);
        const retentionDays =
          row?.message_retention_days === null
            ? null
            : positiveInteger(row?.message_retention_days);
        const conversationPublicId = row?.conversation_public_id;
        const conversationKind = row?.conversation_kind;
        const recipientPublicId = row?.recipient_public_id;
        if (
          material === null ||
          connectionStarted === null ||
          typeof conversationPublicId !== "string" ||
          !/^cvs_[A-Za-z0-9_-]{21}$/u.test(conversationPublicId) ||
          (conversationKind !== "direct" && conversationKind !== "group") ||
          typeof recipientPublicId !== "string" ||
          !/^(ctc|grp)_[A-Za-z0-9_-]{21}$/u.test(recipientPublicId)
        )
          return null;
        const { historyStart, historyStartReason } = historyWindow(
          connectionStarted,
          retentionDays,
          input.observedAt,
        );
        const rows = await db.execute<Record<string, unknown>>(
          selectStoredMessageRows(
            {
              conversationPublicId: input.conversationPublicId,
              cursorPublicId: input.cursorPublicId,
              cursorSentAt: input.cursorSentAt,
              historyStart,
              limit: input.limit,
            },
            material.accountKey.personalAccountId,
            material.connectionKey.connectionId,
          ),
        );
        const pageRows = takeMessageRows(rows, input.limit, 24_000);
        const newest =
          pageRows.messages[0]?.sentAt ?? input.observedAt.toISOString();
        const gaps = await loadIntersectingGaps(db, {
          accountId: material.accountKey.personalAccountId,
          connectionId: material.connectionKey.connectionId,
          historyStart,
          newest,
        });
        return {
          outcome: "success" as const,
          page: {
            ...material,
            conversation: {
              kind: conversationKind,
              publicId: conversationPublicId,
              recipientId: recipientPublicId,
            },
            messages: pageRows.messages,
            hasOlder: pageRows.hasOlder,
            sizeLimited: pageRows.sizeLimited,
            historyStartsAt: historyStart.toISOString(),
            historyStartReason,
            gaps,
          },
        };
      }),
    ),
  searchMessages: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if (
          !/^con_[A-Za-z0-9_-]{21}$/u.test(input.connectionPublicId) ||
          (input.conversationPublicId !== null &&
            !/^cvs_[A-Za-z0-9_-]{21}$/u.test(input.conversationPublicId)) ||
          !Number.isSafeInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 20 ||
          (input.searchTokens !== null &&
            (input.searchTokens.length < 1 ||
              input.searchTokens.length > 8 ||
              new Set(input.searchTokens).size !== input.searchTokens.length ||
              input.searchTokens.some(
                (token) => !/^msi1_[A-Za-z0-9_-]{43}$/u.test(token),
              ))) ||
          (input.cursorSentAt === null) !== (input.cursorPublicId === null) ||
          (input.cursorPublicId !== null &&
            !/^msg_[A-Za-z0-9_-]{21}$/u.test(input.cursorPublicId)) ||
          (input.direction !== "all" &&
            input.direction !== "inbound" &&
            input.direction !== "outbound")
        )
          throw new Error("invalid MCP message search");
        if ((await enterAuthorizationContext(connection, input, true)) === null)
          return null;
        const materialResult = await db.execute<Record<string, unknown>>(sql`
          SELECT connections.personal_account_id, connections.id AS connection_id,
            connections.created_at AS connection_created_at, connections.message_retention_days,
            account_keys.key_version AS account_key_version, account_keys.kms_key_id AS account_kms_key_id,
            account_keys.ciphertext AS account_key_ciphertext,
            connection_keys.account_key_version AS connection_key_account_version,
            connection_keys.key_version AS connection_key_version, connection_keys.nonce AS connection_key_nonce,
            connection_keys.ciphertext AS connection_key_ciphertext,
            secrets.message_search_key_ciphertext_version, secrets.message_search_key_version,
            secrets.message_search_key_nonce, secrets.message_search_key_ciphertext,
            coverage.state AS coverage_state, coverage.searchable_from
          FROM public.mcp_authorizations authorizations
          JOIN public.mcp_authorization_connections selected
            ON selected.personal_account_id=authorizations.personal_account_id
            AND selected.mcp_authorization_id=authorizations.id
          JOIN public.whatsapp_connections connections
            ON connections.personal_account_id=selected.personal_account_id
            AND connections.id=selected.whatsapp_connection_id
          JOIN public.personal_accounts accounts ON accounts.id=connections.personal_account_id AND accounts.state='active'
          JOIN public.personal_account_key_envelopes account_keys
            ON account_keys.personal_account_id=connections.personal_account_id AND account_keys.unavailable_at IS NULL
          JOIN public.whatsapp_connection_key_envelopes connection_keys
            ON connection_keys.personal_account_id=connections.personal_account_id
            AND connection_keys.whatsapp_connection_id=connections.id
            AND connection_keys.account_key_version=account_keys.key_version AND connection_keys.unavailable_at IS NULL
          JOIN public.whatsapp_connection_secrets secrets
            ON secrets.personal_account_id=connections.personal_account_id
            AND secrets.whatsapp_connection_id=connections.id
            AND secrets.message_search_key_version=connection_keys.key_version
          JOIN public.message_search_backfill_coverage coverage
            ON coverage.personal_account_id=connections.personal_account_id
            AND coverage.whatsapp_connection_id=connections.id AND coverage.index_version=1
          WHERE authorizations.id=${input.authorizationId}
            AND authorizations.oauth_subject=${input.oauthSubject}
            AND authorizations.state='active' AND authorizations.revoked_at IS NULL
            AND authorizations.absolute_expires_at>${input.observedAt}
            AND (${input.clientId ?? null}::text IS NULL OR authorizations.client_id=${input.clientId ?? null})
            AND 'messages:read'=ANY(authorizations.scopes)
            AND connections.public_id=${input.connectionPublicId} AND connections.state<>'deleting'
            AND (${input.conversationPublicId}::text IS NULL OR EXISTS (
              SELECT 1 FROM public.whatsapp_conversations conversations
              WHERE conversations.personal_account_id=connections.personal_account_id
                AND conversations.whatsapp_connection_id=connections.id
                AND conversations.public_id=${input.conversationPublicId}
            ))
        `);
        const row = materialResult[0];
        const accountId =
          typeof row?.personal_account_id === "string"
            ? row.personal_account_id
            : null;
        const connectionId =
          typeof row?.connection_id === "string" ? row.connection_id : null;
        const connectionStarted = timestamp(row?.connection_created_at);
        const accountCiphertext = bytes(row?.account_key_ciphertext);
        const connectionCiphertext = bytes(row?.connection_key_ciphertext);
        const connectionNonce = bytes(row?.connection_key_nonce);
        const searchCiphertext = bytes(row?.message_search_key_ciphertext);
        const searchNonce = bytes(row?.message_search_key_nonce);
        if (
          accountId === null ||
          connectionId === null ||
          connectionStarted === null ||
          typeof row?.account_kms_key_id !== "string" ||
          accountCiphertext === null ||
          connectionCiphertext === null ||
          connectionNonce?.byteLength !== 12 ||
          searchCiphertext === null ||
          searchNonce?.byteLength !== 12
        )
          return null;
        const retentionDays =
          row?.message_retention_days === null
            ? null
            : positiveInteger(row?.message_retention_days);
        const retentionStart =
          retentionDays === null
            ? connectionStarted
            : new Date(input.observedAt.valueOf() - retentionDays * 86_400_000);
        const historyStart =
          retentionStart > connectionStarted
            ? retentionStart
            : connectionStarted;
        const storedSearchableFrom =
          row.searchable_from === null ? null : timestamp(row.searchable_from);
        const searchableFrom =
          storedSearchableFrom === null
            ? null
            : new Date(
                Math.max(
                  storedSearchableFrom.valueOf(),
                  historyStart.valueOf(),
                ),
              ).toISOString();
        const searchTokenArray =
          input.searchTokens === null
            ? sql`NULL::public.message_search_token[]`
            : sql`ARRAY[${sql.join(
                input.searchTokens.map((token) => sql`${token}`),
                sql`, `,
              )}]::public.message_search_token[]`;
        const rows =
          input.searchTokens === null
            ? []
            : await db.execute<Record<string, unknown>>(sql`
          SELECT messages.public_id, messages.message_identity, messages.sent_at, messages.direction,
            messages.content_type, messages.content_key_version, messages.content_nonce,
            messages.content_ciphertext, messages.edited_at, conversations.public_id AS conversation_public_id
          FROM public.stored_messages messages
          JOIN public.whatsapp_conversations conversations
            ON conversations.personal_account_id=messages.personal_account_id
            AND conversations.whatsapp_connection_id=messages.whatsapp_connection_id
            AND conversations.id=messages.conversation_id
          WHERE messages.personal_account_id=${accountId} AND messages.whatsapp_connection_id=${connectionId}
            AND NOT public.whatsapp_recipient_excluded(
              conversations.personal_account_id, conversations.whatsapp_connection_id,
              CASE WHEN conversations.kind = 'group' THEN 'group' ELSE 'contact' END,
              conversations.recipient_locator
            )
            AND messages.message_search_index_version=1
            AND messages.message_search_tokens @> ${searchTokenArray}
            AND messages.deleted_at IS NULL AND messages.content_expired_at IS NULL
            AND messages.sent_at >= ${historyStart}
            AND (${searchableFrom}::timestamptz IS NULL OR messages.sent_at >= ${searchableFrom})
            AND (${input.conversationPublicId}::text IS NULL OR conversations.public_id=${input.conversationPublicId})
            AND (${input.direction}='all' OR messages.direction=${input.direction})
            AND (${input.after}::timestamptz IS NULL OR messages.sent_at >= ${input.after})
            AND (${input.before}::timestamptz IS NULL OR messages.sent_at < ${input.before})
            AND (${input.cursorSentAt}::timestamptz IS NULL OR messages.sent_at < ${input.cursorSentAt}
              OR (messages.sent_at=${input.cursorSentAt} AND messages.public_id < ${input.cursorPublicId}))
          ORDER BY messages.sent_at DESC, messages.public_id DESC LIMIT ${input.limit + 1}
        `);
        const candidates = rows.slice(0, input.limit);
        const returned: Array<Record<string, unknown>> = [];
        let encryptedBytes = 0;
        for (const candidate of candidates) {
          const ciphertext = bytes(candidate.content_ciphertext);
          if (ciphertext === null)
            throw new Error("invalid message search candidate");
          if (
            returned.length > 0 &&
            encryptedBytes + ciphertext.byteLength > 24_000
          )
            break;
          returned.push(candidate);
          encryptedBytes += ciphertext.byteLength;
        }
        const searchedUntil = input.before ?? input.observedAt.toISOString();
        const lower =
          input.after === null
            ? historyStart.toISOString()
            : new Date(
                Math.max(
                  historyStart.valueOf(),
                  new Date(input.after).valueOf(),
                ),
              ).toISOString();
        const gapRows = await db
          .select({
            starts_at: ingestionGapsInApp.startsAt,
            ends_at: ingestionGapsInApp.endsAt,
            cause: ingestionGapsInApp.cause,
          })
          .from(ingestionGapsInApp)
          .where(
            and(
              eq(ingestionGapsInApp.personalAccountId, accountId),
              eq(ingestionGapsInApp.whatsappConnectionId, connectionId),
              lte(ingestionGapsInApp.startsAt, searchedUntil),
              or(
                isNull(ingestionGapsInApp.endsAt),
                gte(ingestionGapsInApp.endsAt, lower),
              ),
            ),
          );
        return {
          accountKey: {
            ciphertext: base64(accountCiphertext),
            keyVersion: Number(row.account_key_version),
            kmsKeyId: row.account_kms_key_id,
            personalAccountId: accountId,
            version: 1,
          },
          connectionKey: {
            accountKeyVersion: Number(row.connection_key_account_version),
            ciphertext: base64(connectionCiphertext),
            connectionId,
            keyVersion: Number(row.connection_key_version),
            nonce: base64(connectionNonce),
            personalAccountId: accountId,
            version: 1,
          },
          messageSearchKey: {
            ciphertext: base64(searchCiphertext),
            keyVersion: Number(row.message_search_key_version),
            nonce: base64(searchNonce),
            version: 1,
          },
          messages: returned.map((message) => {
            const ciphertext = bytes(message.content_ciphertext);
            const nonce = bytes(message.content_nonce);
            const sentAt = timestampString(message.sent_at);
            const editedAt =
              message.edited_at === null
                ? null
                : timestampString(message.edited_at);
            if (
              typeof message.public_id !== "string" ||
              typeof message.message_identity !== "string" ||
              typeof message.conversation_public_id !== "string" ||
              sentAt === null ||
              ciphertext === null ||
              nonce?.byteLength !== 12 ||
              (message.direction !== "inbound" &&
                message.direction !== "outbound") ||
              typeof message.content_type !== "string"
            )
              throw new Error("invalid message search candidate");
            return {
              publicId: message.public_id,
              messageIdentity: message.message_identity,
              conversationPublicId: message.conversation_public_id,
              sentAt,
              direction: message.direction,
              contentType:
                message.content_type as McpToolMessageRecord["contentType"],
              content: {
                ciphertext: base64(ciphertext),
                keyVersion: Number(message.content_key_version),
                nonce: base64(nonce),
                version: 1,
              },
              editedAt,
            };
          }),
          hasMore:
            rows.length > candidates.length ||
            returned.length < candidates.length,
          sizeLimited: returned.length < candidates.length,
          coverage: {
            historyStartsAt: historyStart.toISOString(),
            historyStartReason:
              retentionDays !== null &&
              historyStart.valueOf() === retentionStart.valueOf()
                ? "retention_policy"
                : "connection_started",
            searchableHistoryStartsAt: searchableFrom,
            backfillComplete: row.coverage_state === "complete",
            gaps: gapRows.map((gap) => ({
              startsAt: timestampString(gap.starts_at) as string,
              endsAt:
                gap.ends_at === null ? null : timestampString(gap.ends_at),
              cause: gap.cause as McpToolMessagePage["gaps"][number]["cause"],
            })),
          },
        };
      }),
    ),
  completeMessageRecordRead: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if (
          !Number.isSafeInteger(input.dailyRecordLimit) ||
          input.dailyRecordLimit < 1 ||
          !Number.isSafeInteger(input.resultCount) ||
          input.resultCount < 0 ||
          input.resultCount > 50
        )
          throw new Error("invalid MCP message completion");
        if ((await enterAuthorizationContext(connection, input, true)) === null)
          throw new Error("authorization unavailable");
        const accountContext = sql`nullif(
          current_setting('public.personal_account_id', true), ''
        )::uuid`;
        const completion = await db.execute<{
          completed: unknown;
          used_count: unknown;
        }>(sql`
          WITH locked_account AS MATERIALIZED (
            SELECT accounts.id
            FROM public.personal_accounts accounts
            WHERE accounts.id = ${accountContext}
            FOR UPDATE
          ), used AS MATERIALIZED (
            SELECT coalesce(sum(logs.result_count), 0)::int AS count
            FROM public.tool_call_logs logs
            JOIN locked_account ON locked_account.id = logs.personal_account_id
            WHERE logs.tool_name IN ('read_messages', 'search_messages')
              AND logs.outcome = 'success'
              AND logs.started_at >= date_trunc(
                'day', ${input.observedAt}::timestamptz AT TIME ZONE 'UTC'
              ) AT TIME ZONE 'UTC'
              AND logs.started_at < (
                date_trunc(
                  'day', ${input.observedAt}::timestamptz AT TIME ZONE 'UTC'
                ) AT TIME ZONE 'UTC'
              ) + interval '1 day'
          ), updated AS (
            UPDATE public.tool_call_logs logs
            SET completed_at = ${input.observedAt},
                outcome = 'success',
                error_code = NULL,
                result_count = ${input.resultCount},
                latency_ms = GREATEST(
                  0,
                  floor(extract(epoch FROM (${input.observedAt}::timestamptz - logs.started_at)) * 1000)
                )::integer
            FROM used
            WHERE used.count + ${input.resultCount} <= ${input.dailyRecordLimit}
              AND logs.id = ${input.auditLogId}
              AND logs.personal_account_id = ${accountContext}
              AND logs.mcp_authorization_id = ${input.authorizationId}
               AND logs.tool_name IN ('read_messages', 'search_messages')
              AND logs.outcome = 'started'
            RETURNING logs.id
          )
          SELECT used.count AS used_count,
                 EXISTS (SELECT 1 FROM updated) AS completed
          FROM used
        `);
        const usedCount = Number(completion[0]?.used_count);
        if (!Number.isSafeInteger(usedCount))
          throw new Error("invalid returned-record quota");
        if (usedCount + input.resultCount > input.dailyRecordLimit) {
          return {
            outcome: "record_quota_exhausted" as const,
            resetsAt: new Date(
              Date.UTC(
                input.observedAt.getUTCFullYear(),
                input.observedAt.getUTCMonth(),
                input.observedAt.getUTCDate() + 1,
              ),
            ),
          };
        }
        if (completion[0]?.completed !== true)
          throw new Error("Activity Log completion unavailable");
        return { outcome: "success" as const };
      }),
    ),
  listGroups: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if (
          input.searchIndex !== null &&
          !/^gi1_[A-Za-z0-9_-]{43}$/u.test(input.searchIndex)
        ) {
          throw new Error("invalid MCP group search index");
        }
        if ((await enterAuthorizationContext(connection, input)) === null) {
          return null;
        }
        const scopes = await loadAuthorizationScopes(connection, input);
        if (scopes === null || !scopes.includes("directory:read")) {
          return null;
        }
        const material = await loadGroupProjectionMaterial(connection, input);
        if (material === null) return null;
        const personalAccountId = material.accountKey.personalAccountId;
        const connectionId = material.connectionKey.connectionId;
        const persistedGroups = await db
          .select({
            id: whatsappGroupsInApp.id,
            public_id: whatsappGroupsInApp.publicId,
            display_name_ciphertext_version:
              whatsappGroupsInApp.displayNameCiphertextVersion,
            display_name_key_version: whatsappGroupsInApp.displayNameKeyVersion,
            display_name_nonce: whatsappGroupsInApp.displayNameNonce,
            display_name_ciphertext: whatsappGroupsInApp.displayNameCiphertext,
          })
          .from(whatsappGroupsInApp)
          .where(
            and(
              eq(whatsappGroupsInApp.personalAccountId, personalAccountId),
              eq(whatsappGroupsInApp.whatsappConnectionId, connectionId),
              eq(whatsappGroupsInApp.joined, true),
              sql`NOT public.whatsapp_recipient_excluded(${whatsappGroupsInApp.personalAccountId}, ${whatsappGroupsInApp.whatsappConnectionId}, 'group', ${whatsappGroupsInApp.providerLocator})`,
              input.searchIndex === null
                ? undefined
                : sql`${whatsappGroupsInApp.namePrefixIndexes} @> ARRAY[${input.searchIndex}::public.group_name_blind_index]`,
            ),
          );
        const groups = encryptedGroupRecords(persistedGroups);
        return {
          accountKey: material.accountKey,
          asOf: material.asOf,
          connectionKey: material.connectionKey,
          groups,
          partial: material.partial,
          stale: material.stale,
        };
      }),
    ),
  loadGroupSearchMaterial: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if ((await enterAuthorizationContext(connection, input)) === null) {
          return null;
        }
        const scopes = await loadAuthorizationScopes(connection, input);
        if (scopes === null || !scopes.includes("directory:read")) {
          return null;
        }
        return loadGroupIndexMaterial(connection, input);
      }),
    ),
  loadContactReadMaterial: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        const result = await db.execute(sql<ContactMaterialRow>`
          SELECT * FROM public.load_mcp_contact_read_material(
            ${input.authorizationId}, ${input.oauthSubject}, ${input.clientId ?? null},
            ${input.connectionPublicId}, ${input.observedAt}
          )
        `);
        const material = contactReadMaterial(
          result[0] as ContactMaterialRow | undefined,
        );
        if (material === null) return null;
        await db.execute(
          sql`SELECT set_config('public.personal_account_id', ${material.personalAccountId}, true)`,
        );
        return material;
      }),
    ),
  listEncryptedContacts: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if (
          !/^con_[A-Za-z0-9_-]{21}$/u.test(input.connectionPublicId) ||
          !Number.isSafeInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 51 ||
          (input.cursorDisplayNameSort === null) !==
            (input.cursorPublicId === null) ||
          (input.cursorPublicId !== null &&
            !/^ctc_[A-Za-z0-9_-]{21}$/u.test(input.cursorPublicId)) ||
          (input.searchIndex === null) !== (input.searchKind === null) ||
          (input.searchIndex !== null &&
            !/^di1_[A-Za-z0-9_-]{43}$/u.test(input.searchIndex))
        ) {
          throw new Error("invalid MCP contact query");
        }
        await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
        if ((await enterAuthorizationContext(connection, input)) === null) {
          return null;
        }
        const scopes = await loadAuthorizationScopes(connection, input);
        if (scopes === null || !scopes.includes("directory:read")) return null;
        const projectionResult = await db.execute<{
          projection_as_of: unknown;
          projection_partial: unknown;
          projection_snapshot_observed_at: unknown;
          projection_stale: unknown;
        }>(sql`SELECT
             coalesce(projections.as_of, connections.created_at)
               AS projection_as_of,
             CASE
               WHEN projections.snapshot_observed_at IS NULL THEN true
               ELSE public.directory_projection_stale(
                 connections.personal_account_id,
                  connections.id,
                  ${input.observedAt},
                 projections.snapshot_observed_at,
                 projections.stale
               )
             END AS projection_stale,
             CASE
               WHEN projections.snapshot_observed_at IS NULL THEN true
               ELSE public.directory_projection_partial(
                 connections.personal_account_id,
                 connections.id,
                 projections.snapshot_observed_at,
                 projections.partial,
                 projections.retention_limited
               )
             END AS projection_partial,
             projections.snapshot_observed_at
               AS projection_snapshot_observed_at
           FROM public.mcp_authorization_connections AS selected
           JOIN public.whatsapp_connections AS connections
             ON connections.personal_account_id = selected.personal_account_id
            AND connections.id = selected.whatsapp_connection_id
           LEFT JOIN public.directory_contact_projections AS projections
             ON projections.personal_account_id = connections.personal_account_id
            AND projections.whatsapp_connection_id = connections.id
           WHERE selected.mcp_authorization_id = ${input.authorizationId}
             AND connections.public_id = ${input.connectionPublicId}
              AND connections.state <> 'deleting'`);
        const projection = projectionResult[0];
        const asOf = timestampString(projection?.projection_as_of);
        const snapshotObservedAt =
          projection?.projection_snapshot_observed_at === null
            ? null
            : timestampString(projection?.projection_snapshot_observed_at);
        if (
          projection === undefined ||
          asOf === null ||
          typeof projection.projection_stale !== "boolean" ||
          typeof projection.projection_partial !== "boolean" ||
          (projection.projection_snapshot_observed_at !== null &&
            snapshotObservedAt === null)
        ) {
          throw new Error("invalid MCP Directory projection metadata");
        }
        const result = await db.execute<{
          conversation_public_id: unknown;
          display_name_ciphertext: unknown;
          display_name_ciphertext_version: unknown;
          display_name_key_version: unknown;
          display_name_nonce: unknown;
          display_name_sort: unknown;
          phone_ciphertext: unknown;
          phone_ciphertext_version: unknown;
          phone_key_version: unknown;
          phone_nonce: unknown;
          provider_identity_index: unknown;
          public_id: unknown;
        }>(sql`SELECT
             contacts.public_id,
             CASE WHEN 'messages:read' = ANY(authorizations.scopes) THEN (
               SELECT conversations.public_id
               FROM public.whatsapp_conversations AS conversations
               WHERE conversations.personal_account_id = contacts.personal_account_id
                 AND conversations.whatsapp_connection_id = contacts.whatsapp_connection_id
                 AND conversations.kind = 'direct'
                 AND conversations.recipient_locator = contacts.provider_identity_index
                 AND EXISTS (
                   SELECT 1 FROM public.stored_messages AS retained
                   WHERE retained.personal_account_id = conversations.personal_account_id
                     AND retained.whatsapp_connection_id = conversations.whatsapp_connection_id
                     AND retained.conversation_id = conversations.id
                     AND retained.content_expired_at IS NULL
                 )
               ORDER BY conversations.created_at
               LIMIT 1
             ) ELSE NULL END AS conversation_public_id,
             contacts.provider_identity_index,
             contacts.display_name_ciphertext_version,
             contacts.display_name_key_version,
             contacts.display_name_nonce,
             contacts.display_name_ciphertext,
             contacts.display_name_sort,
             contacts.phone_ciphertext_version,
             contacts.phone_key_version,
             contacts.phone_nonce,
             contacts.phone_ciphertext
           FROM public.mcp_authorization_connections AS selected
           JOIN public.mcp_authorizations AS authorizations
             ON authorizations.personal_account_id = selected.personal_account_id
            AND authorizations.id = selected.mcp_authorization_id
           JOIN public.whatsapp_connections AS connections
             ON connections.personal_account_id = selected.personal_account_id
            AND connections.id = selected.whatsapp_connection_id
           JOIN public.directory_contacts AS contacts
             ON contacts.personal_account_id = connections.personal_account_id
            AND contacts.whatsapp_connection_id = connections.id
           WHERE selected.mcp_authorization_id = ${input.authorizationId}
             AND connections.public_id = ${input.connectionPublicId}
             AND connections.state <> 'deleting'
             AND contacts.active
             AND NOT public.whatsapp_recipient_excluded(
               connections.personal_account_id, connections.id, 'contact',
               contacts.provider_identity_index
             )
             AND (
               ${input.cursorDisplayNameSort}::text IS NULL
               OR (contacts.display_name_sort, contacts.public_id)
                 > (${input.cursorDisplayNameSort}::text COLLATE "C", ${input.cursorPublicId}::text)
             )
             AND (
               ${input.searchIndex}::text IS NULL
               OR (${input.searchKind} = 'phone' AND contacts.phone_index = ${input.searchIndex})
               OR (
                 ${input.searchKind} = 'name'
                 AND contacts.name_prefix_indexes
                   @> ARRAY[${input.searchIndex}::public.directory_blind_index]
               )
             )
           ORDER BY contacts.display_name_sort, contacts.public_id
            LIMIT ${input.limit}`);
        const parseField = (
          row: (typeof result)[number],
          prefix: "display_name" | "phone",
        ): McpToolDirectoryCiphertext | null => {
          const ciphertext = bytes(row[`${prefix}_ciphertext`]);
          const nonce = bytes(row[`${prefix}_nonce`]);
          const version = positiveInteger(row[`${prefix}_key_version`]);
          const formatVersion = row[`${prefix}_ciphertext_version`];
          if (
            ciphertext === null &&
            nonce === null &&
            version === null &&
            formatVersion === null
          ) {
            return null;
          }
          if (
            ciphertext === null ||
            nonce?.byteLength !== 12 ||
            version === null ||
            formatVersion !== 1
          ) {
            throw new Error("invalid encrypted MCP Directory field");
          }
          return {
            ciphertext: encodeBase64(ciphertext),
            keyVersion: version,
            nonce: encodeBase64(nonce),
            version: 1,
          };
        };
        const contacts = result.map((row) => {
          if (
            typeof row.public_id !== "string" ||
            !/^ctc_[A-Za-z0-9_-]{21}$/u.test(row.public_id) ||
            typeof row.provider_identity_index !== "string" ||
            !/^di1_[A-Za-z0-9_-]{43}$/u.test(row.provider_identity_index) ||
            typeof row.display_name_sort !== "string"
          ) {
            throw new Error("invalid persisted MCP Directory contact");
          }
          return {
            conversationPublicId:
              row.conversation_public_id === null
                ? null
                : typeof row.conversation_public_id === "string" &&
                    /^cvs_[A-Za-z0-9_-]{21}$/u.test(row.conversation_public_id)
                  ? row.conversation_public_id
                  : (() => {
                      throw new Error("invalid contact conversation handle");
                    })(),
            displayNameCiphertext: parseField(row, "display_name"),
            displayNameSort: row.display_name_sort,
            phoneCiphertext: parseField(row, "phone"),
            providerIdentityIndex: row.provider_identity_index,
            publicId: row.public_id,
          };
        });
        return {
          asOf,
          contacts,
          partial: projection.projection_partial,
          snapshotObservedAt,
          stale: projection.projection_stale,
        };
      }),
    ),
  loadApiKeyContactReadMaterial: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if (
          (await enterAccountContext(connection, input.personalAccountId)) ===
          null
        ) {
          return null;
        }
        if (!input.permissions.includes("directory:read")) return null;
        const db = makeDatabase(connection);
        const result = await db.execute<ContactMaterialRow>(sql`
          SELECT
            accounts.id AS personal_account_id,
            connections.id AS whatsapp_connection_id,
            account_keys.key_version AS account_key_version,
            account_keys.kms_key_id AS account_kms_key_id,
            account_keys.ciphertext AS account_key_ciphertext,
            connection_keys.account_key_version AS connection_key_account_version,
            connection_keys.key_version AS connection_key_version,
            connection_keys.nonce AS connection_key_nonce,
            connection_keys.ciphertext AS connection_key_ciphertext,
            identity_keys.credential_ciphertext_version AS identity_ciphertext_version,
            identity_keys.credential_key_version AS identity_key_version,
            identity_keys.credential_nonce AS identity_nonce,
            identity_keys.credential_ciphertext AS identity_ciphertext,
            coalesce(projections.as_of, connections.created_at) AS projection_as_of,
            coalesce(projections.stale, true) AS projection_stale,
            coalesce(projections.partial, true) AS projection_partial
          FROM public.api_keys AS grants
          JOIN public.personal_accounts AS accounts
            ON accounts.id = grants.personal_account_id
          JOIN public.api_key_connections AS selected
            ON selected.personal_account_id = grants.personal_account_id
           AND selected.api_key_id = grants.id
          JOIN public.whatsapp_connections AS connections
            ON connections.personal_account_id = selected.personal_account_id
           AND connections.id = selected.whatsapp_connection_id
          JOIN public.whatsapp_connection_key_envelopes AS connection_keys
            ON connection_keys.personal_account_id = connections.personal_account_id
           AND connection_keys.whatsapp_connection_id = connections.id
          JOIN public.personal_account_key_envelopes AS account_keys
            ON account_keys.personal_account_id = connections.personal_account_id
           AND account_keys.key_version = connection_keys.account_key_version
          JOIN public.whatsapp_connection_secrets AS identity_keys
            ON identity_keys.personal_account_id = connections.personal_account_id
           AND identity_keys.whatsapp_connection_id = connections.id
           AND identity_keys.credential_key_version = connection_keys.key_version
          LEFT JOIN public.directory_contact_projections AS projections
            ON projections.personal_account_id = connections.personal_account_id
           AND projections.whatsapp_connection_id = connections.id
          WHERE grants.id = ${input.apiKeyGrantId}
            AND grants.personal_account_id = ${input.personalAccountId}
            AND grants.state = 'active'
            AND (grants.expires_at IS NULL OR grants.expires_at > ${input.observedAt})
            AND 'directory:read' = ANY(grants.permissions)
            AND connections.public_id = ${input.connectionPublicId}
            AND connections.state <> 'deleting'
            AND accounts.state = 'active'
            AND account_keys.unavailable_at IS NULL
            AND account_keys.ciphertext IS NOT NULL
            AND connection_keys.unavailable_at IS NULL
            AND connection_keys.nonce IS NOT NULL
            AND connection_keys.ciphertext IS NOT NULL
        `);
        return contactReadMaterial(result[0] as ContactMaterialRow | undefined);
      }),
    ),
  listApiKeyEncryptedContacts: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if (
          !/^con_[A-Za-z0-9_-]{21}$/u.test(input.connectionPublicId) ||
          !Number.isSafeInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 51 ||
          (input.cursorDisplayNameSort === null) !==
            (input.cursorPublicId === null) ||
          (input.cursorPublicId !== null &&
            !/^ctc_[A-Za-z0-9_-]{21}$/u.test(input.cursorPublicId)) ||
          (input.searchIndex === null) !== (input.searchKind === null) ||
          (input.searchIndex !== null &&
            !/^di1_[A-Za-z0-9_-]{43}$/u.test(input.searchIndex))
        ) {
          throw new Error("invalid API contact query");
        }
        await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
        if (
          (await enterAccountContext(connection, input.personalAccountId)) ===
            null ||
          !input.permissions.includes("directory:read")
        ) {
          return null;
        }
        const projectionResult = await db.execute<{
          projection_as_of: unknown;
          projection_partial: unknown;
          projection_snapshot_observed_at: unknown;
          projection_stale: unknown;
        }>(sql`SELECT
             coalesce(projections.as_of, connections.created_at)
               AS projection_as_of,
             CASE
               WHEN projections.snapshot_observed_at IS NULL THEN true
               ELSE public.directory_projection_stale(
                 connections.personal_account_id,
                  connections.id,
                  ${input.observedAt},
                 projections.snapshot_observed_at,
                 projections.stale
               )
             END AS projection_stale,
             CASE
               WHEN projections.snapshot_observed_at IS NULL THEN true
               ELSE public.directory_projection_partial(
                 connections.personal_account_id,
                 connections.id,
                 projections.snapshot_observed_at,
                 projections.partial,
                 projections.retention_limited
               )
             END AS projection_partial,
             projections.snapshot_observed_at
               AS projection_snapshot_observed_at
           FROM public.api_key_connections AS selected
           JOIN public.api_keys AS grants
             ON grants.personal_account_id = selected.personal_account_id
            AND grants.id = selected.api_key_id
           JOIN public.whatsapp_connections AS connections
             ON connections.personal_account_id = selected.personal_account_id
            AND connections.id = selected.whatsapp_connection_id
           LEFT JOIN public.directory_contact_projections AS projections
             ON projections.personal_account_id = connections.personal_account_id
            AND projections.whatsapp_connection_id = connections.id
           WHERE selected.api_key_id = ${input.apiKeyGrantId}
             AND grants.state = 'active'
             AND (grants.expires_at IS NULL OR grants.expires_at > ${input.observedAt})
             AND connections.public_id = ${input.connectionPublicId}
              AND connections.state <> 'deleting'`);
        const projection = projectionResult[0];
        const asOf = timestampString(projection?.projection_as_of);
        const snapshotObservedAt =
          projection?.projection_snapshot_observed_at === null
            ? null
            : timestampString(projection?.projection_snapshot_observed_at);
        if (
          projection === undefined ||
          asOf === null ||
          typeof projection.projection_stale !== "boolean" ||
          typeof projection.projection_partial !== "boolean" ||
          (projection.projection_snapshot_observed_at !== null &&
            snapshotObservedAt === null)
        ) {
          return null;
        }
        const result = await db.execute<{
          conversation_public_id: unknown;
          display_name_ciphertext: unknown;
          display_name_ciphertext_version: unknown;
          display_name_key_version: unknown;
          display_name_nonce: unknown;
          display_name_sort: unknown;
          phone_ciphertext: unknown;
          phone_ciphertext_version: unknown;
          phone_key_version: unknown;
          phone_nonce: unknown;
          provider_identity_index: unknown;
          public_id: unknown;
        }>(sql`SELECT
             contacts.public_id,
             CASE WHEN 'messages:read' = ANY(grants.permissions) THEN (
               SELECT conversations.public_id
               FROM public.whatsapp_conversations AS conversations
               WHERE conversations.personal_account_id = contacts.personal_account_id
                 AND conversations.whatsapp_connection_id = contacts.whatsapp_connection_id
                 AND conversations.kind = 'direct'
                 AND conversations.recipient_locator = contacts.provider_identity_index
                 AND EXISTS (
                   SELECT 1 FROM public.stored_messages AS retained
                   WHERE retained.personal_account_id = conversations.personal_account_id
                     AND retained.whatsapp_connection_id = conversations.whatsapp_connection_id
                     AND retained.conversation_id = conversations.id
                     AND retained.content_expired_at IS NULL
                 )
               ORDER BY conversations.created_at
               LIMIT 1
             ) ELSE NULL END AS conversation_public_id,
             contacts.provider_identity_index,
             contacts.display_name_ciphertext_version,
             contacts.display_name_key_version,
             contacts.display_name_nonce,
             contacts.display_name_ciphertext,
             contacts.display_name_sort,
             contacts.phone_ciphertext_version,
             contacts.phone_key_version,
             contacts.phone_nonce,
             contacts.phone_ciphertext
           FROM public.api_key_connections AS selected
           JOIN public.api_keys AS grants
             ON grants.personal_account_id = selected.personal_account_id
            AND grants.id = selected.api_key_id
           JOIN public.whatsapp_connections AS connections
             ON connections.personal_account_id = selected.personal_account_id
            AND connections.id = selected.whatsapp_connection_id
           JOIN public.directory_contacts AS contacts
             ON contacts.personal_account_id = connections.personal_account_id
            AND contacts.whatsapp_connection_id = connections.id
           WHERE selected.api_key_id = ${input.apiKeyGrantId}
             AND grants.state = 'active'
             AND (grants.expires_at IS NULL OR grants.expires_at > ${input.observedAt})
             AND connections.public_id = ${input.connectionPublicId}
             AND connections.state <> 'deleting'
             AND contacts.active
             AND NOT public.whatsapp_recipient_excluded(
               connections.personal_account_id, connections.id, 'contact',
               contacts.provider_identity_index
             )
             AND (
               ${input.cursorDisplayNameSort}::text IS NULL
               OR (contacts.display_name_sort, contacts.public_id)
                 > (${input.cursorDisplayNameSort}::text COLLATE "C", ${input.cursorPublicId}::text)
             )
             AND (
               ${input.searchIndex}::text IS NULL
               OR (${input.searchKind} = 'phone' AND contacts.phone_index = ${input.searchIndex})
               OR (
                 ${input.searchKind} = 'name'
                 AND contacts.name_prefix_indexes
                   @> ARRAY[${input.searchIndex}::public.directory_blind_index]
               )
             )
           ORDER BY contacts.display_name_sort, contacts.public_id
            LIMIT ${input.limit}`);
        const parseField = (
          row: (typeof result)[number],
          prefix: "display_name" | "phone",
        ): McpToolDirectoryCiphertext | null => {
          const ciphertext = bytes(row[`${prefix}_ciphertext`]);
          const nonce = bytes(row[`${prefix}_nonce`]);
          const version = positiveInteger(row[`${prefix}_key_version`]);
          const formatVersion = row[`${prefix}_ciphertext_version`];
          if (
            ciphertext === null &&
            nonce === null &&
            version === null &&
            formatVersion === null
          ) {
            return null;
          }
          if (
            ciphertext === null ||
            nonce?.byteLength !== 12 ||
            version === null ||
            formatVersion !== 1
          ) {
            throw new Error("invalid encrypted Directory field");
          }
          return {
            ciphertext: encodeBase64(ciphertext),
            keyVersion: version,
            nonce: encodeBase64(nonce),
            version: 1,
          };
        };
        const contacts = result.map((row) => {
          if (
            typeof row.public_id !== "string" ||
            !/^ctc_[A-Za-z0-9_-]{21}$/u.test(row.public_id) ||
            typeof row.provider_identity_index !== "string" ||
            !/^di1_[A-Za-z0-9_-]{43}$/u.test(row.provider_identity_index) ||
            typeof row.display_name_sort !== "string"
          ) {
            throw new Error("invalid persisted Directory contact");
          }
          return {
            conversationPublicId:
              row.conversation_public_id === null
                ? null
                : typeof row.conversation_public_id === "string" &&
                    /^cvs_[A-Za-z0-9_-]{21}$/u.test(row.conversation_public_id)
                  ? row.conversation_public_id
                  : (() => {
                      throw new Error("invalid contact conversation handle");
                    })(),
            displayNameCiphertext: parseField(row, "display_name"),
            displayNameSort: row.display_name_sort,
            phoneCiphertext: parseField(row, "phone"),
            providerIdentityIndex: row.provider_identity_index,
            publicId: row.public_id,
          };
        });
        return {
          asOf,
          contacts,
          partial: projection.projection_partial,
          snapshotObservedAt,
          stale: projection.projection_stale,
        };
      }),
    ),
  loadApiKeyGroupSearchMaterial: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if (
          (await enterAccountContext(connection, input.personalAccountId)) ===
            null ||
          !input.permissions.includes("directory:read")
        ) {
          return null;
        }
        const material = await makeDatabase(connection).execute<
          Record<string, unknown>
        >(sql`
          SELECT
            connections.id AS connection_id,
            connections.personal_account_id,
            account_keys.key_version AS account_key_version,
            account_keys.kms_key_id AS account_kms_key_id,
            account_keys.ciphertext AS account_key_ciphertext,
            connection_keys.account_key_version AS connection_key_account_version,
            connection_keys.key_version AS connection_key_version,
            connection_keys.nonce AS connection_key_nonce,
            connection_keys.ciphertext AS connection_key_ciphertext,
            identity_keys.credential_ciphertext_version AS identity_ciphertext_version,
            identity_keys.credential_key_version AS identity_key_version,
            identity_keys.credential_nonce AS identity_nonce,
            identity_keys.credential_ciphertext AS identity_ciphertext
          FROM public.api_keys AS grants
          JOIN public.personal_accounts AS accounts
            ON accounts.id = grants.personal_account_id
          JOIN public.api_key_connections AS selected
            ON selected.personal_account_id = grants.personal_account_id
           AND selected.api_key_id = grants.id
          JOIN public.whatsapp_connections AS connections
            ON connections.personal_account_id = selected.personal_account_id
           AND connections.id = selected.whatsapp_connection_id
          JOIN public.whatsapp_connection_key_envelopes AS connection_keys
            ON connection_keys.personal_account_id = connections.personal_account_id
           AND connection_keys.whatsapp_connection_id = connections.id
          JOIN public.personal_account_key_envelopes AS account_keys
            ON account_keys.personal_account_id = connections.personal_account_id
           AND account_keys.key_version = connection_keys.account_key_version
          JOIN public.whatsapp_connection_secrets AS identity_keys
            ON identity_keys.personal_account_id = connections.personal_account_id
           AND identity_keys.whatsapp_connection_id = connections.id
           AND identity_keys.credential_key_version = connection_keys.key_version
          WHERE grants.id = ${input.apiKeyGrantId}
            AND grants.personal_account_id = ${input.personalAccountId}
            AND grants.state = 'active'
            AND (grants.expires_at IS NULL OR grants.expires_at > ${input.observedAt})
            AND 'directory:read' = ANY(grants.permissions)
            AND connections.public_id = ${input.connectionPublicId}
            AND connections.state <> 'deleting'
            AND accounts.state = 'active'
            AND account_keys.unavailable_at IS NULL
            AND account_keys.ciphertext IS NOT NULL
            AND connection_keys.unavailable_at IS NULL
            AND connection_keys.nonce IS NOT NULL
            AND connection_keys.ciphertext IS NOT NULL
        `);
        return parseGroupSearchMaterial(material[0]);
      }),
    ),
  listApiKeyGroups: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if (
          !/^con_[A-Za-z0-9_-]{21}$/u.test(input.connectionPublicId) ||
          (input.searchIndex !== null &&
            !/^gi1_[A-Za-z0-9_-]{43}$/u.test(input.searchIndex))
        ) {
          throw new Error("invalid API group query");
        }
        if (
          (await enterAccountContext(connection, input.personalAccountId)) ===
            null ||
          !input.permissions.includes("directory:read")
        ) {
          return null;
        }
        const materialRows = await db.execute<Record<string, unknown>>(sql`
          SELECT
            connections.id AS connection_id,
            connections.created_at AS connection_created_at,
            connections.personal_account_id,
            states.as_of,
            coalesce(states.stale, true) AS stale,
            coalesce(states.partial, true) AS partial,
            account_keys.key_version AS account_key_version,
            account_keys.kms_key_id AS account_kms_key_id,
            account_keys.ciphertext AS account_key_ciphertext,
            connection_keys.account_key_version AS connection_key_account_version,
            connection_keys.key_version AS connection_key_version,
            connection_keys.nonce AS connection_key_nonce,
            connection_keys.ciphertext AS connection_key_ciphertext
          FROM public.api_key_connections AS selected
          JOIN public.api_keys AS grants
            ON grants.personal_account_id = selected.personal_account_id
           AND grants.id = selected.api_key_id
          JOIN public.whatsapp_connections AS connections
            ON connections.personal_account_id = selected.personal_account_id
           AND connections.id = selected.whatsapp_connection_id
          JOIN public.whatsapp_connection_key_envelopes AS connection_keys
            ON connection_keys.personal_account_id = connections.personal_account_id
           AND connection_keys.whatsapp_connection_id = connections.id
          JOIN public.personal_account_key_envelopes AS account_keys
            ON account_keys.personal_account_id = connections.personal_account_id
           AND account_keys.key_version = connection_keys.account_key_version
          LEFT JOIN public.whatsapp_group_directory_states AS states
            ON states.personal_account_id = connections.personal_account_id
           AND states.whatsapp_connection_id = connections.id
          WHERE selected.api_key_id = ${input.apiKeyGrantId}
            AND grants.state = 'active'
            AND (grants.expires_at IS NULL OR grants.expires_at > ${input.observedAt})
            AND connections.public_id = ${input.connectionPublicId}
            AND connections.state <> 'deleting'
        `);
        const parsed = parseGroupMaterial(materialRows[0]);
        if (parsed === null) return null;
        const freshness = await db.execute<Record<string, unknown>>(sql`SELECT
             CASE
               WHEN states.snapshot_observed_at IS NULL THEN true
               ELSE public.directory_projection_stale(
                 states.personal_account_id,
                 states.whatsapp_connection_id,
                 ${input.observedAt},
                 states.snapshot_observed_at,
                 states.stale
               )
             END AS stale,
             CASE
               WHEN states.snapshot_observed_at IS NULL THEN true
               ELSE public.directory_projection_partial(
                 states.personal_account_id,
                 states.whatsapp_connection_id,
                 states.snapshot_observed_at,
                 states.partial,
                 states.retention_limited
               )
             END AS partial
           FROM public.whatsapp_group_directory_states AS states
           WHERE states.personal_account_id = ${parsed.accountKey.personalAccountId}
             AND states.whatsapp_connection_id = ${parsed.connectionKey.connectionId}`);
        const freshnessRow = freshness[0];
        const material =
          freshnessRow === undefined
            ? { ...parsed, partial: true, stale: true }
            : typeof freshnessRow.stale === "boolean" &&
                typeof freshnessRow.partial === "boolean"
              ? {
                  ...parsed,
                  partial: freshnessRow.partial,
                  stale: freshnessRow.stale,
                }
              : (() => {
                  throw new Error("invalid API group projection freshness");
                })();
        const personalAccountId = material.accountKey.personalAccountId;
        const connectionId = material.connectionKey.connectionId;
        const persistedGroups = await db
          .select({
            id: whatsappGroupsInApp.id,
            public_id: whatsappGroupsInApp.publicId,
            display_name_ciphertext_version:
              whatsappGroupsInApp.displayNameCiphertextVersion,
            display_name_key_version: whatsappGroupsInApp.displayNameKeyVersion,
            display_name_nonce: whatsappGroupsInApp.displayNameNonce,
            display_name_ciphertext: whatsappGroupsInApp.displayNameCiphertext,
          })
          .from(whatsappGroupsInApp)
          .where(
            and(
              eq(whatsappGroupsInApp.personalAccountId, personalAccountId),
              eq(whatsappGroupsInApp.whatsappConnectionId, connectionId),
              eq(whatsappGroupsInApp.joined, true),
              sql`NOT public.whatsapp_recipient_excluded(${whatsappGroupsInApp.personalAccountId}, ${whatsappGroupsInApp.whatsappConnectionId}, 'group', ${whatsappGroupsInApp.providerLocator})`,
              input.searchIndex === null
                ? undefined
                : sql`${whatsappGroupsInApp.namePrefixIndexes} @> ARRAY[${input.searchIndex}::public.group_name_blind_index]`,
            ),
          );
        return {
          accountKey: material.accountKey,
          asOf: material.asOf,
          connectionKey: material.connectionKey,
          groups: encryptedGroupRecords(persistedGroups),
          partial: material.partial,
          stale: material.stale,
        };
      }),
    ),
  listApiKeyChats: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if (
          !/^con_[A-Za-z0-9_-]{21}$/u.test(input.connectionPublicId) ||
          !Number.isSafeInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 51 ||
          (input.kind !== "all" &&
            input.kind !== "direct" &&
            input.kind !== "group") ||
          (input.cursorActivityAt === null) !==
            (input.cursorPublicId === null) ||
          (input.cursorPublicId !== null &&
            !/^cvs_[A-Za-z0-9_-]{21}$/u.test(input.cursorPublicId))
        ) {
          throw new Error("invalid API conversation query");
        }
        if (
          (await enterAccountContext(connection, input.personalAccountId)) ===
            null ||
          !input.permissions.includes("messages:read")
        ) {
          return null;
        }
        const result = await db.execute<Record<string, unknown>>(sql`
          WITH projection AS MATERIALIZED (
            SELECT
              connections.personal_account_id,
              connections.id AS connection_id,
              connections.created_at AS connection_created_at,
              greatest(
                coalesce(contacts.as_of, connections.created_at),
                coalesce(groups.as_of, connections.created_at)
              ) AS as_of,
              (coalesce(contacts.stale, true)
                OR coalesce(groups.stale, true)) AS stale,
              (coalesce(contacts.partial, true)
                OR coalesce(groups.partial, true)) AS partial,
              account_keys.key_version AS account_key_version,
              account_keys.kms_key_id AS account_kms_key_id,
              account_keys.ciphertext AS account_key_ciphertext,
              connection_keys.account_key_version AS connection_key_account_version,
              connection_keys.key_version AS connection_key_version,
              connection_keys.nonce AS connection_key_nonce,
              connection_keys.ciphertext AS connection_key_ciphertext
            FROM public.api_keys AS grants
            JOIN public.api_key_connections AS selected
              ON selected.personal_account_id = grants.personal_account_id
             AND selected.api_key_id = grants.id
            JOIN public.whatsapp_connections AS connections
              ON connections.personal_account_id = selected.personal_account_id
             AND connections.id = selected.whatsapp_connection_id
            JOIN public.whatsapp_connection_key_envelopes AS connection_keys
              ON connection_keys.personal_account_id =
                  connections.personal_account_id
             AND connection_keys.whatsapp_connection_id = connections.id
            JOIN public.personal_account_key_envelopes AS account_keys
              ON account_keys.personal_account_id =
                  connections.personal_account_id
             AND account_keys.key_version = connection_keys.account_key_version
            LEFT JOIN public.directory_contact_projections AS contacts
              ON contacts.personal_account_id = connections.personal_account_id
             AND contacts.whatsapp_connection_id = connections.id
            LEFT JOIN public.whatsapp_group_directory_states AS groups
              ON groups.personal_account_id = connections.personal_account_id
             AND groups.whatsapp_connection_id = connections.id
            WHERE grants.id = ${input.apiKeyGrantId}
              AND grants.personal_account_id = ${input.personalAccountId}
              AND grants.state = 'active'
              AND (grants.expires_at IS NULL
                OR grants.expires_at > ${input.observedAt})
              AND 'messages:read' = ANY(grants.permissions)
              AND connections.public_id = ${input.connectionPublicId}
              AND connections.state <> 'deleting'
              AND account_keys.unavailable_at IS NULL
              AND account_keys.ciphertext IS NOT NULL
              AND connection_keys.unavailable_at IS NULL
              AND connection_keys.nonce IS NOT NULL
              AND connection_keys.ciphertext IS NOT NULL
          ), chats AS MATERIALIZED (
            SELECT
              conversations.public_id,
              conversations.kind,
              coalesce(
                contacts.public_id,
                groups.public_id,
                conversations.recipient_public_id
              ) AS recipient_public_id,
              conversations.last_activity_at,
              conversations.last_activity_direction,
              coalesce(
                contacts.provider_identity_index,
                groups.id::text,
                conversations.recipient_public_id
              ) AS recipient_record_id,
              coalesce(
                contacts.display_name_ciphertext_version,
                groups.display_name_ciphertext_version
              ) AS display_version,
              coalesce(
                contacts.display_name_key_version,
                groups.display_name_key_version
              ) AS display_key_version,
              coalesce(
                contacts.display_name_nonce,
                groups.display_name_nonce
              ) AS display_nonce,
              coalesce(
                contacts.display_name_ciphertext,
                groups.display_name_ciphertext
              ) AS display_ciphertext,
              contacts.phone_ciphertext_version AS phone_version,
              contacts.phone_key_version,
              contacts.phone_nonce,
              contacts.phone_ciphertext
            FROM projection
            JOIN public.whatsapp_conversations conversations
              ON conversations.personal_account_id =
                  projection.personal_account_id
             AND conversations.whatsapp_connection_id =
                  projection.connection_id
            LEFT JOIN public.directory_contacts contacts
              ON conversations.kind = 'direct'
             AND contacts.personal_account_id =
                  conversations.personal_account_id
             AND contacts.whatsapp_connection_id =
                  conversations.whatsapp_connection_id
             AND contacts.provider_identity_index =
                  conversations.recipient_locator
            LEFT JOIN public.whatsapp_groups groups
              ON conversations.kind = 'group'
             AND groups.personal_account_id =
                  conversations.personal_account_id
             AND groups.whatsapp_connection_id =
                  conversations.whatsapp_connection_id
             AND groups.provider_locator = conversations.recipient_locator
            WHERE NOT public.whatsapp_recipient_excluded(
                conversations.personal_account_id,
                conversations.whatsapp_connection_id,
                CASE WHEN conversations.kind = 'group' THEN 'group' ELSE 'contact' END,
                conversations.recipient_locator
              )
              AND EXISTS (
              SELECT 1
              FROM public.stored_messages retained
              WHERE retained.personal_account_id =
                  conversations.personal_account_id
                AND retained.whatsapp_connection_id =
                  conversations.whatsapp_connection_id
                AND retained.conversation_id = conversations.id
                AND retained.content_expired_at IS NULL
            )
              AND (${input.kind} = 'all' OR conversations.kind = ${input.kind})
              AND (
                ${input.cursorActivityAt}::timestamptz IS NULL
                OR conversations.last_activity_at < ${input.cursorActivityAt}
                OR (
                  conversations.last_activity_at = ${input.cursorActivityAt}
                  AND conversations.public_id > ${input.cursorPublicId}
                )
              )
            ORDER BY conversations.last_activity_at DESC,
              conversations.public_id
            LIMIT ${input.limit}
          )
          SELECT
            projection.personal_account_id,
            projection.connection_id,
            projection.connection_created_at,
            projection.as_of AS projection_as_of,
            projection.stale AS projection_stale,
            projection.partial AS projection_partial,
            projection.account_key_version,
            projection.account_kms_key_id,
            projection.account_key_ciphertext,
            projection.connection_key_account_version,
            projection.connection_key_version,
            projection.connection_key_nonce,
            projection.connection_key_ciphertext,
            chats.*
          FROM projection
          LEFT JOIN chats ON true
          ORDER BY chats.last_activity_at DESC, chats.public_id
        `);
        const projection = result[0];
        const asOf = timestampString(
          projection?.projection_as_of ?? projection?.connection_created_at,
        );
        if (
          projection === undefined ||
          asOf === null ||
          typeof projection.projection_stale !== "boolean" ||
          typeof projection.projection_partial !== "boolean"
        ) {
          return null;
        }
        const keyMaterial = parseGroupKeyMaterial(projection);
        const rows = result.filter((row) => typeof row.public_id === "string");
        const encrypted = (
          row: Record<string, unknown>,
          prefix: "display" | "phone",
        ): McpToolDirectoryCiphertext | null => {
          const ciphertext = bytes(row[`${prefix}_ciphertext`]);
          const nonce = bytes(row[`${prefix}_nonce`]);
          const version = positiveInteger(row[`${prefix}_version`]);
          const keyVersion = positiveInteger(
            row[
              prefix === "display" ? "display_key_version" : "phone_key_version"
            ],
          );
          if (
            ciphertext === null &&
            nonce === null &&
            version === null &&
            keyVersion === null
          )
            return null;
          if (
            ciphertext === null ||
            nonce === null ||
            version !== 1 ||
            keyVersion === null
          )
            throw new Error("invalid conversation metadata ciphertext");
          return {
            ciphertext: base64(ciphertext),
            nonce: base64(nonce),
            keyVersion,
            version: 1,
          };
        };
        return {
          accountKey: keyMaterial?.accountKey ?? null,
          asOf,
          connectionKey: keyMaterial?.connectionKey ?? null,
          partial: projection.projection_partial,
          stale: projection.projection_stale,
          chats: rows.map((row) => {
            const activity = timestampString(row.last_activity_at);
            if (
              typeof row.public_id !== "string" ||
              typeof row.recipient_public_id !== "string" ||
              typeof row.recipient_record_id !== "string" ||
              activity === null ||
              (row.kind !== "direct" && row.kind !== "group") ||
              (row.last_activity_direction !== "inbound" &&
                row.last_activity_direction !== "outbound")
            )
              throw new Error("invalid WhatsApp Conversation");
            return {
              conversationId: row.public_id,
              kind: row.kind,
              recipientId: row.recipient_public_id,
              displayName: encrypted(row, "display"),
              displayNameRecordId: row.recipient_record_id,
              displayNameEntity:
                row.kind === "direct" ? "directory-contact" : "whatsapp-group",
              phone: encrypted(row, "phone"),
              lastActivityAt: activity,
              lastActivityDirection: row.last_activity_direction,
            };
          }),
        };
      }),
    ),
  readApiKeyMessages: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if (
          !/^con_[A-Za-z0-9_-]{21}$/u.test(input.connectionPublicId) ||
          !/^cvs_[A-Za-z0-9_-]{21}$/u.test(input.conversationPublicId) ||
          !Number.isSafeInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 51 ||
          (input.cursorSentAt === null) !== (input.cursorPublicId === null) ||
          (input.cursorPublicId !== null &&
            !/^msg_[A-Za-z0-9_-]{21}$/u.test(input.cursorPublicId))
        ) {
          throw new Error("invalid API message query");
        }
        if (
          (await enterAccountContext(connection, input.personalAccountId)) ===
            null ||
          !input.permissions.includes("messages:read")
        ) {
          return null;
        }
        const materialResult = await db.execute<Record<string, unknown>>(sql`
          SELECT
            connections.id AS connection_id,
            connections.created_at AS connection_created_at,
            connections.message_retention_days,
            connections.personal_account_id,
            conversations.public_id AS conversation_public_id,
            conversations.kind AS conversation_kind,
            coalesce(
              contacts.public_id,
              groups.public_id,
              conversations.recipient_public_id
            ) AS recipient_public_id,
            account_keys.key_version AS account_key_version,
            account_keys.kms_key_id AS account_kms_key_id,
            account_keys.ciphertext AS account_key_ciphertext,
            connection_keys.account_key_version AS connection_key_account_version,
            connection_keys.key_version AS connection_key_version,
            connection_keys.nonce AS connection_key_nonce,
            connection_keys.ciphertext AS connection_key_ciphertext
          FROM public.api_keys AS grants
          JOIN public.api_key_connections AS selected
            ON selected.personal_account_id = grants.personal_account_id
           AND selected.api_key_id = grants.id
          JOIN public.whatsapp_connections AS connections
            ON connections.personal_account_id = selected.personal_account_id
           AND connections.id = selected.whatsapp_connection_id
          JOIN public.whatsapp_conversations AS conversations
            ON conversations.personal_account_id = connections.personal_account_id
           AND conversations.whatsapp_connection_id = connections.id
          JOIN public.whatsapp_connection_key_envelopes AS connection_keys
            ON connection_keys.personal_account_id =
                connections.personal_account_id
           AND connection_keys.whatsapp_connection_id = connections.id
          JOIN public.personal_account_key_envelopes AS account_keys
            ON account_keys.personal_account_id =
                connections.personal_account_id
           AND account_keys.key_version = connection_keys.account_key_version
          LEFT JOIN public.directory_contacts AS contacts
            ON conversations.kind = 'direct'
           AND contacts.personal_account_id = conversations.personal_account_id
           AND contacts.whatsapp_connection_id =
                conversations.whatsapp_connection_id
           AND contacts.provider_identity_index =
                conversations.recipient_locator
          LEFT JOIN public.whatsapp_groups AS groups
            ON conversations.kind = 'group'
           AND groups.personal_account_id = conversations.personal_account_id
           AND groups.whatsapp_connection_id =
                conversations.whatsapp_connection_id
           AND groups.provider_locator = conversations.recipient_locator
          WHERE grants.id = ${input.apiKeyGrantId}
            AND grants.personal_account_id = ${input.personalAccountId}
            AND grants.state = 'active'
            AND (grants.expires_at IS NULL
              OR grants.expires_at > ${input.observedAt})
            AND 'messages:read' = ANY(grants.permissions)
            AND connections.public_id = ${input.connectionPublicId}
            AND conversations.public_id = ${input.conversationPublicId}
            AND connections.state <> 'deleting'
            AND NOT public.whatsapp_recipient_excluded(
              conversations.personal_account_id,
              conversations.whatsapp_connection_id,
              CASE WHEN conversations.kind = 'group' THEN 'group' ELSE 'contact' END,
              conversations.recipient_locator
            )
            AND account_keys.unavailable_at IS NULL
            AND account_keys.ciphertext IS NOT NULL
            AND connection_keys.unavailable_at IS NULL
            AND connection_keys.nonce IS NOT NULL
            AND connection_keys.ciphertext IS NOT NULL
        `);
        const row = materialResult[0];
        const accountId =
          typeof row?.personal_account_id === "string"
            ? row.personal_account_id
            : null;
        const connectionId =
          typeof row?.connection_id === "string" ? row.connection_id : null;
        const accountCiphertext = bytes(row?.account_key_ciphertext);
        const accountKeyVersion = positiveInteger(row?.account_key_version);
        const connectionAccountKeyVersion = positiveInteger(
          row?.connection_key_account_version,
        );
        const connectionCiphertext = bytes(row?.connection_key_ciphertext);
        const connectionKeyVersion = positiveInteger(
          row?.connection_key_version,
        );
        const connectionNonce = bytes(row?.connection_key_nonce);
        const material =
          accountId === null ||
          connectionId === null ||
          typeof row?.account_kms_key_id !== "string" ||
          accountCiphertext === null ||
          accountKeyVersion === null ||
          connectionAccountKeyVersion === null ||
          connectionCiphertext === null ||
          connectionKeyVersion === null ||
          connectionNonce?.byteLength !== 12
            ? null
            : {
                accountKey: {
                  ciphertext: base64(accountCiphertext),
                  keyVersion: accountKeyVersion,
                  kmsKeyId: row.account_kms_key_id,
                  personalAccountId: accountId,
                  version: 1 as const,
                },
                connectionKey: {
                  accountKeyVersion: connectionAccountKeyVersion,
                  ciphertext: base64(connectionCiphertext),
                  connectionId,
                  keyVersion: connectionKeyVersion,
                  nonce: base64(connectionNonce),
                  personalAccountId: accountId,
                  version: 1 as const,
                },
              };
        const connectionStarted = timestamp(row?.connection_created_at);
        const retentionDays =
          row?.message_retention_days === null
            ? null
            : positiveInteger(row?.message_retention_days);
        const conversationPublicId = row?.conversation_public_id;
        const conversationKind = row?.conversation_kind;
        const recipientPublicId = row?.recipient_public_id;
        if (
          material === null ||
          connectionStarted === null ||
          typeof conversationPublicId !== "string" ||
          !/^cvs_[A-Za-z0-9_-]{21}$/u.test(conversationPublicId) ||
          (conversationKind !== "direct" && conversationKind !== "group") ||
          typeof recipientPublicId !== "string" ||
          !/^(ctc|grp)_[A-Za-z0-9_-]{21}$/u.test(recipientPublicId)
        ) {
          return null;
        }
        const { historyStart, historyStartReason } = historyWindow(
          connectionStarted,
          retentionDays,
          input.observedAt,
        );
        const rows = await db.execute<Record<string, unknown>>(
          selectStoredMessageRows(
            {
              conversationPublicId: input.conversationPublicId,
              cursorPublicId: input.cursorPublicId,
              cursorSentAt: input.cursorSentAt,
              historyStart,
              limit: input.limit,
            },
            material.accountKey.personalAccountId,
            material.connectionKey.connectionId,
          ),
        );
        const pageRows = takeMessageRows(rows, input.limit, null);
        const newest =
          pageRows.messages[0]?.sentAt ?? input.observedAt.toISOString();
        const gaps = await loadIntersectingGaps(db, {
          accountId: material.accountKey.personalAccountId,
          connectionId: material.connectionKey.connectionId,
          historyStart,
          newest,
        });
        return {
          ...material,
          conversation: {
            kind: conversationKind,
            publicId: conversationPublicId,
            recipientId: recipientPublicId,
          },
          messages: pageRows.messages,
          hasOlder: pageRows.hasOlder,
          sizeLimited: pageRows.sizeLimited,
          historyStartsAt: historyStart.toISOString(),
          historyStartReason,
          gaps,
        };
      }),
    ),
  completeApiKeyMessageRecordRead: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if (
          !Number.isSafeInteger(input.dailyRecordLimit) ||
          input.dailyRecordLimit < 1 ||
          !Number.isSafeInteger(input.resultCount) ||
          input.resultCount < 0 ||
          input.resultCount > 50
        ) {
          throw new Error("invalid API message completion");
        }
        if (
          (await enterAccountContext(connection, input.personalAccountId)) ===
          null
        ) {
          throw new Error("authorization unavailable");
        }
        const accountContext = sql`nullif(
          current_setting('public.personal_account_id', true), ''
        )::uuid`;
        const completion = await db.execute<{
          completed: unknown;
          used_count: unknown;
        }>(sql`
          WITH locked_account AS MATERIALIZED (
            SELECT accounts.id
            FROM public.personal_accounts accounts
            WHERE accounts.id = ${accountContext}
            FOR UPDATE
          ), used AS MATERIALIZED (
            SELECT coalesce(sum(logs.result_count), 0)::int AS count
            FROM public.tool_call_logs logs
            JOIN locked_account ON locked_account.id = logs.personal_account_id
            WHERE logs.tool_name IN ('read_messages', 'search_messages')
              AND logs.outcome = 'success'
              AND logs.started_at >= date_trunc(
                'day', ${input.observedAt}::timestamptz AT TIME ZONE 'UTC'
              ) AT TIME ZONE 'UTC'
              AND logs.started_at < (
                date_trunc(
                  'day', ${input.observedAt}::timestamptz AT TIME ZONE 'UTC'
                ) AT TIME ZONE 'UTC'
              ) + interval '1 day'
          ), updated AS (
            UPDATE public.tool_call_logs logs
            SET completed_at = ${input.observedAt},
                outcome = 'success',
                error_code = NULL,
                result_count = ${input.resultCount},
                latency_ms = GREATEST(
                  0,
                  floor(extract(epoch FROM (${input.observedAt}::timestamptz - logs.started_at)) * 1000)
                )::integer
            FROM used
            WHERE used.count + ${input.resultCount} <= ${input.dailyRecordLimit}
              AND logs.id = ${input.auditLogId}
              AND logs.personal_account_id = ${accountContext}
              AND logs.api_key_id = ${input.apiKeyGrantId}
              AND logs.tool_name IN ('read_messages', 'search_messages')
              AND logs.outcome = 'started'
            RETURNING logs.id
          )
          SELECT used.count AS used_count,
                 EXISTS (SELECT 1 FROM updated) AS completed
          FROM used
        `);
        const usedCount = Number(completion[0]?.used_count);
        if (!Number.isSafeInteger(usedCount))
          throw new Error("invalid returned-record quota");
        if (usedCount + input.resultCount > input.dailyRecordLimit) {
          return {
            outcome: "record_quota_exhausted" as const,
            resetsAt: new Date(
              Date.UTC(
                input.observedAt.getUTCFullYear(),
                input.observedAt.getUTCMonth(),
                input.observedAt.getUTCDate() + 1,
              ),
            ),
          };
        }
        if (completion[0]?.completed !== true)
          throw new Error("Activity Log completion unavailable");
        return { outcome: "success" as const };
      }),
    ),
  rejectProtectedOperation: (input) =>
    input.channel === "mcp"
      ? rejectMcpProtectedOperation(provider, {
          ...input.authorization,
          auditLogId: input.auditLogId,
          errorCode: input.errorCode,
          observedAt: input.observedAt,
          operationName: input.operationName as
            | "list_connections"
            | "list_contacts"
            | "search_messages",
          ...(input.connectionPublicId === undefined
            ? {}
            : { connectionPublicId: input.connectionPublicId }),
        })
      : provider.withConnection((connection) =>
          withTransaction(connection, async () => {
            const personalAccountId = await enterAccountContext(
              connection,
              input.personalAccountId,
            );
            if (personalAccountId === null)
              return "authorization_denied" as const;
            const apiKeyName = input.apiKey.name.trim();
            if (
              apiKeyName.length < 1 ||
              apiKeyName.length > 64 ||
              !/^apk_[A-Za-z0-9_-]{21}$/u.test(input.apiKey.publicId) ||
              !/^[a-z][a-z0-9_]{0,63}$/u.test(input.operationName)
            ) {
              throw new Error("invalid API Activity Log principal");
            }
            if (
              input.requiredPermission !== undefined &&
              !(input.permissions ?? []).includes(input.requiredPermission)
            ) {
              await insertActivityLog(connection, {
                apiKey: { ...input.apiKey, name: apiKeyName },
                auditLogId: input.auditLogId,
                authorizationId: null,
                channel: "api",
                completed: true,
                connectionPublicId: input.connectionPublicId,
                errorCode: "authorization_denied",
                observedAt: input.observedAt,
                outcome: "authorization_denied",
                personalAccountId,
                quotaReserved: false,
                toolName: input.operationName,
              });
              return "authorization_denied" as const;
            }
            await insertActivityLog(connection, {
              apiKey: { ...input.apiKey, name: apiKeyName },
              auditLogId: input.auditLogId,
              authorizationId: null,
              channel: "api",
              completed: true,
              connectionPublicId: input.connectionPublicId,
              errorCode: input.errorCode,
              observedAt: input.observedAt,
              outcome: "execution_error",
              personalAccountId,
              quotaReserved: false,
              toolName: input.operationName,
            });
            return "rejected" as const;
          }),
        ),
  completeProtectedOperation: (input) =>
    provider.withConnection((connection) =>
      (async () => {
        const db = makeDatabase(connection);
        const completed = await db.execute(sql<{
          personal_account_id: unknown;
          updated_id: unknown;
        }>`WITH authorized AS MATERIALIZED (
              SELECT public.bootstrap_tool_call_log(${input.auditLogId})
                AS personal_account_id
            ), context AS MATERIALIZED (
              SELECT set_config(
                'public.personal_account_id',
                COALESCE((SELECT personal_account_id::text FROM authorized), ''),
                false
              )
            ), updated AS (
              UPDATE public.tool_call_logs AS logs
              SET completed_at = ${input.completedAt},
                  outcome = ${input.outcome},
                  error_code = ${input.errorCode},
                  result_count = ${input.resultCount},
                  latency_ms = GREATEST(
                    0,
                    floor(extract(epoch FROM (
                      ${input.completedAt}::timestamptz - logs.started_at
                    )) * 1000)
                  )::integer
              FROM authorized
              CROSS JOIN context
              WHERE logs.id = ${input.auditLogId}
                AND logs.personal_account_id = authorized.personal_account_id
                AND (
                  (${input.outcome} = 'execution_error' AND (
                    logs.outcome = 'started'
                    OR (
                       logs.tool_name IN ('read_messages', 'search_messages')
                      AND logs.outcome = 'success'
                    )
                  ))
                  OR (${input.outcome} <> 'execution_error'
                    AND logs.outcome = 'started')
                )
              RETURNING logs.id
            )
            SELECT authorized.personal_account_id, updated.id AS updated_id
            FROM authorized
            CROSS JOIN context
            CROSS JOIN updated`);
        const personalAccountId = completed[0]?.personal_account_id;
        if (typeof personalAccountId !== "string") {
          throw new Error("Activity Log unavailable");
        }
        if (typeof completed[0]?.updated_id !== "string") {
          throw new Error("Activity Log completion unavailable");
        }
      })(),
    ),
});

const makePgConnectionProvider = (
  connectionString: string,
): McpToolConnectionProvider => ({
  withConnection: (use) =>
    withPgRequestConnection(connectionString, (client) =>
      use(makeQueryConnection(client)),
    ),
});

export const makePgMcpToolRepository = (
  connectionString: string,
): McpToolRepository =>
  makeMcpToolRepository(makePgConnectionProvider(connectionString));
