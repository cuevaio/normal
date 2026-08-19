import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations } from "../src/migrations";
import { assertExpectedSchemaVersion } from "../src/readiness";

const accountA = "10000000-0000-4000-8000-000000000001";
const accountB = "10000000-0000-4000-8000-000000000002";
const accountC = "10000000-0000-4000-8000-000000000003";
const accountD = "10000000-0000-4000-8000-000000000004";
const connectionA = "20000000-0000-4000-8000-000000000001";
const connectionB = "20000000-0000-4000-8000-000000000002";
const ingressA = "30000000-0000-4000-8000-000000000001";

describe("production migrations", () => {
  let database: PGlite;

  beforeEach(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE ROLE neon_superuser NOLOGIN BYPASSRLS;
      CREATE ROLE whatsapp_api_runtime LOGIN;
      CREATE ROLE whatsapp_webhook_runtime LOGIN;
      GRANT neon_superuser TO whatsapp_api_runtime;
      GRANT neon_superuser TO whatsapp_webhook_runtime;
    `);
  });

  afterEach(async () => {
    await database.close();
  });

  test("coexists with the complete legacy migration ledger", async () => {
    await runMigrations(database);
    await database.exec(`
      CREATE TABLE public.schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
      );
      INSERT INTO public.schema_migrations (version, name, checksum)
      SELECT version, 'legacy migration ' || version, repeat('a', 64)
      FROM generate_series(1, 40) AS version;
    `);

    await runMigrations(database);

    const ledgers = await database.query<{ legacy: number; standard: number }>(`
      SELECT
        (SELECT count(*)::int FROM public.schema_migrations) AS legacy,
        (SELECT count(*)::int FROM public.drizzle_migrations) AS standard
    `);
    expect(ledgers.rows).toEqual([{ legacy: 40, standard: 19 }]);
  });

  test("clears only retention limitations superseded by a complete Directory snapshot", async () => {
    await runMigrations(database);
    await seedTenants(database);
    const initialSnapshot = new Date("2026-07-31T12:00:00.000Z");
    const partialSnapshot = new Date("2026-07-31T12:01:00.000Z");
    const completeSnapshot = new Date("2026-07-31T12:02:00.000Z");

    await database.query(
      `INSERT INTO public.directory_contact_projections (
         personal_account_id, whatsapp_connection_id, as_of,
         snapshot_observed_at, stale, partial, retention_limited, updated_at
       ) VALUES ($1, $2, $3, $3, false, true, true, $3)`,
      [accountA, connectionA, initialSnapshot],
    );
    await database.query(
      `INSERT INTO public.whatsapp_group_directory_states (
         personal_account_id, whatsapp_connection_id, as_of,
         snapshot_observed_at, stale, partial, retention_limited, updated_at
       ) VALUES ($1, $2, $3, $3, false, true, true, $3)`,
      [accountA, connectionA, initialSnapshot],
    );

    for (const table of [
      "directory_contact_projections",
      "whatsapp_group_directory_states",
    ]) {
      await database.query(
        `UPDATE public.${table}
         SET as_of = $3, snapshot_observed_at = $3, updated_at = $3
         WHERE personal_account_id = $1
           AND whatsapp_connection_id = $2`,
        [accountA, connectionA, partialSnapshot],
      );
      const partial = await database.query<{ retention_limited: boolean }>(
        `SELECT retention_limited FROM public.${table}
         WHERE personal_account_id = $1
           AND whatsapp_connection_id = $2`,
        [accountA, connectionA],
      );
      expect(partial.rows).toEqual([{ retention_limited: true }]);

      await database.query(
        `UPDATE public.${table}
         SET as_of = $3, snapshot_observed_at = $3,
             partial = false, updated_at = $3
         WHERE personal_account_id = $1
           AND whatsapp_connection_id = $2`,
        [accountA, connectionA, completeSnapshot],
      );
      const complete = await database.query<{ retention_limited: boolean }>(
        `SELECT retention_limited FROM public.${table}
         WHERE personal_account_id = $1
           AND whatsapp_connection_id = $2`,
        [accountA, connectionA],
      );
      expect(complete.rows).toEqual([{ retention_limited: false }]);
    }
  });

  test("contains opaque message-search tokens and clears them with content lifecycle", async () => {
    await runMigrations(database);
    await seedTenants(database);
    const tokenA = `msi1_${"A".repeat(43)}`;
    const tokenB = `msi1_${"B".repeat(43)}`;
    const conversationA = "40000000-0000-4000-8000-000000000001";
    const conversationB = "40000000-0000-4000-8000-000000000002";
    await database.query(
      `INSERT INTO public.whatsapp_conversations
        (id, personal_account_id, whatsapp_connection_id, public_id, kind,
         recipient_locator, recipient_public_id, last_activity_at, last_activity_direction)
       VALUES
        ($1, $2, $3, 'cvs_000000000000000000001', 'direct',
         $4, 'ctc_000000000000000000001', now(), 'inbound'),
        ($5, $6, $7, 'cvs_000000000000000000002', 'direct',
         $8, 'ctc_000000000000000000002', now(), 'inbound')`,
      [
        conversationA,
        accountA,
        connectionA,
        `wi1_${"C".repeat(43)}`,
        conversationB,
        accountB,
        connectionB,
        `wi1_${"D".repeat(43)}`,
      ],
    );
    await database.query(
      `INSERT INTO public.stored_messages
        (id, personal_account_id, whatsapp_connection_id, conversation_id,
         public_id, message_identity, direction, sent_at, content_type,
         content_ciphertext_version, content_key_version, content_nonce,
         content_ciphertext, received_at, message_search_index_version,
         message_search_tokens)
       VALUES
        ('50000000-0000-4000-8000-000000000001', $1, $2, $3,
         'msg_000000000000000000001', $4, 'inbound', now(), 'text',
         1, 1, decode(repeat('01', 12), 'hex'), decode(repeat('02', 32), 'hex'),
         now(), 1, ARRAY[$5, $6]::public.message_search_token[]),
        ('50000000-0000-4000-8000-000000000002', $7, $8, $9,
         'msg_000000000000000000002', $10, 'inbound', now(), 'text',
         1, 1, decode(repeat('03', 12), 'hex'), decode(repeat('04', 32), 'hex'),
         now(), 1, ARRAY[$5]::public.message_search_token[])`,
      [
        accountA,
        connectionA,
        conversationA,
        `wi1_${"E".repeat(43)}`,
        tokenA,
        tokenB,
        accountB,
        connectionB,
        conversationB,
        `wi1_${"F".repeat(43)}`,
      ],
    );
    const searchIndex = await database.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname='public' AND indexname='stored_messages_message_search_v1'`,
    );
    expect(searchIndex.rows[0]?.indexdef).toContain("USING gin");
    expect(searchIndex.rows[0]?.indexdef).toContain(
      "message_search_index_version = 1",
    );

    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      await database.query(
        "SELECT set_config('public.personal_account_id', $1, false)",
        [accountA],
      );
      const contained = await database.query<{ public_id: string }>(
        `SELECT public_id FROM public.stored_messages
         WHERE message_search_index_version=1
           AND message_search_tokens @> ARRAY[$1,$2]::public.message_search_token[]`,
        [tokenA, tokenB],
      );
      expect(contained.rows).toEqual([
        { public_id: "msg_000000000000000000001" },
      ]);
      expect(
        await database.query(
          `SELECT public_id FROM public.stored_messages
           WHERE message_search_tokens @> ARRAY[$1]::public.message_search_token[]`,
          [tokenA],
        ),
      ).toMatchObject({ rows: [{ public_id: "msg_000000000000000000001" }] });

      await database.query(
        `UPDATE public.stored_messages SET message_search_tokens=ARRAY[$1]::public.message_search_token[]
         WHERE public_id='msg_000000000000000000001'`,
        [tokenB],
      );
      expect(
        await database.query(
          `SELECT count(*)::int AS count FROM public.stored_messages
           WHERE message_search_tokens @> ARRAY[$1]::public.message_search_token[]`,
          [tokenA],
        ),
      ).toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await database.exec("RESET ROLE");
    }

    await database.query(
      `UPDATE public.stored_messages SET content_type=NULL,
        content_ciphertext_version=NULL,content_key_version=NULL,
        content_nonce=NULL,content_ciphertext=NULL,deleted_at=now()
       WHERE public_id='msg_000000000000000000001'`,
    );
    const tombstone = await database.query<Record<string, unknown>>(
      `SELECT message_search_index_version,message_search_tokens
       FROM public.stored_messages WHERE public_id='msg_000000000000000000001'`,
    );
    expect(tombstone.rows).toEqual([
      { message_search_index_version: null, message_search_tokens: null },
    ]);

    await database.query(
      `UPDATE public.stored_messages SET content_type=NULL,
        content_ciphertext_version=NULL,content_key_version=NULL,
        content_nonce=NULL,content_ciphertext=NULL,content_expired_at=now()
       WHERE public_id='msg_000000000000000000002'`,
    );
    expect(
      await database.query(
        `SELECT message_search_index_version,message_search_tokens
         FROM public.stored_messages WHERE public_id='msg_000000000000000000002'`,
      ),
    ).toMatchObject({
      rows: [
        { message_search_index_version: null, message_search_tokens: null },
      ],
    });
  });

  test("exposes only the schema version needed by restricted readiness", async () => {
    await runMigrations(database);

    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      await expect(
        assertExpectedSchemaVersion(database),
      ).resolves.toBeUndefined();
      await expect(
        database.query("DELETE FROM public.drizzle_migrations WHERE id = 1"),
      ).rejects.toThrow();
    } finally {
      await database.exec("RESET ROLE");
    }
  });

  test("removes elevated membership and leaves runtime roles restricted", async () => {
    await runMigrations(database);

    const roles = await database.query<{
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolname: string;
      rolreplication: boolean;
      rolsuper: boolean;
    }>(`
      SELECT
        rolname,
        rolsuper,
        rolcreatedb,
        rolcreaterole,
        rolreplication,
        rolbypassrls,
        rolinherit
      FROM pg_catalog.pg_roles
      WHERE rolname IN ('whatsapp_api_runtime', 'whatsapp_webhook_runtime')
      ORDER BY rolname
    `);
    const memberships = await database.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM pg_catalog.pg_auth_members memberships
      JOIN pg_catalog.pg_roles granted_role
        ON granted_role.oid = memberships.roleid
      JOIN pg_catalog.pg_roles member_role
        ON member_role.oid = memberships.member
      WHERE granted_role.rolname = 'neon_superuser'
        AND member_role.rolname IN (
          'whatsapp_api_runtime',
          'whatsapp_webhook_runtime'
        )
    `);

    expect(roles.rows).toEqual([
      {
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolname: "whatsapp_api_runtime",
        rolreplication: false,
        rolsuper: false,
      },
      {
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolname: "whatsapp_webhook_runtime",
        rolreplication: false,
        rolsuper: false,
      },
    ]);
    expect(memberships.rows[0]?.count).toBe(0);

    const runtimeOwnedTables = await database.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM pg_catalog.pg_tables
      WHERE schemaname IN ('public', 'public')
        AND tableowner IN (
          'whatsapp_api_runtime',
          'whatsapp_webhook_runtime'
        )
    `);
    expect(runtimeOwnedTables.rows[0]?.count).toBe(0);
  });

  test("isolates reads and writes to transaction-local Personal Account context", async () => {
    await runMigrations(database);
    await seedTenants(database);

    await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
    try {
      const withoutContext = await database.query(
        "SELECT id FROM public.whatsapp_connections",
      );
      expect(withoutContext.rows).toEqual([]);
      await expect(
        database.query(
          `INSERT INTO public.whatsapp_connections
            (personal_account_id, id, webhook_ingress_id, display_name_fallback)
           VALUES ($1, $2, gen_random_uuid(), 'Bright Badger')`,
          [accountA, "20000000-0000-4000-8000-000000000003"],
        ),
      ).rejects.toThrow();
      await database.exec("ROLLBACK; SET ROLE whatsapp_api_runtime; BEGIN");

      await database.query(
        "SELECT set_config('public.personal_account_id', $1, true)",
        [accountA],
      );
      const accountRows = await database.query<{ id: string }>(
        "SELECT id FROM public.whatsapp_connections ORDER BY id",
      );
      expect(accountRows.rows).toEqual([{ id: connectionA }]);

      await expect(
        database.query(
          `INSERT INTO public.whatsapp_connections
            (personal_account_id, id, webhook_ingress_id, display_name_fallback)
           VALUES ($1, $2, gen_random_uuid(), 'Calm Falcon')`,
          [accountB, "20000000-0000-4000-8000-000000000004"],
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }
  });

  test("rejects cross-Personal Account relationships through composite keys", async () => {
    await runMigrations(database);
    await seedTenants(database);

    await expect(
      database.query(
        `INSERT INTO public.whatsapp_connection_secrets
          (personal_account_id, whatsapp_connection_id, credential_ciphertext)
         VALUES ($1, $2, decode('01', 'hex'))`,
        [accountB, connectionA],
      ),
    ).rejects.toThrow();
  });

  test("makes a WhatsApp Connection key durably unavailable and cannot restore it through the runtime role", async () => {
    await runMigrations(database);
    await seedTenants(database);
    await seedKeyEnvelopes(database);

    await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
    try {
      await database.query(
        "SELECT set_config('public.personal_account_id', $1, true)",
        [accountA],
      );
      const first = await database.query<{ unavailable_at: Date }>(
        `SELECT public.make_whatsapp_connection_key_unavailable(
          $1, $2, $3::timestamptz
        ) AS unavailable_at`,
        [accountA, connectionA, "2026-07-31T12:00:00.000Z"],
      );
      const replay = await database.query<{ unavailable_at: Date }>(
        `SELECT public.make_whatsapp_connection_key_unavailable(
          $1, $2, $3::timestamptz
        ) AS unavailable_at`,
        [accountA, connectionA, "2026-07-31T13:00:00.000Z"],
      );
      const available = await database.query(
        `SELECT *
         FROM public.load_available_whatsapp_connection_key($1, $2)`,
        [accountA, connectionA],
      );

      expect(first.rows[0]?.unavailable_at).toEqual(
        new Date("2026-07-31T12:00:00.000Z"),
      );
      expect(replay.rows).toEqual(first.rows);
      expect(available.rows).toEqual([]);
      await expect(
        database.query(
          `UPDATE public.whatsapp_connection_key_envelopes
           SET ciphertext = decode('ff', 'hex'), unavailable_at = NULL
           WHERE personal_account_id = $1
             AND whatsapp_connection_id = $2`,
          [accountA, connectionA],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          `DELETE FROM public.whatsapp_connection_key_envelopes
           WHERE personal_account_id = $1
             AND whatsapp_connection_id = $2`,
          [accountA, connectionA],
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }
  });

  test("makes a Personal Account key unavailable across ordinary runtime decryption", async () => {
    await runMigrations(database);
    await seedTenants(database);
    await seedKeyEnvelopes(database);

    await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
    try {
      await database.query(
        "SELECT set_config('public.personal_account_id', $1, true)",
        [accountA],
      );
      await database.query(
        `SELECT public.make_personal_account_key_unavailable(
          $1, $2::timestamptz
        )`,
        [accountA, "2026-07-31T12:00:00.000Z"],
      );
      const accountKey = await database.query(
        "SELECT * FROM public.load_available_personal_account_key($1)",
        [accountA],
      );
      const connectionKey = await database.query(
        `SELECT *
         FROM public.load_available_whatsapp_connection_key($1, $2)`,
        [accountA, connectionA],
      );

      expect(accountKey.rows).toEqual([]);
      expect(connectionKey.rows).toEqual([]);
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }
  });

  test("leaves an unavailability tombstone when no WhatsApp Connection envelope existed", async () => {
    await runMigrations(database);
    await seedTenants(database);
    await seedKeyEnvelopes(database);
    await database.query(
      `DELETE FROM public.whatsapp_connection_key_envelopes
       WHERE personal_account_id = $1
         AND whatsapp_connection_id = $2`,
      [accountA, connectionA],
    );

    await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
    try {
      await database.query(
        "SELECT set_config('public.personal_account_id', $1, true)",
        [accountA],
      );
      const unavailable = await database.query<{ unavailable_at: Date }>(
        `SELECT public.make_whatsapp_connection_key_unavailable(
          $1, $2, $3::timestamptz
        ) AS unavailable_at`,
        [accountA, connectionA, "2026-07-31T12:00:00.000Z"],
      );

      expect(unavailable.rows[0]?.unavailable_at).toEqual(
        new Date("2026-07-31T12:00:00.000Z"),
      );
      await expect(
        database.query(
          `INSERT INTO public.whatsapp_connection_key_envelopes
            (
              personal_account_id,
              whatsapp_connection_id,
              account_key_version,
              key_version,
              nonce,
              ciphertext
            )
           VALUES ($1, $2, 1, 1, decode('0102', 'hex'), decode('0304', 'hex'))`,
          [accountA, connectionA],
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }
  });

  test("does not load a WhatsApp Connection envelope bound to another account-key version", async () => {
    await runMigrations(database);
    await seedTenants(database);
    await seedKeyEnvelopes(database);
    await database.query(
      `UPDATE public.whatsapp_connection_key_envelopes
       SET account_key_version = 2
       WHERE personal_account_id = $1
         AND whatsapp_connection_id = $2`,
      [accountA, connectionA],
    );

    await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
    try {
      await database.query(
        "SELECT set_config('public.personal_account_id', $1, true)",
        [accountA],
      );
      const available = await database.query(
        `SELECT *
         FROM public.load_available_whatsapp_connection_key($1, $2)`,
        [accountA, connectionA],
      );

      expect(available.rows).toEqual([]);
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }
  });

  test("restricts key unavailability and loading to the current Personal Account and API role", async () => {
    await runMigrations(database);
    await seedTenants(database);
    await seedKeyEnvelopes(database);

    await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
    try {
      await database.query(
        "SELECT set_config('public.personal_account_id', $1, true)",
        [accountA],
      );
      await expect(
        database.query(
          `SELECT public.make_whatsapp_connection_key_unavailable(
            $1, $2, transaction_timestamp()
          )`,
          [accountB, connectionB],
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }

    await database.exec("SET ROLE whatsapp_webhook_runtime; BEGIN");
    try {
      await database.query(
        "SELECT set_config('public.personal_account_id', $1, true)",
        [accountA],
      );
      await expect(
        database.query(
          "SELECT * FROM public.load_available_personal_account_key($1)",
          [accountA],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          `SELECT public.make_whatsapp_connection_key_unavailable(
            $1, $2, transaction_timestamp()
          )`,
          [accountA, connectionA],
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }
  });

  test("limits fixed-search-path bootstrap functions to their runtime identities", async () => {
    await runMigrations(database);
    await seedTenants(database);

    const functions = await database.query<{
      config: Array<string>;
      proname: string;
      prosecdef: boolean;
    }>(`
      SELECT proname, prosecdef, proconfig AS config
      FROM pg_catalog.pg_proc
      JOIN pg_catalog.pg_namespace
        ON pg_namespace.oid = pg_proc.pronamespace
      WHERE pg_namespace.nspname = 'public'
        AND proname IN (
          'bootstrap_personal_account_for_clerk',
          'bootstrap_whatsapp_connection_for_ingress',
          'bootstrap_active_mcp_tool_call',
          'bootstrap_mcp_access_authorization',
          'bootstrap_mcp_authorization',
          'bootstrap_mcp_refresh_authorization',
          'bootstrap_mcp_refresh_credential',
          'bootstrap_mcp_tool_call',
          'bootstrap_tool_call_log',
          'admit_personal_account_for_clerk',
          'load_connection_setup_failure_code_for_user',
          'load_connection_setup_webhook_ingress_for_user',
          'load_connection_setup_webhook_ingress_for_worker',
          'purge_expired_tool_call_logs',
          'expire_api_key_credentials',
          'purge_expired_api_key_metadata',
          'resolve_personal_account_for_clerk'
        )
      ORDER BY proname
    `);
    expect(functions.rows).toEqual([
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "admit_personal_account_for_clerk",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_active_mcp_tool_call",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_mcp_access_authorization",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_mcp_authorization",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_mcp_refresh_authorization",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_mcp_refresh_credential",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_mcp_tool_call",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_personal_account_for_clerk",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_tool_call_log",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "bootstrap_whatsapp_connection_for_ingress",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "expire_api_key_credentials",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "load_connection_setup_failure_code_for_user",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "load_connection_setup_webhook_ingress_for_user",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "load_connection_setup_webhook_ingress_for_worker",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "purge_expired_api_key_metadata",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "purge_expired_tool_call_logs",
        prosecdef: true,
      },
      {
        config: ["search_path=pg_catalog, pg_temp"],
        proname: "resolve_personal_account_for_clerk",
        prosecdef: true,
      },
    ]);

    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      const clerkLookup = await database.query<{ account_id: string }>(
        "SELECT public.bootstrap_personal_account_for_clerk($1) AS account_id",
        ["clerk_user_a"],
      );
      expect(clerkLookup.rows[0]?.account_id).toBe(accountA);
      expect(
        (
          await database.query(
            `SELECT *
             FROM public.bootstrap_mcp_refresh_credential(
               decode(repeat('00', 32), 'hex'), $1, $2
             )`,
            ["A".repeat(43), "approved-client"],
          )
        ).rows,
      ).toEqual([]);
      await expect(
        database.query(
          "SELECT * FROM public.bootstrap_whatsapp_connection_for_ingress($1)",
          [ingressA],
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("RESET ROLE");
    }

    await database.exec("SET ROLE whatsapp_webhook_runtime");
    try {
      const ingressLookup = await database.query<{
        personal_account_id: string;
        whatsapp_connection_id: string;
      }>("SELECT * FROM public.bootstrap_whatsapp_connection_for_ingress($1)", [
        ingressA,
      ]);
      expect(ingressLookup.rows).toEqual([]);
      await expect(
        database.query(
          "SELECT public.bootstrap_personal_account_for_clerk($1)",
          ["clerk_user_a"],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          `SELECT *
           FROM public.bootstrap_mcp_refresh_credential(
             decode(repeat('00', 32), 'hex'), $1, $2
           )`,
          ["A".repeat(43), "approved-client"],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          "SELECT credential_hash FROM public.mcp_refresh_credentials",
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          `SELECT public.load_connection_setup_webhook_ingress_for_user(
            $1, $2
          )`,
          ["clerk_user_a", "cst_000000000000000000001"],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          `SELECT public.load_connection_setup_webhook_ingress_for_worker(
            $1, $2
          )`,
          [
            "cst_000000000000000000001",
            "cspw_0000000000000000000000000000000000000000000",
          ],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          `SELECT public.bootstrap_mcp_access_authorization(
            $1, $2, transaction_timestamp()
          )`,
          ["40000000-0000-4000-8000-000000000001", "A".repeat(43)],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          `SELECT public.bootstrap_mcp_authorization(
            $1, $2, $3, transaction_timestamp()
          )`,
          [
            "40000000-0000-4000-8000-000000000001",
            "A".repeat(43),
            "approved-client",
          ],
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("RESET ROLE");
    }
  });

  test("resolves only an active ingress to encrypted connection material for the webhook role", async () => {
    await runMigrations(database);
    await seedTenants(database);
    await seedKeyEnvelopes(database);
    await database.query(
      `INSERT INTO public.whatsapp_connection_provider_sessions (
        personal_account_id,
        whatsapp_connection_id,
        locator_ciphertext_version,
        locator_key_version,
        locator_nonce,
        locator_ciphertext,
        authority_ciphertext_version,
        authority_key_version,
        authority_nonce,
        authority_ciphertext,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2,
        1, 1, decode(repeat('11', 12), 'hex'), decode(repeat('12', 32), 'hex'),
        1, 1, decode(repeat('13', 12), 'hex'), decode(repeat('14', 32), 'hex'),
        transaction_timestamp(), transaction_timestamp()
      )`,
      [accountA, connectionA],
    );

    await database.exec("SET ROLE whatsapp_webhook_runtime");
    try {
      const resolved = await database.query(
        `SELECT
          ingress.personal_account_id,
          ingress.whatsapp_connection_id,
          ingress.account_key_version,
          ingress.account_kms_key_id,
          encode(ingress.account_key_ciphertext, 'hex')
            AS account_key_ciphertext,
          ingress.connection_key_account_version,
          ingress.connection_key_version,
          encode(ingress.connection_key_nonce, 'hex')
            AS connection_key_nonce,
          encode(ingress.connection_key_ciphertext, 'hex')
            AS connection_key_ciphertext,
          ingress.authority_ciphertext_version,
          ingress.authority_key_version,
          encode(ingress.authority_nonce, 'hex') AS authority_nonce,
          encode(ingress.authority_ciphertext, 'hex')
            AS authority_ciphertext
        FROM public.bootstrap_whatsapp_connection_for_ingress($1)
          AS ingress`,
        [ingressA],
      );
      const unknown = await database.query(
        "SELECT * FROM public.bootstrap_whatsapp_connection_for_ingress($1)",
        ["30000000-0000-4000-8000-000000000099"],
      );

      expect(resolved.rows).toEqual([
        {
          account_key_ciphertext: "0102",
          account_key_version: 1,
          account_kms_key_id: "kms-content-root",
          authority_ciphertext: "14".repeat(32),
          authority_ciphertext_version: 1,
          authority_key_version: 1,
          authority_nonce: "13".repeat(12),
          connection_key_account_version: 1,
          connection_key_ciphertext: "0405",
          connection_key_nonce: "010203",
          connection_key_version: 1,
          personal_account_id: accountA,
          whatsapp_connection_id: connectionA,
        },
      ]);
      expect(unknown.rows).toEqual([]);
      await expect(
        database.query(
          "SELECT authority_ciphertext FROM public.whatsapp_connection_provider_sessions",
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          "SELECT ciphertext FROM public.whatsapp_connection_key_envelopes",
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("RESET ROLE");
    }

    await database.query(
      "UPDATE public.whatsapp_connections SET state = 'deleting' WHERE id = $1",
      [connectionA],
    );
    await database.exec("SET ROLE whatsapp_webhook_runtime");
    try {
      const deleting = await database.query(
        "SELECT * FROM public.bootstrap_whatsapp_connection_for_ingress($1)",
        [ingressA],
      );
      expect(deleting.rows).toEqual([]);
    } finally {
      await database.exec("RESET ROLE");
    }
  });

  test("creates or recovers exactly one admitted Personal Account with private-beta defaults", async () => {
    await runMigrations(database);

    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      const attempts = await Promise.all(
        [
          [accountC, "a1b2"],
          [accountD, "c3d4"],
        ].map(([accountId, ciphertext]) =>
          database.query<{
            created: boolean;
            personal_account_id: string;
          }>(
            `SELECT *
             FROM public.admit_personal_account_for_clerk(
               $1, $2, 1, $3, decode($4, 'hex'), 3
             )`,
            [
              "user_bootstrap123",
              accountId,
              "arn:aws:kms:us-east-1:111122223333:key/content-root",
              ciphertext,
            ],
          ),
        ),
      );

      expect(attempts.map(({ rows }) => rows[0]?.personal_account_id)).toEqual([
        accountC,
        accountC,
      ]);
      expect(attempts.map(({ rows }) => rows[0]?.created)).toEqual([
        true,
        false,
      ]);

      const lookup = await database.query<{ account_id: string }>(
        "SELECT public.bootstrap_personal_account_for_clerk($1) AS account_id",
        ["user_bootstrap123"],
      );
      expect(lookup.rows).toEqual([{ account_id: accountC }]);
    } finally {
      await database.exec("RESET ROLE");
    }

    const persisted = await database.query<{
      account_count: number;
      ciphertext: string;
      envelope_count: number;
      identity_count: number;
      message_retention_days: number;
      stored_media_limit_bytes: number;
      whatsapp_connection_limit: number;
    }>(
      `SELECT
         (
           SELECT count(*)::integer
           FROM public.personal_accounts
           WHERE id IN ($1, $2)
         ) AS account_count,
         (
           SELECT encode(ciphertext, 'hex')
           FROM public.personal_account_key_envelopes
           WHERE personal_account_id IN ($1, $2)
         ) AS ciphertext,
         (
           SELECT count(*)::integer
           FROM public.personal_account_key_envelopes
           WHERE personal_account_id IN ($1, $2)
         ) AS envelope_count,
         (
           SELECT count(*)::integer
           FROM public.clerk_identities
           WHERE clerk_user_id = 'user_bootstrap123'
         ) AS identity_count,
         (
           SELECT message_retention_days
           FROM public.personal_accounts
           WHERE id IN ($1, $2)
         ) AS message_retention_days,
         (
           SELECT stored_media_limit_bytes
           FROM public.personal_accounts
           WHERE id IN ($1, $2)
         ) AS stored_media_limit_bytes,
         (
           SELECT whatsapp_connection_limit
           FROM public.personal_accounts
           WHERE id IN ($1, $2)
         ) AS whatsapp_connection_limit`,
      [accountC, accountD],
    );
    expect(persisted.rows).toEqual([
      {
        account_count: 1,
        ciphertext: "a1b2",
        envelope_count: 1,
        identity_count: 1,
        message_retention_days: 30,
        stored_media_limit_bytes: 5_368_709_120,
        whatsapp_connection_limit: 3,
      },
    ]);
  });

  test("serializes bootstrap without reserving provider capacity", async () => {
    await runMigrations(database);

    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      const first = await database.query<{
        admission_state: string;
        created: boolean;
      }>(
        `SELECT *
         FROM public.admit_personal_account_for_clerk(
           'user_admitted', $1, 1, $2, decode('a1b2', 'hex'), 3
         )`,
        [accountC, "arn:aws:kms:us-east-1:111122223333:key/content-root"],
      );
      const concurrent = await Promise.all(
        [accountD, accountA].map((accountId) =>
          database.query<{
            admission_state: string;
            personal_account_id: string | null;
          }>(
            `SELECT *
             FROM public.admit_personal_account_for_clerk(
               'user_capacityexhausted', $1, 1, $2, decode('c3d4', 'hex'), 3
             )`,
            [accountId, "arn:aws:kms:us-east-1:111122223333:key/content-root"],
          ),
        ),
      );

      expect(first.rows[0]).toMatchObject({
        admission_state: "active",
        created: true,
      });
      expect(concurrent.map(({ rows }) => rows[0])).toEqual([
        expect.objectContaining({
          admission_state: "active",
          personal_account_id: accountD,
        }),
        expect.objectContaining({
          admission_state: "active",
          personal_account_id: accountD,
        }),
      ]);

      const promoted = await database.query<{
        admission_state: string;
        created: boolean;
        personal_account_id: string;
      }>(
        `SELECT *
         FROM public.admit_personal_account_for_clerk(
            'user_capacityexhausted', $1, 1, $2, decode('e5f6', 'hex'), 6
         )`,
        [accountD, "arn:aws:kms:us-east-1:111122223333:key/content-root"],
      );
      expect(promoted.rows[0]).toMatchObject({
        admission_state: "active",
        created: false,
        personal_account_id: accountD,
      });
    } finally {
      await database.exec("RESET ROLE");
    }

    const persisted = await database.query<{
      account_count: number;
      identity_count: number;
    }>(`
      SELECT
        (SELECT count(*)::integer FROM public.personal_accounts) AS account_count,
        (SELECT count(*)::integer FROM public.clerk_identities) AS identity_count
    `);
    expect(persisted.rows).toEqual([
      {
        account_count: 2,
        identity_count: 2,
      },
    ]);
  });

  test("does not recover or replace a deleting Personal Account", async () => {
    await runMigrations(database);
    await seedTenants(database);
    await database.query(
      "UPDATE public.personal_accounts SET state = 'deleting' WHERE id = $1",
      [accountA],
    );

    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      const lookup = await database.query<{ account_id: string | null }>(
        "SELECT public.bootstrap_personal_account_for_clerk($1) AS account_id",
        ["clerk_user_a"],
      );
      const replacement = await database.query(
        `SELECT *
         FROM public.admit_personal_account_for_clerk(
           $1, $2, 1, $3, decode('a1b2', 'hex'), 3
         )`,
        [
          "clerk_user_a",
          accountC,
          "arn:aws:kms:us-east-1:111122223333:key/content-root",
        ],
      );

      expect(lookup.rows).toEqual([{ account_id: null }]);
      expect(replacement.rows).toEqual([]);
    } finally {
      await database.exec("RESET ROLE");
    }

    const candidate = await database.query(
      "SELECT id FROM public.personal_accounts WHERE id = $1",
      [accountC],
    );
    expect(candidate.rows).toEqual([]);
  });

  test("denies Personal Account admission to the webhook runtime role", async () => {
    await runMigrations(database);

    await database.exec("SET ROLE whatsapp_webhook_runtime");
    try {
      await expect(
        database.query(
          `SELECT *
           FROM public.admit_personal_account_for_clerk(
             $1, $2, 1, $3, decode('a1b2', 'hex'), 3
           )`,
          [
            "user_bootstrap123",
            accountC,
            "arn:aws:kms:us-east-1:111122223333:key/content-root",
          ],
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("RESET ROLE");
    }

    const removedWaitlist = await database.query<{ table_name: string | null }>(
      "SELECT to_regclass('public.private_beta_waitlist')::text AS table_name",
    );
    expect(removedWaitlist.rows).toEqual([{ table_name: null }]);
  });

  test("keeps a restored branch closed while locked markers and wall-clock expiry replay", async () => {
    await runMigrations(database);
    await seedTenants(database);
    await seedKeyEnvelopes(database);
    await database.query(
      `INSERT INTO public.stored_media_object_deletions
        (personal_account_id, object_key, requested_at)
       VALUES ($1, 'expired/media-object', '2026-08-03T11:00:00Z')`,
      [accountA],
    );

    await database.exec("SET ROLE whatsapp_api_runtime");
    try {
      const before = await database.query<{ ready: boolean }>(
        "SELECT public.is_restore_ready('br-restored') AS ready",
      );
      expect(before.rows).toEqual([{ ready: false }]);
      await expect(
        database.query(
          "SELECT * FROM public.begin_restore_replay('br-restored', statement_timestamp())",
        ),
      ).rejects.toThrow();
    } finally {
      await database.exec("RESET ROLE");
    }

    await database.exec("SET ROLE whatsapp_restore_runtime");
    try {
      const candidates = await database.query<{
        deletion_kind: string;
        opaque_entity_id: string;
      }>(
        "SELECT * FROM public.begin_restore_replay('br-restored', '2026-08-03T12:00:00Z')",
      );
      expect(candidates.rows).toContainEqual({
        deletion_kind: "personal_account",
        opaque_entity_id: accountA,
      });
      const replay = await database.query<{ replayed: boolean }>(
        `SELECT public.replay_restore_deletion(
          'personal_account', $1, $2, '2026-08-03T12:00:00Z'
        ) AS replayed`,
        [accountA, "a".repeat(64)],
      );
      expect(replay.rows).toEqual([{ replayed: true }]);
      await database.query(
        "SELECT public.purge_restore_expired('2026-08-03T12:00:00Z', 1000)",
      );
      const objectDeletions = await database.query<{
        bucket: string;
        object_key: string;
      }>("SELECT * FROM public.list_restore_object_deletions(1000)");
      expect(objectDeletions.rows).toContainEqual({
        bucket: "stored_media",
        object_key: "expired/media-object",
      });
      await expect(
        database.query(
          "SELECT public.complete_restore_replay('br-restored','2026-08-03T12:01:00Z',1,1,0)",
        ),
      ).rejects.toThrow("restore object deletions remain");
      await database.query(
        "SELECT public.finish_restore_object_deletion('stored_media','expired/media-object')",
      );
      await database.query(
        "SELECT public.complete_restore_replay('br-restored','2026-08-03T12:01:00Z',1,1,0)",
      );
    } finally {
      await database.exec("RESET ROLE");
    }

    const protectedState = await database.query<{
      account_count: number;
      audit_columns: number;
      object_deletion_count: number;
    }>(
      `SELECT
        (SELECT count(*)::integer FROM public.personal_accounts WHERE id = $1) AS account_count,
        (SELECT count(*)::integer FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'restore_replay_audit') AS audit_columns,
        (SELECT count(*)::integer FROM public.stored_media_object_deletions) AS object_deletion_count`,
      [accountA],
    );
    expect(protectedState.rows).toEqual([
      { account_count: 0, audit_columns: 7, object_deletion_count: 0 },
    ]);
  });
});

const seedTenants = async (database: PGlite) => {
  await database.query(
    `INSERT INTO public.personal_accounts (id, state)
     VALUES ($1, 'active'), ($2, 'active')`,
    [accountA, accountB],
  );
  await database.query(
    `INSERT INTO public.clerk_identities
      (clerk_user_id, personal_account_id)
     VALUES ('clerk_user_a', $1), ('clerk_user_b', $2)`,
    [accountA, accountB],
  );
  await database.query(
    `INSERT INTO public.whatsapp_connections
      (personal_account_id, id, webhook_ingress_id, display_name_fallback)
     VALUES
      ($1, $2, $3, 'Bright Badger'),
      ($4, $5, gen_random_uuid(), 'Calm Falcon')`,
    [accountA, connectionA, ingressA, accountB, connectionB],
  );
};

const seedKeyEnvelopes = async (database: PGlite) => {
  await database.query(
    `INSERT INTO public.personal_account_key_envelopes
      (personal_account_id, key_version, kms_key_id, ciphertext)
     VALUES
      ($1, 1, 'kms-content-root', decode('0102', 'hex')),
      ($2, 1, 'kms-content-root', decode('0304', 'hex'))`,
    [accountA, accountB],
  );
  await database.query(
    `INSERT INTO public.whatsapp_connection_key_envelopes
      (
        personal_account_id,
        whatsapp_connection_id,
        account_key_version,
        key_version,
        nonce,
        ciphertext
      )
     VALUES
      ($1, $2, 1, 1, decode('010203', 'hex'), decode('0405', 'hex')),
      ($3, $4, 1, 1, decode('060708', 'hex'), decode('090a', 'hex'))`,
    [accountA, connectionA, accountB, connectionB],
  );
};
