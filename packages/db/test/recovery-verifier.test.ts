import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { makeMcpToolRepository } from "../src/mcp-tool";
import { runMigrations } from "../src/migrations";

const branchId = "br-weekly-recovery";
const observedAt = "2026-08-18T12:00:00.000Z";

describe("recovery verifier database boundary", () => {
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
    await runMigrations(database);
  });

  afterEach(async () => database.close());

  test("is an unprivileged NOINHERIT login with no tenant table access", async () => {
    const role = await database.query(`
      SELECT rolsuper, rolinherit, rolcreaterole, rolcreatedb,
        rolcanlogin, rolreplication, rolbypassrls
      FROM pg_catalog.pg_roles
      WHERE rolname = 'whatsapp_recovery_auditor'
    `);
    expect(role.rows).toEqual([
      {
        rolbypassrls: false,
        rolcanlogin: true,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolsuper: false,
      },
    ]);

    await database.exec("SET ROLE whatsapp_recovery_auditor");
    try {
      await expect(
        database.query("SELECT id FROM public.personal_accounts"),
      ).rejects.toThrow();
      await expect(
        database.query("SELECT max(created_at) FROM public.drizzle_migrations"),
      ).resolves.toBeDefined();
    } finally {
      await database.exec("RESET ROLE");
    }
  });

  test("records a committed source point through the API role and exposes only the timestamp to the verifier", async () => {
    await database.exec("SET ROLE whatsapp_api_runtime");
    const recorded = await database.query<{ observed_at: string }>(
      "SELECT public.record_recovery_source_point() AS observed_at",
    );
    await database.exec("RESET ROLE");

    await database.exec("SET ROLE whatsapp_recovery_auditor");
    const recovered = await database.query<{ source_point_at: string }>(
      "SELECT public.read_recovery_source_point() AS source_point_at",
    );
    await expect(
      database.query("SELECT observed_at FROM public.recovery_source_points"),
    ).rejects.toThrow();
    await database.exec("RESET ROLE");

    expect(Date.parse(recorded.rows[0]?.observed_at ?? "")).toBeFinite();
    expect(
      new Date(recovered.rows[0]?.source_point_at ?? "").toISOString(),
    ).toBe(new Date(recorded.rows[0]?.observed_at ?? "").toISOString());
  });

  test("denies a mismatched branch without disclosing readiness metadata", async () => {
    await database.query("SELECT * FROM public.begin_restore_replay($1, $2)", [
      branchId,
      observedAt,
    ]);
    await database.exec("SET ROLE whatsapp_recovery_auditor");
    try {
      await expect(
        database.query(
          "SELECT * FROM public.verify_recovery_branch('br-other', $1)",
          [observedAt],
        ),
      ).rejects.toThrow("recovery verifier branch mismatch");
    } finally {
      await database.exec("RESET ROLE");
    }
  });

  test("keeps drills non-serving before and after independent verification", async () => {
    await database.query(
      "SELECT * FROM public.begin_restore_replay($1, $2, true)",
      [branchId, "2026-08-18T11:00:00.000Z"],
    );
    await database.exec("SET ROLE whatsapp_recovery_auditor");
    await expect(
      database.query("SELECT * FROM public.verify_recovery_branch($1, $2)", [
        branchId,
        observedAt,
      ]),
    ).rejects.toThrow("recovery verifier branch mismatch");
    await database.exec("RESET ROLE");

    await database.query(
      "SELECT public.complete_restore_replay($1, $2, 0, 0, 0)",
      [branchId, "2026-08-18T11:30:00.000Z"],
    );
    await database.query(
      `INSERT INTO public.whatsapp_recipient_transition_prefixes
         (journal_prefix, recorded_at) VALUES ($1, $2)`,
      ["a".repeat(64), "2026-08-18T11:31:00.000Z"],
    );

    expect(
      (
        await database.query<{ ready: boolean }>(
          "SELECT public.is_restore_ready($1) AS ready",
          [branchId],
        )
      ).rows,
    ).toEqual([{ ready: false }]);
    await database.exec("SET ROLE whatsapp_recovery_auditor");
    const after = await database.query<Record<string, boolean>>(
      "SELECT * FROM public.verify_recovery_branch($1, $2)",
      [branchId, observedAt],
    );
    await database.query(
      "SELECT public.complete_recovery_drill_verification($1, $2)",
      [branchId, observedAt],
    );
    await database.exec("RESET ROLE");
    expect(after.rows[0]).toEqual({
      api_key_ok: true,
      audit_ok: true,
      deletion_ok: true,
      expiry_ok: true,
      invariants_ok: true,
      object_intent_ok: true,
      quota_ok: true,
      recipient_content_ok: true,
      recipient_cutoff_ok: true,
      recipient_transition_ok: true,
      rls_ok: true,
      schema_ok: true,
    });
    expect(
      (
        await database.query<{ ready: boolean; state: string }>(
          `SELECT state, public.is_restore_ready($1) AS ready
           FROM public.restore_readiness`,
          [branchId],
        )
      ).rows,
    ).toEqual([{ ready: false, state: "drill_verified" }]);
  });

  test("proves tenant RLS with disposable accounts on a drill branch", async () => {
    const firstAccountId = "10000000-0000-4000-8000-000000000191";
    const secondAccountId = "10000000-0000-4000-8000-000000000192";
    const unrelatedAccountId = "10000000-0000-4000-8000-000000000193";
    const connectionId = "20000000-0000-4000-8000-000000000193";
    const conversationId = "70000000-0000-4000-8000-000000000193";
    const messageId = "71000000-0000-4000-8000-000000000193";
    const mediaId = "72000000-0000-4000-8000-000000000193";
    const authorizationId = "40000000-0000-4000-8000-000000000193";
    const auditLogId = "50000000-0000-4000-8000-000000000193";
    await database.query(
      "SELECT * FROM public.begin_restore_replay($1, $2, true)",
      [branchId, "2026-08-18T11:00:00.000Z"],
    );
    await database.query(
      "SELECT public.complete_restore_replay($1, $2, 0, 0, 0)",
      [branchId, "2026-08-18T11:30:00.000Z"],
    );
    await database.query(
      `INSERT INTO public.whatsapp_recipient_transition_prefixes
         (journal_prefix, recorded_at) VALUES ($1, $2)`,
      ["b".repeat(64), "2026-08-18T11:31:00.000Z"],
    );

    await database.exec("SET ROLE whatsapp_recovery_auditor");
    const prepared = await database.query<{ prepared: boolean }>(
      "SELECT public.prepare_recovery_rls_probe($1, $2, $3) AS prepared",
      [branchId, firstAccountId, secondAccountId],
    );
    expect(prepared.rows).toEqual([{ prepared: true }]);
    const retryPrepared = await database.query<{ prepared: boolean }>(
      "SELECT public.prepare_recovery_rls_probe($1, $2, $3) AS prepared",
      [branchId, firstAccountId, secondAccountId],
    );
    expect(retryPrepared.rows).toEqual([{ prepared: true }]);
    const mediaPrepared = await database.query<{ prepared: boolean }>(
      `SELECT public.prepare_recovery_media_loss_probe(
         $1,$2,$3,$4,$5,$6,$7,$8
       ) AS prepared`,
      [
        branchId,
        firstAccountId,
        connectionId,
        conversationId,
        messageId,
        mediaId,
        authorizationId,
        auditLogId,
      ],
    );
    expect(mediaPrepared.rows).toEqual([{ prepared: true }]);
    await database.exec("RESET ROLE");

    await database.query(
      "INSERT INTO public.personal_accounts (id, state) VALUES ($1, 'active')",
      [unrelatedAccountId],
    );
    await database.exec("SET ROLE whatsapp_recovery_auditor");
    await expect(
      database.query("SELECT public.complete_recovery_rls_probe($1, $2, $3)", [
        branchId,
        firstAccountId,
        unrelatedAccountId,
      ]),
    ).rejects.toThrow("recovery RLS probe cleanup failed");
    await database.exec("RESET ROLE");

    for (const [context, expected] of [
      [firstAccountId, firstAccountId],
      [secondAccountId, secondAccountId],
    ] as const) {
      await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
      try {
        await database.query(
          "SELECT set_config('public.personal_account_id', $1, true)",
          [context],
        );
        const visible = await database.query<{ id: string }>(
          `SELECT id::text FROM public.personal_accounts
           WHERE id = ANY($1::uuid[])`,
          [[firstAccountId, secondAccountId]],
        );
        expect(visible.rows).toEqual([{ id: expected }]);
      } finally {
        await database.exec("ROLLBACK; RESET ROLE");
      }
    }

    const runtimeRepository = makeMcpToolRepository({
      withConnection: (use) => use(database as never),
    });
    await database.exec("SET ROLE whatsapp_api_runtime");
    await runtimeRepository.failStoredMediaRead({
      auditLogId,
      completedAt: new Date(observedAt),
      errorCode: "resource_unavailable",
      mediaId,
      mediaFailureCode: "object_missing",
    });
    await database.exec("RESET ROLE");
    await database.exec("SET ROLE whatsapp_recovery_auditor");
    expect(
      (
        await database.query<{ verified: boolean }>(
          `SELECT public.verify_recovery_media_loss_probe(
             $1,$2,$3,$4
           ) AS verified`,
          [branchId, firstAccountId, mediaId, auditLogId],
        )
      ).rows,
    ).toEqual([{ verified: true }]);
    expect(
      (
        await database.query<{ prepared: boolean }>(
          `SELECT public.prepare_recovery_media_loss_probe(
             $1,$2,$3,$4,$5,$6,$7,$8
           ) AS prepared`,
          [
            branchId,
            firstAccountId,
            connectionId,
            conversationId,
            messageId,
            mediaId,
            authorizationId,
            auditLogId,
          ],
        )
      ).rows,
    ).toEqual([{ prepared: false }]);
    await database.exec("RESET ROLE");

    await database.exec("SET ROLE whatsapp_recovery_auditor");
    await database.query(
      "SELECT public.complete_recovery_rls_probe($1, $2, $3)",
      [branchId, firstAccountId, secondAccountId],
    );
    await database.exec("RESET ROLE");
    await database.exec("SET ROLE whatsapp_recovery_auditor");
    await database.query(
      "SELECT public.complete_recovery_drill_verification($1, $2)",
      [branchId, observedAt],
    );
    expect(
      (
        await database.query<{ prepared: boolean }>(
          "SELECT public.prepare_recovery_rls_probe($1, $2, $3) AS prepared",
          [branchId, firstAccountId, secondAccountId],
        )
      ).rows,
    ).toEqual([{ prepared: false }]);
    await database.exec("RESET ROLE");
    expect(
      (
        await database.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM public.personal_accounts
           WHERE id = ANY($1::uuid[])`,
          [[firstAccountId, secondAccountId, unrelatedAccountId]],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });

  test("rejects incomplete recipient cutoff and prepared-transition evidence", async () => {
    const accountId = "10000000-0000-4000-8000-000000000090";
    const connectionId = "20000000-0000-4000-8000-000000000090";
    await database.query(
      `SELECT * FROM public.admit_personal_account_for_clerk(
        'user_recovery90',$1,1,
        'arn:aws:kms:us-east-1:111122223333:key/content',decode('0102','hex'),3
      )`,
      [accountId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connections(
        id,personal_account_id,webhook_ingress_id,public_id,number_suffix,
        state,state_changed_at,created_at
      ) VALUES(
        $1,$2,'30000000-0000-4000-8000-000000000090',
        'con_000000000000000000090','0090','connected',$3,$3
      )`,
      [connectionId, accountId, observedAt],
    );
    await database.query(
      "SELECT * FROM public.begin_restore_replay($1, $2, true)",
      [branchId, "2026-08-18T11:00:00.000Z"],
    );
    await database.query(
      "SELECT public.complete_restore_replay($1, $2, 1, 0, 0)",
      [branchId, "2026-08-18T11:30:00.000Z"],
    );
    await database.query(
      `INSERT INTO public.whatsapp_recipient_exclusions(
        personal_account_id,whatsapp_connection_id,recipient_kind,
        recipient_locator,recipient_public_id,excluded,effective_at,
        transition_id,transition_excluded,transition_effective_at,
        transition_idempotency_key,transition_prepared_at
      ) VALUES(
        $1,$2,'contact',$3,'ctc_000000000000000000090',true,$4,
        '40000000-0000-4000-8000-000000000090',true,$4,
        'recovery-transition-0000000090',$4
      )`,
      [accountId, connectionId, `di1_${"A".repeat(43)}`, observedAt],
    );

    await database.exec("SET ROLE whatsapp_recovery_auditor");
    const result = await database.query<Record<string, boolean>>(
      "SELECT * FROM public.verify_recovery_branch($1, $2)",
      [branchId, observedAt],
    );
    await database.exec("RESET ROLE");
    expect(result.rows[0]?.recipient_transition_ok).toBe(false);
    expect(result.rows[0]?.recipient_cutoff_ok).toBe(false);
  });
});
