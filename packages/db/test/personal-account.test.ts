import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { makeApiKeyRepository } from "../src/api-key";
import { runMigrations } from "../src/migrations";
import {
  makePersonalAccountRepository,
  type PersonalAccountConnectionProvider,
} from "../src/personal-account";

const accountId = "10000000-0000-4000-8000-000000000010";
const apiKeyPublicId = "apk_aaaaaaaaaaaaaaaaaaaaa";
const apiKeyDigest = new Uint8Array(32).fill(7);

const insertApiKey = async (
  database: PGlite,
  input: {
    readonly digestHex?: string | null;
    readonly id: string;
    readonly name: string;
    readonly publicId: string;
    readonly revokedAt?: string;
  },
) => {
  const digestHex =
    input.digestHex === undefined ? "07".repeat(32) : input.digestHex;
  await database.query(
    `INSERT INTO public.api_keys (
       id, personal_account_id, public_id, name, credential_digest,
       credential_hint, permissions, state, created_at, reverified_at,
       revoked_at, metadata_expires_at
     ) VALUES (
       $1, $2, $3, $4,
       CASE WHEN $5::text IS NULL THEN NULL ELSE decode($5, 'hex') END,
       $6, ARRAY['connections:read'], $7,
       '2026-08-03T00:00:00Z', '2026-08-03T00:00:00Z', $8,
       CASE WHEN $8::timestamptz IS NULL THEN NULL ELSE $8::timestamptz + interval '90 days' END
     )`,
    [
      input.id,
      accountId,
      input.publicId,
      input.name,
      digestHex,
      `normal_${input.publicId}.…wxyz`,
      input.revokedAt === undefined ? "active" : "revoked",
      input.revokedAt ?? null,
    ],
  );
};

describe("Personal Account repository", () => {
  let database: PGlite;
  let provider: PersonalAccountConnectionProvider;

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
    provider = {
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    };
  });

  afterEach(async () => {
    await database.close();
  });

  test("resolves, creates, and recovers through restricted bootstrap functions", async () => {
    const repository = makePersonalAccountRepository(provider);

    await expect(repository.resolve("user_repository123")).resolves.toBeNull();
    await expect(
      repository.create({
        clerkUserId: "user_repository123",
        keyCiphertext: new Uint8Array([1, 2, 3]),
        keyVersion: 1,
        kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
        personalAccountId: accountId,
      }),
    ).resolves.toEqual({
      admissionState: "active",
      created: true,
      messageRetentionDays: 30,
      personalAccountId: accountId,
      storedMediaLimitBytes: 5_368_709_120,
      whatsappConnectionLimit: 3,
    });
    await expect(repository.resolve("user_repository123")).resolves.toEqual({
      admissionState: "active",
      keyAvailable: true,
      messageRetentionDays: 30,
      personalAccountId: accountId,
      storedMediaLimitBytes: 5_368_709_120,
      whatsappConnectionLimit: 3,
    });
    await expect(
      repository.create({
        clerkUserId: "user_repository123",
        keyCiphertext: new Uint8Array([4, 5, 6]),
        keyVersion: 1,
        kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
        personalAccountId: "10000000-0000-4000-8000-000000000011",
      }),
    ).resolves.toEqual({
      admissionState: "active",
      created: false,
      messageRetentionDays: 30,
      personalAccountId: accountId,
      storedMediaLimitBytes: 5_368_709_120,
      whatsappConnectionLimit: 3,
    });
  });

  test("accepts a production-valid capacity above PostgreSQL integer range", async () => {
    const repository = makePersonalAccountRepository(provider);

    await expect(
      repository.create({
        clerkUserId: "user_largecapacity",
        keyCiphertext: new Uint8Array([1, 2, 3]),
        keyVersion: 1,
        kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
        personalAccountId: accountId,
      }),
    ).resolves.toMatchObject({
      admissionState: "active",
      created: true,
      personalAccountId: accountId,
    });
  });

  test("returns one safe absence for a deleting identity", async () => {
    const repository = makePersonalAccountRepository(provider);
    await repository.create({
      clerkUserId: "user_repository123",
      keyCiphertext: new Uint8Array([1, 2, 3]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: accountId,
    });
    await expect(
      repository.prepareDeletion({
        clerkUserId: "user_repository123",
        observedAt: "2026-08-03T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ state: "deleting" });
    await expect(
      repository.finishDeletion({
        clerkUserId: "user_repository123",
        deletionMarkerId: "a".repeat(64),
        requestedAt: "2026-08-03T00:00:00.000Z",
      }),
    ).resolves.toBe(true);

    await expect(repository.resolve("user_repository123")).resolves.toBeNull();
    await expect(
      repository.create({
        clerkUserId: "user_repository123",
        keyCiphertext: new Uint8Array([4, 5, 6]),
        keyVersion: 1,
        kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
        personalAccountId: "10000000-0000-4000-8000-000000000011",
      }),
    ).resolves.toBeNull();
  });

  test("prepares and idempotently finishes terminal deletion without creating unknown identities", async () => {
    const repository = makePersonalAccountRepository(provider);
    await repository.create({
      clerkUserId: "user_delete123",
      keyCiphertext: new Uint8Array([1, 2, 3]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: accountId,
    });

    await expect(
      repository.prepareDeletion({
        clerkUserId: "user_unknown123",
        observedAt: "2026-08-03T01:00:00.000Z",
      }),
    ).resolves.toBeNull();
    await expect(
      repository.prepareDeletion({
        clerkUserId: "user_delete123",
        observedAt: "2026-08-03T01:00:00.000Z",
      }),
    ).resolves.toEqual({
      connectionPublicIds: [],
      personalAccountId: accountId,
      requestedAt: "2026-08-03T01:00:00.000Z",
      state: "deleting",
    });
    const input = {
      clerkUserId: "user_delete123",
      deletionMarkerId: "b".repeat(64),
      requestedAt: "2026-08-03T01:00:00.000Z",
    };
    await expect(repository.finishDeletion(input)).resolves.toBe(true);
    await expect(repository.finishDeletion(input)).resolves.toBe(true);
    await expect(
      repository.prepareDeletion({
        clerkUserId: "user_delete123",
        observedAt: "2026-08-03T02:00:00.000Z",
      }),
    ).resolves.toEqual({
      connectionPublicIds: [],
      personalAccountId: accountId,
      requestedAt: "2026-08-03T01:00:00.000Z",
      state: "deleting",
    });

    const account = await database.query<{
      ciphertext: Uint8Array | null;
      deletion_marker_id: string;
      state: string;
    }>(
      `SELECT accounts.state, accounts.deletion_marker_id, keys.ciphertext
       FROM public.personal_accounts accounts
       JOIN public.personal_account_key_envelopes keys ON keys.personal_account_id = accounts.id
       WHERE accounts.id = $1`,
      [accountId],
    );
    expect(account.rows).toEqual([
      {
        ciphertext: null,
        deletion_marker_id: "b".repeat(64),
        state: "deleting",
      },
    ]);
  });

  test("revokes every API Key and clears digests before tenant access can continue", async () => {
    const repository = makePersonalAccountRepository(provider);
    const apiKeys = makeApiKeyRepository(provider);
    await repository.create({
      clerkUserId: "user_deletekeys",
      keyCiphertext: new Uint8Array([1, 2, 3]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: accountId,
    });

    await database.exec("RESET ROLE");
    await insertApiKey(database, {
      id: "60000000-0000-4000-8000-000000000001",
      name: "Billing automation",
      publicId: apiKeyPublicId,
    });
    await insertApiKey(database, {
      digestHex: null,
      id: "60000000-0000-4000-8000-000000000002",
      name: "Already revoked",
      publicId: "apk_bbbbbbbbbbbbbbbbbbbbb",
      revokedAt: "2026-08-03T00:30:00Z",
    });
    await database.exec("SET ROLE whatsapp_api_runtime");

    await expect(
      apiKeys.authenticate({
        digest: apiKeyDigest,
        publicId: apiKeyPublicId,
      }),
    ).resolves.toMatchObject({
      id: apiKeyPublicId,
      personalAccountId: accountId,
    });

    await expect(
      repository.prepareDeletion({
        clerkUserId: "user_deletekeys",
        observedAt: "2026-08-03T01:00:00.000Z",
      }),
    ).resolves.toMatchObject({ state: "deleting" });
    await expect(
      repository.prepareDeletion({
        clerkUserId: "user_deletekeys",
        observedAt: "2026-08-03T02:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      requestedAt: "2026-08-03T01:00:00.000Z",
      state: "deleting",
    });

    await expect(
      apiKeys.authenticate({
        digest: apiKeyDigest,
        publicId: apiKeyPublicId,
      }),
    ).resolves.toBeNull();
    await expect(repository.resolve("user_deletekeys")).resolves.toBeNull();

    await database.exec("RESET ROLE");
    const keys = await database.query<{
      digest: Uint8Array | null;
      metadata_expires_at: Date | null;
      name: string;
      public_id: string;
      revoked_at: Date;
      state: string;
    }>(
      `SELECT public_id, name, state, credential_digest AS digest, revoked_at,
              metadata_expires_at
       FROM public.api_keys
       ORDER BY public_id`,
    );
    expect(keys.rows).toEqual([
      {
        digest: null,
        metadata_expires_at: new Date("2026-11-01T01:00:00.000Z"),
        name: "Billing automation",
        public_id: apiKeyPublicId,
        revoked_at: new Date("2026-08-03T01:00:00.000Z"),
        state: "revoked",
      },
      {
        digest: null,
        metadata_expires_at: new Date("2026-11-01T00:30:00.000Z"),
        name: "Already revoked",
        public_id: "apk_bbbbbbbbbbbbbbbbbbbbb",
        revoked_at: new Date("2026-08-03T00:30:00.000Z"),
        state: "revoked",
      },
    ]);
  });

  test("purges a deletion-complete account into unlinkable Security Records", async () => {
    const repository = makePersonalAccountRepository(provider);
    await repository.create({
      clerkUserId: "user_purge123",
      keyCiphertext: new Uint8Array([1, 2, 3]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: accountId,
    });
    await database.exec("RESET ROLE");
    await insertApiKey(database, {
      id: "60000000-0000-4000-8000-000000000001",
      name: "Billing automation",
      publicId: apiKeyPublicId,
    });
    await database.exec("SET ROLE whatsapp_api_runtime");
    await repository.prepareDeletion({
      clerkUserId: "user_purge123",
      observedAt: "2026-08-03T01:00:00.000Z",
    });
    await repository.finishDeletion({
      clerkUserId: "user_purge123",
      deletionMarkerId: "c".repeat(64),
      requestedAt: "2026-08-03T01:00:00.000Z",
    });

    await database.exec("RESET ROLE");
    expect(
      (
        await database.query<{
          digest: Uint8Array | null;
          state: string;
        }>(`SELECT state, credential_digest AS digest FROM public.api_keys`)
      ).rows,
    ).toEqual([{ digest: null, state: "revoked" }]);
    await database.query(
      `INSERT INTO public.mcp_authorizations (
         id, personal_account_id, oauth_subject, client_id, client_class,
         scopes, state, reverified_at, authorized_at, absolute_expires_at,
         revoked_at, refresh_family_state, refresh_family_revoked_at
       ) VALUES (
         '20000000-0000-4000-8000-000000000001', $1, $2, 'client-secret-ref',
         'approved', ARRAY['connections:read'], 'revoked',
         '2026-08-03T00:00:00Z', '2026-08-03T00:01:00Z',
         '2026-10-31T00:01:00Z', '2026-08-03T01:00:00Z', 'revoked',
         '2026-08-03T01:00:00Z'
       )`,
      [accountId, "s".repeat(43)],
    );
    await database.query(
      `INSERT INTO public.tool_call_logs (
         id, personal_account_id, mcp_authorization_id, tool_name, started_at,
         completed_at, outcome, result_count, latency_ms, quota_reserved,
         expires_at, public_id
       ) VALUES (
         '30000000-0000-4000-8000-000000000001', $1,
         '20000000-0000-4000-8000-000000000001', 'list_connections',
         '2026-08-03T00:10:00Z', '2026-08-03T00:10:00.025Z', 'success', 2, 25,
         false, '2026-11-01T00:10:00Z', 'tcl_aaaaaaaaaaaaaaaaaaaaa'
       )`,
      [accountId],
    );
    await database.query(
      `INSERT INTO public.tool_call_logs (
         id, personal_account_id, mcp_authorization_id, channel, api_key_id,
         api_key_public_id, api_key_name, tool_name, started_at, completed_at,
         outcome, result_count, latency_ms, quota_reserved, expires_at,
         public_id
       ) VALUES (
         '30000000-0000-4000-8000-000000000002', $1, NULL, 'api',
         '60000000-0000-4000-8000-000000000002', 'apk_bbbbbbbbbbbbbbbbbbbbb',
         'Billing automation', 'list_connections', '2026-08-03T00:11:00Z',
         '2026-08-03T00:11:00.040Z', 'success', 1, 40, true,
         '2026-11-01T00:11:00Z', 'tcl_bbbbbbbbbbbbbbbbbbbbb'
       )`,
      [accountId],
    );
    await database.exec("SET ROLE whatsapp_api_runtime");

    await expect(
      repository.listDeletionPurgeCandidates({
        limit: 100,
        observedAt: "2026-08-03T02:00:00.000Z",
      }),
    ).resolves.toEqual([
      {
        deadlineAt: "2026-08-04T01:00:00.000Z",
        deadlineRisk: false,
        deletionMarkerId: "c".repeat(64),
        requestedAt: "2026-08-03T01:00:00.000Z",
      },
    ]);
    await expect(
      repository.purgeDeletion({
        completedAt: "2026-08-03T02:00:00.000Z",
        deletionMarkerId: "c".repeat(64),
      }),
    ).resolves.toBe(true);

    await database.exec("RESET ROLE");
    expect(
      (
        await database.query(
          "SELECT count(*)::integer AS count FROM public.personal_accounts",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (
        await database.query(
          "SELECT count(*)::integer AS count FROM public.api_keys",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (
        await database.query(
          "SELECT * FROM public.security_records ORDER BY started_at",
        )
      ).rows,
    ).toEqual([
      {
        category: "tool_call",
        client_class: "approved",
        completed_at: new Date("2026-08-03T00:10:00.025Z"),
        expires_at: new Date("2026-11-01T00:10:00.000Z"),
        latency_ms: 25,
        outcome: "success",
        result_count: 2,
        started_at: new Date("2026-08-03T00:10:00.000Z"),
      },
      {
        category: "tool_call",
        client_class: "api_key",
        completed_at: new Date("2026-08-03T00:11:00.040Z"),
        expires_at: new Date("2026-11-01T00:11:00.000Z"),
        latency_ms: 40,
        outcome: "success",
        result_count: 1,
        started_at: new Date("2026-08-03T00:11:00.000Z"),
      },
    ]);
    expect(
      JSON.stringify(
        (await database.query("SELECT * FROM public.security_records")).rows,
      ),
    ).not.toMatch(
      /apk_|Billing|personal_account|60000000|user_|clerk|connection|phone|credential|digest|normal_/iu,
    );
    expect(
      (
        await database.query(
          "SELECT * FROM public.personal_account_cleanup_audit",
        )
      ).rows,
    ).toEqual([
      {
        completed_at: new Date("2026-08-03T02:00:00.000Z"),
        deletion_marker_id: "c".repeat(64),
        expires_at: new Date("2026-11-01T02:00:00.000Z"),
      },
    ]);
  });

  test("bounds deletion-record expiry across both record types", async () => {
    const repository = makePersonalAccountRepository(provider);
    await database.exec("RESET ROLE");
    await database.query(`
      INSERT INTO public.security_records (
        category, client_class, outcome, result_count, started_at,
        completed_at, latency_ms, expires_at
      )
      SELECT
        'tool_call', 'approved', 'success', 1,
        '2025-01-01T00:00:00Z'::timestamptz + value * interval '1 second',
        '2025-01-01T00:00:00.001Z'::timestamptz + value * interval '1 second',
        1,
        '2025-04-01T00:00:00Z'::timestamptz + value * interval '1 second'
      FROM generate_series(0, 500) AS value
    `);
    await database.query(`
      INSERT INTO public.personal_account_cleanup_audit (
        deletion_marker_id, completed_at, expires_at
      )
      SELECT
        encode(sha256(value::text::bytea), 'hex'),
        '2025-01-01T00:00:00Z'::timestamptz + value * interval '1 second',
        '2025-04-01T00:00:00Z'::timestamptz + value * interval '1 second'
      FROM generate_series(0, 500) AS value
    `);

    await expect(repository.purgeExpiredDeletionRecords(500)).resolves.toBe(
      500,
    );

    await database.exec("RESET ROLE");
    expect(
      (
        await database.query(`
          SELECT
            (SELECT count(*)::integer FROM public.security_records) +
            (SELECT count(*)::integer FROM public.personal_account_cleanup_audit)
              AS count
        `)
      ).rows,
    ).toEqual([{ count: 502 }]);
  });

  test("revokes every API Key and clears digests before Personal Account purge", async () => {
    const repository = makePersonalAccountRepository(provider);
    const apiKeys = makeApiKeyRepository(provider);
    const secondAccountId = "10000000-0000-4000-8000-000000000011";
    const connectionPublicId = "con_123456789012345678901";
    const digest = new Uint8Array(32).fill(7);
    const otherDigest = new Uint8Array(32).fill(8);
    const publicId = "apk_aaaaaaaaaaaaaaaaaaaaa";
    const expiredPublicId = "apk_bbbbbbbbbbbbbbbbbbbbb";
    const otherPublicId = "apk_ccccccccccccccccccccc";
    await repository.create({
      clerkUserId: "user_apikeydelete",
      keyCiphertext: new Uint8Array([1, 2, 3]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: accountId,
    });
    await repository.create({
      clerkUserId: "user_otheraccount",
      keyCiphertext: new Uint8Array([4, 5, 6]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: secondAccountId,
    });
    await database.query(
      `INSERT INTO public.whatsapp_connections (
         id, personal_account_id, webhook_ingress_id,
         display_name_fallback, public_id
       ) VALUES
         ('20000000-0000-4000-8000-000000000010', $1,
          '30000000-0000-4000-8000-000000000010', 'Bright Badger', $2),
         ('20000000-0000-4000-8000-000000000011', $3,
          '30000000-0000-4000-8000-000000000011', 'Calm Falcon',
          'con_123456789012345678902')`,
      [accountId, connectionPublicId, secondAccountId],
    );
    expect(
      await apiKeys.create({
        clerkUserId: "user_apikeydelete",
        connectionIds: [connectionPublicId],
        createdAt: new Date("2026-08-03T00:00:00.000Z"),
        credentialDigest: digest,
        credentialHint: `normal_${publicId}.…wxyz`,
        expiresAt: null,
        id: "50000000-0000-4000-8000-000000000001",
        name: "CI",
        permissions: ["connections:read"],
        publicId,
        reverifiedAt: new Date("2026-08-02T23:59:00.000Z"),
      }),
    ).toMatchObject({ outcome: "created" });
    expect(
      await apiKeys.create({
        clerkUserId: "user_apikeydelete",
        connectionIds: [connectionPublicId],
        createdAt: new Date("2026-08-03T00:00:00.000Z"),
        credentialDigest: otherDigest,
        credentialHint: `normal_${expiredPublicId}.…wxyz`,
        expiresAt: new Date("2026-08-03T00:30:00.000Z"),
        id: "50000000-0000-4000-8000-000000000002",
        name: "Nightly",
        permissions: ["messages:send"],
        publicId: expiredPublicId,
        reverifiedAt: new Date("2026-08-02T23:59:00.000Z"),
      }),
    ).toMatchObject({ outcome: "created" });
    expect(
      await apiKeys.create({
        clerkUserId: "user_otheraccount",
        connectionIds: ["con_123456789012345678902"],
        createdAt: new Date("2026-08-03T00:00:00.000Z"),
        credentialDigest: new Uint8Array(32).fill(9),
        credentialHint: `normal_${otherPublicId}.…wxyz`,
        expiresAt: null,
        id: "50000000-0000-4000-8000-000000000003",
        name: "Other",
        permissions: ["directory:read"],
        publicId: otherPublicId,
        reverifiedAt: new Date("2026-08-02T23:59:00.000Z"),
      }),
    ).toMatchObject({ outcome: "created" });
    expect(await apiKeys.authenticate({ digest, publicId })).not.toBeNull();

    const first = await repository.prepareDeletion({
      clerkUserId: "user_apikeydelete",
      observedAt: "2026-08-03T01:00:00.000Z",
    });
    const replay = await repository.prepareDeletion({
      clerkUserId: "user_apikeydelete",
      observedAt: "2026-08-03T02:00:00.000Z",
    });
    expect(first).toMatchObject({
      personalAccountId: accountId,
      requestedAt: "2026-08-03T01:00:00.000Z",
      state: "deleting",
    });
    expect(replay).toEqual(first);
    expect(await apiKeys.authenticate({ digest, publicId })).toBeNull();
    expect(
      await apiKeys.authenticate({
        digest: otherDigest,
        publicId: expiredPublicId,
      }),
    ).toBeNull();

    const revoked = await database.query<{
      digest: Uint8Array | null;
      public_id: string;
      revoked_at: Date;
      state: string;
    }>(
      `SELECT public_id, state, credential_digest AS digest, revoked_at
       FROM public.api_keys
       WHERE personal_account_id = $1
       ORDER BY public_id`,
      [accountId],
    );
    expect(revoked.rows).toEqual([
      {
        digest: null,
        public_id: publicId,
        revoked_at: new Date("2026-08-03T01:00:00.000Z"),
        state: "revoked",
      },
      {
        digest: null,
        public_id: expiredPublicId,
        revoked_at: new Date("2026-08-03T01:00:00.000Z"),
        state: "revoked",
      },
    ]);

    const other = await database.query<{
      digest_length: number;
      state: string;
    }>(
      `SELECT state, octet_length(credential_digest)::int AS digest_length
       FROM public.api_keys
       WHERE public_id = $1`,
      [otherPublicId],
    );
    expect(other.rows).toEqual([{ digest_length: 32, state: "active" }]);

    await database.query(
      `UPDATE public.whatsapp_connections
       SET state = 'deleting',
           desired_state = 'disconnected',
           deletion_requested_at = '2026-08-03T01:00:00Z',
           deletion_marker_id = $2
       WHERE personal_account_id = $1`,
      [accountId, "e".repeat(64)],
    );
    await repository.finishDeletion({
      clerkUserId: "user_apikeydelete",
      deletionMarkerId: "d".repeat(64),
      requestedAt: "2026-08-03T01:00:00.000Z",
    });
    await database.query(
      "DELETE FROM public.whatsapp_connections WHERE personal_account_id = $1",
      [accountId],
    );
    expect(
      (
        await database.query(
          "SELECT count(*)::integer AS count FROM public.api_keys WHERE personal_account_id = $1",
          [accountId],
        )
      ).rows,
    ).toEqual([{ count: 2 }]);
    await expect(
      repository.purgeDeletion({
        completedAt: "2026-08-03T03:00:00.000Z",
        deletionMarkerId: "d".repeat(64),
      }),
    ).resolves.toBe(true);
    expect(
      (
        await database.query(
          "SELECT count(*)::integer AS count FROM public.api_keys WHERE personal_account_id = $1",
          [accountId],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (
        await database.query(
          "SELECT count(*)::integer AS count FROM public.api_keys WHERE public_id = $1",
          [otherPublicId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });

  test("admits another Clerk User without reserving provider capacity", async () => {
    const repository = makePersonalAccountRepository(provider);
    await repository.create({
      clerkUserId: "user_admitted",
      keyCiphertext: new Uint8Array([1, 2, 3]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: accountId,
    });

    const first = await repository.create({
      clerkUserId: "user_capacityexhausted",
      keyCiphertext: new Uint8Array([4, 5, 6]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: "10000000-0000-4000-8000-000000000011",
    });
    const replay = await repository.create({
      clerkUserId: "user_capacityexhausted",
      keyCiphertext: new Uint8Array([7, 8, 9]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: "10000000-0000-4000-8000-000000000012",
    });

    expect(first).toMatchObject({ admissionState: "active", created: true });
    expect(replay).toMatchObject({ admissionState: "active", created: false });
    await expect(
      repository.resolve("user_capacityexhausted"),
    ).resolves.toMatchObject({ admissionState: "active" });

    const persisted = await database.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM public.clerk_identities
       WHERE clerk_user_id = 'user_capacityexhausted'`,
    );
    expect(persisted.rows).toEqual([{ count: 1 }]);
  });
});
