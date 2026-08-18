import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { makeApiKeyRepository } from "../src/api-key";
import { runMigrations } from "../src/migrations";

const accountId = "10000000-0000-4000-8000-000000000093";
const secondAccountId = "10000000-0000-4000-8000-000000000094";
const clerkUserId = "user_restore93";
const secondClerkUserId = "user_restore94";
const connectionA = "con_123456789012345678993";
const connectionB = "con_123456789012345678994";
const createdAt = new Date("2026-08-14T12:00:00.000Z");
const reverifiedAt = new Date("2026-08-14T11:59:00.000Z");
const digest = new Uint8Array(32).fill(9);
const otherDigest = new Uint8Array(32).fill(10);

const publicIdFor = (index: number): string =>
  `apk_${String(index).padStart(21, "0")}`;

const hintFor = (publicId: string): string => `normal_${publicId}.…wxyz`;

describe("API Key restore invalidation", () => {
  let database: PGlite;

  const repository = () =>
    makeApiKeyRepository({
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    });

  const createKey = (
    overrides: Partial<
      Parameters<ReturnType<typeof repository>["create"]>[0]
    > = {},
  ) =>
    repository().create({
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
        ) VALUES
          ('20000000-0000-4000-8000-000000000093', $1,
           '30000000-0000-4000-8000-000000000093', 'Bright Badger', $2,
           '3456'),
          ('20000000-0000-4000-8000-000000000094', $3,
           '30000000-0000-4000-8000-000000000094', 'Calm Falcon', $4,
           '7890')`,
      [accountId, connectionA, secondAccountId, connectionB],
    );
  });

  afterEach(async () => {
    await database.close();
  });

  test("revokes every restored API Key and clears every digest before readiness", async () => {
    expect(await createKey()).toMatchObject({ outcome: "created" });
    expect(
      await createKey({
        clerkUserId: secondClerkUserId,
        connectionIds: [connectionB],
        credentialDigest: otherDigest,
        credentialHint: hintFor(publicIdFor(2)),
        id: "50000000-0000-4000-8000-000000000002",
        name: "Backup",
        publicId: publicIdFor(2),
      }),
    ).toMatchObject({ outcome: "created" });

    await database.exec("SET ROLE whatsapp_restore_runtime");
    try {
      await database.query(
        "SELECT * FROM public.begin_restore_replay('br-api-keys-93','2026-08-18T12:00:00Z')",
      );
      await expect(
        database.query(
          "SELECT public.complete_restore_replay('br-api-keys-93','2026-08-18T12:01:00Z',0,0,0)",
        ),
      ).rejects.toThrow("restored api keys remain authenticable");

      const first = await database.query<{
        digests_cleared: number;
        revoked: number;
      }>(
        "SELECT * FROM public.invalidate_restored_api_keys('2026-08-18T12:00:00Z', 1)",
      );
      expect(first.rows).toEqual([{ digests_cleared: 1, revoked: 1 }]);
      await expect(
        database.query(
          "SELECT public.complete_restore_replay('br-api-keys-93','2026-08-18T12:01:00Z',0,0,0)",
        ),
      ).rejects.toThrow("restored api keys remain authenticable");

      const remaining = await database.query<{
        digests_cleared: number;
        revoked: number;
      }>(
        "SELECT * FROM public.invalidate_restored_api_keys('2026-08-18T12:00:00Z', 1000)",
      );
      expect(remaining.rows).toEqual([{ digests_cleared: 1, revoked: 1 }]);
      await database.query(
        "SELECT public.complete_restore_replay('br-api-keys-93','2026-08-18T12:01:00Z',0,0,0)",
      );
    } finally {
      await database.exec("RESET ROLE");
    }

    const persisted = await database.query<{
      digest_count: number;
      ready: boolean;
      revoked: number;
      state: string;
    }>(
      `SELECT
         keys.state,
         count(*) FILTER (WHERE keys.credential_digest IS NOT NULL)::int AS digest_count,
         count(*) FILTER (WHERE keys.state = 'revoked')::int AS revoked,
         (SELECT public.is_restore_ready('br-api-keys-93')) AS ready
       FROM public.api_keys keys
       GROUP BY keys.state`,
    );
    expect(persisted.rows).toEqual([
      { digest_count: 0, ready: true, revoked: 2, state: "revoked" },
    ]);

    const evidence = await database.query<{
      api_key_digests_cleared: number;
      api_keys_revoked: number;
    }>(
      `SELECT api_keys_revoked, api_key_digests_cleared
       FROM public.restore_replay_audit
       WHERE branch_id = 'br-api-keys-93'`,
    );
    expect(evidence.rows).toEqual([
      { api_key_digests_cleared: 2, api_keys_revoked: 2 },
    ]);

    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      const authenticated = await repository().authenticate({
        digest,
        publicId: publicIdFor(1),
      });
      expect(authenticated).toBeNull();
      const other = await repository().authenticate({
        digest: otherDigest,
        publicId: publicIdFor(2),
      });
      expect(other).toBeNull();
    } finally {
      await database.exec("RESET ROLE");
    }
  });

  test("rejects a predecessor digest after restore and requires a replacement key", async () => {
    expect(await createKey()).toMatchObject({ outcome: "created" });

    await database.exec("SET ROLE whatsapp_restore_runtime");
    try {
      await database.query(
        "SELECT * FROM public.begin_restore_replay('br-api-keys-93','2026-08-18T12:00:00Z')",
      );
      await database.query(
        "SELECT * FROM public.invalidate_restored_api_keys('2026-08-18T12:00:00Z', 1000)",
      );
      await database.query(
        "SELECT public.complete_restore_replay('br-api-keys-93','2026-08-18T12:01:00Z',0,0,0)",
      );
    } finally {
      await database.exec("RESET ROLE");
    }

    expect(
      await repository().authenticate({
        digest,
        publicId: publicIdFor(1),
      }),
    ).toBeNull();

    const replacement = await createKey({
      credentialDigest: new Uint8Array(32).fill(11),
      credentialHint: hintFor(publicIdFor(3)),
      id: "50000000-0000-4000-8000-000000000003",
      name: "Replacement",
      publicId: publicIdFor(3),
    });
    expect(replacement).toMatchObject({
      outcome: "created",
      summary: { id: publicIdFor(3), name: "Replacement", state: "active" },
    });
    expect(
      await repository().authenticate({
        digest,
        publicId: publicIdFor(1),
      }),
    ).toBeNull();
  });

  test("fails closed on a branch mismatch before verification access", async () => {
    await database.exec("SET ROLE whatsapp_restore_runtime");
    try {
      await database.query(
        "SELECT * FROM public.begin_restore_replay('br-api-keys-93','2026-08-18T12:00:00Z')",
      );
      await database.query(
        "SELECT * FROM public.invalidate_restored_api_keys('2026-08-18T12:00:00Z', 1000)",
      );
      await expect(
        database.query(
          "SELECT public.complete_restore_replay('br-other-93','2026-08-18T12:01:00Z',0,0,0)",
        ),
      ).rejects.toThrow("restore replay is not active");
      expect(
        (
          await database.query<{ ready: boolean }>(
            "SELECT public.is_restore_ready('br-other-93') AS ready",
          )
        ).rows,
      ).toEqual([{ ready: false }]);
      expect(
        (
          await database.query<{ ready: boolean }>(
            "SELECT public.is_restore_ready('br-api-keys-93') AS ready",
          )
        ).rows,
      ).toEqual([{ ready: false }]);
    } finally {
      await database.exec("RESET ROLE");
    }
  });

  test("keeps global invalidation off the API runtime role", async () => {
    expect(await createKey()).toMatchObject({ outcome: "created" });
    await database.query(
      "SELECT * FROM public.begin_restore_replay('br-api-keys-93','2026-08-18T12:00:00Z')",
    );
    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      await expect(
        database.query(
          "SELECT * FROM public.invalidate_restored_api_keys('2026-08-18T12:00:00Z', 1000)",
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("RESET ROLE");
    }
    const remaining = await database.query<{
      digest_length: number | null;
      state: string;
    }>(
      `SELECT state, octet_length(credential_digest)::int AS digest_length
       FROM public.api_keys`,
    );
    expect(remaining.rows).toEqual([{ digest_length: 32, state: "active" }]);
  });

  test("records zero invalidation evidence when the snapshot has no API Keys", async () => {
    await database.exec("SET ROLE whatsapp_restore_runtime");
    try {
      await database.query(
        "SELECT * FROM public.begin_restore_replay('br-api-keys-93','2026-08-18T12:00:00Z')",
      );
      const empty = await database.query<{
        digests_cleared: number;
        revoked: number;
      }>(
        "SELECT * FROM public.invalidate_restored_api_keys('2026-08-18T12:00:00Z', 1000)",
      );
      expect(empty.rows).toEqual([{ digests_cleared: 0, revoked: 0 }]);
      await database.query(
        "SELECT public.complete_restore_replay('br-api-keys-93','2026-08-18T12:01:00Z',0,0,0)",
      );
    } finally {
      await database.exec("RESET ROLE");
    }
    const evidence = await database.query<{
      api_key_digests_cleared: number;
      api_keys_revoked: number;
      ready: boolean;
    }>(
      `SELECT audit.api_keys_revoked, audit.api_key_digests_cleared,
         public.is_restore_ready('br-api-keys-93') AS ready
       FROM public.restore_replay_audit audit
       WHERE audit.branch_id = 'br-api-keys-93'`,
    );
    expect(evidence.rows).toEqual([
      { api_key_digests_cleared: 0, api_keys_revoked: 0, ready: true },
    ]);
  });

  test("limits the restore invalidation function to a fixed search path", async () => {
    const definition = await database.query<{
      config: Array<string>;
      proname: string;
      prosecdef: boolean;
    }>(`
      SELECT proname, prosecdef, proconfig AS config
      FROM pg_catalog.pg_proc
      JOIN pg_catalog.pg_namespace
        ON pg_namespace.oid = pg_proc.pronamespace
      WHERE pg_namespace.nspname = 'public'
        AND proname = 'invalidate_restored_api_keys'
    `);
    expect(definition.rows).toEqual([
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "invalidate_restored_api_keys",
        prosecdef: true,
      },
    ]);
  });
});
