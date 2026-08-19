import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  type McpToolConnectionProvider,
  type McpToolRepository,
  makeMcpToolRepository,
} from "../src/mcp-tool";
import { runMigrations } from "../src/migrations";

const accountId = "10000000-0000-4000-8000-000000000040";
const apiKeyId = "60000000-0000-4000-8000-000000000040";
const otherApiKeyId = "60000000-0000-4000-8000-000000000041";
const apiKeyPublicId = "apk_123456789012345678940";
const otherApiKeyPublicId = "apk_123456789012345678941";
const observedAt = new Date("2026-07-31T12:00:00.000Z");

describe("Activity Log protected-operation admission", () => {
  let database: PGlite;
  let repository: McpToolRepository;

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
        "user_activity40",
        accountId,
        "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      ],
    );
    await database.query(
      `INSERT INTO public.api_keys (
         id, personal_account_id, public_id, name, credential_digest,
         credential_hint, permissions, created_at, reverified_at
       ) VALUES
         ($1, $3, $4, 'Billing automation', decode(repeat('11', 32), 'hex'),
          $6, ARRAY['connections:read', 'directory:read', 'messages:read', 'messages:send'], $8, $8),
         ($2, $3, $5, 'Search automation', decode(repeat('22', 32), 'hex'),
          $7, ARRAY['connections:read', 'directory:read', 'messages:read', 'messages:send'], $8, $8)`,
      [
        apiKeyId,
        otherApiKeyId,
        accountId,
        apiKeyPublicId,
        otherApiKeyPublicId,
        `normal_${apiKeyPublicId}.…ABCD`,
        `normal_${otherApiKeyPublicId}.…EFGH`,
        observedAt,
      ],
    );
    const provider: McpToolConnectionProvider = {
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    };
    repository = makeMcpToolRepository(provider);
  });

  afterEach(async () => {
    await database.close();
  });

  const apiPrincipal = {
    channel: "api" as const,
    apiKey: {
      grantId: apiKeyId,
      name: "Billing automation",
      publicId: apiKeyPublicId,
    },
    hourLimit: 3,
    keyHourLimit: 2,
    keyMinuteLimit: 1,
    minuteLimit: 2,
    personalAccountId: accountId,
  };

  test("admits an API-channel operation before protected work and reserves shared quota", async () => {
    await expect(
      repository.beginProtectedOperation({
        ...apiPrincipal,
        auditLogId: "50000000-0000-4000-8000-000000000040",
        observedAt,
        operationName: "list_connections",
      }),
    ).resolves.toEqual({
      auditLogId: "50000000-0000-4000-8000-000000000040",
      outcome: "started",
    });

    const persisted = await database.query<{
      api_key_name: string | null;
      api_key_public_id: string | null;
      channel: string;
      mcp_authorization_id: string | null;
      outcome: string;
      quota_reserved: boolean;
    }>(
      `SELECT channel, mcp_authorization_id, api_key_public_id, api_key_name,
              outcome, quota_reserved
       FROM public.tool_call_logs`,
    );
    expect(persisted.rows).toEqual([
      {
        api_key_name: "Billing automation",
        api_key_public_id: apiKeyPublicId,
        channel: "api",
        mcp_authorization_id: null,
        outcome: "started",
        quota_reserved: true,
      },
    ]);
  });

  test("shares Personal Account request quota across MCP and API channels", async () => {
    await database.query(
      `INSERT INTO public.mcp_authorizations (
         id, personal_account_id, oauth_subject, client_id, client_class,
         scopes, state, reverified_at, authorized_at, absolute_expires_at
       ) VALUES (
         '40000000-0000-4000-8000-000000000040', $1, $2, 'approved-client',
         'approved', ARRAY['connections:read'], 'active', $3, $3,
         '2026-10-29T12:00:00Z'
       )`,
      [accountId, "A".repeat(43), observedAt],
    );
    await database.query(
      `INSERT INTO public.tool_call_logs (
         id, personal_account_id, mcp_authorization_id, tool_name, started_at,
         outcome, quota_reserved, expires_at
       ) VALUES (
         '50000000-0000-4000-8000-000000000041', $1,
         '40000000-0000-4000-8000-000000000040', 'list_connections', $2,
         'started', true, $2::timestamptz + interval '90 days'
       )`,
      [accountId, observedAt],
    );

    await expect(
      repository.beginProtectedOperation({
        ...apiPrincipal,
        auditLogId: "50000000-0000-4000-8000-000000000042",
        hourLimit: 1,
        minuteLimit: 1,
        observedAt: new Date("2026-07-31T12:00:30.000Z"),
        operationName: "list_connections",
      }),
    ).resolves.toMatchObject({
      auditLogId: "50000000-0000-4000-8000-000000000042",
      outcome: "rate_limited",
    });

    const persisted = await database.query<{
      channel: string;
      outcome: string;
      quota_reserved: boolean;
    }>(
      `SELECT channel, outcome, quota_reserved
       FROM public.tool_call_logs
       WHERE id = '50000000-0000-4000-8000-000000000042'`,
    );
    expect(persisted.rows).toEqual([
      { channel: "api", outcome: "rate_limited", quota_reserved: false },
    ]);
  });

  test("enforces per-API-Key request frequency independently of another key", async () => {
    await expect(
      repository.beginProtectedOperation({
        ...apiPrincipal,
        auditLogId: "50000000-0000-4000-8000-000000000043",
        observedAt,
        operationName: "list_connections",
      }),
    ).resolves.toEqual({
      auditLogId: "50000000-0000-4000-8000-000000000043",
      outcome: "started",
    });
    await expect(
      repository.beginProtectedOperation({
        ...apiPrincipal,
        auditLogId: "50000000-0000-4000-8000-000000000044",
        observedAt: new Date("2026-07-31T12:00:10.000Z"),
        operationName: "list_connections",
      }),
    ).resolves.toMatchObject({
      auditLogId: "50000000-0000-4000-8000-000000000044",
      outcome: "rate_limited",
    });
    await expect(
      repository.beginProtectedOperation({
        ...apiPrincipal,
        apiKey: {
          grantId: otherApiKeyId,
          name: "Search automation",
          publicId: otherApiKeyPublicId,
        },
        auditLogId: "50000000-0000-4000-8000-000000000045",
        observedAt: new Date("2026-07-31T12:00:10.000Z"),
        operationName: "list_connections",
      }),
    ).resolves.toEqual({
      auditLogId: "50000000-0000-4000-8000-000000000045",
      outcome: "started",
    });
  });

  test("counts a later-stamped reservation against an earlier admission", async () => {
    await expect(
      repository.beginProtectedOperation({
        ...apiPrincipal,
        auditLogId: "50000000-0000-4000-8000-000000000047",
        observedAt: new Date("2026-07-31T12:00:30.000Z"),
        operationName: "list_connections",
      }),
    ).resolves.toEqual({
      auditLogId: "50000000-0000-4000-8000-000000000047",
      outcome: "started",
    });
    await expect(
      repository.beginProtectedOperation({
        ...apiPrincipal,
        auditLogId: "50000000-0000-4000-8000-000000000048",
        observedAt,
        operationName: "list_connections",
      }),
    ).resolves.toMatchObject({
      auditLogId: "50000000-0000-4000-8000-000000000048",
      outcome: "rate_limited",
    });
  });

  test("records missing API Key permission without reserving quota", async () => {
    await database.query(
      `UPDATE public.api_keys
       SET permissions = ARRAY['messages:send']
       WHERE id = $1`,
      [apiKeyId],
    );
    await expect(
      repository.beginProtectedOperation({
        ...apiPrincipal,
        auditLogId: "50000000-0000-4000-8000-000000000049",
        observedAt,
        operationName: "list_connections",
        requiredPermission: "connections:read",
      }),
    ).resolves.toEqual({
      auditLogId: "50000000-0000-4000-8000-000000000049",
      outcome: "authorization_denied",
    });
    const persisted = await database.query<{
      outcome: string;
      quota_reserved: boolean;
    }>(
      `SELECT outcome, quota_reserved
       FROM public.tool_call_logs
       WHERE id = '50000000-0000-4000-8000-000000000049'`,
    );
    expect(persisted.rows).toEqual([
      { outcome: "authorization_denied", quota_reserved: false },
    ]);
  });

  test("denies an inactive Personal Account without writing an Activity Log", async () => {
    await database.query(
      `UPDATE public.personal_accounts SET state = 'deleting' WHERE id = $1`,
      [accountId],
    );
    await expect(
      repository.beginProtectedOperation({
        ...apiPrincipal,
        auditLogId: "50000000-0000-4000-8000-000000000046",
        observedAt,
        operationName: "list_connections",
      }),
    ).resolves.toEqual({
      auditLogId: "50000000-0000-4000-8000-000000000046",
      outcome: "authorization_denied",
    });
    expect(
      (await database.query("SELECT id FROM public.tool_call_logs")).rows,
    ).toEqual([]);
  });
});
