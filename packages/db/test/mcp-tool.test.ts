import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { makeDirectoryRepository } from "../src/directory";
import { makeMcpAuthorizationRepository } from "../src/mcp-authorization";
import {
  type McpToolConnectionProvider,
  type McpToolRepository,
  makeMcpToolRepository,
  mcpSendGrant,
} from "../src/mcp-tool";
import { runMigrations } from "../src/migrations";
import type { PersonalAccountConnectionProvider } from "../src/personal-account";
import {
  type AtomicSendRepository,
  makePgAtomicSendRepository,
} from "../src/send";
import { makeWebhookEventRepository } from "../src/webhook-event";

const accountId = "10000000-0000-4000-8000-000000000030";
const authorizationId = "40000000-0000-4000-8000-000000000030";
const oauthSubject = "A".repeat(43);
const connectionA = "con_123456789012345678930";
const connectionB = "con_123456789012345678931";
const connectionLater = "con_123456789012345678932";
const connectionWithoutSuffix = "con_123456789012345678933";
const observedAt = new Date("2026-07-31T12:00:00.000Z");

describe("MCP tool repository", () => {
  let database: PGlite;
  let repository: McpToolRepository;
  let sends: AtomicSendRepository;

  beforeEach(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE ROLE neon_superuser NOLOGIN BYPASSRLS;
      CREATE ROLE whatsapp_api_runtime LOGIN;
      CREATE ROLE whatsapp_webhook_runtime LOGIN;
      GRANT neon_superuser TO whatsapp_api_runtime;
      GRANT neon_superuser TO whatsapp_webhook_runtime;
    `);
    await runMigrations(database);
    await database.query(
      `SELECT * FROM public.admit_personal_account_for_clerk(
        $1, $2, 1, $3, decode('0102', 'hex'), 6
      )`,
      [
        "user_mcptool30",
        accountId,
        "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      ],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connections (
          id, personal_account_id, webhook_ingress_id,
          display_name_fallback, public_id, number_suffix, state,
          state_changed_at
        ) VALUES
          ('20000000-0000-4000-8000-000000000030', $1,
           '30000000-0000-4000-8000-000000000030', 'Bright Badger', $2, '1234',
           'connected', $6),
          ('20000000-0000-4000-8000-000000000031', $1,
           '30000000-0000-4000-8000-000000000031', 'Calm Falcon', $3, '5678',
           'deleting', $6),
          ('20000000-0000-4000-8000-000000000032', $1,
           '30000000-0000-4000-8000-000000000032', 'Clever Fox', $4, '9012',
           'connected', $6),
          ('20000000-0000-4000-8000-000000000033', $1,
           '30000000-0000-4000-8000-000000000033', 'Kind Otter', $5, NULL,
           'connecting', $6)`,
      [
        accountId,
        connectionA,
        connectionB,
        connectionLater,
        connectionWithoutSuffix,
        observedAt,
      ],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connection_key_envelopes (
         personal_account_id, whatsapp_connection_id, account_key_version,
         key_version, nonce, ciphertext
       ) VALUES (
          $1, '20000000-0000-4000-8000-000000000030', 1, 1,
          decode(repeat('03', 12), 'hex'), decode(repeat('04', 32), 'hex')
        ), (
          $1, '20000000-0000-4000-8000-000000000033', 1, 1,
          decode(repeat('07', 12), 'hex'), decode(repeat('08', 32), 'hex')
        )`,
      [accountId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connection_secrets (
         personal_account_id, whatsapp_connection_id, credential_ciphertext,
         credential_ciphertext_version, credential_key_version, credential_nonce,
         message_search_key_ciphertext_version, message_search_key_version,
         message_search_key_nonce, message_search_key_ciphertext
       ) VALUES (
         $1, '20000000-0000-4000-8000-000000000030',
         decode(repeat('05', 32), 'hex'), 1, 1,
          decode(repeat('06', 12), 'hex'), 1, 1,
          decode(repeat('11', 12), 'hex'), decode(repeat('12', 32), 'hex')
       )`,
      [accountId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connection_provider_sessions (
         personal_account_id, whatsapp_connection_id,
         locator_ciphertext_version, locator_key_version,
         locator_nonce, locator_ciphertext,
         authority_ciphertext_version, authority_key_version,
         authority_nonce, authority_ciphertext, created_at, updated_at
       ) VALUES (
         $1, '20000000-0000-4000-8000-000000000030',
         1, 1, decode(repeat('0d', 12), 'hex'), decode(repeat('0e', 32), 'hex'),
         1, 1, decode(repeat('0f', 12), 'hex'), decode(repeat('10', 32), 'hex'),
         $2, $2
       )`,
      [accountId, observedAt],
    );

    const provider: McpToolConnectionProvider &
      PersonalAccountConnectionProvider = {
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    };
    const authorizations = makeMcpAuthorizationRepository(provider);
    await authorizations.create({
      authorizationId,
      authorizedAt: observedAt,
      clientClass: "approved",
      clientId: "approved-client",
      clientName: "Approved MCP Client",
      clerkUserId: "user_mcptool30",
      connectionIds: [connectionA, connectionB, connectionWithoutSuffix],
      expiresAt: new Date("2026-10-29T12:00:00.000Z"),
      oauthSubject,
      reverifiedAt: new Date("2026-07-31T11:59:00.000Z"),
      scopes: [
        "connections:read",
        "directory:read",
        "messages:read",
        "messages:send",
      ],
    });
    repository = makeMcpToolRepository(provider);
    sends = makePgAtomicSendRepository(provider);
  });

  afterEach(async () => {
    await database.close();
  });

  const authorization = {
    authorizationId,
    clientId: "approved-client",
    oauthSubject,
  } as const;
  const grant = mcpSendGrant(authorization);

  test("discovers current scopes and lists only explicitly selected non-deleting Connections", async () => {
    const inspected = await repository.inspectAuthorization({
      ...authorization,
      observedAt,
    });
    expect(inspected).toEqual({
      scopes: [
        "connections:read",
        "directory:read",
        "messages:read",
        "messages:send",
      ],
    });

    await expect(
      repository.beginProtectedOperation({
        channel: "mcp",
        authorization,
        auditLogId: "50000000-0000-4000-8000-000000000030",
        hourLimit: 3,
        minuteLimit: 2,
        observedAt,
        operationName: "list_connections",
      }),
    ).resolves.toEqual({
      auditLogId: "50000000-0000-4000-8000-000000000030",
      outcome: "started",
    });

    const listed = await repository.listConnections({
      ...authorization,
      observedAt,
    });
    expect(listed).toMatchObject([
      {
        displayNameFallback: expect.any(String),
        numberLastFour: "1234",
        publicId: connectionA,
        state: "connected",
        stateChangedAt: "2026-07-31T12:00:00.000Z",
      },
      {
        displayNameFallback: expect.any(String),
        numberLastFour: null,
        publicId: connectionWithoutSuffix,
        state: "connecting",
        stateChangedAt: "2026-07-31T12:00:00.000Z",
      },
    ]);

    await repository.completeProtectedOperation({
      auditLogId: "50000000-0000-4000-8000-000000000030",
      completedAt: new Date("2026-07-31T12:00:00.025Z"),
      errorCode: null,
      outcome: "success",
      resultCount: 2,
    });
    const persisted = await database.query<{
      error_code: string | null;
      outcome: string;
      quota_reserved: boolean;
      result_count: number | null;
      tool_name: string;
    }>(
      `SELECT tool_name, outcome, error_code, result_count, quota_reserved
       FROM public.tool_call_logs`,
    );
    expect(persisted.rows).toEqual([
      {
        error_code: null,
        outcome: "success",
        quota_reserved: true,
        result_count: 2,
        tool_name: "list_connections",
      },
    ]);
  });

  test("lists a selected fallback-named Connection without encryption envelopes", async () => {
    await database.query(
      `DELETE FROM public.whatsapp_connection_key_envelopes
       WHERE personal_account_id = $1
         AND whatsapp_connection_id = '20000000-0000-4000-8000-000000000033'`,
      [accountId],
    );

    const listed = await repository.listConnections({
      ...authorization,
      observedAt,
    });

    expect(listed).toContainEqual(
      expect.objectContaining({
        accountKey: null,
        connectionKey: null,
        displayName: null,
        displayNameFallback: "Kind Otter",
        publicId: connectionWithoutSuffix,
      }),
    );
  });

  test("atomically binds, leases, quotas, audits, and encrypts one send before replay", async () => {
    await database.query(
      `INSERT INTO public.directory_contact_projections (
         personal_account_id, whatsapp_connection_id, as_of, stale, partial
       ) VALUES ($1, '20000000-0000-4000-8000-000000000030', $2, false, false)`,
      [accountId, observedAt],
    );
    await database.query(
      `INSERT INTO public.directory_contacts (
         personal_account_id, whatsapp_connection_id, public_id,
         provider_identity_index, provider_identity_ciphertext_version,
         provider_identity_key_version, provider_identity_nonce,
         provider_identity_ciphertext, display_name_sort, active,
         received_at
       ) VALUES (
         $1, '20000000-0000-4000-8000-000000000030',
         'ctc_123456789012345678930', $2, 1, 1,
         decode(repeat('11', 12), 'hex'), decode(repeat('12', 32), 'hex'),
         '', true, $3
       )`,
      [accountId, `di1_${"A".repeat(43)}`, observedAt],
    );
    let encrypted = 0;
    const input = {
      auditLogId: "50000000-0000-4000-8000-000000000099",
      channel: "mcp",
      connectionPublicId: connectionA,
      fingerprint: `sf1_${"B".repeat(43)}`,
      grant,
      hourRequestLimit: 100,
      idempotencyKey: "123456789012345678930",
      minuteRequestLimit: 100,
      observedAt,
      pendingExpiresAt: new Date("2026-08-07T12:00:00.000Z"),
      recipientPublicId: "ctc_123456789012345678930",
      sendDailyLimit: 100,
      sendId: "60000000-0000-4000-8000-000000000099",
      sendPerMinuteLimit: 100,
      sendPublicId: "snd_123456789012345678930",
    } as const;
    const created = await sends.commit(input, async (material) => {
      encrypted += 1;
      expect(material.connectionKey.connectionId).toBe(
        "20000000-0000-4000-8000-000000000030",
      );
      return {
        ciphertext: new Uint8Array(32).fill(20),
        keyVersion: 1,
        nonce: new Uint8Array(12).fill(21),
      };
    });
    expect(created).toMatchObject({
      outcome: "created",
      receipt: { status: "processing" },
    });
    expect(created).not.toHaveProperty("receipt.grantType");
    expect(created).not.toHaveProperty("receipt.mcpAuthorizationId");
    expect(created).not.toHaveProperty("receipt.apiKeyId");
    expect(encrypted).toBe(1);
    const grantRow = await database.query<{
      api_key_id: string | null;
      grant_type: string;
      mcp_authorization_id: string | null;
    }>(
      `SELECT grant_type, mcp_authorization_id, api_key_id
       FROM public.send_operations
       WHERE id=$1`,
      [input.sendId],
    );
    expect(grantRow.rows[0]).toEqual({
      api_key_id: null,
      grant_type: "mcp",
      mcp_authorization_id: authorizationId,
    });

    await database.query(
      `UPDATE public.whatsapp_connections SET state='degraded'
       WHERE public_id=$1`,
      [connectionA],
    );
    await database.query(
      `UPDATE public.directory_contacts SET active=false
       WHERE public_id='ctc_123456789012345678930'`,
    );
    await database.query(
      `UPDATE public.directory_contact_projections SET stale=true
       WHERE whatsapp_connection_id='20000000-0000-4000-8000-000000000030'`,
    );

    const replay = await sends.commit(
      { ...input, auditLogId: "50000000-0000-4000-8000-000000000098" },
      async () => {
        encrypted += 1;
        throw new Error("replay must not encrypt");
      },
    );
    expect(replay).toMatchObject({ outcome: "replay" });
    expect(encrypted).toBe(1);

    await database.query(
      `UPDATE public.whatsapp_connections SET state='disconnected'
       WHERE public_id=$1`,
      [connectionA],
    );
    await expect(
      sends.commit(
        { ...input, auditLogId: "50000000-0000-4000-8000-000000000097" },
        async () => {
          throw new Error("disconnected replay must not encrypt");
        },
      ),
    ).resolves.toMatchObject({ outcome: "replay" });

    for (const [auditLogId, changed] of [
      [
        "50000000-0000-4000-8000-000000000096",
        { fingerprint: `sf1_${"C".repeat(43)}` },
      ],
      [
        "50000000-0000-4000-8000-000000000095",
        {
          fingerprint: `sf1_${"D".repeat(43)}`,
          recipientPublicId: "grp_123456789012345678930",
        },
      ],
      [
        "50000000-0000-4000-8000-000000000094",
        {
          connectionPublicId: connectionWithoutSuffix,
          fingerprint: `sf1_${"E".repeat(43)}`,
        },
      ],
    ] as const) {
      await expect(
        sends.commit({ ...input, ...changed, auditLogId }, async () => {
          throw new Error("conflicting replay must not encrypt");
        }),
      ).resolves.toEqual({ outcome: "idempotency_conflict" });
    }

    const [concurrentReplay, concurrentConflict] = await Promise.all([
      sends.commit(
        { ...input, auditLogId: "50000000-0000-4000-8000-000000000093" },
        async () => {
          throw new Error("concurrent replay must not encrypt");
        },
      ),
      sends.commit(
        {
          ...input,
          auditLogId: "50000000-0000-4000-8000-000000000092",
          fingerprint: `sf1_${"F".repeat(43)}`,
        },
        async () => {
          throw new Error("concurrent conflict must not encrypt");
        },
      ),
    ]);
    expect(concurrentReplay).toMatchObject({ outcome: "replay" });
    expect(concurrentConflict).toEqual({ outcome: "idempotency_conflict" });

    const rows = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.send_operations
       WHERE id='60000000-0000-4000-8000-000000000099'`,
    );
    expect(rows.rows[0]?.count).toBe(1);
    const auditAndQuota = await database.query<{
      audit_count: number;
      quota_count: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM public.tool_call_logs
          WHERE tool_name='send_text_message') AS audit_count,
         (SELECT count(*)::int FROM public.send_quota_reservations) AS quota_count`,
    );
    expect(auditAndQuota.rows[0]).toEqual({
      audit_count: 8,
      quota_count: 1,
    });
    const replayAudits = await database.query<{
      error_code: string | null;
      outcome: string;
      quota_reserved: boolean;
    }>(
      `SELECT error_code, outcome, quota_reserved
       FROM public.tool_call_logs
       WHERE id <> '50000000-0000-4000-8000-000000000099'
         AND tool_name='send_text_message'
       ORDER BY id`,
    );
    expect(replayAudits.rows).toEqual([
      {
        error_code: "idempotency_conflict",
        outcome: "execution_error",
        quota_reserved: false,
      },
      { error_code: null, outcome: "success", quota_reserved: false },
      {
        error_code: "idempotency_conflict",
        outcome: "execution_error",
        quota_reserved: false,
      },
      {
        error_code: "idempotency_conflict",
        outcome: "execution_error",
        quota_reserved: false,
      },
      {
        error_code: "idempotency_conflict",
        outcome: "execution_error",
        quota_reserved: false,
      },
      { error_code: null, outcome: "success", quota_reserved: false },
      { error_code: null, outcome: "success", quota_reserved: false },
    ]);

    await expect(
      sends.recordProviderOutcome({
        changedAt: new Date(observedAt.valueOf() + 15_000),
        messageIdentity: `wi1_${"M".repeat(43)}`,
        sendId: input.sendId,
        status: "sent",
        storedMessage: {
          content: {
            ciphertext: new Uint8Array(32).fill(21),
            keyVersion: 1,
            nonce: new Uint8Array(12).fill(20),
          },
          contentType: "text",
          conversationId: "70000000-0000-4000-8000-000000000099",
          conversationPublicId: "cvs_123456789012345678999",
          messageId: "80000000-0000-4000-8000-000000000099",
          messagePublicId: "msg_123456789012345678999",
          messageSearch: { indexVersion: 1, tokens: [] },
        },
      }),
    ).resolves.toMatchObject({ status: "sent" });
    await expect(
      repository.getSendStatus({
        connectionPublicId: connectionA,
        grant,
        observedAt: new Date(observedAt.valueOf() + 16_000),
        sendPublicId: input.sendPublicId,
      }),
    ).resolves.toMatchObject({
      publicId: input.sendPublicId,
      status: "sent",
    });
    const projected = await database.query<{
      pending_count: number;
      stored_count: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM public.pending_send_contents WHERE send_operation_id=$1) AS pending_count,
        (SELECT count(*)::int FROM public.stored_messages WHERE message_identity=$2 AND direction='outbound') AS stored_count`,
      [input.sendId, `wi1_${"M".repeat(43)}`],
    );
    expect(projected.rows).toEqual([{ pending_count: 0, stored_count: 1 }]);
    await expect(
      repository.getSendStatus({
        connectionPublicId: connectionLater,
        grant,
        observedAt: new Date(observedAt.valueOf() + 16_000),
        sendPublicId: input.sendPublicId,
      }),
    ).resolves.toBeNull();
  });

  test("expires Pending Send Content by the WhatsApp Connection Message Retention Policy", async () => {
    await database.query(
      `INSERT INTO public.directory_contact_projections (
         personal_account_id, whatsapp_connection_id, as_of, stale, partial
       ) VALUES ($1, '20000000-0000-4000-8000-000000000030', $2, false, false)`,
      [accountId, observedAt],
    );
    await database.query(
      `INSERT INTO public.directory_contacts (
         personal_account_id, whatsapp_connection_id, public_id,
         provider_identity_index, provider_identity_ciphertext_version,
         provider_identity_key_version, provider_identity_nonce,
         provider_identity_ciphertext, display_name_sort, active,
         received_at
       ) VALUES (
         $1, '20000000-0000-4000-8000-000000000030',
         'ctc_123456789012345678930', $2, 1, 1,
         decode(repeat('11', 12), 'hex'), decode(repeat('12', 32), 'hex'),
         '', true, $3
       )`,
      [accountId, `di1_${"A".repeat(43)}`, observedAt],
    );
    const encrypt = async () => ({
      ciphertext: new Uint8Array(32).fill(20),
      keyVersion: 1,
      nonce: new Uint8Array(12).fill(21),
    });
    const input = {
      auditLogId: "50000000-0000-4000-8000-000000000091",
      channel: "mcp",
      connectionPublicId: connectionA,
      fingerprint: `sf1_${"C".repeat(43)}`,
      grant,
      hourRequestLimit: 100,
      idempotencyKey: "123456789012345678941",
      minuteRequestLimit: 100,
      observedAt,
      pendingExpiresAt: new Date("2026-08-07T12:00:00.000Z"),
      recipientPublicId: "ctc_123456789012345678930",
      sendDailyLimit: 100,
      sendId: "60000000-0000-4000-8000-000000000091",
      sendPerMinuteLimit: 100,
      sendPublicId: "snd_123456789012345678941",
    } as const;
    const expiryOf = async (sendId: string) => {
      const rows = await database.query<{ expires_at: Date }>(
        `SELECT expires_at FROM public.pending_send_contents
         WHERE send_operation_id = $1`,
        [sendId],
      );
      return rows.rows[0]?.expires_at.toISOString();
    };

    // A policy shorter than the seven-day cap decides the deadline. The owning
    // Personal Account keeps its own default of 30 days.
    await database.query(
      `UPDATE public.whatsapp_connections SET message_retention_days = 1
       WHERE public_id = $1`,
      [connectionA],
    );
    expect(await sends.commit(input, encrypt)).toMatchObject({
      outcome: "created",
    });
    expect(await expiryOf(input.sendId)).toBe("2026-08-01T12:00:00.000Z");

    // Retain until deletion contributes no earlier deadline, so the seven-day
    // cap still applies.
    await database.query(
      `UPDATE public.whatsapp_connections SET message_retention_days = NULL
       WHERE public_id = $1`,
      [connectionA],
    );
    const retained = {
      ...input,
      auditLogId: "50000000-0000-4000-8000-000000000092",
      fingerprint: `sf1_${"D".repeat(43)}`,
      idempotencyKey: "123456789012345678942",
      sendId: "60000000-0000-4000-8000-000000000092",
      sendPublicId: "snd_123456789012345678942",
    } as const;
    expect(await sends.commit(retained, encrypt)).toMatchObject({
      outcome: "created",
    });
    expect(await expiryOf(retained.sendId)).toBe("2026-08-07T12:00:00.000Z");
  });

  test("atomically expires unresolved leases and rejects late direct responses", async () => {
    await database.query(
      `INSERT INTO public.tool_call_logs (id,personal_account_id,mcp_authorization_id,tool_name,started_at,outcome,quota_reserved,expires_at)
       VALUES ('50000000-0000-4000-8000-000000000089',$1,$2,'send_text_message',$3,'started',true,$3::timestamptz+interval '90 days')`,
      [accountId, authorizationId, observedAt],
    );
    await database.query(
      `INSERT INTO public.send_operations (id,public_id,personal_account_id,mcp_authorization_id,tool_call_log_id,whatsapp_connection_id,recipient_type,recipient_public_id,status,created_at,status_changed_at,attempt_claimed_at,lease_expires_at,expires_at)
       VALUES ('60000000-0000-4000-8000-000000000089','snd_123456789012345678929',$1,$2,'50000000-0000-4000-8000-000000000089','20000000-0000-4000-8000-000000000030','contact','ctc_123456789012345678930','processing',$3,$3,$3,$3::timestamptz+interval '30 seconds',$3::timestamptz+interval '90 days')`,
      [accountId, authorizationId, observedAt],
    );

    await expect(
      sends.expireLeases(new Date(observedAt.valueOf() + 30_000)),
    ).resolves.toBe(1);
    await expect(
      sends.recordProviderOutcome({
        changedAt: new Date(observedAt.valueOf() + 31_000),
        sendId: "60000000-0000-4000-8000-000000000089",
        status: "accepted",
      }),
    ).resolves.toMatchObject({ status: "unknown" });
    await expect(
      sends.expireLeases(new Date(observedAt.valueOf() + 60_000)),
    ).resolves.toBe(0);
    await expect(
      sends.expireLeases(new Date(Date.now() + 30_000)),
    ).rejects.toThrow("send dispatch lease sweep cutoff is in the future");
  });

  test("atomically audits rate-limit rejection without another reservation", async () => {
    for (const [index, time] of [
      [30, "2026-07-31T11:59:30.000Z"],
      [31, "2026-07-31T11:59:45.000Z"],
    ] as const) {
      await expect(
        repository.beginProtectedOperation({
          channel: "mcp",
          authorization,
          auditLogId: `50000000-0000-4000-8000-0000000000${index}`,
          hourLimit: 3,
          minuteLimit: 2,
          observedAt: new Date(time),
          operationName: "list_connections",
        }),
      ).resolves.toMatchObject({ outcome: "started" });
    }

    await expect(
      repository.beginProtectedOperation({
        channel: "mcp",
        authorization,
        auditLogId: "50000000-0000-4000-8000-000000000032",
        hourLimit: 3,
        minuteLimit: 2,
        observedAt,
        operationName: "list_connections",
      }),
    ).resolves.toEqual({
      auditLogId: "50000000-0000-4000-8000-000000000032",
      outcome: "rate_limited",
      resetsAt: new Date("2026-07-31T12:00:30.000Z"),
      retryAfterSeconds: 30,
    });

    const persisted = await database.query<{
      outcome: string;
      quota_reserved: boolean;
    }>(
      `SELECT outcome, quota_reserved
       FROM public.tool_call_logs
       WHERE id = '50000000-0000-4000-8000-000000000032'`,
    );
    expect(persisted.rows).toEqual([
      { outcome: "rate_limited", quota_reserved: false },
    ]);
  });

  test("audits validation rejection without reserving request quota", async () => {
    await expect(
      repository.rejectProtectedOperation({
        channel: "mcp",
        authorization,
        auditLogId: "50000000-0000-4000-8000-000000000033",
        connectionPublicId: connectionA,
        errorCode: "invalid_cursor",
        observedAt,
        operationName: "list_contacts",
      }),
    ).resolves.toBe("rejected");

    const persisted = await database.query<{
      connection_public_id: string | null;
      error_code: string | null;
      outcome: string;
      quota_reserved: boolean;
    }>(
      `SELECT connection_public_id, outcome, error_code, quota_reserved
       FROM public.tool_call_logs
       WHERE id = '50000000-0000-4000-8000-000000000033'`,
    );
    expect(persisted.rows).toEqual([
      {
        connection_public_id: connectionA,
        error_code: "invalid_cursor",
        outcome: "execution_error",
        quota_reserved: false,
      },
    ]);
  });

  test("persists safe connection and send targets with the invocation", async () => {
    const sendPublicId = "snd_123456789012345678901";
    await expect(
      repository.beginProtectedOperation({
        channel: "mcp",
        authorization,
        auditLogId: "50000000-0000-4000-8000-000000000034",
        connectionPublicId: connectionA,
        hourLimit: 3,
        minuteLimit: 2,
        observedAt,
        sendPublicId,
        operationName: "get_send_status",
      }),
    ).resolves.toMatchObject({ outcome: "started" });

    const persisted = await database.query<{
      connection_public_id: string | null;
      send_public_id: string | null;
    }>(
      `SELECT connection_public_id, send_public_id
       FROM public.tool_call_logs
       WHERE id = '50000000-0000-4000-8000-000000000034'`,
    );
    expect(persisted.rows).toEqual([
      {
        connection_public_id: connectionA,
        send_public_id: sendPublicId,
      },
    ]);
  });

  test("loads encrypted contact material only for the selected authorized Connection", async () => {
    await database.query(
      `INSERT INTO public.directory_contact_projections (
         personal_account_id, whatsapp_connection_id, as_of, stale, partial,
         snapshot_observed_at
       ) VALUES (
         $1, '20000000-0000-4000-8000-000000000030', $2, false, false, $2
       )`,
      [accountId, observedAt],
    );
    await database.query(
      `INSERT INTO public.directory_contacts (
         personal_account_id, whatsapp_connection_id, public_id,
         provider_identity_index, provider_identity_ciphertext_version,
         provider_identity_key_version, provider_identity_nonce,
         provider_identity_ciphertext, display_name_ciphertext_version,
         display_name_key_version, display_name_nonce, display_name_ciphertext,
         display_name_sort,
         phone_ciphertext_version, phone_key_version, phone_nonce,
         phone_ciphertext, name_prefix_indexes, phone_index, active, received_at
       ) VALUES (
         $1, '20000000-0000-4000-8000-000000000030',
         'ctc_123456789012345678901', $2, 1, 1,
         decode(repeat('07', 12), 'hex'), decode(repeat('08', 32), 'hex'),
         1, 1, decode(repeat('09', 12), 'hex'), decode(repeat('0a', 32), 'hex'),
         'ada',
         1, 1, decode(repeat('0b', 12), 'hex'), decode(repeat('0c', 32), 'hex'),
         ARRAY[$3::public.directory_blind_index], $4, true, $5
       )`,
      [
        accountId,
        `di1_${"i".repeat(43)}`,
        `di1_${"n".repeat(43)}`,
        `di1_${"p".repeat(43)}`,
        observedAt,
      ],
    );

    await expect(
      repository.loadContactReadMaterial({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
      }),
    ).resolves.toMatchObject({
      asOf: observedAt.toISOString(),
      partial: false,
      personalAccountId: accountId,
      stale: false,
      whatsappConnectionId: "20000000-0000-4000-8000-000000000030",
    });
    await expect(
      repository.listEncryptedContacts({
        ...authorization,
        connectionPublicId: connectionA,
        cursorDisplayNameSort: null,
        cursorPublicId: null,
        limit: 21,
        observedAt,
        searchIndex: `di1_${"n".repeat(43)}`,
        searchKind: "name",
      }),
    ).resolves.toEqual({
      asOf: observedAt.toISOString(),
      contacts: [
        expect.objectContaining({
          displayNameCiphertext: expect.objectContaining({ keyVersion: 1 }),
          displayNameSort: "ada",
          phoneCiphertext: expect.objectContaining({ keyVersion: 1 }),
          providerIdentityIndex: `di1_${"i".repeat(43)}`,
          publicId: "ctc_123456789012345678901",
        }),
      ],
      partial: false,
      snapshotObservedAt: observedAt.toISOString(),
      stale: false,
    });
    await expect(
      repository.listEncryptedContacts({
        ...authorization,
        connectionPublicId: connectionA,
        cursorDisplayNameSort: null,
        cursorPublicId: null,
        limit: 21,
        observedAt,
        searchIndex: `di1_${"p".repeat(43)}`,
        searchKind: "phone",
      }),
    ).resolves.toMatchObject({
      contacts: [
        expect.objectContaining({
          publicId: "ctc_123456789012345678901",
        }),
      ],
    });
    await expect(
      repository.listEncryptedContacts({
        ...authorization,
        connectionPublicId: connectionA,
        cursorDisplayNameSort: null,
        cursorPublicId: null,
        limit: 21,
        observedAt,
        searchIndex: `di1_${"x".repeat(43)}`,
        searchKind: "phone",
      }),
    ).resolves.toMatchObject({ contacts: [] });
    await expect(
      repository.listEncryptedContacts({
        ...authorization,
        connectionPublicId: connectionA,
        cursorDisplayNameSort: "ada",
        cursorPublicId: "ctc_123456789012345678901",
        limit: 1,
        observedAt,
        searchIndex: null,
        searchKind: null,
      }),
    ).resolves.toMatchObject({ contacts: [] });
    await expect(
      repository.loadContactReadMaterial({
        ...authorization,
        connectionPublicId: connectionLater,
        observedAt,
      }),
    ).resolves.toBeNull();
  });

  test("reports the reset that restores capacity after a quota reduction", async () => {
    for (const [index, time] of [
      [40, "2026-07-31T11:59:10.000Z"],
      [41, "2026-07-31T11:59:20.000Z"],
      [42, "2026-07-31T11:59:30.000Z"],
    ] as const) {
      await expect(
        repository.beginProtectedOperation({
          channel: "mcp",
          authorization,
          auditLogId: `50000000-0000-4000-8000-0000000000${index}`,
          hourLimit: 10,
          minuteLimit: 3,
          observedAt: new Date(time),
          operationName: "list_connections",
        }),
      ).resolves.toMatchObject({ outcome: "started" });
    }

    await expect(
      repository.beginProtectedOperation({
        channel: "mcp",
        authorization,
        auditLogId: "50000000-0000-4000-8000-000000000043",
        hourLimit: 10,
        minuteLimit: 2,
        observedAt,
        operationName: "list_connections",
      }),
    ).resolves.toEqual({
      auditLogId: "50000000-0000-4000-8000-000000000043",
      outcome: "rate_limited",
      resetsAt: new Date("2026-07-31T12:00:20.000Z"),
      retryAfterSeconds: 20,
    });
  });

  test("reconciles complete contact snapshots and removes missing contacts without retaining PII", async () => {
    const directory = makeDirectoryRepository({
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    });
    const claimed = await directory.claimContactReconciliations({
      claimedAt: observedAt.toISOString(),
      limit: 100,
    });
    expect(claimed).toHaveLength(1);
    const first = claimed[0];
    if (first === undefined) throw new Error("missing reconciliation claim");
    const encrypted = (byte: string) => ({
      ciphertext: Buffer.from(byte.repeat(32), "hex").toString("base64"),
      keyVersion: 1,
      nonce: Buffer.from("11".repeat(12), "hex").toString("base64"),
      version: 1 as const,
    });
    expect(
      await directory.finishContactReconciliation({
        claimId: first.claimId,
        contacts: [
          {
            displayNameCiphertext: encrypted("12"),
            displayNameSort: "ada",
            namePrefixIndexes: [`di1_${"n".repeat(43)}`],
            phoneCiphertext: encrypted("13"),
            phoneIndex: `di1_${"p".repeat(43)}`,
            providerIdentityCiphertext: encrypted("14"),
            providerIdentityIndex: `di1_${"i".repeat(43)}`,
            publicId: "ctc_123456789012345678901",
          },
        ],
        observedAt: observedAt.toISOString(),
        partial: false,
        stale: false,
        whatsappConnectionId: first.whatsappConnectionId,
      }),
    ).toBe(true);

    const later = new Date(observedAt.valueOf() + 6 * 60_000);
    const reclaimed = await directory.claimContactReconciliations({
      claimedAt: later.toISOString(),
      limit: 100,
    });
    expect(reclaimed).toHaveLength(1);
    const second = reclaimed[0];
    if (second === undefined) throw new Error("missing second claim");
    expect(
      await directory.finishContactReconciliation({
        claimId: second.claimId,
        contacts: [],
        observedAt: later.toISOString(),
        partial: false,
        stale: false,
        whatsappConnectionId: second.whatsappConnectionId,
      }),
    ).toBe(true);

    const persisted = await database.query<{
      active: boolean;
      display_name_ciphertext: Uint8Array | null;
      phone_ciphertext: Uint8Array | null;
    }>(
      "SELECT active, display_name_ciphertext, phone_ciphertext FROM public.directory_contacts",
    );
    expect(persisted.rows).toEqual([
      {
        active: false,
        display_name_ciphertext: null,
        phone_ciphertext: null,
      },
    ]);
  });

  test("does not let a partial snapshot supersede webhook evidence for an unobserved contact", async () => {
    const connectionProvider = {
      withConnection: async <Value>(
        use: (connection: typeof database) => Promise<Value>,
      ) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    };
    const directory = makeDirectoryRepository(connectionProvider);
    const encrypted = (byte: string) => ({
      ciphertext: Buffer.from(byte.repeat(32), "hex").toString("base64"),
      keyVersion: 1,
      nonce: Buffer.from("11".repeat(12), "hex").toString("base64"),
      version: 1 as const,
    });
    const firstContact = {
      displayNameCiphertext: encrypted("12"),
      displayNameSort: "ada",
      namePrefixIndexes: [`di1_${"n".repeat(43)}`],
      phoneCiphertext: encrypted("13"),
      phoneIndex: `di1_${"p".repeat(43)}`,
      providerIdentityCiphertext: encrypted("14"),
      providerIdentityIndex: `di1_${"i".repeat(43)}`,
      publicId: "ctc_123456789012345678901",
    } as const;
    const secondContact = {
      displayNameCiphertext: encrypted("15"),
      displayNameSort: "grace",
      namePrefixIndexes: [`di1_${"o".repeat(43)}`],
      phoneCiphertext: encrypted("16"),
      phoneIndex: `di1_${"q".repeat(43)}`,
      providerIdentityCiphertext: encrypted("17"),
      providerIdentityIndex: `di1_${"j".repeat(43)}`,
      publicId: "ctc_123456789012345678902",
    } as const;
    const initialClaim = (
      await directory.claimContactReconciliations({
        claimedAt: observedAt.toISOString(),
        limit: 100,
      })
    )[0];
    if (initialClaim === undefined) throw new Error("missing initial claim");
    expect(
      await directory.finishContactReconciliation({
        claimId: initialClaim.claimId,
        contacts: [firstContact, secondContact],
        observedAt: observedAt.toISOString(),
        partial: false,
        stale: false,
        whatsappConnectionId: initialClaim.whatsappConnectionId,
      }),
    ).toBe(true);

    const partialAt = new Date(observedAt.valueOf() + 6 * 60_000);
    const partialClaim = (
      await directory.claimContactReconciliations({
        claimedAt: partialAt.toISOString(),
        limit: 100,
      })
    )[0];
    if (partialClaim === undefined) throw new Error("missing partial claim");
    expect(
      await directory.finishContactReconciliation({
        claimId: partialClaim.claimId,
        contacts: [firstContact],
        observedAt: partialAt.toISOString(),
        partial: true,
        stale: true,
        whatsappConnectionId: partialClaim.whatsappConnectionId,
      }),
    ).toBe(true);

    const webhookProvider = {
      withConnection: async <Value>(
        use: (connection: typeof database) => Promise<Value>,
      ) => {
        await database.exec("SET ROLE whatsapp_webhook_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    };
    const webhooks = makeWebhookEventRepository(webhookProvider);
    const eventId = "50000000-0000-4000-8000-000000000039";
    const webhookReceivedAt = new Date(
      partialAt.valueOf() + 60_000,
    ).toISOString();
    await webhooks.prepare({
      ciphertextSha256: "a".repeat(64),
      eventId,
      payloadBytes: 128,
      personalAccountId: accountId,
      receivedAt: webhookReceivedAt,
      whatsappConnectionId: initialClaim.whatsappConnectionId,
    });
    const olderOccurrence = new Date(
      observedAt.valueOf() + 60_000,
    ).toISOString();
    expect(
      await webhooks.projectDirectoryContact(
        {
          ...firstContact,
          displayNameCiphertext: encrypted("19"),
          displayNameSort: "ada older",
          eventId,
          evidence: { occurredAt: olderOccurrence, version: null },
          itemIdentity: `wi1_${"v".repeat(43)}`,
          itemIndex: 0,
          personalAccountId: accountId,
          publicId: "ctc_123456789012345678904",
          receivedAt: webhookReceivedAt,
          whatsappConnectionId: initialClaim.whatsappConnectionId,
          active: true,
        },
        async () => "incomparable",
      ),
    ).toBe("superseded");
    expect(
      await webhooks.projectDirectoryContact(
        {
          ...secondContact,
          displayNameCiphertext: encrypted("18"),
          displayNameSort: "grace updated",
          eventId,
          evidence: { occurredAt: olderOccurrence, version: null },
          itemIdentity: `wi1_${"w".repeat(43)}`,
          itemIndex: 1,
          personalAccountId: accountId,
          publicId: "ctc_123456789012345678903",
          receivedAt: webhookReceivedAt,
          whatsappConnectionId: initialClaim.whatsappConnectionId,
          active: true,
        },
        async () => "incomparable",
      ),
    ).toBe("applied");

    expect(
      await webhooks.projectDirectoryContact(
        {
          ...firstContact,
          displayNameCiphertext: encrypted("20"),
          displayNameSort: "ada current",
          eventId,
          evidence: { occurredAt: null, version: null },
          itemIdentity: `wi1_${"x".repeat(43)}`,
          itemIndex: 2,
          personalAccountId: accountId,
          publicId: "ctc_123456789012345678905",
          receivedAt: webhookReceivedAt,
          whatsappConnectionId: initialClaim.whatsappConnectionId,
          active: true,
        },
        async () => "incomparable",
      ),
    ).toBe("applied");

    const laterEventId = "50000000-0000-4000-8000-000000000040";
    const laterReceivedAt = new Date(
      partialAt.valueOf() + 2 * 60_000,
    ).toISOString();
    await webhooks.prepare({
      ciphertextSha256: "b".repeat(64),
      eventId: laterEventId,
      payloadBytes: 128,
      personalAccountId: accountId,
      receivedAt: laterReceivedAt,
      whatsappConnectionId: initialClaim.whatsappConnectionId,
    });
    expect(
      await webhooks.projectDirectoryContact(
        {
          ...firstContact,
          displayNameCiphertext: encrypted("21"),
          displayNameSort: "ada stale",
          eventId: laterEventId,
          evidence: {
            occurredAt: new Date(partialAt.valueOf() - 60_000).toISOString(),
            version: null,
          },
          itemIdentity: `wi1_${"y".repeat(43)}`,
          itemIndex: 0,
          personalAccountId: accountId,
          publicId: "ctc_123456789012345678906",
          receivedAt: laterReceivedAt,
          whatsappConnectionId: initialClaim.whatsappConnectionId,
          active: true,
        },
        async () => "incomparable",
      ),
    ).toBe("superseded");

    const persisted = await database.query<{
      display_name_sort: string;
      provider_identity_index: string;
    }>(
      `SELECT provider_identity_index, display_name_sort
       FROM public.directory_contacts
       WHERE provider_identity_index IN (
         $1::public.directory_blind_index,
         $2::public.directory_blind_index
       )
       ORDER BY provider_identity_index`,
      [firstContact.providerIdentityIndex, secondContact.providerIdentityIndex],
    );
    expect(persisted.rows).toEqual([
      {
        display_name_sort: "ada current",
        provider_identity_index: firstContact.providerIdentityIndex,
      },
      {
        display_name_sort: "grace updated",
        provider_identity_index: secondContact.providerIdentityIndex,
      },
    ]);

    const inFlightSnapshotAt = new Date(partialAt.valueOf() + 6 * 60_000);
    const inFlightClaim = (
      await directory.claimContactReconciliations({
        claimedAt: inFlightSnapshotAt.toISOString(),
        limit: 100,
      })
    )[0];
    if (inFlightClaim === undefined) throw new Error("missing in-flight claim");

    const newestEventId = "50000000-0000-4000-8000-000000000041";
    const newestReceivedAt = new Date(
      inFlightSnapshotAt.valueOf() + 60_000,
    ).toISOString();
    await webhooks.prepare({
      ciphertextSha256: "c".repeat(64),
      eventId: newestEventId,
      payloadBytes: 128,
      personalAccountId: accountId,
      receivedAt: newestReceivedAt,
      whatsappConnectionId: initialClaim.whatsappConnectionId,
    });
    expect(
      await webhooks.projectDirectoryContact(
        {
          ...firstContact,
          displayNameCiphertext: encrypted("22"),
          displayNameSort: "ada newest",
          eventId: newestEventId,
          evidence: { occurredAt: null, version: null },
          itemIdentity: `wi1_${"z".repeat(43)}`,
          itemIndex: 0,
          personalAccountId: accountId,
          publicId: "ctc_123456789012345678907",
          receivedAt: newestReceivedAt,
          whatsappConnectionId: initialClaim.whatsappConnectionId,
          active: true,
        },
        async () => "incomparable",
      ),
    ).toBe("applied");
    expect(
      await directory.finishContactReconciliation({
        claimId: inFlightClaim.claimId,
        contacts: [],
        observedAt: inFlightSnapshotAt.toISOString(),
        partial: false,
        stale: false,
        whatsappConnectionId: inFlightClaim.whatsappConnectionId,
      }),
    ).toBe(true);

    const delayedEventId = "50000000-0000-4000-8000-000000000042";
    const delayedReceivedAt = new Date(
      inFlightSnapshotAt.valueOf() + 2 * 60_000,
    ).toISOString();
    await webhooks.prepare({
      ciphertextSha256: "d".repeat(64),
      eventId: delayedEventId,
      payloadBytes: 128,
      personalAccountId: accountId,
      receivedAt: delayedReceivedAt,
      whatsappConnectionId: initialClaim.whatsappConnectionId,
    });
    expect(
      await webhooks.projectDirectoryContact(
        {
          ...firstContact,
          displayNameCiphertext: encrypted("23"),
          displayNameSort: "ada delayed",
          eventId: delayedEventId,
          evidence: {
            occurredAt: new Date(
              inFlightSnapshotAt.valueOf() - 60_000,
            ).toISOString(),
            version: null,
          },
          itemIdentity: `wi1_${"0".repeat(43)}`,
          itemIndex: 0,
          personalAccountId: accountId,
          publicId: "ctc_123456789012345678908",
          receivedAt: delayedReceivedAt,
          whatsappConnectionId: initialClaim.whatsappConnectionId,
          active: true,
        },
        async () => "incomparable",
      ),
    ).toBe("superseded");

    const converged = await database.query<{ display_name_sort: string }>(
      `SELECT display_name_sort
       FROM public.directory_contacts
       WHERE provider_identity_index = $1`,
      [firstContact.providerIdentityIndex],
    );
    expect(converged.rows).toEqual([{ display_name_sort: "ada newest" }]);
  });

  test("rechecks scope and revocation at audit and protected-read boundaries", async () => {
    await database.query(
      `UPDATE public.mcp_authorizations
       SET scopes = ARRAY['messages:send']::text[]
       WHERE id = $1`,
      [authorizationId],
    );
    await expect(
      repository.beginProtectedOperation({
        channel: "mcp",
        authorization,
        auditLogId: "50000000-0000-4000-8000-000000000033",
        hourLimit: 3,
        minuteLimit: 2,
        observedAt,
        operationName: "list_connections",
      }),
    ).resolves.toMatchObject({ outcome: "authorization_denied" });

    await database.query(
      `UPDATE public.mcp_authorizations
       SET scopes = ARRAY['connections:read']::text[]
       WHERE id = $1`,
      [authorizationId],
    );
    await expect(
      repository.beginProtectedOperation({
        channel: "mcp",
        authorization,
        auditLogId: "50000000-0000-4000-8000-000000000034",
        hourLimit: 3,
        minuteLimit: 2,
        observedAt,
        operationName: "list_connections",
      }),
    ).resolves.toMatchObject({ outcome: "started" });
    await database.query(
      `UPDATE public.mcp_authorizations
       SET state = 'revoked', revoked_at = $2
       WHERE id = $1`,
      [authorizationId, observedAt],
    );
    await expect(
      repository.listConnections({
        ...authorization,
        observedAt,
      }),
    ).resolves.toBeNull();
  });

  test("returns an empty list after every selected Connection is purged", async () => {
    await database.query(
      `DELETE FROM public.whatsapp_connections
       WHERE personal_account_id = $1
         AND public_id IN ($2, $3, $4)`,
      [accountId, connectionA, connectionB, connectionWithoutSuffix],
    );

    await expect(
      repository.inspectAuthorization({
        ...authorization,
        observedAt,
      }),
    ).resolves.toEqual({
      scopes: [
        "connections:read",
        "directory:read",
        "messages:read",
        "messages:send",
      ],
    });
    await expect(
      repository.beginProtectedOperation({
        channel: "mcp",
        authorization,
        auditLogId: "50000000-0000-4000-8000-000000000035",
        hourLimit: 3,
        minuteLimit: 2,
        observedAt,
        operationName: "list_connections",
      }),
    ).resolves.toMatchObject({ outcome: "started" });
    await expect(
      repository.listConnections({
        ...authorization,
        observedAt,
      }),
    ).resolves.toEqual([]);
  });

  test("selects newest Stored Messages and atomically shares exact returned-record quota with search", async () => {
    const conversationId = "70000000-0000-4000-8000-000000000042";
    const conversationPublicId = "cvs_123456789012345678942";
    await database.query(
      "UPDATE public.whatsapp_connections SET created_at=$2 WHERE personal_account_id=$1 AND public_id=$3",
      [accountId, observedAt, connectionA],
    );
    await database.query(
      `INSERT INTO public.whatsapp_conversations (id, personal_account_id, whatsapp_connection_id, public_id, kind, recipient_locator, recipient_public_id, last_activity_at, last_activity_direction)
       VALUES ($1,$2,'20000000-0000-4000-8000-000000000030',$3,'direct',$4,'ctc_123456789012345678942',$5,'inbound')`,
      [
        conversationId,
        accountId,
        conversationPublicId,
        `di1_${"C".repeat(43)}`,
        new Date("2026-07-31T12:03:00Z"),
      ],
    );
    await database.query(
      `INSERT INTO public.directory_contacts (
         personal_account_id, whatsapp_connection_id, public_id,
         provider_identity_index, provider_identity_ciphertext_version,
         provider_identity_key_version, provider_identity_nonce,
         provider_identity_ciphertext, display_name_ciphertext_version,
         display_name_key_version, display_name_nonce, display_name_ciphertext,
         display_name_sort, phone_ciphertext_version, phone_key_version,
         phone_nonce, phone_ciphertext, active, received_at
       ) VALUES (
         $1, '20000000-0000-4000-8000-000000000030',
         'ctc_123456789012345678942', $2, 1, 1,
         decode(repeat('13',12),'hex'), decode(repeat('14',32),'hex'),
         1, 1, decode(repeat('15',12),'hex'), decode(repeat('16',32),'hex'),
         'ada', 1, 1, decode(repeat('17',12),'hex'),
         decode(repeat('18',32),'hex'), true, $3
       )`,
      [accountId, `di1_${"C".repeat(43)}`, observedAt],
    );
    for (const [suffix, sentAt] of [
      ["1", "2026-07-31T12:01:00Z"],
      ["2", "2026-07-31T12:02:00Z"],
      ["3", "2026-07-31T12:03:00Z"],
    ] as const) {
      await database.query(
        `INSERT INTO public.stored_messages (id, personal_account_id, whatsapp_connection_id, conversation_id, public_id, message_identity, direction, sent_at, content_type, content_ciphertext_version, content_key_version, content_nonce, content_ciphertext, received_at, webhook_item_identity)
         VALUES ($1,$2,'20000000-0000-4000-8000-000000000030',$3,$4,$5,'inbound',$6,'text',1,1,decode(repeat('11',12),'hex'),decode(repeat('12',32),'hex'),$6,$7)`,
        [
          `71000000-0000-4000-8000-00000000004${suffix}`,
          accountId,
          conversationId,
          `msg_12345678901234567894${suffix}`,
          `wi1_${suffix.repeat(43)}`,
          new Date(sentAt),
          `wi1_${suffix.repeat(43)}`,
        ],
      );
    }
    const readAt = new Date("2026-08-01T12:00:00Z");
    const auditLogId = "50000000-0000-4000-8000-000000000042";
    await database.query(
      "UPDATE public.mcp_authorizations SET scopes=ARRAY['directory:read','messages:read']::text[] WHERE id=$1",
      [authorizationId],
    );
    await expect(
      repository.beginProtectedOperation({
        channel: "mcp",
        authorization,
        auditLogId,
        hourLimit: 10,
        minuteLimit: 10,
        observedAt: readAt,
        operationName: "read_messages",
      }),
    ).resolves.toMatchObject({ outcome: "started" });
    const result = await repository.readMessages({
      ...authorization,
      auditLogId,
      authorizationContextEstablished: true,
      connectionPublicId: connectionA,
      conversationPublicId,
      cursorSentAt: null,
      cursorPublicId: null,
      dailyRecordLimit: 2,
      limit: 2,
      observedAt: readAt,
    });
    expect(result).toMatchObject({
      outcome: "success",
      page: {
        conversation: {
          kind: "direct",
          publicId: conversationPublicId,
          recipientId: "ctc_123456789012345678942",
        },
        hasOlder: true,
        messages: [
          {
            publicId: "msg_123456789012345678943",
            sender: {
              displayName: { keyVersion: 1 },
              phone: { keyVersion: 1 },
              recordId: `di1_${"C".repeat(43)}`,
            },
          },
          {
            publicId: "msg_123456789012345678942",
            sender: {
              displayName: { keyVersion: 1 },
              phone: { keyVersion: 1 },
              recordId: `di1_${"C".repeat(43)}`,
            },
          },
        ],
      },
    });
    await expect(
      repository.listEncryptedContacts({
        ...authorization,
        connectionPublicId: connectionA,
        cursorDisplayNameSort: null,
        cursorPublicId: null,
        limit: 20,
        observedAt: readAt,
        searchIndex: null,
        searchKind: null,
      }),
    ).resolves.toMatchObject({
      contacts: [
        {
          conversationPublicId,
          publicId: "ctc_123456789012345678942",
        },
      ],
    });
    await expect(
      repository.completeMessageRecordRead({
        ...authorization,
        auditLogId,
        authorizationContextEstablished: true,
        dailyRecordLimit: 2,
        observedAt: readAt,
        resultCount: 1,
      }),
    ).resolves.toEqual({ outcome: "success" });
    const log = await database.query(
      `SELECT outcome, result_count FROM public.tool_call_logs WHERE id=$1`,
      [auditLogId],
    );
    expect(log.rows).toEqual([{ outcome: "success", result_count: 1 }]);

    const concurrentAuditLogIds = [
      "50000000-0000-4000-8000-000000000043",
      "50000000-0000-4000-8000-000000000044",
    ] as const;
    await Promise.all(
      concurrentAuditLogIds.map((concurrentAuditLogId, index) =>
        repository.beginProtectedOperation({
          channel: "mcp",
          authorization,
          auditLogId: concurrentAuditLogId,
          hourLimit: 10,
          minuteLimit: 10,
          observedAt: readAt,
          operationName: index === 0 ? "read_messages" : "search_messages",
        }),
      ),
    );
    const completions = await Promise.all(
      concurrentAuditLogIds.map((concurrentAuditLogId) =>
        repository.completeMessageRecordRead({
          ...authorization,
          auditLogId: concurrentAuditLogId,
          dailyRecordLimit: 2,
          observedAt: readAt,
          resultCount: 1,
        }),
      ),
    );
    expect(completions.map(({ outcome }) => outcome).sort()).toEqual([
      "record_quota_exhausted",
      "success",
    ]);
    const concurrentLogs = await database.query(
      `SELECT outcome, result_count
         FROM public.tool_call_logs
        WHERE id = ANY($1::uuid[])
        ORDER BY outcome`,
      [concurrentAuditLogIds],
    );
    expect(concurrentLogs.rows).toEqual([
      { outcome: "started", result_count: null },
      { outcome: "success", result_count: 1 },
    ]);
  });

  test("searches authorized indexed messages with AND semantics and deterministic filters", async () => {
    const connectionId = "20000000-0000-4000-8000-000000000030";
    const conversationId = "70000000-0000-4000-8000-000000000046";
    const conversationPublicId = "cvs_123456789012345678946";
    const tokenA = `msi1_${"A".repeat(43)}`;
    const tokenB = `msi1_${"B".repeat(43)}`;
    const readAt = new Date("2026-08-01T12:00:00Z");
    await database.query(
      "UPDATE public.whatsapp_connections SET created_at='2026-07-01T00:00:00Z' WHERE personal_account_id=$1 AND id=$2",
      [accountId, connectionId],
    );
    await database.query(
      "UPDATE public.mcp_authorizations SET scopes=ARRAY['messages:read']::text[] WHERE id=$1",
      [authorizationId],
    );
    await database.query(
      `UPDATE public.whatsapp_connection_secrets SET
         message_search_key_ciphertext_version=1, message_search_key_version=1,
         message_search_key_nonce=decode(repeat('21',12),'hex'),
         message_search_key_ciphertext=decode(repeat('22',32),'hex')
       WHERE personal_account_id=$1 AND whatsapp_connection_id=$2`,
      [accountId, connectionId],
    );
    await database.query(
      `INSERT INTO public.message_search_backfill_coverage
       (personal_account_id, whatsapp_connection_id, index_version, state, searchable_from)
       VALUES ($1,$2,1,'complete',$3)
       ON CONFLICT (personal_account_id, whatsapp_connection_id, index_version)
       DO UPDATE SET state='complete', searchable_from=excluded.searchable_from`,
      [accountId, connectionId, "2026-07-01T00:00:00Z"],
    );
    await database.query(
      `INSERT INTO public.whatsapp_conversations
       (id, personal_account_id, whatsapp_connection_id, public_id, kind,
        recipient_locator, recipient_public_id, last_activity_at, last_activity_direction)
       VALUES ($1,$2,$3,$4,'direct',$5,'ctc_123456789012345678946',$6,'inbound')`,
      [
        conversationId,
        accountId,
        connectionId,
        conversationPublicId,
        `di1_${"F".repeat(43)}`,
        "2026-07-31T12:02:00Z",
      ],
    );
    for (const [suffix, sentAt, tokens] of [
      ["5", "2026-07-31T12:02:00Z", [tokenA, tokenB]],
      ["6", "2026-07-31T12:01:00Z", [tokenA]],
    ] as const) {
      await database.query(
        `INSERT INTO public.stored_messages
         (id, personal_account_id, whatsapp_connection_id, conversation_id,
          public_id, message_identity, direction, sent_at, content_type,
          content_ciphertext_version, content_key_version, content_nonce,
          content_ciphertext, received_at, webhook_item_identity,
          message_search_index_version, message_search_tokens)
         VALUES ($1,$2,$3,$4,$5,$6,'inbound',$7,'text',1,1,
          decode(repeat('11',12),'hex'),decode(repeat('12',32),'hex'),$7,$6,1,$8::public.message_search_token[])`,
        [
          `71000000-0000-4000-8000-00000000004${suffix}`,
          accountId,
          connectionId,
          conversationId,
          `msg_12345678901234567894${suffix}`,
          `wi1_${suffix.repeat(43)}`,
          sentAt,
          `{${tokens.join(",")}}`,
        ],
      );
    }
    const auditLogId = "50000000-0000-4000-8000-000000000046";
    await repository.beginProtectedOperation({
      channel: "mcp",
      authorization,
      auditLogId,
      connectionPublicId: connectionA,
      hourLimit: 10,
      minuteLimit: 10,
      observedAt: readAt,
      operationName: "search_messages",
    });
    const material = await repository.searchMessages({
      ...authorization,
      connectionPublicId: connectionA,
      conversationPublicId,
      cursorSentAt: null,
      cursorPublicId: null,
      direction: "all",
      after: "2026-07-31T12:00:00Z",
      before: "2026-08-01T00:00:00Z",
      limit: 20,
      observedAt: readAt,
      searchTokens: null,
    });
    expect(material).toMatchObject({
      messages: [],
      coverage: { backfillComplete: true },
      messageSearchKey: { keyVersion: 1 },
    });
    const result = await repository.searchMessages({
      ...authorization,
      connectionPublicId: connectionA,
      conversationPublicId,
      cursorSentAt: null,
      cursorPublicId: null,
      direction: "inbound",
      after: "2026-07-31T12:00:00Z",
      before: "2026-08-01T00:00:00Z",
      limit: 20,
      observedAt: readAt,
      searchTokens: [tokenB, tokenA],
    });
    expect(result?.messages.map((message) => message.publicId)).toEqual([
      "msg_123456789012345678945",
    ]);
  });

  test("lists chats without direct runtime access to key envelope tables", async () => {
    const conversationId = "70000000-0000-4000-8000-000000000047";
    const conversationPublicId = "cvs_123456789012345678947";
    await database.query(
      `UPDATE public.mcp_authorizations SET scopes=ARRAY['messages:read']::text[] WHERE id=$1`,
      [authorizationId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_conversations (
         id, personal_account_id, whatsapp_connection_id, public_id, kind,
         recipient_locator, recipient_public_id, last_activity_at,
         last_activity_direction
       ) VALUES (
         $1, $2, '20000000-0000-4000-8000-000000000030', $3, 'direct',
         $4, 'ctc_123456789012345678947', $5, 'inbound'
       )`,
      [
        conversationId,
        accountId,
        conversationPublicId,
        `di1_${"E".repeat(43)}`,
        observedAt,
      ],
    );
    await database.query(
      `INSERT INTO public.stored_messages (
         id, personal_account_id, whatsapp_connection_id, conversation_id,
         public_id, message_identity, direction, sent_at, content_type,
         content_ciphertext_version, content_key_version, content_nonce,
         content_ciphertext, received_at, webhook_item_identity
       ) VALUES (
         '71000000-0000-4000-8000-000000000047', $1,
         '20000000-0000-4000-8000-000000000030', $2,
         'msg_123456789012345678947', $3, 'inbound', $4, 'text', 1, 1,
         decode(repeat('11',12),'hex'), decode(repeat('12',32),'hex'), $4, $3
       )`,
      [accountId, conversationId, `wi1_${"E".repeat(43)}`, observedAt],
    );
    await database.query(
      `INSERT INTO public.directory_contacts (
         personal_account_id, whatsapp_connection_id, public_id,
         provider_identity_index, provider_identity_ciphertext_version,
         provider_identity_key_version, provider_identity_nonce,
         provider_identity_ciphertext, display_name_ciphertext_version,
         display_name_key_version, display_name_nonce, display_name_ciphertext,
         display_name_sort, phone_ciphertext_version, phone_key_version,
         phone_nonce, phone_ciphertext, active, received_at
       ) VALUES (
         $1, '20000000-0000-4000-8000-000000000030',
         'ctc_123456789012345678948', $2, 1, 1,
         decode(repeat('13',12),'hex'), decode(repeat('14',32),'hex'),
         1, 1, decode(repeat('15',12),'hex'), decode(repeat('16',32),'hex'),
         'ada', 1, 1, decode(repeat('17',12),'hex'),
         decode(repeat('18',32),'hex'), true, $3
       )`,
      [accountId, `di1_${"E".repeat(43)}`, observedAt],
    );
    await database.exec("REVOKE neon_superuser FROM whatsapp_api_runtime");

    const page = await repository.listChats({
      ...authorization,
      connectionPublicId: connectionA,
      cursorActivityAt: null,
      cursorPublicId: null,
      kind: "all",
      limit: 20,
      observedAt,
    });

    expect(page).toMatchObject({
      accountKey: { personalAccountId: accountId },
      chats: [
        {
          conversationId: conversationPublicId,
          displayName: { keyVersion: 1 },
          displayNameRecordId: `di1_${"E".repeat(43)}`,
          phone: { keyVersion: 1 },
          recipientId: "ctc_123456789012345678948",
        },
      ],
      connectionKey: {
        connectionId: "20000000-0000-4000-8000-000000000030",
      },
    });
  });

  test("establishes chat authorization context on its own pooled connection", async () => {
    const conversationId = "70000000-0000-4000-8000-000000000048";
    await database.query(
      `UPDATE public.mcp_authorizations SET scopes=ARRAY['messages:read']::text[] WHERE id=$1`,
      [authorizationId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_conversations (
         id, personal_account_id, whatsapp_connection_id, public_id, kind,
         recipient_locator, recipient_public_id, last_activity_at,
         last_activity_direction
       ) VALUES (
         $1, $2, '20000000-0000-4000-8000-000000000030',
         'cvs_123456789012345678948', 'direct', $3,
         'ctc_123456789012345678948', $4, 'inbound'
       )`,
      [conversationId, accountId, `di1_${"F".repeat(43)}`, observedAt],
    );
    await database.query(
      `INSERT INTO public.stored_messages (
         id, personal_account_id, whatsapp_connection_id, conversation_id,
         public_id, message_identity, direction, sent_at, content_type,
         content_ciphertext_version, content_key_version, content_nonce,
         content_ciphertext, received_at, webhook_item_identity
       ) VALUES (
         '71000000-0000-4000-8000-000000000048', $1,
         '20000000-0000-4000-8000-000000000030', $2,
         'msg_123456789012345678948', $3, 'inbound', $4, 'text', 1, 1,
         decode(repeat('11',12),'hex'), decode(repeat('12',32),'hex'), $4, $3
       )`,
      [accountId, conversationId, `wi1_${"F".repeat(43)}`, observedAt],
    );

    const page = await repository.listChats({
      ...authorization,
      authorizationContextEstablished: true,
      connectionPublicId: connectionA,
      cursorActivityAt: null,
      cursorPublicId: null,
      kind: "all",
      limit: 20,
      observedAt,
    });

    expect(page).toMatchObject({
      accountKey: { personalAccountId: accountId },
      chats: [{ conversationId: "cvs_123456789012345678948" }],
      connectionKey: {
        connectionId: "20000000-0000-4000-8000-000000000030",
      },
    });
  });

  test("loads chat read material when the OAuth context has no client ID", async () => {
    const conversationId = "70000000-0000-4000-8000-000000000049";
    await database.query(
      `UPDATE public.mcp_authorizations SET scopes=ARRAY['messages:read']::text[] WHERE id=$1`,
      [authorizationId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_conversations (
         id, personal_account_id, whatsapp_connection_id, public_id, kind,
         recipient_locator, recipient_public_id, last_activity_at,
         last_activity_direction
       ) VALUES (
         $1, $2, '20000000-0000-4000-8000-000000000030',
         'cvs_123456789012345678949', 'direct', $3,
         'ctc_123456789012345678949', $4, 'inbound'
       )`,
      [conversationId, accountId, `di1_${"G".repeat(43)}`, observedAt],
    );
    await database.query(
      `INSERT INTO public.stored_messages (
         id, personal_account_id, whatsapp_connection_id, conversation_id,
         public_id, message_identity, direction, sent_at, content_type,
         content_ciphertext_version, content_key_version, content_nonce,
         content_ciphertext, received_at, webhook_item_identity
       ) VALUES (
         '71000000-0000-4000-8000-000000000049', $1,
         '20000000-0000-4000-8000-000000000030', $2,
         'msg_123456789012345678949', $3, 'inbound', $4, 'text', 1, 1,
         decode(repeat('11',12),'hex'), decode(repeat('12',32),'hex'), $4, $3
       )`,
      [accountId, conversationId, `wi1_${"G".repeat(43)}`, observedAt],
    );

    const page = await repository.listChats({
      authorizationId,
      oauthSubject,
      connectionPublicId: connectionA,
      cursorActivityAt: null,
      cursorPublicId: null,
      kind: "all",
      limit: 20,
      observedAt,
    });

    expect(page).toMatchObject({
      accountKey: { personalAccountId: accountId },
      chats: [{ conversationId: "cvs_123456789012345678949" }],
      connectionKey: {
        connectionId: "20000000-0000-4000-8000-000000000030",
      },
    });
  });

  test("atomically reauthorizes and reserves protected Stored Media bytes", async () => {
    const conversationId = "70000000-0000-4000-8000-000000000046";
    const messageId = "71000000-0000-4000-8000-000000000046";
    await database.query(
      `UPDATE public.mcp_authorizations SET scopes=ARRAY['messages:read']::text[] WHERE id=$1`,
      [authorizationId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_conversations (id,personal_account_id,whatsapp_connection_id,public_id,kind,recipient_locator,recipient_public_id,last_activity_at,last_activity_direction)
       VALUES ($1,$2,'20000000-0000-4000-8000-000000000030','cvs_123456789012345678946','direct',$3,'ctc_123456789012345678946',$4,'inbound')`,
      [conversationId, accountId, `di1_${"D".repeat(43)}`, observedAt],
    );
    await database.query(
      `INSERT INTO public.stored_messages (id,personal_account_id,whatsapp_connection_id,conversation_id,public_id,message_identity,direction,sent_at,content_type,content_ciphertext_version,content_key_version,content_nonce,content_ciphertext,received_at,webhook_item_identity)
       VALUES ($1,$2,'20000000-0000-4000-8000-000000000030',$3,'msg_123456789012345678946',$4,'inbound',$5,'image',1,1,decode(repeat('11',12),'hex'),decode(repeat('12',32),'hex'),$5,$4)`,
      [
        messageId,
        accountId,
        conversationId,
        `wi1_${"D".repeat(43)}`,
        observedAt,
      ],
    );
    await database.query(
      `INSERT INTO public.stored_media (id,personal_account_id,whatsapp_connection_id,stored_message_id,public_id,state,media_type,object_key,plaintext_size_bytes,sha256,metadata_ciphertext_version,metadata_key_version,metadata_nonce,metadata_ciphertext)
       VALUES ('72000000-0000-4000-8000-000000000046',$1,'20000000-0000-4000-8000-000000000030',$2,'med_123456789012345678946','ready','image','opaque-object',15,repeat('a',64),1,1,decode(repeat('13',12),'hex'),decode(repeat('14',32),'hex'))`,
      [accountId, messageId],
    );
    const auditLogId = "50000000-0000-4000-8000-000000000046";
    const material = await repository.reserveStoredMediaRead({
      ...authorization,
      auditLogId,
      connectionPublicId: connectionA,
      dailyByteLimit: 15,
      mediaPublicId: "med_123456789012345678946",
      messagePublicId: "msg_123456789012345678946",
      observedAt,
    });
    expect(material).toMatchObject({
      mediaId: "72000000-0000-4000-8000-000000000046",
      objectKey: "opaque-object",
      plaintextSizeBytes: 15,
    });
    const log = await database.query(
      `SELECT outcome,media_bytes_reserved FROM public.tool_call_logs WHERE id=$1`,
      [auditLogId],
    );
    expect(log.rows).toEqual([
      { media_bytes_reserved: 15, outcome: "started" },
    ]);
    await repository.failStoredMediaRead({
      auditLogId,
      completedAt: new Date(observedAt.getTime() + 1_000),
      errorCode: "resource_unavailable",
    });
    const failedLog = await database.query(
      `SELECT outcome,error_code,result_count,media_bytes_reserved FROM public.tool_call_logs WHERE id=$1`,
      [auditLogId],
    );
    expect(failedLog.rows).toEqual([
      {
        error_code: "resource_unavailable",
        media_bytes_reserved: 0,
        outcome: "execution_error",
        result_count: 0,
      },
    ]);
    await expect(
      repository.reserveStoredMediaRead({
        ...authorization,
        auditLogId: "50000000-0000-4000-8000-000000000047",
        connectionPublicId: connectionA,
        dailyByteLimit: 100,
        mediaPublicId: "med_123456789012345678946",
        messagePublicId: "msg_000000000000000000000",
        observedAt,
      }),
    ).resolves.toBeNull();
  });

  test("rechecks directory scope, selected connection, and joined state for encrypted groups", async () => {
    await database.query(
      `UPDATE public.mcp_authorizations
       SET scopes = ARRAY['directory:read']::text[]
       WHERE id = $1`,
      [authorizationId],
    );
    await database.query(
      `DELETE FROM public.whatsapp_connection_secrets
       WHERE personal_account_id = $1
         AND whatsapp_connection_id = '20000000-0000-4000-8000-000000000030'`,
      [accountId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_group_directory_states (
         personal_account_id, whatsapp_connection_id, as_of, snapshot_observed_at,
         stale, partial, updated_at
       ) VALUES ($1, '20000000-0000-4000-8000-000000000030', $2, $2,
         false, false, $2)`,
      [accountId, observedAt],
    );
    await database.query(
      `UPDATE public.whatsapp_connections
       SET health_last_confirmed_at = $2
       WHERE personal_account_id = $1
         AND id = '20000000-0000-4000-8000-000000000030'`,
      [accountId, observedAt],
    );
    await expect(
      repository.listGroups({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
        searchIndex: null,
      }),
    ).resolves.toMatchObject({ groups: [] });
    await expect(
      repository.loadGroupSearchMaterial({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
      }),
    ).resolves.toBeNull();
    await database.query(
      `INSERT INTO public.whatsapp_connection_secrets (
         personal_account_id, whatsapp_connection_id, credential_ciphertext,
         credential_ciphertext_version, credential_key_version,
         credential_nonce
       ) VALUES ($1, '20000000-0000-4000-8000-000000000030',
         decode(repeat('07', 32), 'hex'), 1, 1,
         decode(repeat('08', 12), 'hex'))`,
      [accountId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_groups (
         id, personal_account_id, whatsapp_connection_id, public_id,
         provider_locator, display_name_ciphertext_version,
         display_name_key_version, display_name_nonce,
         display_name_ciphertext, provider_identity_ciphertext_version,
         provider_identity_key_version, provider_identity_nonce,
         provider_identity_ciphertext, name_prefix_indexes, joined, last_observed_at,
         created_at, updated_at
       ) VALUES (
         '30000000-0000-4000-8000-000000000039', $1,
         '20000000-0000-4000-8000-000000000030',
         'grp_123456789012345678939', $2, 1, 1,
         decode(repeat('03', 12), 'hex'), decode(repeat('04', 20), 'hex'),
         1, 1, decode(repeat('05', 12), 'hex'),
         decode(repeat('06', 20), 'hex'),
         ARRAY[$4::public.group_name_blind_index], true, $3, $3, $3
       )`,
      [accountId, `wi1_${"A".repeat(43)}`, observedAt, `gi1_${"A".repeat(43)}`],
    );

    await expect(
      repository.beginProtectedOperation({
        channel: "mcp",
        authorization,
        auditLogId: "50000000-0000-4000-8000-000000000039",
        hourLimit: 10,
        minuteLimit: 10,
        observedAt,
        operationName: "list_groups",
      }),
    ).resolves.toMatchObject({ outcome: "started" });
    await expect(
      repository.loadGroupSearchMaterial({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
      }),
    ).resolves.toMatchObject({
      identityKey: { keyVersion: 1, version: 1 },
    });
    await expect(
      repository.listGroups({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
        searchIndex: `gi1_${"B".repeat(43)}`,
      }),
    ).resolves.toMatchObject({ groups: [] });
    const page = await repository.listGroups({
      ...authorization,
      connectionPublicId: connectionA,
      observedAt,
      searchIndex: `gi1_${"A".repeat(43)}`,
    });
    expect(page).toMatchObject({
      asOf: "2026-07-31T12:00:00.000Z",
      groups: [
        {
          id: "30000000-0000-4000-8000-000000000039",
          publicId: "grp_123456789012345678939",
        },
      ],
      partial: false,
      stale: false,
    });
    expect(page?.groups[0]?.displayName?.ciphertext).not.toContain("Family");

    await database.query(
      `INSERT INTO public.ingestion_gaps (
         personal_account_id, whatsapp_connection_id, cause,
         history_window_started_at, starts_at, detected_at, updated_at
       ) VALUES (
         $1, '20000000-0000-4000-8000-000000000030',
         'processing_failure', $2, $3, $3, $3
       )`,
      [accountId, observedAt, new Date(observedAt.valueOf() + 1_000)],
    );
    await expect(
      repository.listGroups({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt: new Date(observedAt.valueOf() + 2_000),
        searchIndex: `gi1_${"A".repeat(43)}`,
      }),
    ).resolves.toMatchObject({ partial: true, stale: false });
    await database.query(
      `UPDATE public.ingestion_gaps
       SET ends_at = $2, updated_at = $2
       WHERE personal_account_id = $1
         AND whatsapp_connection_id = '20000000-0000-4000-8000-000000000030'`,
      [accountId, new Date(observedAt.valueOf() + 3_000)],
    );
    await database.query(
      `UPDATE public.whatsapp_group_directory_states
       SET retention_limited = true
       WHERE personal_account_id = $1
         AND whatsapp_connection_id = '20000000-0000-4000-8000-000000000030'`,
      [accountId],
    );
    await expect(
      repository.listGroups({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt: new Date(observedAt.valueOf() + 4_000),
        searchIndex: `gi1_${"A".repeat(43)}`,
      }),
    ).resolves.toMatchObject({ partial: true, stale: false });

    await database.query(
      `UPDATE public.whatsapp_groups
       SET joined = false,
           name_prefix_indexes = ARRAY[]::public.group_name_blind_index[]
       WHERE public_id = 'grp_123456789012345678939'`,
    );
    await expect(
      repository.listGroups({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
        searchIndex: `gi1_${"A".repeat(43)}`,
      }),
    ).resolves.toMatchObject({ groups: [] });
    await expect(
      repository.listGroups({
        ...authorization,
        connectionPublicId: connectionLater,
        observedAt,
        searchIndex: null,
      }),
    ).resolves.toBeNull();

    await database.query(
      `UPDATE public.whatsapp_groups SET joined = true
       WHERE public_id = 'grp_123456789012345678939'`,
    );
    await database.query(
      `UPDATE public.mcp_authorizations
       SET state = 'revoked', revoked_at = $2
       WHERE id = $1`,
      [authorizationId, observedAt],
    );
    await expect(
      repository.listGroups({
        ...authorization,
        connectionPublicId: connectionA,
        observedAt,
        searchIndex: null,
      }),
    ).resolves.toBeNull();
    await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
    try {
      await database.query(
        "SELECT set_config('public.personal_account_id', $1, true)",
        [accountId],
      );
      const protectedBoundary = await database.query(
        `SELECT * FROM public.load_mcp_group_projection_material(
          $1, $2, $3, $4, $5
        )`,
        [
          authorizationId,
          authorization.oauthSubject,
          authorization.clientId,
          observedAt,
          connectionA,
        ],
      );
      expect(protectedBoundary.rows).toEqual([]);
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }
  });
});
