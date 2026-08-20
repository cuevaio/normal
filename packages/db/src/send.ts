import { and, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { makeDatabase, makeQueryConnection } from "./database";
import type { McpToolConnectionProvider, SendGrantIdentity } from "./mcp-tool";
import { withPgRequestConnection } from "./request-connection";
import {
  activityLogsInApp,
  directoryContactsInApp,
  pendingSendContentsInApp,
  sendOperationsInApp,
  storedMessagesInApp,
  whatsappConversationsInApp,
  whatsappGroupsInApp,
  whatsappRecipientExclusionsInApp,
} from "./schema";

export interface SendCiphertext {
  readonly ciphertext: Uint8Array;
  readonly keyVersion: number;
  readonly nonce: Uint8Array;
}

export interface SendEncryptionMaterial {
  readonly accountKey: {
    readonly ciphertext: Uint8Array;
    readonly keyVersion: number;
    readonly kmsKeyId: string;
    readonly personalAccountId: string;
  };
  readonly connectionKey: {
    readonly accountKeyVersion: number;
    readonly ciphertext: Uint8Array;
    readonly connectionId: string;
    readonly keyVersion: number;
    readonly nonce: Uint8Array;
    readonly personalAccountId: string;
  };
}

interface SendProviderBase extends SendEncryptionMaterial {
  readonly authority: SendCiphertext;
  readonly identityKey: SendCiphertext;
  readonly messageSearchKey: SendCiphertext;
}

export type SendProviderMaterial = SendProviderBase &
  (
    | {
        readonly contactPhone?: SendCiphertext | null;
        readonly recipient: SendCiphertext;
        readonly recipientType: "contact" | "group";
        readonly recipientRecordId: string;
      }
    | { readonly recipientType: "phone" | "username" }
  );

export interface SendReceiptRecord {
  readonly createdAt: Date;
  readonly publicId: string;
  readonly status:
    | "processing"
    | "accepted"
    | "sent"
    | "delivered"
    | "read"
    | "failed"
    | "unknown";
  readonly statusChangedAt: Date;
}

export type CommitSendResult =
  | {
      readonly outcome:
        | "authorization_denied"
        | "connection_unavailable"
        | "idempotency_conflict"
        | "recipient_not_found";
    }
  | {
      readonly outcome: "rate_limited";
      readonly resetsAt: Date;
      readonly retryAfterSeconds: number;
    }
  | { readonly outcome: "replay"; readonly receipt: SendReceiptRecord }
  | {
      readonly outcome: "created";
      readonly provider: SendProviderMaterial;
      readonly receipt: SendReceiptRecord;
    };

export type { SendGrantIdentity };
export { apiSendGrant, mcpSendGrant } from "./mcp-tool";

export type CommitSendInput = {
  readonly auditLogId: string;
  readonly channel: "api" | "mcp";
  readonly connectionPublicId: string;
  readonly fingerprint: string;
  readonly grant: SendGrantIdentity;
  readonly hourRequestLimit: number;
  readonly idempotencyKey: string;
  readonly minuteRequestLimit: number;
  readonly observedAt: Date;
  readonly pendingExpiresAt: Date;
  readonly directRecipientType?: "phone" | "username";
  readonly recipientPublicId: string | null;
  readonly sendDailyLimit: number;
  readonly sendId: string;
  readonly sendPublicId: string;
  readonly sendPerMinuteLimit: number;
};

export interface AtomicSendRepository {
  readonly commit: (
    input: CommitSendInput,
    encrypt: (material: SendEncryptionMaterial) => Promise<SendCiphertext>,
  ) => Promise<CommitSendResult>;
  readonly expireLeases: (observedAt: Date) => Promise<number>;
  readonly recordProviderOutcome: (input: {
    readonly changedAt: Date;
    readonly messageIdentity?: string;
    readonly sendId: string;
    readonly status:
      | "accepted"
      | "sent"
      | "delivered"
      | "read"
      | "failed"
      | "unknown";
    readonly storedMessage?: {
      readonly content: SendCiphertext;
      readonly contentType: "text";
      readonly conversationId: string;
      readonly conversationPublicId: string;
      readonly messageId: string;
      readonly messagePublicId: string;
      readonly messageSearch: {
        readonly indexVersion: 1;
        readonly tokens: ReadonlyArray<string>;
      };
    };
  }) => Promise<SendReceiptRecord>;
}

const scalar = (
  row: Record<string, unknown> | undefined,
  key: string,
): string => {
  const value = row?.[key];
  if (typeof value !== "string") throw new Error(`invalid ${key}`);
  return value;
};
const bytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value))
    return new Uint8Array(value);
  throw new Error("invalid ciphertext");
};
const integer = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("invalid version");
  return value;
};
const date = (value: unknown): Date => {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.valueOf())) throw new Error("invalid timestamp");
  return parsed;
};
const receipt = (row: Record<string, unknown>): SendReceiptRecord => ({
  createdAt: date(row.created_at),
  publicId: scalar(row, "public_id"),
  status: scalar(row, "status") as SendReceiptRecord["status"],
  statusChangedAt: date(row.status_changed_at),
});

const grantPrincipal = (grant: SendGrantIdentity, channel: "api" | "mcp") =>
  grant.kind === "mcp"
    ? {
        apiKeyId: null as string | null,
        apiKeyName: null as string | null,
        apiKeyPublicId: null as string | null,
        channel: "mcp" as const,
        grantId: grant.authorization.authorizationId,
        grantType: "mcp" as const,
        mcpAuthorizationId: grant.authorization.authorizationId,
      }
    : {
        apiKeyId: grant.apiKey.grantId,
        apiKeyName: grant.apiKey.name,
        apiKeyPublicId: grant.apiKey.publicId,
        channel,
        grantId: grant.apiKey.grantId,
        grantType: "api" as const,
        mcpAuthorizationId: null as string | null,
      };

export const makePgAtomicSendRepository = (
  provider: McpToolConnectionProvider,
): AtomicSendRepository => ({
  commit: (input, encrypt) =>
    provider.withConnection(async (connection) => {
      const db = makeDatabase(connection);
      let transactionCommitted = false;
      await db.execute(sql`BEGIN`);
      try {
        const principal = grantPrincipal(input.grant, input.channel);
        const boot =
          input.grant.kind === "mcp"
            ? await db.execute<{ personal_account_id: unknown }>(
                sql`WITH authorized AS MATERIALIZED (
                      SELECT public.bootstrap_mcp_tool_call(
                        ${input.grant.authorization.authorizationId},
                        ${input.grant.authorization.oauthSubject},
                        ${input.grant.authorization.clientId ?? null}
                      ) AS personal_account_id
                    )
                    SELECT authorized.personal_account_id,
                           set_config(
                             'public.personal_account_id',
                             authorized.personal_account_id::text,
                             false
                           ) AS configured_account_id
                    FROM authorized
                    WHERE authorized.personal_account_id IS NOT NULL`,
              )
            : await (async () => {
                const apiKey =
                  input.grant.kind === "api" ? input.grant.apiKey : null;
                if (apiKey === null) {
                  return [] as Array<{ personal_account_id: unknown }>;
                }
                await db.execute(
                  sql`SELECT set_config(
                        'public.personal_account_id',
                        ${apiKey.personalAccountId},
                        true
                      )`,
                );
                return db.execute<{ personal_account_id: unknown }>(
                  sql`SELECT account.id AS personal_account_id
                      FROM public.personal_accounts AS account
                      INNER JOIN public.api_keys AS keys
                        ON keys.personal_account_id = account.id
                       AND keys.id = ${principal.grantId}
                      WHERE account.id = ${apiKey.personalAccountId}
                        AND account.state = 'active'`,
                );
              })();
        const accountId = boot[0]?.personal_account_id;
        if (typeof accountId !== "string") {
          await db.execute(sql`ROLLBACK`);
          return { outcome: "authorization_denied" as const };
        }
        const finishAudit = async (
          outcome:
            | "authorization_denied"
            | "execution_error"
            | "rate_limited"
            | "success",
          errorCode: string | null,
          sendPublicId: string | null = null,
        ) => {
          await db.insert(activityLogsInApp).values({
            id: input.auditLogId,
            personalAccountId: accountId,
            channel: principal.channel,
            mcpAuthorizationId: principal.mcpAuthorizationId,
            apiKeyId: principal.apiKeyId,
            apiKeyPublicId: principal.apiKeyPublicId,
            apiKeyName: principal.apiKeyName,
            toolName: "send_text_message",
            startedAt: input.observedAt.toISOString(),
            completedAt: input.observedAt.toISOString(),
            outcome,
            errorCode,
            resultCount: outcome === "success" ? 1 : null,
            latencyMs: 0,
            quotaReserved: false,
            expiresAt: sql`${input.observedAt}::timestamptz + interval '90 days'`,
            connectionPublicId: input.connectionPublicId,
            sendPublicId,
          });
          await db.execute(sql`COMMIT`);
        };
        const authorized = await db.execute<Record<string, unknown>>(
          input.grant.kind === "mcp"
            ? sql`WITH locked_account AS MATERIALIZED (
                    SELECT account.id
                    FROM public.personal_accounts AS account
                    WHERE account.id = ${accountId}
                    FOR UPDATE
                  ),
                  locked_authorization AS MATERIALIZED (
                    SELECT auth.id,
                           auth.personal_account_id,
                           auth.scopes
                    FROM public.mcp_authorizations AS auth
                    INNER JOIN locked_account
                      ON locked_account.id = auth.personal_account_id
                    WHERE auth.id = ${input.grant.authorization.authorizationId}
                    FOR UPDATE OF auth
                  ),
                  active AS MATERIALIZED (
                    SELECT public.bootstrap_active_mcp_tool_call(
                      ${input.grant.authorization.authorizationId},
                      ${input.grant.authorization.oauthSubject},
                      ${input.grant.authorization.clientId ?? null},
                      ${input.observedAt}
                    ) AS personal_account_id
                  )
                  SELECT conn.id AS connection_id,
                         conn.state AS connection_state,
                         conn.message_retention_days,
                         bound.id AS bound_id,
                         bound.public_id AS bound_public_id,
                         bound.status AS bound_status,
                         bound.created_at AS bound_created_at,
                         bound.status_changed_at AS bound_status_changed_at,
                         bound.lease_expires_at AS bound_lease_expires_at,
                         bound.request_fingerprint AS bound_request_fingerprint
                  FROM locked_account
                  INNER JOIN locked_authorization
                    ON locked_authorization.personal_account_id = locked_account.id
                  INNER JOIN active
                    ON active.personal_account_id = locked_authorization.personal_account_id
                  INNER JOIN public.mcp_authorization_connections AS selected
                    ON selected.personal_account_id = locked_authorization.personal_account_id
                   AND selected.mcp_authorization_id = locked_authorization.id
                  INNER JOIN public.whatsapp_connections AS conn
                    ON conn.personal_account_id = selected.personal_account_id
                   AND conn.id = selected.whatsapp_connection_id
                  LEFT JOIN LATERAL (
                    SELECT send.id,
                           send.public_id,
                           send.status,
                           send.created_at,
                           send.status_changed_at,
                           send.lease_expires_at,
                           binding.request_fingerprint
                    FROM public.send_idempotency_bindings AS binding
                    INNER JOIN public.send_operations AS send
                      ON send.id = binding.send_operation_id
                    WHERE binding.grant_id = ${principal.grantId}
                      AND binding.idempotency_key = ${input.idempotencyKey}
                      AND binding.expires_at > ${input.observedAt}
                    FOR UPDATE OF binding, send
                  ) AS bound ON true
                  WHERE ${"messages:send"} = ANY(locked_authorization.scopes)
                    AND conn.public_id = ${input.connectionPublicId}
                  FOR UPDATE OF conn`
            : sql`WITH locked_account AS MATERIALIZED (
                    SELECT account.id
                    FROM public.personal_accounts AS account
                    WHERE account.id = ${accountId}
                      AND account.state = 'active'
                    FOR UPDATE
                  ),
                  locked_key AS MATERIALIZED (
                    SELECT keys.id,
                           keys.personal_account_id,
                           keys.permissions,
                           keys.state,
                           keys.expires_at
                    FROM public.api_keys AS keys
                    INNER JOIN locked_account
                      ON locked_account.id = keys.personal_account_id
                    WHERE keys.id = ${principal.grantId}
                    FOR UPDATE OF keys
                  )
                  SELECT conn.id AS connection_id,
                         conn.state AS connection_state,
                         conn.message_retention_days,
                         bound.id AS bound_id,
                         bound.public_id AS bound_public_id,
                         bound.status AS bound_status,
                         bound.created_at AS bound_created_at,
                         bound.status_changed_at AS bound_status_changed_at,
                         bound.lease_expires_at AS bound_lease_expires_at,
                         bound.request_fingerprint AS bound_request_fingerprint
                  FROM locked_account
                  INNER JOIN locked_key
                    ON locked_key.personal_account_id = locked_account.id
                  INNER JOIN public.api_key_connections AS selected
                    ON selected.personal_account_id = locked_key.personal_account_id
                   AND selected.api_key_id = locked_key.id
                  INNER JOIN public.whatsapp_connections AS conn
                    ON conn.personal_account_id = selected.personal_account_id
                   AND conn.id = selected.whatsapp_connection_id
                  LEFT JOIN LATERAL (
                    SELECT send.id,
                           send.public_id,
                           send.status,
                           send.created_at,
                           send.status_changed_at,
                           send.lease_expires_at,
                           binding.request_fingerprint
                    FROM public.send_idempotency_bindings AS binding
                    INNER JOIN public.send_operations AS send
                      ON send.id = binding.send_operation_id
                    WHERE binding.grant_id = ${principal.grantId}
                      AND binding.idempotency_key = ${input.idempotencyKey}
                      AND binding.expires_at > ${input.observedAt}
                    FOR UPDATE OF binding, send
                  ) AS bound ON true
                  WHERE locked_key.state = 'active'
                    AND (
                      locked_key.expires_at IS NULL
                      OR locked_key.expires_at > ${input.observedAt}
                    )
                    AND ${"messages:send"} = ANY(locked_key.permissions)
                    AND conn.public_id = ${input.connectionPublicId}
                  FOR UPDATE OF conn`,
        );
        if (authorized[0] === undefined) {
          await finishAudit("authorization_denied", "authorization_denied");
          return { outcome: "authorization_denied" as const };
        }
        const connectionId = scalar(authorized[0], "connection_id");
        // A WhatsApp Connection set to retain until deletion stores NULL and
        // contributes no policy deadline of its own.
        const retentionDays =
          authorized[0].message_retention_days === null
            ? null
            : integer(authorized[0].message_retention_days);
        const bound: Record<string, unknown>[] =
          authorized[0].bound_id === null
            ? []
            : [
                {
                  id: authorized[0].bound_id,
                  public_id: authorized[0].bound_public_id,
                  status: authorized[0].bound_status,
                  created_at: authorized[0].bound_created_at,
                  status_changed_at: authorized[0].bound_status_changed_at,
                  lease_expires_at: authorized[0].bound_lease_expires_at,
                  request_fingerprint: authorized[0].bound_request_fingerprint,
                },
              ];
        if (bound[0] !== undefined) {
          if (
            bound[0].status === "processing" &&
            date(bound[0].lease_expires_at) <= input.observedAt
          ) {
            await db
              .update(sendOperationsInApp)
              .set({
                status: "unknown",
                statusChangedAt: input.observedAt.toISOString(),
              })
              .where(eq(sendOperationsInApp.id, scalar(bound[0], "id")));
            bound[0].status = "unknown";
            bound[0].status_changed_at = input.observedAt.toISOString();
          }
          const result =
            scalar(bound[0], "request_fingerprint") === input.fingerprint
              ? { outcome: "replay" as const, receipt: receipt(bound[0]) }
              : { outcome: "idempotency_conflict" as const };
          await finishAudit(
            result.outcome === "replay" ? "success" : "execution_error",
            result.outcome === "replay" ? null : "idempotency_conflict",
            scalar(bound[0], "public_id"),
          );
          return result;
        }
        if (authorized[0].connection_state !== "connected") {
          await finishAudit("execution_error", "connection_unavailable");
          return { outcome: "connection_unavailable" as const };
        }
        const recipientType =
          input.directRecipientType ??
          (input.recipientPublicId?.startsWith("ctc_") ? "contact" : "group");
        const directRecipient =
          recipientType === "phone" || recipientType === "username";
        if (
          (directRecipient && input.recipientPublicId !== null) ||
          (!directRecipient && input.recipientPublicId === null)
        ) {
          throw new Error("invalid send recipient input");
        }
        if (directRecipient) {
          const activeExclusion = await db
            .select({
              recipientPublicId:
                whatsappRecipientExclusionsInApp.recipientPublicId,
            })
            .from(whatsappRecipientExclusionsInApp)
            .where(
              and(
                eq(
                  whatsappRecipientExclusionsInApp.personalAccountId,
                  accountId,
                ),
                eq(
                  whatsappRecipientExclusionsInApp.whatsappConnectionId,
                  connectionId,
                ),
                eq(whatsappRecipientExclusionsInApp.excluded, true),
              ),
            )
            .limit(1);
          if (activeExclusion.length > 0) {
            await finishAudit("execution_error", "recipient_not_found");
            return { outcome: "recipient_not_found" as const };
          }
        }
        const recipient = directRecipient
          ? []
          : recipientType === "contact"
            ? await db
                .select({
                  phone_ciphertext_version:
                    directoryContactsInApp.phoneCiphertextVersion,
                  phone_key_version: directoryContactsInApp.phoneKeyVersion,
                  phone_nonce: directoryContactsInApp.phoneNonce,
                  phone_ciphertext: directoryContactsInApp.phoneCiphertext,
                  recipient_record_id:
                    directoryContactsInApp.providerIdentityIndex,
                  provider_identity_ciphertext_version:
                    directoryContactsInApp.providerIdentityCiphertextVersion,
                  provider_identity_key_version:
                    directoryContactsInApp.providerIdentityKeyVersion,
                  provider_identity_nonce:
                    directoryContactsInApp.providerIdentityNonce,
                  provider_identity_ciphertext:
                    directoryContactsInApp.providerIdentityCiphertext,
                })
                .from(directoryContactsInApp)
                .where(
                  and(
                    eq(directoryContactsInApp.personalAccountId, accountId),
                    eq(
                      directoryContactsInApp.whatsappConnectionId,
                      connectionId,
                    ),
                    eq(
                      directoryContactsInApp.publicId,
                      input.recipientPublicId ?? "",
                    ),
                    eq(directoryContactsInApp.active, true),
                    sql`NOT public.whatsapp_recipient_excluded(${accountId}, ${connectionId}, 'contact', ${directoryContactsInApp.providerIdentityIndex})`,
                  ),
                )
            : await db.execute<Record<string, unknown>>(
                sql`SELECT NULL AS phone_ciphertext_version,
                           NULL AS phone_key_version,
                           NULL AS phone_nonce,
                           NULL AS phone_ciphertext,
                           groups.id AS recipient_record_id,
                           groups.provider_identity_ciphertext_version,
                           groups.provider_identity_key_version,
                           groups.provider_identity_nonce,
                           groups.provider_identity_ciphertext
                    FROM public.whatsapp_groups AS groups
                    WHERE groups.personal_account_id = ${accountId}
                      AND groups.whatsapp_connection_id = ${connectionId}
                      AND groups.public_id = ${input.recipientPublicId}
                      AND groups.joined = true
                      AND NOT public.whatsapp_recipient_excluded(
                        ${accountId}, ${connectionId}, 'group', groups.provider_locator
                      )`,
              );
        if (!directRecipient && recipient[0] === undefined) {
          await finishAudit("execution_error", "recipient_not_found");
          return { outcome: "recipient_not_found" as const };
        }
        const policyPendingExpiry =
          retentionDays === null
            ? null
            : new Date(input.observedAt.valueOf() + retentionDays * 86_400_000);
        const pendingExpiresAt =
          policyPendingExpiry !== null &&
          policyPendingExpiry < input.pendingExpiresAt
            ? policyPendingExpiry
            : input.pendingExpiresAt;
        const minuteStart = new Date(input.observedAt.valueOf() - 60_000);
        const dayStart = new Date(
          Date.UTC(
            input.observedAt.getUTCFullYear(),
            input.observedAt.getUTCMonth(),
            input.observedAt.getUTCDate(),
          ),
        );
        const hourStart = new Date(input.observedAt.valueOf() - 3_600_000);
        const quotasAndMaterial = await db.execute<Record<string, unknown>>(
          sql`SELECT material.*,
             (SELECT count(*)::int FROM public.tool_call_logs WHERE personal_account_id=${accountId} AND quota_reserved AND started_at>${minuteStart} AND started_at<=${input.observedAt}) AS request_minute,
             (SELECT (array_agg(started_at ORDER BY started_at DESC))[(${input.minuteRequestLimit}::int)] FROM public.tool_call_logs WHERE personal_account_id=${accountId} AND quota_reserved AND started_at>${minuteStart} AND started_at<=${input.observedAt}) AS request_minute_reset,
             (SELECT count(*)::int FROM public.tool_call_logs WHERE personal_account_id=${accountId} AND quota_reserved AND started_at>${hourStart} AND started_at<=${input.observedAt}) AS request_hour,
             (SELECT (array_agg(started_at ORDER BY started_at DESC))[(${input.hourRequestLimit}::int)] FROM public.tool_call_logs WHERE personal_account_id=${accountId} AND quota_reserved AND started_at>${hourStart} AND started_at<=${input.observedAt}) AS request_hour_reset,
             (SELECT count(*)::int FROM public.send_quota_reservations WHERE ${
               principal.grantType === "mcp"
                 ? sql`mcp_authorization_id=${principal.grantId}`
                 : sql`api_key_id=${principal.grantId}`
             } AND reserved_at>${minuteStart} AND reserved_at<=${input.observedAt}) AS send_minute,
             (SELECT (array_agg(reserved_at ORDER BY reserved_at DESC))[(${input.sendPerMinuteLimit}::int)] FROM public.send_quota_reservations WHERE ${
               principal.grantType === "mcp"
                 ? sql`mcp_authorization_id=${principal.grantId}`
                 : sql`api_key_id=${principal.grantId}`
             } AND reserved_at>${minuteStart} AND reserved_at<=${input.observedAt}) AS send_minute_reset,
             (SELECT count(*)::int FROM public.send_quota_reservations WHERE personal_account_id=${accountId} AND reserved_at>=${dayStart} AND reserved_at<=${input.observedAt}) AS send_day
           FROM public.load_send_key_material(
             ${accountId},
             ${connectionId}
           ) AS material`,
        );
        const row = quotasAndMaterial[0];
        if (row === undefined) throw new Error("send key material unavailable");
        const q = row;
        const limited =
          Number(q.request_minute) >= input.minuteRequestLimit ||
          Number(q.request_hour) >= input.hourRequestLimit ||
          Number(q.send_minute) >= input.sendPerMinuteLimit ||
          Number(q.send_day) >= input.sendDailyLimit;
        if (limited) {
          await finishAudit("rate_limited", "rate_limited");
          const candidates: Date[] = [];
          if (Number(q.request_minute) >= input.minuteRequestLimit)
            candidates.push(
              new Date(date(q.request_minute_reset).valueOf() + 60_000),
            );
          if (Number(q.request_hour) >= input.hourRequestLimit)
            candidates.push(
              new Date(date(q.request_hour_reset).valueOf() + 3_600_000),
            );
          if (Number(q.send_minute) >= input.sendPerMinuteLimit)
            candidates.push(
              new Date(date(q.send_minute_reset).valueOf() + 60_000),
            );
          if (Number(q.send_day) >= input.sendDailyLimit)
            candidates.push(new Date(dayStart.valueOf() + 86_400_000));
          const resetsAt = new Date(
            Math.max(...candidates.map((candidate) => candidate.valueOf())),
          );
          return {
            outcome: "rate_limited" as const,
            resetsAt,
            retryAfterSeconds: Math.max(
              1,
              Math.ceil(
                (resetsAt.valueOf() - input.observedAt.valueOf()) / 1_000,
              ),
            ),
          };
        }
        const encryptionMaterial: SendEncryptionMaterial = {
          accountKey: {
            ciphertext: bytes(row.account_key_ciphertext),
            keyVersion: integer(row.account_key_version),
            kmsKeyId: scalar(row, "kms_key_id"),
            personalAccountId: accountId,
          },
          connectionKey: {
            accountKeyVersion: integer(row.connection_account_key_version),
            ciphertext: bytes(row.connection_key_ciphertext),
            connectionId,
            keyVersion: integer(row.connection_key_version),
            nonce: bytes(row.connection_key_nonce),
            personalAccountId: accountId,
          },
        };
        const pending = await encrypt(encryptionMaterial);
        const observedAt = input.observedAt.toISOString();
        await db.execute(
          sql`WITH inserted_audit AS (
                INSERT INTO public.tool_call_logs (
                  id, personal_account_id, channel, mcp_authorization_id,
                  api_key_id, api_key_public_id, api_key_name, tool_name,
                  started_at, completed_at, outcome, error_code, result_count,
                  latency_ms, quota_reserved, expires_at,
                  connection_public_id, send_public_id
                ) VALUES (
                  ${input.auditLogId}, ${accountId}, ${principal.channel},
                  ${principal.mcpAuthorizationId}, ${principal.apiKeyId},
                  ${principal.apiKeyPublicId}, ${principal.apiKeyName},
                  'send_text_message', ${observedAt}, NULL, 'started', NULL,
                  NULL, NULL, true,
                  ${input.observedAt}::timestamptz + interval '90 days',
                  ${input.connectionPublicId}, ${input.sendPublicId}
                )
                RETURNING id, personal_account_id
              ),
              inserted_send AS (
                INSERT INTO public.send_operations (
                  id, public_id, personal_account_id, grant_type,
                  mcp_authorization_id, api_key_id, tool_call_log_id,
                  whatsapp_connection_id, recipient_type, recipient_public_id,
                  status, created_at, status_changed_at, attempt_claimed_at,
                  lease_expires_at, expires_at
                )
                SELECT ${input.sendId}, ${input.sendPublicId},
                       inserted_audit.personal_account_id,
                       ${principal.grantType}, ${principal.mcpAuthorizationId},
                       ${principal.apiKeyId}, inserted_audit.id,
                       ${connectionId}, ${recipientType},
                       ${input.recipientPublicId}, 'processing', ${observedAt},
                       ${observedAt}, ${observedAt},
                       ${input.observedAt}::timestamptz + interval '30 seconds',
                       ${input.observedAt}::timestamptz + interval '90 days'
                FROM inserted_audit
                RETURNING id, personal_account_id
              ),
              inserted_binding AS (
                INSERT INTO public.send_idempotency_bindings (
                  personal_account_id, grant_type, grant_id,
                  mcp_authorization_id, api_key_id, idempotency_key,
                  send_operation_id, request_fingerprint, created_at, expires_at
                )
                SELECT inserted_send.personal_account_id,
                       ${principal.grantType}, ${principal.grantId},
                       ${principal.mcpAuthorizationId}, ${principal.apiKeyId},
                       ${input.idempotencyKey}, inserted_send.id,
                       ${input.fingerprint}, ${observedAt},
                       ${input.observedAt}::timestamptz + interval '90 days'
                FROM inserted_send
                RETURNING send_operation_id, personal_account_id
              ),
              inserted_pending AS (
                INSERT INTO public.pending_send_contents (
                  send_operation_id, personal_account_id,
                  whatsapp_connection_id, ciphertext_version, key_version,
                  nonce, ciphertext, expires_at
                )
                SELECT inserted_binding.send_operation_id,
                       inserted_binding.personal_account_id, ${connectionId},
                       1, ${pending.keyVersion}, ${pending.nonce},
                       ${pending.ciphertext}, ${pendingExpiresAt}
                FROM inserted_binding
                RETURNING send_operation_id, personal_account_id
              )
              INSERT INTO public.send_quota_reservations (
                send_operation_id, personal_account_id, grant_type,
                mcp_authorization_id, api_key_id, reserved_at
              )
              SELECT inserted_pending.send_operation_id,
                     inserted_pending.personal_account_id,
                     ${principal.grantType}, ${principal.mcpAuthorizationId},
                     ${principal.apiKeyId}, ${observedAt}
              FROM inserted_pending`,
        );
        await db.execute(sql`COMMIT`);
        transactionCommitted = true;
        const recipientRow = recipient[0];
        const providerBase: SendProviderBase = {
          ...encryptionMaterial,
          authority: {
            ciphertext: bytes(row.authority_ciphertext),
            keyVersion: integer(row.authority_key_version),
            nonce: bytes(row.authority_nonce),
          },
          identityKey: {
            ciphertext: bytes(row.identity_ciphertext),
            keyVersion: integer(row.identity_key_version),
            nonce: bytes(row.identity_nonce),
          },
          messageSearchKey: {
            ciphertext: bytes(row.message_search_key_ciphertext),
            keyVersion: integer(row.message_search_key_version),
            nonce: bytes(row.message_search_key_nonce),
          },
        };
        let providerMaterial: SendProviderMaterial;
        if (directRecipient) {
          providerMaterial = { ...providerBase, recipientType };
        } else {
          if (recipientRow === undefined) {
            throw new Error("send recipient material unavailable");
          }
          providerMaterial = {
            ...providerBase,
            contactPhone:
              recipientType === "contact" &&
              recipientRow.phone_ciphertext !== null &&
              recipientRow.phone_key_version !== null &&
              recipientRow.phone_nonce !== null
                ? {
                    ciphertext: bytes(recipientRow.phone_ciphertext),
                    keyVersion: integer(recipientRow.phone_key_version),
                    nonce: bytes(recipientRow.phone_nonce),
                  }
                : null,
            recipient: {
              ciphertext: bytes(recipientRow.provider_identity_ciphertext),
              keyVersion: integer(recipientRow.provider_identity_key_version),
              nonce: bytes(recipientRow.provider_identity_nonce),
            },
            recipientType,
            recipientRecordId: scalar(recipientRow, "recipient_record_id"),
          };
        }
        return {
          outcome: "created" as const,
          receipt: {
            createdAt: input.observedAt,
            publicId: input.sendPublicId,
            status: "processing" as const,
            statusChangedAt: input.observedAt,
          },
          provider: providerMaterial,
        };
      } catch (error) {
        if (!transactionCommitted) await db.execute(sql`ROLLBACK`);
        throw error;
      }
    }),
  expireLeases: (observedAt) =>
    provider.withConnection(async (connection) => {
      const result = await connection.query<{ expired_count: unknown }>(
        "SELECT public.expire_send_dispatch_leases($1) AS expired_count",
        [observedAt],
      );
      const count = Number(result.rows[0]?.expired_count);
      if (!Number.isSafeInteger(count) || count < 0)
        throw new Error("invalid expired send lease count");
      return count;
    }),
  recordProviderOutcome: (input) =>
    provider.withConnection(async (connection) => {
      const db = makeDatabase(connection);
      if (input.storedMessage === undefined) {
        const complete = () =>
          db.execute<Record<string, unknown>>(
            sql`WITH updated AS (
                UPDATE public.send_operations AS send
                SET status = ${input.status},
                    status_changed_at = ${input.changedAt},
                    message_identity = ${input.messageIdentity ?? null}
                WHERE send.id = ${input.sendId}
                  AND send.status = 'processing'
                  AND send.lease_expires_at > ${input.changedAt}
                RETURNING send.id,
                          send.public_id,
                          send.personal_account_id,
                          send.whatsapp_connection_id,
                          send.recipient_type,
                          send.recipient_public_id,
                          send.status,
                          send.created_at,
                          send.status_changed_at,
                          send.lease_expires_at,
                          send.tool_call_log_id
              ),
              expired AS (
                UPDATE public.send_operations AS send
                SET status = 'unknown',
                    status_changed_at = send.lease_expires_at
                WHERE send.id = ${input.sendId}
                  AND send.status = 'processing'
                  AND send.lease_expires_at <= ${input.changedAt}
                  AND NOT EXISTS (SELECT 1 FROM updated)
                RETURNING send.id,
                          send.public_id,
                          send.personal_account_id,
                          send.whatsapp_connection_id,
                          send.recipient_type,
                          send.recipient_public_id,
                          send.status,
                          send.created_at,
                          send.status_changed_at,
                          send.lease_expires_at,
                          send.tool_call_log_id
              ),
              existing AS MATERIALIZED (
                SELECT send.id,
                       send.public_id,
                       send.personal_account_id,
                       send.whatsapp_connection_id,
                       send.recipient_type,
                       send.recipient_public_id,
                       send.status,
                       send.created_at,
                       send.status_changed_at,
                       send.lease_expires_at,
                       send.tool_call_log_id
                FROM public.send_operations AS send
                WHERE send.id = ${input.sendId}
                  AND NOT EXISTS (SELECT 1 FROM updated)
                  AND NOT EXISTS (SELECT 1 FROM expired)
              ),
              operation AS MATERIALIZED (
                SELECT * FROM updated
                UNION ALL
                SELECT * FROM expired
                UNION ALL
                SELECT * FROM existing
              ),
              cleared_pending AS (
                DELETE FROM public.pending_send_contents AS pending
                USING updated
                WHERE ${input.status} = 'failed'
                  AND pending.send_operation_id = updated.id
              ),
              completed_audit AS (
                UPDATE public.tool_call_logs AS audit
                SET completed_at = ${input.changedAt},
                    outcome = 'success',
                    result_count = 1,
                    latency_ms = greatest(
                      0,
                      floor(extract(epoch FROM (
                        ${input.changedAt}::timestamptz - audit.started_at
                      )) * 1000)::int
                    )
                FROM operation
                WHERE audit.id = operation.tool_call_log_id
              )
              SELECT operation.*
              FROM operation`,
          );
        let rows = await complete();
        if (rows[0] === undefined) {
          const context = await db.execute<{ personal_account_id: unknown }>(
            sql`WITH send_context AS MATERIALIZED (
                  SELECT public.bootstrap_send_operation(${input.sendId}) AS personal_account_id
                )
                SELECT send_context.personal_account_id,
                       set_config(
                         'public.personal_account_id',
                         send_context.personal_account_id::text,
                         false
                       ) AS configured_account_id
                FROM send_context
                WHERE send_context.personal_account_id IS NOT NULL`,
          );
          if (typeof context[0]?.personal_account_id !== "string")
            throw new Error("send operation unavailable");
          rows = await complete();
        }
        if (rows[0] === undefined)
          throw new Error("send operation unavailable");
        return receipt(rows[0]);
      }
      await db.execute(sql`BEGIN`);
      const context = await db.execute<{ personal_account_id: unknown }>(
        sql`WITH send_context AS MATERIALIZED (
              SELECT public.bootstrap_send_operation(${input.sendId}) AS personal_account_id
            )
            SELECT send_context.personal_account_id,
                   set_config(
                     'public.personal_account_id',
                     send_context.personal_account_id::text,
                     true
                   ) AS configured_account_id
            FROM send_context
            WHERE send_context.personal_account_id IS NOT NULL`,
      );
      const accountId = context[0]?.personal_account_id;
      if (typeof accountId !== "string") {
        await db.execute(sql`ROLLBACK`);
        throw new Error("send operation unavailable");
      }
      const operationSelection = {
        id: sendOperationsInApp.id,
        public_id: sendOperationsInApp.publicId,
        personal_account_id: sendOperationsInApp.personalAccountId,
        whatsapp_connection_id: sendOperationsInApp.whatsappConnectionId,
        recipient_type: sendOperationsInApp.recipientType,
        recipient_public_id: sendOperationsInApp.recipientPublicId,
        status: sendOperationsInApp.status,
        created_at: sendOperationsInApp.createdAt,
        status_changed_at: sendOperationsInApp.statusChangedAt,
        lease_expires_at: sendOperationsInApp.leaseExpiresAt,
      };
      const result = await db
        .update(sendOperationsInApp)
        .set({
          status: input.status,
          statusChangedAt: input.changedAt.toISOString(),
          messageIdentity: input.messageIdentity ?? null,
        })
        .where(
          and(
            eq(sendOperationsInApp.id, input.sendId),
            eq(sendOperationsInApp.status, "processing"),
            gt(
              sendOperationsInApp.leaseExpiresAt,
              input.changedAt.toISOString(),
            ),
          ),
        )
        .returning(operationSelection);
      const operation =
        result[0] ??
        (
          await db
            .update(sendOperationsInApp)
            .set({
              status: "unknown",
              statusChangedAt: sendOperationsInApp.leaseExpiresAt,
            })
            .where(
              and(
                eq(sendOperationsInApp.id, input.sendId),
                eq(sendOperationsInApp.status, "processing"),
                lte(
                  sendOperationsInApp.leaseExpiresAt,
                  input.changedAt.toISOString(),
                ),
              ),
            )
            .returning(operationSelection)
        )[0] ??
        (
          await db
            .select(operationSelection)
            .from(sendOperationsInApp)
            .where(eq(sendOperationsInApp.id, input.sendId))
            .for("update")
        )[0];
      if (operation === undefined) {
        await db.execute(sql`ROLLBACK`);
        throw new Error("send operation unavailable");
      }
      if (
        result[0] !== undefined &&
        input.messageIdentity !== undefined &&
        input.storedMessage !== undefined &&
        (result[0].recipient_type === "contact" ||
          result[0].recipient_type === "group") &&
        ["sent", "delivered", "read"].includes(input.status)
      ) {
        const recipient = await db
          .select({
            recipient_type: sendOperationsInApp.recipientType,
            recipient_public_id: sendOperationsInApp.recipientPublicId,
            recipient_locator: sql<string>`CASE ${sendOperationsInApp.recipientType}
              WHEN 'contact' THEN ${directoryContactsInApp.providerIdentityIndex}
              ELSE ${whatsappGroupsInApp.providerLocator}
            END`,
          })
          .from(sendOperationsInApp)
          .leftJoin(
            directoryContactsInApp,
            and(
              eq(sendOperationsInApp.recipientType, "contact"),
              eq(
                directoryContactsInApp.personalAccountId,
                sendOperationsInApp.personalAccountId,
              ),
              eq(
                directoryContactsInApp.whatsappConnectionId,
                sendOperationsInApp.whatsappConnectionId,
              ),
              eq(
                directoryContactsInApp.publicId,
                sendOperationsInApp.recipientPublicId,
              ),
            ),
          )
          .leftJoin(
            whatsappGroupsInApp,
            and(
              eq(sendOperationsInApp.recipientType, "group"),
              eq(
                whatsappGroupsInApp.personalAccountId,
                sendOperationsInApp.personalAccountId,
              ),
              eq(
                whatsappGroupsInApp.whatsappConnectionId,
                sendOperationsInApp.whatsappConnectionId,
              ),
              eq(
                whatsappGroupsInApp.publicId,
                sendOperationsInApp.recipientPublicId,
              ),
            ),
          )
          .where(eq(sendOperationsInApp.id, input.sendId));
        const recipientLocator = scalar(recipient[0], "recipient_locator");
        const recipientType = scalar(recipient[0], "recipient_type");
        const recipientPublicId = scalar(recipient[0], "recipient_public_id");
        await db
          .insert(whatsappConversationsInApp)
          .values({
            id: input.storedMessage.conversationId,
            personalAccountId: scalar(operation, "personal_account_id"),
            whatsappConnectionId: scalar(operation, "whatsapp_connection_id"),
            publicId: input.storedMessage.conversationPublicId,
            kind: recipientType === "contact" ? "direct" : "group",
            recipientLocator,
            recipientPublicId,
            lastActivityAt: input.changedAt.toISOString(),
            lastActivityDirection: "outbound",
          })
          .onConflictDoNothing();
        const conversation = await db
          .select({ id: whatsappConversationsInApp.id })
          .from(whatsappConversationsInApp)
          .where(
            and(
              eq(
                whatsappConversationsInApp.personalAccountId,
                scalar(operation, "personal_account_id"),
              ),
              eq(
                whatsappConversationsInApp.whatsappConnectionId,
                scalar(operation, "whatsapp_connection_id"),
              ),
              eq(whatsappConversationsInApp.recipientLocator, recipientLocator),
            ),
          );
        const conversationId = scalar(conversation[0], "id");
        await db
          .insert(storedMessagesInApp)
          .values({
            id: input.storedMessage.messageId,
            personalAccountId: scalar(operation, "personal_account_id"),
            whatsappConnectionId: scalar(operation, "whatsapp_connection_id"),
            conversationId,
            publicId: input.storedMessage.messagePublicId,
            messageIdentity: input.messageIdentity,
            direction: "outbound",
            sentAt: input.changedAt.toISOString(),
            contentType: input.storedMessage.contentType,
            contentCiphertextVersion: 1,
            contentKeyVersion: input.storedMessage.content.keyVersion,
            contentNonce: input.storedMessage.content.nonce,
            contentCiphertext: input.storedMessage.content.ciphertext,
            messageSearchIndexVersion:
              input.storedMessage.messageSearch.indexVersion,
            messageSearchTokens: [...input.storedMessage.messageSearch.tokens],
            receivedAt: input.changedAt.toISOString(),
            webhookItemIdentity: null,
          })
          .onConflictDoNothing();
        const latest = await db
          .select({
            direction: storedMessagesInApp.direction,
            sentAt: storedMessagesInApp.sentAt,
          })
          .from(storedMessagesInApp)
          .innerJoin(
            sendOperationsInApp,
            and(
              eq(
                sendOperationsInApp.personalAccountId,
                storedMessagesInApp.personalAccountId,
              ),
              eq(
                sendOperationsInApp.whatsappConnectionId,
                storedMessagesInApp.whatsappConnectionId,
              ),
            ),
          )
          .where(
            and(
              eq(sendOperationsInApp.id, input.sendId),
              eq(storedMessagesInApp.conversationId, conversationId),
              isNull(storedMessagesInApp.contentExpiredAt),
            ),
          )
          .orderBy(
            desc(storedMessagesInApp.sentAt),
            desc(storedMessagesInApp.publicId),
          )
          .limit(1);
        if (latest[0] !== undefined) {
          await db
            .update(whatsappConversationsInApp)
            .set({
              lastActivityAt: latest[0].sentAt,
              lastActivityDirection: latest[0].direction,
              updatedAt: sql`transaction_timestamp()`,
            })
            .where(eq(whatsappConversationsInApp.id, conversationId));
        }
        await db
          .delete(pendingSendContentsInApp)
          .where(eq(pendingSendContentsInApp.sendOperationId, input.sendId));
      }
      if (result[0] !== undefined && input.status === "failed") {
        await db
          .delete(pendingSendContentsInApp)
          .where(eq(pendingSendContentsInApp.sendOperationId, input.sendId));
      }
      await db.execute(sql`COMMIT`);
      try {
        await db.execute(
          sql`WITH send_context AS MATERIALIZED (
                SELECT public.bootstrap_send_operation(${input.sendId}) AS personal_account_id
              ),
              configured AS MATERIALIZED (
                SELECT send_context.personal_account_id,
                       set_config(
                         'public.personal_account_id',
                         send_context.personal_account_id::text,
                         false
                       ) AS configured_account_id
                FROM send_context
                WHERE send_context.personal_account_id IS NOT NULL
              ),
              selected_send AS MATERIALIZED (
                SELECT send.tool_call_log_id
                FROM public.send_operations AS send
                INNER JOIN configured
                  ON configured.personal_account_id = send.personal_account_id
                WHERE send.id = ${input.sendId}
              )
              UPDATE public.tool_call_logs AS audit
              SET completed_at = ${input.changedAt},
                  outcome = 'success',
                  result_count = 1,
                  latency_ms = greatest(
                    0,
                    floor(extract(epoch FROM (
                      ${input.changedAt}::timestamptz - audit.started_at
                    )) * 1000)::int
                  )
              FROM selected_send
              WHERE audit.id = selected_send.tool_call_log_id`,
        );
      } catch {
        // Provider outcome persistence remains authoritative even if audit
        // completion fails independently.
      }
      return receipt(operation);
    }),
});

export const makePgAtomicSendRepositoryFromConnectionString = (
  connectionString: string,
): AtomicSendRepository =>
  makePgAtomicSendRepository({
    withConnection: (use) =>
      withPgRequestConnection(connectionString, (client) =>
        use(makeQueryConnection(client)),
      ),
  });
