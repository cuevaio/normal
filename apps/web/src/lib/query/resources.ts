import {
  type ApiKeySummary as ContractApiKeySummary,
  type CreatedApiKey,
  decodeApiKeyList,
  decodeApiKeyRevokeResponse,
  decodeCreatedApiKey,
} from "@whatsapp-mcp/contracts/api-key";
import {
  ApiKeyId,
  McpAuthorizationId,
  makeIdempotencyKey,
} from "@whatsapp-mcp/contracts/handles";
import { Schema } from "effect";
import {
  type AccountInsights,
  decodeAccountInsights,
} from "@/app/account-insights";
import { authorizedJson } from "./http";

export interface ApiKeyRecord {
  readonly connection_ids: ReadonlyArray<string>;
  readonly created_at: string;
  readonly credential_hint: string;
  readonly expires_at: string | null;
  readonly id: string;
  readonly last_used_at: string | null;
  readonly name: string;
  readonly permissions: ReadonlyArray<
    "connections:read" | "directory:read" | "messages:read" | "messages:send"
  >;
  readonly revoked_at: string | null;
  readonly state: "active" | "expired" | "revoked";
}

export interface CreatedApiKeyRecord extends ApiKeyRecord {
  readonly credential: string;
}

export interface SelectableConnection {
  readonly displayName: string;
  readonly id: string;
  readonly numberSuffix: string;
  readonly state: string;
}

export interface SafeWhatsAppConnection {
  readonly displayName: string;
  readonly id: string;
  readonly numberSuffix: string;
  readonly retentionDays: number | null;
  readonly retentionOptions: ReadonlyArray<number>;
  readonly state:
    | "connected"
    | "connecting"
    | "degraded"
    | "deleting"
    | "disconnected"
    | "reconnect_required";
  readonly stateChangedAt: string;
}

export interface McpAuthorization {
  readonly client: {
    readonly id: string;
    readonly name: string;
  };
  readonly connectionIds: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly expiryState: "active" | "expired";
  readonly id: string;
  readonly revocationState: "active" | "revoked";
  readonly revokedAt: string | null;
  readonly scopes: ReadonlyArray<
    "connections:read" | "directory:read" | "messages:read" | "messages:send"
  >;
}

export interface ActivityLog {
  readonly capability: string;
  readonly channel: "api" | "mcp";
  readonly client: { readonly id: string; readonly name: string };
  readonly completedAt: string | null;
  readonly counts: {
    readonly mediaBytes: number;
    readonly results: number | null;
  };
  readonly errorCode: string | null;
  readonly latencyMs: number | null;
  readonly outcome:
    | "started"
    | "success"
    | "execution_error"
    | "rate_limited"
    | "authorization_denied";
  readonly principal: "api_key" | "mcp_authorization";
  readonly references: ReadonlyArray<string>;
  readonly startedAt: string;
}

export interface ActivityLogPage {
  readonly logs: ReadonlyArray<ActivityLog>;
  readonly nextCursor: string | null;
}

export type RecipientKind = "contact" | "group";

export interface Recipient {
  readonly displayName: string | null;
  readonly excluded: boolean;
  readonly id: string;
  readonly kind: RecipientKind;
  readonly phoneLastFour: string | null;
}

export interface RecipientPage {
  readonly directory: {
    readonly asOf: string;
    readonly partial: boolean;
    readonly stale: boolean;
  };
  readonly nextCursor: string | null;
  readonly recipients: ReadonlyArray<Recipient>;
}

const authorizationScopeLabels: Record<
  McpAuthorization["scopes"][number],
  true
> = {
  "connections:read": true,
  "directory:read": true,
  "messages:read": true,
  "messages:send": true,
};

const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const toApiKeyRecord = (summary: ContractApiKeySummary): ApiKeyRecord => ({
  connection_ids: [...summary.connection_ids],
  created_at: summary.created_at,
  credential_hint: summary.credential_hint,
  expires_at: summary.expires_at,
  id: summary.id,
  last_used_at: summary.last_used_at,
  name: summary.name,
  permissions: [...summary.permissions],
  revoked_at: summary.revoked_at,
  state: summary.state,
});

export const apiKeySummaryFromCreated = (
  created: CreatedApiKey | CreatedApiKeyRecord,
): ApiKeyRecord => {
  const { credential: _credential, ...summary } = created;
  return {
    connection_ids: [...summary.connection_ids],
    created_at: summary.created_at,
    credential_hint: summary.credential_hint,
    expires_at: summary.expires_at,
    id: summary.id,
    last_used_at: summary.last_used_at,
    name: summary.name,
    permissions: [...summary.permissions],
    revoked_at: summary.revoked_at,
    state: summary.state,
  };
};

export const upsertApiKey = (
  keys: ReadonlyArray<ApiKeyRecord> | undefined,
  next: ApiKeyRecord,
): ReadonlyArray<ApiKeyRecord> => [
  next,
  ...(keys ?? []).filter((key) => key.id !== next.id),
];

export const applyApiKeyRevocation = (
  keys: ReadonlyArray<ApiKeyRecord> | undefined,
  revoked: {
    readonly id: string;
    readonly revoked_at: string;
    readonly state: "revoked";
  },
): ReadonlyArray<ApiKeyRecord> | undefined =>
  keys?.map((key) =>
    key.id === revoked.id
      ? { ...key, revoked_at: revoked.revoked_at, state: "revoked" }
      : key,
  );

export const decodeActivityLogs = (value: unknown): ActivityLogPage | null => {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { activity_logs?: unknown }).activity_logs)
  ) {
    return null;
  }
  const nextCursor = (value as { next_cursor?: unknown }).next_cursor;
  if (
    nextCursor !== null &&
    (typeof nextCursor !== "string" ||
      !/^tcl_[A-Za-z0-9_-]{21}$/u.test(nextCursor))
  ) {
    return null;
  }
  const decoded: ActivityLog[] = [];
  for (const candidate of (value as { activity_logs: unknown[] })
    .activity_logs) {
    if (typeof candidate !== "object" || candidate === null) return null;
    const log = candidate as Record<string, unknown>;
    const client = log.client as Record<string, unknown> | undefined;
    const counts = log.counts as Record<string, unknown> | undefined;
    const references = log.references as Record<string, unknown> | undefined;
    if (
      typeof log.capability !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/u.test(log.capability) ||
      typeof client?.id !== "string" ||
      typeof client.name !== "string" ||
      (log.completed_at !== null && !isIsoDate(log.completed_at)) ||
      typeof counts?.media_bytes !== "number" ||
      (counts.results !== null && typeof counts.results !== "number") ||
      (log.error_code !== null && typeof log.error_code !== "string") ||
      (log.latency_ms !== null && typeof log.latency_ms !== "number") ||
      (log.outcome !== "started" &&
        log.outcome !== "success" &&
        log.outcome !== "execution_error" &&
        log.outcome !== "rate_limited" &&
        log.outcome !== "authorization_denied") ||
      typeof references !== "object" ||
      references === null ||
      (log.channel !== undefined &&
        log.channel !== "mcp" &&
        log.channel !== "api") ||
      (references.mcp_authorization_id !== null &&
        references.mcp_authorization_id !== undefined &&
        !Schema.is(McpAuthorizationId)(references.mcp_authorization_id)) ||
      (references.api_key_id !== null &&
        references.api_key_id !== undefined &&
        !Schema.is(ApiKeyId)(references.api_key_id)) ||
      (typeof references.api_key_id === "string") ===
        (typeof references.mcp_authorization_id === "string") ||
      (references.whatsapp_connection_id !== null &&
        (typeof references.whatsapp_connection_id !== "string" ||
          !/^con_[A-Za-z0-9_-]{21}$/u.test(
            references.whatsapp_connection_id,
          ))) ||
      (references.send_id !== null &&
        (typeof references.send_id !== "string" ||
          !/^snd_[A-Za-z0-9_-]{21}$/u.test(references.send_id))) ||
      !isIsoDate(log.started_at)
    ) {
      return null;
    }
    decoded.push({
      capability: log.capability,
      channel: log.channel === "api" ? "api" : "mcp",
      client: { id: client.id, name: client.name },
      completedAt: log.completed_at,
      counts: { mediaBytes: counts.media_bytes, results: counts.results },
      errorCode: log.error_code,
      latencyMs: log.latency_ms,
      outcome: log.outcome,
      principal:
        typeof references.api_key_id === "string"
          ? "api_key"
          : "mcp_authorization",
      references: [
        ...(typeof references.mcp_authorization_id === "string"
          ? [references.mcp_authorization_id]
          : []),
        ...(typeof references.api_key_id === "string"
          ? [references.api_key_id]
          : []),
        ...(typeof references.whatsapp_connection_id === "string"
          ? [references.whatsapp_connection_id]
          : []),
        ...(typeof references.send_id === "string" ? [references.send_id] : []),
      ],
      startedAt: log.started_at,
    });
  }
  return { logs: decoded, nextCursor };
};

export const decodeMcpAuthorizations = (
  value: unknown,
): ReadonlyArray<McpAuthorization> | null => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Array.isArray(
      (value as { readonly mcp_authorizations?: unknown }).mcp_authorizations,
    )
  ) {
    return null;
  }
  const decoded: Array<McpAuthorization> = [];
  for (const candidate of (
    value as { readonly mcp_authorizations: ReadonlyArray<unknown> }
  ).mcp_authorizations) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return null;
    }
    const authorization = candidate as Record<string, unknown>;
    const client = authorization.client;
    const scopes = authorization.scopes;
    const connectionIds = authorization.connection_ids;
    if (
      typeof client !== "object" ||
      client === null ||
      Array.isArray(client) ||
      typeof (client as Record<string, unknown>).id !== "string" ||
      typeof (client as Record<string, unknown>).name !== "string" ||
      !Array.isArray(connectionIds) ||
      connectionIds.some(
        (connectionId) =>
          typeof connectionId !== "string" ||
          !/^con_[A-Za-z0-9_-]{21}$/u.test(connectionId),
      ) ||
      !Array.isArray(scopes) ||
      scopes.some(
        (scope) =>
          typeof scope !== "string" ||
          !Object.hasOwn(authorizationScopeLabels, scope),
      ) ||
      typeof authorization.id !== "string" ||
      !/^mca_[A-Za-z0-9_-]{21}$/u.test(authorization.id) ||
      !isIsoDate(authorization.created_at) ||
      !isIsoDate(authorization.expires_at) ||
      (authorization.expiry_state !== "active" &&
        authorization.expiry_state !== "expired") ||
      (authorization.revocation_state !== "active" &&
        authorization.revocation_state !== "revoked") ||
      (authorization.revoked_at !== null &&
        !isIsoDate(authorization.revoked_at))
    ) {
      return null;
    }
    decoded.push({
      client: {
        id: (client as { readonly id: string }).id,
        name: (client as { readonly name: string }).name,
      },
      connectionIds: connectionIds as ReadonlyArray<string>,
      createdAt: authorization.created_at,
      expiresAt: authorization.expires_at,
      expiryState: authorization.expiry_state,
      id: authorization.id,
      revocationState: authorization.revocation_state,
      revokedAt: authorization.revoked_at,
      scopes: scopes as McpAuthorization["scopes"],
    });
  }
  return decoded;
};

export const decodeSafeWhatsAppConnection = (
  connection: Record<string, unknown>,
): SafeWhatsAppConnection | null => {
  if (
    typeof connection.display_name !== "string" ||
    connection.display_name.length === 0 ||
    typeof connection.id !== "string" ||
    !/^con_[A-Za-z0-9_-]{21}$/u.test(connection.id) ||
    typeof connection.number_suffix !== "string" ||
    !/^[0-9]{4}$/u.test(connection.number_suffix) ||
    (connection.state !== "connected" &&
      connection.state !== "connecting" &&
      connection.state !== "degraded" &&
      connection.state !== "deleting" &&
      connection.state !== "disconnected" &&
      connection.state !== "reconnect_required") ||
    typeof connection.state_changed_at !== "string"
  ) {
    return null;
  }
  return {
    displayName: connection.display_name,
    id: connection.id,
    numberSuffix: connection.number_suffix,
    retentionDays: 30,
    retentionOptions: [],
    state: connection.state,
    stateChangedAt: connection.state_changed_at,
  };
};

export const selectableConnections = (
  connections: ReadonlyArray<SafeWhatsAppConnection>,
): ReadonlyArray<SelectableConnection> =>
  connections
    .filter((connection) => connection.state !== "deleting")
    .map((connection) => ({
      displayName: connection.displayName,
      id: connection.id,
      numberSuffix: connection.numberSuffix,
      state: connection.state,
    }));

const decodeRecipientPage = (value: unknown): RecipientPage | null => {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  const directory = body.directory as Record<string, unknown> | undefined;
  const nextCursor = body.next_cursor;
  if (
    typeof directory?.as_of !== "string" ||
    typeof directory.partial !== "boolean" ||
    typeof directory.stale !== "boolean" ||
    !Array.isArray(body.recipients) ||
    (nextCursor !== null &&
      (typeof nextCursor !== "string" ||
        !/^(?:ctc|grp)_[A-Za-z0-9_-]{21}$/u.test(nextCursor)))
  ) {
    return null;
  }
  const recipients: Recipient[] = [];
  for (const candidate of body.recipients) {
    if (typeof candidate !== "object" || candidate === null) return null;
    const recipient = candidate as Record<string, unknown>;
    if (
      typeof recipient.id !== "string" ||
      !/^(?:ctc|grp)_[A-Za-z0-9_-]{21}$/u.test(recipient.id) ||
      (recipient.kind !== "contact" && recipient.kind !== "group") ||
      typeof recipient.excluded !== "boolean" ||
      (recipient.display_name !== null &&
        typeof recipient.display_name !== "string") ||
      (recipient.phone_last_four !== null &&
        typeof recipient.phone_last_four !== "string")
    ) {
      return null;
    }
    recipients.push({
      displayName: recipient.display_name as string | null,
      excluded: recipient.excluded,
      id: recipient.id,
      kind: recipient.kind,
      phoneLastFour: recipient.phone_last_four as string | null,
    });
  }
  return {
    directory: {
      asOf: directory.as_of,
      partial: directory.partial,
      stale: directory.stale,
    },
    nextCursor: nextCursor as string | null,
    recipients,
  };
};

export const fetchApiKeys = async (
  endpoint: string,
  token: string,
): Promise<ReadonlyArray<ApiKeyRecord>> => {
  const { body, ok } = await authorizedJson({ token, url: endpoint });
  if (!ok) throw new Error("api keys unavailable");
  try {
    return decodeApiKeyList(body).api_keys.map(toApiKeyRecord);
  } catch {
    throw new Error("api keys unavailable");
  }
};

export const createApiKey = async ({
  body,
  endpoint,
  token,
}: {
  readonly body: {
    readonly connection_ids: ReadonlyArray<string>;
    readonly expires_at?: string;
    readonly name: string;
    readonly permissions: ReadonlyArray<string>;
  };
  readonly endpoint: string;
  readonly token: string;
}): Promise<
  | { readonly created: CreatedApiKeyRecord; readonly ok: true }
  | { readonly error: string | undefined; readonly ok: false }
> => {
  const response = await authorizedJson({
    init: {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    token,
    url: endpoint,
  });
  if (!response.ok) {
    return {
      error:
        typeof (response.body as { error?: unknown }).error === "string"
          ? (response.body as { error: string }).error
          : undefined,
      ok: false,
    };
  }
  try {
    const created = decodeCreatedApiKey(response.body);
    return {
      created: {
        ...toApiKeyRecord(created),
        credential: created.credential,
      },
      ok: true,
    };
  } catch {
    return { error: undefined, ok: false };
  }
};

export const revokeApiKey = async ({
  endpoint,
  id,
  token,
}: {
  readonly endpoint: string;
  readonly id: string;
  readonly token: string;
}) => {
  const { body, ok } = await authorizedJson({
    init: { method: "DELETE" },
    token,
    url: `${endpoint}/${encodeURIComponent(id)}`,
  });
  if (!ok) throw new Error("api key revoke unavailable");
  try {
    return decodeApiKeyRevokeResponse(body).api_key;
  } catch {
    throw new Error("api key revoke unavailable");
  }
};

export const fetchConnections = async (
  endpoint: string,
  token: string,
): Promise<ReadonlyArray<SafeWhatsAppConnection>> => {
  const { body, ok } = await authorizedJson({ token, url: endpoint });
  if (!ok) throw new Error("connections unavailable");
  const listed = (body as { readonly whatsapp_connections?: unknown })
    .whatsapp_connections;
  if (!Array.isArray(listed)) throw new Error("connections unavailable");
  const parsed: SafeWhatsAppConnection[] = [];
  for (const connection of listed) {
    if (typeof connection !== "object" || connection === null) {
      throw new Error("connections unavailable");
    }
    const decoded = decodeSafeWhatsAppConnection(
      connection as Record<string, unknown>,
    );
    if (decoded === null) throw new Error("connections unavailable");
    parsed.push(decoded);
  }
  return parsed;
};

export const fetchConnectionsWithPolicies = async (
  endpoint: string,
  token: string,
): Promise<ReadonlyArray<SafeWhatsAppConnection>> => {
  const parsed = await fetchConnections(endpoint, token);
  return Promise.all(
    parsed.map(async (connection) => {
      const policy = await authorizedJson({
        token,
        url: `${endpoint}/${encodeURIComponent(connection.id)}/retention-policy`,
      });
      if (!policy.ok) throw new Error("retention unavailable");
      const policyBody = policy.body as {
        readonly allowed_days?: unknown;
        readonly policy?: { readonly days?: unknown };
      };
      if (
        !Array.isArray(policyBody.allowed_days) ||
        policyBody.allowed_days.some((day) => typeof day !== "number") ||
        (policyBody.policy?.days !== null &&
          typeof policyBody.policy?.days !== "number")
      ) {
        throw new Error("invalid retention policy");
      }
      return {
        ...connection,
        retentionDays: policyBody.policy.days as number | null,
        retentionOptions: policyBody.allowed_days as number[],
      };
    }),
  );
};

export const fetchMcpAuthorizations = async (
  endpoint: string,
  token: string,
): Promise<ReadonlyArray<McpAuthorization>> => {
  const { body, ok } = await authorizedJson({ token, url: endpoint });
  const decoded = decodeMcpAuthorizations(body);
  if (!ok || decoded === null) throw new Error("authorizations unavailable");
  return decoded;
};

export const fetchAccountInsights = async (
  endpoint: string,
  token: string,
): Promise<AccountInsights> => {
  const { body, ok } = await authorizedJson({ token, url: endpoint });
  const decoded = decodeAccountInsights(body);
  if (!ok || decoded === null) throw new Error("account insights unavailable");
  return decoded;
};

export const revokeMcpAuthorization = async ({
  authorization,
  endpoint,
  token,
}: {
  readonly authorization: McpAuthorization;
  readonly endpoint: string;
  readonly token: string;
}): Promise<McpAuthorization> => {
  const { body, ok } = await authorizedJson({
    init: { method: "DELETE" },
    token,
    url: `${endpoint}/${encodeURIComponent(authorization.id)}`,
  });
  const revoked = (body as { readonly mcp_authorization?: unknown })
    .mcp_authorization as
    | {
        readonly id?: unknown;
        readonly revocation_state?: unknown;
        readonly revoked_at?: unknown;
      }
    | undefined;
  if (
    !ok ||
    revoked?.id !== authorization.id ||
    revoked.revocation_state !== "revoked" ||
    !isIsoDate(revoked.revoked_at)
  ) {
    throw new Error("authorization revoke unavailable");
  }
  return {
    ...authorization,
    revocationState: "revoked",
    revokedAt: revoked.revoked_at,
  };
};

export const fetchActivityLogPage = async ({
  cursor,
  endpoint,
  token,
}: {
  readonly cursor: string | null;
  readonly endpoint: string;
  readonly token: string;
}): Promise<ActivityLogPage> => {
  const url = new URL(endpoint);
  if (cursor !== null) url.searchParams.set("cursor", cursor);
  const { body, ok } = await authorizedJson({ token, url: url.toString() });
  const decoded = decodeActivityLogs(body);
  if (!ok || decoded === null) throw new Error("activity logs unavailable");
  return decoded;
};

export const flattenActivityLogs = (
  pages: ReadonlyArray<ActivityLogPage> | undefined,
): ReadonlyArray<ActivityLog> => pages?.flatMap((page) => page.logs) ?? [];

export const fetchRecipientPage = async ({
  connectionId,
  cursor,
  endpoint,
  kind,
  search,
  token,
}: {
  readonly connectionId: string;
  readonly cursor: string | null;
  readonly endpoint: string;
  readonly kind: RecipientKind;
  readonly search: string;
  readonly token: string;
}): Promise<RecipientPage> => {
  const url = new URL(`${endpoint}/${connectionId}/recipients`);
  url.searchParams.set("kind", kind);
  if (cursor !== null) url.searchParams.set("cursor", cursor);
  if (search.trim().length >= 3) {
    url.searchParams.set("search", search.trim());
  }
  const { body, ok } = await authorizedJson({ token, url: url.toString() });
  const decoded = decodeRecipientPage(body);
  if (!ok || decoded === null) throw new Error("recipients unavailable");
  return decoded;
};

export const flattenRecipientPages = (
  pages: ReadonlyArray<RecipientPage> | undefined,
): RecipientPage | null => {
  if (pages === undefined || pages.length === 0) return null;
  const latest = pages[pages.length - 1];
  if (latest === undefined) return null;
  return {
    directory: latest.directory,
    nextCursor: latest.nextCursor,
    recipients: pages.flatMap((page) => page.recipients),
  };
};

export const applyRecipientExclusion = (
  pages: ReadonlyArray<RecipientPage> | undefined,
  recipientId: string,
  excluded: boolean,
): ReadonlyArray<RecipientPage> | undefined =>
  pages?.map((page) => ({
    ...page,
    recipients: page.recipients.map((recipient) =>
      recipient.id === recipientId ? { ...recipient, excluded } : recipient,
    ),
  }));

export const setRecipientExclusion = async ({
  connectionId,
  endpoint,
  excluded,
  expectedExcluded,
  recipientId,
  token,
}: {
  readonly connectionId: string;
  readonly endpoint: string;
  readonly excluded: boolean;
  readonly expectedExcluded: boolean;
  readonly recipientId: string;
  readonly token: string;
}): Promise<boolean> => {
  const { body, ok } = await authorizedJson({
    init: {
      body: JSON.stringify({
        excluded,
        expected_excluded: expectedExcluded,
        idempotency_key: makeIdempotencyKey(),
      }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    },
    token,
    url: `${endpoint}/${connectionId}/recipients/${recipientId}/exclusion`,
  });
  const saved = (
    body as { readonly exclusion?: { readonly excluded?: unknown } }
  ).exclusion?.excluded;
  if (!ok || typeof saved !== "boolean") {
    throw new Error("exclusion unavailable");
  }
  return saved;
};

export const applyAuthorizationRevocation = (
  authorizations: ReadonlyArray<McpAuthorization> | undefined,
  revoked: McpAuthorization,
): ReadonlyArray<McpAuthorization> | undefined =>
  authorizations?.map((authorization) =>
    authorization.id === revoked.id ? revoked : authorization,
  );

export const replaceConnection = (
  connections: ReadonlyArray<SafeWhatsAppConnection> | undefined,
  next: SafeWhatsAppConnection,
): ReadonlyArray<SafeWhatsAppConnection> | undefined =>
  connections?.map((connection) =>
    connection.id === next.id ? next : connection,
  );

export const removeConnection = (
  connections: ReadonlyArray<SafeWhatsAppConnection> | undefined,
  connectionId: string,
): ReadonlyArray<SafeWhatsAppConnection> | undefined =>
  connections?.filter((connection) => connection.id !== connectionId);
