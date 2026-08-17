import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { type ApiKeyRepository, makeApiKeyRepository } from "../src/api-key";
import { makeMcpToolRepository } from "../src/mcp-tool";
import { runMigrations } from "../src/migrations";

const accountId = "10000000-0000-4000-8000-000000000078";
const secondAccountId = "10000000-0000-4000-8000-000000000079";
const connectionA = "con_123456789012345678901";
const connectionB = "con_123456789012345678902";
const clerkUserId = "user_apikey78";
const secondClerkUserId = "user_apikey79";
const createdAt = new Date("2026-08-14T12:00:00.000Z");
const reverifiedAt = new Date("2026-08-14T11:59:00.000Z");
const digest = new Uint8Array(32).fill(7);
const otherDigest = new Uint8Array(32).fill(8);

const publicIdFor = (index: number): string =>
  `apk_${String(index).padStart(21, "0")}`;

const hintFor = (publicId: string): string => `normal_${publicId}.…wxyz`;

describe("API Key repository", () => {
  let database: PGlite;
  let repository: ApiKeyRepository;

  const createKey = (
    overrides: Partial<Parameters<ApiKeyRepository["create"]>[0]> = {},
  ) =>
    repository.create({
      clerkUserId,
      connectionIds: [connectionA],
      createdAt,
      credentialDigest: digest,
      credentialHint: hintFor(overrides.publicId ?? publicIdFor(1)),
      expiresAt: null,
      id: overrides.id ?? "50000000-0000-4000-8000-000000000001",
      name: "CI",
      permissions: ["connections:read"],
      publicId: publicIdFor(1),
      reverifiedAt,
      ...overrides,
    });

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
        clerkUserId,
        accountId,
        "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      ],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connections (
          id, personal_account_id, webhook_ingress_id,
          display_name_fallback, public_id, number_suffix
        ) VALUES
          ('20000000-0000-4000-8000-000000000078', $1,
           '30000000-0000-4000-8000-000000000078', 'Bright Badger', $2,
           '3456'),
          ('20000000-0000-4000-8000-000000000079', $1,
           '30000000-0000-4000-8000-000000000079', 'Calm Falcon', $3,
           '7890')`,
      [accountId, connectionA, connectionB],
    );
    repository = makeApiKeyRepository({
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    });
  });

  afterEach(async () => {
    await database.close();
  });

  test("persists only the digest and the explicitly selected Connections", async () => {
    const created = await createKey();
    expect(created).toMatchObject({
      outcome: "created",
      summary: {
        connectionIds: [connectionA],
        credentialHint: hintFor(publicIdFor(1)),
        id: publicIdFor(1),
        name: "CI",
        permissions: ["connections:read"],
        state: "active",
      },
    });
    if (created.outcome !== "created") {
      throw new Error("API Key was not created");
    }
    expect(created.summary).not.toHaveProperty("credential");
    expect(created.summary).not.toHaveProperty("credentialDigest");

    const persisted = await database.query<{
      digest_length: number;
      hint: string;
      name: string;
      public_id: string;
    }>(
      `SELECT
         octet_length(credential_digest)::int AS digest_length,
         credential_hint AS hint,
         name,
         public_id
       FROM public.api_keys`,
    );
    expect(persisted.rows).toEqual([
      {
        digest_length: 32,
        hint: hintFor(publicIdFor(1)),
        name: "CI",
        public_id: publicIdFor(1),
      },
    ]);
    await database.query(
      `INSERT INTO public.whatsapp_connections (
         id, personal_account_id, webhook_ingress_id,
         display_name_fallback, public_id
       ) VALUES (
         '20000000-0000-4000-8000-000000000080', $1,
         '30000000-0000-4000-8000-000000000080', 'Clever Fox',
         'con_123456789012345678903'
       )`,
      [accountId],
    );
    const listed = await repository.list(clerkUserId, createdAt);
    expect(listed?.[0]?.connectionIds).toEqual([connectionA]);
  });

  test("enforces unique active names and the ten active key limit", async () => {
    expect(await createKey()).toMatchObject({ outcome: "created" });
    expect(
      await createKey({
        id: "50000000-0000-4000-8000-000000000002",
        name: "ci",
        publicId: publicIdFor(2),
        credentialHint: hintFor(publicIdFor(2)),
      }),
    ).toEqual({ outcome: "duplicate_name" });

    for (let index = 2; index <= 10; index += 1) {
      const publicId = publicIdFor(index);
      expect(
        await createKey({
          id: `50000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`,
          name: `Key ${index}`,
          publicId,
          credentialHint: hintFor(publicId),
        }),
      ).toMatchObject({ outcome: "created" });
    }
    expect(
      await createKey({
        id: "50000000-0000-4000-8000-000000000011",
        name: "Key 11",
        publicId: publicIdFor(11),
        credentialHint: hintFor(publicIdFor(11)),
      }),
    ).toEqual({ outcome: "limit_reached" });
  });

  test("treats missing, deleted, and cross-tenant Connections as not found", async () => {
    expect(
      await createKey({
        connectionIds: ["con_999999999999999999999"],
      }),
    ).toEqual({ outcome: "not_found" });

    await database.query(
      `DELETE FROM public.whatsapp_connections WHERE public_id = $1`,
      [connectionB],
    );
    expect(
      await createKey({
        connectionIds: [connectionB],
        id: "50000000-0000-4000-8000-000000000002",
        name: "Deleted",
        publicId: publicIdFor(2),
        credentialHint: hintFor(publicIdFor(2)),
      }),
    ).toEqual({ outcome: "not_found" });

    await database.query(
      `SELECT * FROM public.admit_personal_account_for_clerk(
        $1, $2, 1, $3, decode('0304', 'hex'), 6
      )`,
      [
        secondClerkUserId,
        secondAccountId,
        "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      ],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connections (
         id, personal_account_id, webhook_ingress_id,
         display_name_fallback, public_id, number_suffix
       ) VALUES (
         '20000000-0000-4000-8000-000000000081', $1,
         '30000000-0000-4000-8000-000000000081', 'Kind Otter',
         'con_123456789012345678904', '1111'
       )`,
      [secondAccountId],
    );
    const unknown = await createKey({
      connectionIds: ["con_123456789012345678904"],
      id: "50000000-0000-4000-8000-000000000003",
      name: "Cross",
      publicId: publicIdFor(3),
      credentialHint: hintFor(publicIdFor(3)),
    });
    const missing = await createKey({
      connectionIds: ["con_999999999999999999998"],
      id: "50000000-0000-4000-8000-000000000004",
      name: "Missing",
      publicId: publicIdFor(4),
      credentialHint: hintFor(publicIdFor(4)),
    });
    expect(unknown).toEqual(missing);
    expect(unknown).toEqual({ outcome: "not_found" });
  });

  test("allows a disconnected WhatsApp Connection and rejects invalid grants", async () => {
    await database.query(
      `UPDATE public.whatsapp_connections
       SET state = 'disconnected'
       WHERE public_id = $1`,
      [connectionA],
    );
    expect(await createKey()).toMatchObject({ outcome: "created" });
    expect(
      await createKey({
        connectionIds: [connectionA, connectionA],
        id: "50000000-0000-4000-8000-000000000002",
        name: "Dup",
        publicId: publicIdFor(2),
        credentialHint: hintFor(publicIdFor(2)),
      }),
    ).toEqual({ outcome: "invalid" });
    expect(
      await createKey({
        expiresAt: new Date("2026-08-14T11:00:00.000Z"),
        id: "50000000-0000-4000-8000-000000000003",
        name: "Past",
        publicId: publicIdFor(3),
        credentialHint: hintFor(publicIdFor(3)),
      }),
    ).toEqual({ outcome: "invalid" });
  });

  test("lists active, expired, and revoked metadata without the digest", async () => {
    expect(await createKey()).toMatchObject({ outcome: "created" });
    expect(
      await createKey({
        expiresAt: new Date("2026-08-14T13:00:00.000Z"),
        id: "50000000-0000-4000-8000-000000000002",
        name: "Expiring",
        publicId: publicIdFor(2),
        credentialHint: hintFor(publicIdFor(2)),
      }),
    ).toMatchObject({ outcome: "created" });

    const beforeExpiry = await repository.list(
      clerkUserId,
      new Date("2026-08-14T12:30:00.000Z"),
    );
    expect(beforeExpiry?.map((key) => key.state).sort()).toEqual([
      "active",
      "active",
    ]);

    const afterExpiry = await repository.list(
      clerkUserId,
      new Date("2026-08-14T13:00:00.000Z"),
    );
    expect(afterExpiry?.find((key) => key.id === publicIdFor(2))?.state).toBe(
      "expired",
    );
    expect(afterExpiry?.find((key) => key.id === publicIdFor(1))?.state).toBe(
      "active",
    );
    expect(JSON.stringify(afterExpiry)).not.toMatch(/credentialDigest|digest/u);

    const first = await repository.revoke({
      clerkUserId,
      publicId: publicIdFor(1),
      revokedAt: new Date("2026-08-14T12:05:00.000Z"),
    });
    const replay = await repository.revoke({
      clerkUserId,
      publicId: publicIdFor(1),
      revokedAt: new Date("2026-08-14T13:05:00.000Z"),
    });
    expect(first).toEqual({
      revokedAt: new Date("2026-08-14T12:05:00.000Z"),
    });
    expect(replay).toEqual(first);
    expect(JSON.stringify(first)).not.toMatch(/normal_apk_|digest/u);

    const cleared = await database.query<{ digest: Uint8Array | null }>(
      `SELECT credential_digest AS digest FROM public.api_keys WHERE public_id = $1`,
      [publicIdFor(1)],
    );
    expect(cleared.rows[0]?.digest).toBeNull();

    const listed = await repository.list(
      clerkUserId,
      new Date("2026-08-14T12:06:00.000Z"),
    );
    expect(listed?.find((key) => key.id === publicIdFor(1))?.state).toBe(
      "revoked",
    );
    expect(
      await repository.revoke({
        clerkUserId,
        publicId: "apk_999999999999999999999",
        revokedAt: new Date("2026-08-14T12:07:00.000Z"),
      }),
    ).toBeNull();
  });

  test("authenticates a matching digest and rejects every other outcome as null", async () => {
    expect(await createKey()).toMatchObject({ outcome: "created" });
    const accepted = await repository.authenticate({
      digest,
      publicId: publicIdFor(1),
    });
    expect(accepted).toMatchObject({
      connectionIds: [connectionA],
      grantId: "50000000-0000-4000-8000-000000000001",
      id: publicIdFor(1),
      permissions: ["connections:read"],
      personalAccountId: accountId,
    });
    expect(accepted).not.toHaveProperty("credentialDigest");
    const used = await database.query<{ last_used_at: string | null }>(
      `SELECT last_used_at FROM public.api_keys WHERE public_id = $1`,
      [publicIdFor(1)],
    );
    expect(used.rows[0]?.last_used_at).not.toBeNull();

    const wrongDigest = await repository.authenticate({
      digest: otherDigest,
      publicId: publicIdFor(1),
    });
    const unknown = await repository.authenticate({
      digest,
      publicId: publicIdFor(9),
    });
    expect(wrongDigest).toBeNull();
    expect(unknown).toBeNull();

    await repository.revoke({
      clerkUserId,
      publicId: publicIdFor(1),
      revokedAt: new Date("2026-08-14T12:05:00.000Z"),
    });
    expect(
      await repository.authenticate({
        digest,
        publicId: publicIdFor(1),
      }),
    ).toBeNull();

    expect(
      await createKey({
        id: "50000000-0000-4000-8000-000000000002",
        name: "Soon",
        publicId: publicIdFor(2),
        credentialHint: hintFor(publicIdFor(2)),
        credentialDigest: otherDigest,
      }),
    ).toMatchObject({ outcome: "created" });
    await database.query(
      `UPDATE public.api_keys
       SET created_at = transaction_timestamp() - interval '2 hours',
           reverified_at = transaction_timestamp() - interval '2 hours'
             - interval '1 minute',
           expires_at = transaction_timestamp() - interval '1 hour'
       WHERE public_id = $1`,
      [publicIdFor(2)],
    );
    const expired = await repository.authenticate({
      digest: otherDigest,
      publicId: publicIdFor(2),
    });
    expect(expired).toBeNull();
    expect(expired).toEqual(unknown);
  });

  test("lists only explicitly selected non-deleted Connections for an API Key", async () => {
    expect(await createKey()).toMatchObject({ outcome: "created" });
    const tools = makeMcpToolRepository({
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    });
    const listed = await tools.listApiKeyConnections({
      apiKeyGrantId: "50000000-0000-4000-8000-000000000001",
      observedAt: createdAt,
      personalAccountId: accountId,
    });
    expect(listed?.map((row) => row.publicId)).toEqual([connectionA]);
    expect(listed?.[0]).toMatchObject({
      displayNameFallback: "Bright Badger",
      numberLastFour: "3456",
      publicId: connectionA,
    });

    expect(listed?.map((row) => row.publicId)).not.toContain(connectionB);
    await database.query(
      `INSERT INTO public.whatsapp_connections (
         id, personal_account_id, webhook_ingress_id,
         display_name_fallback, public_id
       ) VALUES (
         '20000000-0000-4000-8000-000000000081', $1,
         '30000000-0000-4000-8000-000000000081', 'Kind Otter',
         'con_123456789012345678904'
       )`,
      [accountId],
    );
    const afterLater = await tools.listApiKeyConnections({
      apiKeyGrantId: "50000000-0000-4000-8000-000000000001",
      observedAt: createdAt,
      personalAccountId: accountId,
    });
    expect(afterLater?.map((row) => row.publicId)).toEqual([connectionA]);

    expect(
      await createKey({
        connectionIds: [connectionA, connectionB],
        id: "50000000-0000-4000-8000-000000000010",
        name: "Send only",
        permissions: ["messages:send"],
        publicId: publicIdFor(10),
        credentialHint: hintFor(publicIdFor(10)),
        credentialDigest: otherDigest,
      }),
    ).toMatchObject({ outcome: "created" });
    expect(
      await tools.listApiKeyConnections({
        apiKeyGrantId: "50000000-0000-4000-8000-000000000010",
        observedAt: createdAt,
        personalAccountId: accountId,
      }),
    ).toBeNull();
  });

  test("keeps another Personal Account from reading API Keys under RLS", async () => {
    expect(await createKey()).toMatchObject({ outcome: "created" });
    await database.query(
      `SELECT * FROM public.admit_personal_account_for_clerk(
        $1, $2, 1, $3, decode('0304', 'hex'), 6
      )`,
      [
        secondClerkUserId,
        secondAccountId,
        "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      ],
    );
    expect(await repository.list(secondClerkUserId, createdAt)).toEqual([]);
    expect(
      await repository.revoke({
        clerkUserId: secondClerkUserId,
        publicId: publicIdFor(1),
        revokedAt: new Date("2026-08-14T12:05:00.000Z"),
      }),
    ).toBeNull();
    expect(
      await repository.authenticate({
        digest,
        publicId: publicIdFor(1),
      }),
    ).not.toBeNull();

    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      await database.query("BEGIN");
      await database.query(
        `SELECT set_config('public.personal_account_id', $1, true)`,
        [secondAccountId],
      );
      const leaked = await database.query<{ public_id: string }>(
        `SELECT public_id FROM public.api_keys`,
      );
      await database.query("ROLLBACK");
      expect(leaked.rows).toEqual([]);
    } finally {
      await database.exec("RESET ROLE");
    }
  });

  test("scheduled expiry clears the digest with database time and frees the active slot", async () => {
    expect(
      await createKey({
        expiresAt: new Date("2026-08-14T13:00:00.000Z"),
      }),
    ).toMatchObject({ outcome: "created" });
    await database.query(
      `UPDATE public.api_keys
       SET created_at = transaction_timestamp() - interval '2 hours',
           reverified_at = transaction_timestamp() - interval '2 hours'
             - interval '1 minute',
           expires_at = transaction_timestamp() - interval '1 hour'
       WHERE public_id = $1`,
      [publicIdFor(1)],
    );
    expect(
      await repository.authenticate({
        digest,
        publicId: publicIdFor(1),
      }),
    ).toBeNull();

    expect(await repository.expireCredentials(500)).toBe(1);
    expect(await repository.expireCredentials(500)).toBe(0);

    const persisted = await database.query<{
      digest: Uint8Array | null;
      metadata_expires_at: Date;
      state: string;
    }>(
      `SELECT credential_digest AS digest, metadata_expires_at, state
       FROM public.api_keys
       WHERE public_id = $1`,
      [publicIdFor(1)],
    );
    expect(persisted.rows[0]?.digest).toBeNull();
    expect(persisted.rows[0]?.state).toBe("expired");
    expect(persisted.rows[0]?.metadata_expires_at).toBeInstanceOf(Date);

    const listed = await repository.list(
      clerkUserId,
      new Date("2026-08-14T14:00:00.000Z"),
    );
    expect(listed).toEqual([
      expect.objectContaining({
        id: publicIdFor(1),
        name: "CI",
        state: "expired",
      }),
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/credentialDigest|digest/u);

    expect(
      await createKey({
        id: "50000000-0000-4000-8000-000000000002",
        name: "CI",
        publicId: publicIdFor(2),
        credentialHint: hintFor(publicIdFor(2)),
        credentialDigest: otherDigest,
      }),
    ).toMatchObject({ outcome: "created" });
    expect(
      await repository.authenticate({
        digest,
        publicId: publicIdFor(1),
      }),
    ).toBeNull();
  });

  test("keeps expired and revoked metadata for 90 days, then purges it", async () => {
    expect(await createKey()).toMatchObject({ outcome: "created" });
    expect(
      await createKey({
        expiresAt: new Date("2026-08-14T13:00:00.000Z"),
        id: "50000000-0000-4000-8000-000000000002",
        name: "Expiring",
        publicId: publicIdFor(2),
        credentialHint: hintFor(publicIdFor(2)),
        credentialDigest: otherDigest,
      }),
    ).toMatchObject({ outcome: "created" });
    expect(
      await repository.revoke({
        clerkUserId,
        publicId: publicIdFor(1),
        revokedAt: new Date("2026-08-14T12:05:00.000Z"),
      }),
    ).toEqual({ revokedAt: new Date("2026-08-14T12:05:00.000Z") });
    await database.query(
      `UPDATE public.api_keys
       SET created_at = transaction_timestamp() - interval '2 hours',
           reverified_at = transaction_timestamp() - interval '2 hours'
             - interval '1 minute',
           expires_at = transaction_timestamp() - interval '1 hour'
       WHERE public_id = $1`,
      [publicIdFor(2)],
    );
    expect(await repository.expireCredentials(500)).toBe(1);

    const beforeDeadline = await repository.list(
      clerkUserId,
      new Date("2026-08-14T14:00:00.000Z"),
    );
    expect(beforeDeadline?.map((key) => key.state).sort()).toEqual([
      "expired",
      "revoked",
    ]);

    await database.query(
      `UPDATE public.api_keys
       SET metadata_expires_at = statement_timestamp() - interval '1 hour'
       WHERE public_id = $1`,
      [publicIdFor(1)],
    );
    const afterRevokedWindow = await repository.list(
      clerkUserId,
      new Date("2026-11-13T12:05:00.000Z"),
    );
    expect(afterRevokedWindow?.map((key) => key.id)).toEqual([publicIdFor(2)]);

    expect(await repository.purgeExpiredMetadata(500)).toBe(1);
    expect(await repository.purgeExpiredMetadata(500)).toBe(0);
    const remaining = await database.query<{ public_id: string }>(
      `SELECT public_id FROM public.api_keys ORDER BY public_id`,
    );
    expect(remaining.rows).toEqual([{ public_id: publicIdFor(2) }]);
  });

  test("retains Activity Log presentation after API Key metadata purge", async () => {
    expect(await createKey()).toMatchObject({ outcome: "created" });
    const startedAt = new Date("2026-08-14T12:01:00.000Z");
    await database.query(
      `INSERT INTO public.tool_call_logs (
         id, personal_account_id, mcp_authorization_id, channel, api_key_id,
         api_key_public_id, api_key_name, tool_name, started_at, completed_at,
         outcome, result_count, latency_ms, quota_reserved, expires_at
       ) VALUES (
         '50000000-0000-4000-8000-000000000090', $1, NULL, 'api', $2, $3,
         'CI', 'list_connections', $4, $5, 'success', 1, 12, true,
         $4::timestamptz + interval '90 days'
       )`,
      [
        accountId,
        "50000000-0000-4000-8000-000000000001",
        publicIdFor(1),
        startedAt,
        new Date("2026-08-14T12:01:00.012Z"),
      ],
    );
    expect(
      await repository.revoke({
        clerkUserId,
        publicId: publicIdFor(1),
        revokedAt: new Date("2026-08-14T12:05:00.000Z"),
      }),
    ).not.toBeNull();
    await database.query(
      `UPDATE public.api_keys
       SET metadata_expires_at = statement_timestamp() - interval '1 hour'
       WHERE public_id = $1`,
      [publicIdFor(1)],
    );
    expect(await repository.purgeExpiredMetadata(500)).toBe(1);

    const logs = await database.query<{
      api_key_name: string | null;
      api_key_public_id: string | null;
      expires_at: Date;
    }>(
      `SELECT api_key_name, api_key_public_id, expires_at
       FROM public.tool_call_logs
       WHERE id = '50000000-0000-4000-8000-000000000090'`,
    );
    expect(logs.rows).toEqual([
      {
        api_key_name: "CI",
        api_key_public_id: publicIdFor(1),
        expires_at: new Date("2026-11-12T12:01:00.000Z"),
      },
    ]);
    expect(await repository.list(clerkUserId, createdAt)).toEqual([]);
  });

  test("keeps retention functions tenant-safe, bounded, and free of caller cutoffs", async () => {
    await expect(repository.expireCredentials(0)).rejects.toThrow();
    await expect(repository.expireCredentials(1001)).rejects.toThrow();
    await expect(repository.purgeExpiredMetadata(0)).rejects.toThrow();
    await expect(
      database.query("SELECT public.expire_api_key_credentials($1, $2)", [
        new Date("2099-01-01T00:00:00.000Z"),
        500,
      ]),
    ).rejects.toThrow();
    await expect(
      database.query("SELECT public.purge_expired_api_key_metadata($1, $2)", [
        new Date("2099-01-01T00:00:00.000Z"),
        500,
      ]),
    ).rejects.toThrow();

    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      await database.query("BEGIN");
      await database.query(
        `SELECT set_config('public.personal_account_id', $1, true)`,
        [accountId],
      );
      await expect(
        database.query("DELETE FROM public.api_keys"),
      ).rejects.toThrow();
      await database.query("ROLLBACK");
    } finally {
      await database.exec("RESET ROLE");
    }
  });
});
