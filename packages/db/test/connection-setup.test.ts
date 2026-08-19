import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  type ConnectionSetupConnectionProvider,
  makeConnectionSetupRepository,
} from "../src/connection-setup";
import { runMigrations } from "../src/migrations";
import { makeOnboardingProfileRepository } from "../src/onboarding-profile";
import {
  makePersonalAccountRepository,
  type PersonalAccountConnectionProvider,
} from "../src/personal-account";

const accountA = "10000000-0000-4000-8000-000000000021";
const accountB = "10000000-0000-4000-8000-000000000022";
const createdAt = "2026-07-31T12:00:00.000Z";

describe("Connection Setup repository", () => {
  let database: PGlite;
  let provider: ConnectionSetupConnectionProvider &
    PersonalAccountConnectionProvider;

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

    const accounts = makePersonalAccountRepository(provider);
    await accounts.create({
      clerkUserId: "user_setupa",
      keyCiphertext: new Uint8Array([1, 2, 3]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: accountA,
    });
    await accounts.create({
      clerkUserId: "user_setupb",
      keyCiphertext: new Uint8Array([4, 5, 6]),
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId: accountB,
    });
    const profiles = makeOnboardingProfileRepository(provider);
    for (const user of ["user_setupa", "user_setupb"]) {
      await profiles.upsertForUser({
        clerkUserId: user,
        intendedMcpClient: "not_sure",
        primaryUseCase: "exploration",
        researchCallInterest: "not_sure",
        role: "not_sure",
        updatedAt: createdAt,
        whatsappUsageContext: "personal",
      });
    }
  });

  afterEach(async () => {
    await database.close();
  });

  const startInput = (
    personalAccountId: string,
    setupId: string,
    idempotencyKey: string,
    numberToken: number,
  ) => ({
    accountKey: {
      ciphertext: "AQID",
      keyVersion: 1,
      kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      personalAccountId,
      version: 1 as const,
    },
    connectionKeyCiphertext: new Uint8Array(32).fill(numberToken),
    connectionKeyNonce: new Uint8Array(12).fill(numberToken),
    connectionKeyVersion: 1,
    createdAt,
    displayNameCiphertext: new Uint8Array(32).fill(8),
    displayNameCiphertextNonce: new Uint8Array(12).fill(9),
    displayNameCiphertextVersion: 1,
    displayNameKeyVersion: 1,
    idempotencyKey,
    numberCiphertext: new Uint8Array(32).fill(numberToken),
    numberCiphertextNonce: new Uint8Array(12).fill(numberToken),
    numberCiphertextVersion: 1,
    numberKeyVersion: 1,
    numberToken: new Uint8Array(32).fill(numberToken),
    personalAccountId,
    setupId,
  });

  test("creates one durable 15-minute setup and returns its exact replay", async () => {
    const repository = makeConnectionSetupRepository(provider);
    const prepared = await repository.prepare({
      clerkUserId: "user_setupa",
      idempotencyKey: "123456789012345678901",
      numberToken: new Uint8Array(32).fill(1),
    });
    expect(prepared).toMatchObject({
      outcome: "unbound",
      whatsappConnectionLimit: 3,
    });

    const first = await repository.start(
      startInput(
        accountA,
        "cst_000000000000000000001",
        "123456789012345678901",
        1,
      ),
    );
    const replay = await repository.start(
      startInput(
        accountA,
        "cst_000000000000000000002",
        "123456789012345678901",
        1,
      ),
    );

    expect(first).toEqual({
      outcome: "created",
      setup: {
        createdAt,
        expiresAt: "2026-07-31T12:15:00.000Z",
        setupId: "cst_000000000000000000001",
        state: "provisioning_pending",
      },
    });
    if (!("setup" in first)) {
      throw new Error("expected a created Connection Setup");
    }
    expect(replay).toMatchObject({
      outcome: "replay",
      setup: first.setup,
    });

    const persisted = await database.query<{
      expires_at: Date;
      plaintext_column_count: number;
      plaintext_in_ciphertext: boolean;
      setup_count: number;
    }>(`
      SELECT
        count(*)::integer AS setup_count,
        max(expires_at) AS expires_at,
        bool_or(position(encode(convert_to('Personal WhatsApp', 'UTF8'), 'hex') in encode(display_name_ciphertext, 'hex')) > 0) AS plaintext_in_ciphertext,
        (SELECT count(*)::integer FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'connection_setups' AND column_name = 'display_name') AS plaintext_column_count
      FROM public.connection_setups
    `);
    expect(persisted.rows[0]?.setup_count).toBe(1);
    expect(persisted.rows[0]?.expires_at).toEqual(
      new Date("2026-07-31T12:15:00.000Z"),
    );
    expect(persisted.rows[0]?.plaintext_column_count).toBe(0);
    expect(persisted.rows[0]?.plaintext_in_ciphertext).toBe(false);
  });

  test("requires a completed profile before replaying a pending first Connection Setup", async () => {
    const repository = makeConnectionSetupRepository(provider);
    await database.query(
      "DELETE FROM public.personal_account_onboarding_profiles WHERE personal_account_id = $1",
      [accountA],
    );
    await repository.start(
      startInput(
        accountA,
        "cst_000000000000000000001",
        "123456789012345678901",
        1,
      ),
    );

    await expect(
      repository.prepare({
        clerkUserId: "user_setupa",
        idempotencyKey: "123456789012345678901",
        numberToken: new Uint8Array(32).fill(1),
      }),
    ).resolves.toEqual({ outcome: "onboarding_profile_required" });
  });

  test("rejects changed input, a globally reserved number, and excess retained Connections", async () => {
    const repository = makeConnectionSetupRepository(provider);
    const first = await repository.start(
      startInput(
        accountA,
        "cst_000000000000000000001",
        "123456789012345678901",
        1,
      ),
    );
    expect(first.outcome).toBe("created");

    await expect(
      repository.start(
        startInput(
          accountA,
          "cst_000000000000000000002",
          "123456789012345678901",
          2,
        ),
      ),
    ).resolves.toEqual({ outcome: "idempotency_conflict" });
    await expect(
      repository.start(
        startInput(
          accountB,
          "cst_000000000000000000003",
          "223456789012345678901",
          1,
        ),
      ),
    ).resolves.toEqual({ outcome: "number_unavailable" });

    for (let index = 2; index <= 3; index += 1) {
      await repository.start(
        startInput(
          accountA,
          `cst_${String(index).padStart(21, "0")}`,
          `${index}23456789012345678901`,
          index,
        ),
      );
    }
    await expect(
      repository.start(
        startInput(
          accountA,
          "cst_000000000000000000004",
          "423456789012345678901",
          4,
        ),
      ),
    ).resolves.toEqual({ outcome: "connection_limit_reached" });
  });

  test("keeps setup rows isolated under the restricted API role", async () => {
    const repository = makeConnectionSetupRepository(provider);
    await repository.start(
      startInput(
        accountA,
        "cst_000000000000000000001",
        "123456789012345678901",
        1,
      ),
    );
    await repository.start(
      startInput(
        accountB,
        "cst_000000000000000000002",
        "223456789012345678901",
        2,
      ),
    );

    await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
    try {
      await database.query(
        "SELECT set_config('public.personal_account_id', $1, true)",
        [accountA],
      );
      const visible = await database.query<{ id: string }>(
        "SELECT id FROM public.connection_setups ORDER BY id",
      );
      expect(visible.rows).toEqual([{ id: "cst_000000000000000000001" }]);
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }
  });

  test("leases provisioning once and atomically quarantines encrypted duplicate sessions", async () => {
    const repository = makeConnectionSetupRepository(provider);
    await repository.start(
      startInput(
        accountA,
        "cst_000000000000000000001",
        "123456789012345678901",
        1,
      ),
    );

    const claimed = await repository.claimProvisioning({
      claimedAt: "2026-07-31T12:01:00.000Z",
      setupId: "cst_000000000000000000001",
      workerId: "cspw_0000000000000000000000000000000000000000000",
    });
    const concurrent = await repository.claimProvisioning({
      claimedAt: "2026-07-31T12:01:01.000Z",
      setupId: "cst_000000000000000000001",
      workerId: "cspw_1111111111111111111111111111111111111111111",
    });

    expect(claimed).toMatchObject({
      outcome: "claimed",
      setup: {
        accountKey: {
          keyVersion: 1,
          personalAccountId: accountA,
          version: 1,
        },
        createdAt,
        firstClaim: true,
        connectionKey: {
          connectionId: "cst_000000000000000000001",
          keyVersion: 1,
          personalAccountId: accountA,
          version: 1,
        },
        personalAccountId: accountA,
        provisioningStartedAt: "2026-07-31T12:01:00.000Z",
        setupId: "cst_000000000000000000001",
        webhookIngressId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
      },
    });
    expect(concurrent).toEqual({ outcome: "leased" });
    await expect(
      repository.renewProvisioningLease({
        observedAt: "2026-07-31T12:01:30.000Z",
        setupId: "cst_000000000000000000001",
        workerId: "cspw_0000000000000000000000000000000000000000000",
      }),
    ).resolves.toBe(true);

    const finished = await repository.finishProvisioning({
      observedAt: "2026-07-31T12:01:31.000Z",
      outcome: "quarantined",
      sessions: [1, 2].map((fill, ordinal) => ({
        authorityCiphertext: new Uint8Array(32).fill(fill),
        authorityCiphertextVersion: 1,
        authorityKeyVersion: 1,
        authorityNonce: new Uint8Array(12).fill(fill),
        locatorCiphertext: new Uint8Array(32).fill(fill + 2),
        locatorCiphertextVersion: 1,
        locatorKeyVersion: 1,
        locatorNonce: new Uint8Array(12).fill(fill + 2),
        ordinal,
      })),
      setupId: "cst_000000000000000000001",
      workerId: "cspw_0000000000000000000000000000000000000000000",
    });

    expect(finished).toBe(true);
    const persisted = await database.query<{
      provider_session_count: number;
      state: string;
    }>(`
      SELECT
        setups.state,
        count(provider_sessions.ordinal)::integer AS provider_session_count
      FROM public.connection_setups AS setups
      LEFT JOIN public.connection_setup_provider_sessions AS provider_sessions
        ON provider_sessions.personal_account_id = setups.personal_account_id
       AND provider_sessions.connection_setup_id = setups.id
      WHERE setups.id = 'cst_000000000000000000001'
      GROUP BY setups.state
    `);
    expect(persisted.rows).toEqual([
      {
        provider_session_count: 2,
        state: "provisioning_quarantined",
      },
    ]);
    await expect(
      repository.prepare({
        clerkUserId: "user_setupa",
        idempotencyKey: "123456789012345678901",
        numberToken: new Uint8Array(32).fill(1),
      }),
    ).resolves.toMatchObject({
      outcome: "replay",
      setup: { state: "provisioning_quarantined" },
    });
    await database.exec("SET ROLE whatsapp_api_runtime; BEGIN");
    try {
      await database.query(
        "SELECT set_config('public.personal_account_id', $1, true)",
        [accountB],
      );
      const crossTenant = await database.query(
        "SELECT ordinal FROM public.connection_setup_provider_sessions",
      );
      expect(crossTenant.rows).toEqual([]);
      await database.exec("ROLLBACK; SET ROLE whatsapp_api_runtime; BEGIN");
      await database.query(
        "SELECT set_config('public.personal_account_id', $1, true)",
        [accountA],
      );
      const owningTenant = await database.query<{ ordinal: number }>(
        `SELECT ordinal
         FROM public.connection_setup_provider_sessions
         ORDER BY ordinal`,
      );
      expect(owningTenant.rows).toEqual([{ ordinal: 0 }, { ordinal: 1 }]);
    } finally {
      await database.exec("ROLLBACK; RESET ROLE");
    }
    await expect(
      repository.claimProvisioning({
        claimedAt: "2026-07-31T12:02:00.000Z",
        setupId: "cst_000000000000000000001",
        workerId: "cspw_2222222222222222222222222222222222222222222",
      }),
    ).resolves.toEqual({ outcome: "not_pending" });
  });

  test("releases an ambiguous attempt for reconcile-first retry and recovers unleased intents", async () => {
    const repository = makeConnectionSetupRepository(provider);
    await repository.start(
      startInput(
        accountA,
        "cst_000000000000000000001",
        "123456789012345678901",
        1,
      ),
    );
    await repository.claimProvisioning({
      claimedAt: "2026-07-31T12:01:00.000Z",
      setupId: "cst_000000000000000000001",
      workerId: "cspw_0000000000000000000000000000000000000000000",
    });

    await expect(
      repository.releaseProvisioningLease({
        failureCode: "timed_out",
        observedAt: "2026-07-31T12:01:15.000Z",
        setupId: "cst_000000000000000000001",
        workerId: "cspw_0000000000000000000000000000000000000000000",
      }),
    ).resolves.toBe(true);
    await expect(
      repository.listProvisioningCandidates({
        limit: 100,
        observedAt: "2026-07-31T12:01:16.000Z",
      }),
    ).resolves.toEqual(["cst_000000000000000000001"]);

    const retry = await repository.claimProvisioning({
      claimedAt: "2026-07-31T12:01:16.000Z",
      setupId: "cst_000000000000000000001",
      workerId: "cspw_1111111111111111111111111111111111111111111",
    });
    expect(retry).toMatchObject({
      outcome: "claimed",
      setup: {
        firstClaim: false,
        provisioningStartedAt: "2026-07-31T12:01:00.000Z",
      },
    });
  });

  test("makes a definitive lifecycle rejection terminal and ineligible for recovery", async () => {
    const repository = makeConnectionSetupRepository(provider);
    await repository.start(
      startInput(
        accountA,
        "cst_000000000000000000001",
        "123456789012345678901",
        1,
      ),
    );
    await repository.claimProvisioning({
      claimedAt: "2026-07-31T12:01:00.000Z",
      setupId: "cst_000000000000000000001",
      workerId: "cspw_0000000000000000000000000000000000000000000",
    });

    await expect(
      repository.failProvisioning({
        failureCode: "source_rejected",
        observedAt: "2026-07-31T12:01:15.000Z",
        setupId: "cst_000000000000000000001",
        workerId: "cspw_0000000000000000000000000000000000000000000",
      }),
    ).resolves.toBe(true);
    await expect(
      repository.listProvisioningCandidates({
        limit: 100,
        observedAt: "2026-07-31T12:01:16.000Z",
      }),
    ).resolves.toEqual([]);
    await expect(
      repository.claimProvisioning({
        claimedAt: "2026-07-31T12:01:16.000Z",
        setupId: "cst_000000000000000000001",
        workerId: "cspw_1111111111111111111111111111111111111111111",
      }),
    ).resolves.toEqual({ outcome: "not_pending" });
  });

  test("cancels idempotently, waits out provisioning, and releases the number only after confirmed absence", async () => {
    const repository = makeConnectionSetupRepository(provider);
    const setupId = "cst_000000000000000000001";
    await repository.start(
      startInput(accountA, setupId, "123456789012345678901", 1),
    );
    await repository.claimProvisioning({
      claimedAt: "2026-07-31T12:01:00.000Z",
      setupId,
      workerId: "cspw_0000000000000000000000000000000000000000000",
    });

    const first = await repository.cancel({
      cancelledAt: "2026-07-31T12:01:01.000Z",
      clerkUserId: "user_setupa",
      setupId,
    });
    const replay = await repository.cancel({
      cancelledAt: "2026-07-31T12:01:02.000Z",
      clerkUserId: "user_setupa",
      setupId,
    });

    expect(first).toEqual({
      cleanupState: "pending",
      outcome: "cancelled",
      setupId,
      state: "cancelled",
    });
    expect(replay).toEqual({
      cleanupState: "pending",
      outcome: "replay",
      setupId,
      state: "cancelled",
    });
    await expect(
      repository.cancel({
        cancelledAt: "2026-07-31T12:01:03.000Z",
        clerkUserId: "user_setupb",
        setupId,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.claimCleanup({
        claimedAt: "2026-07-31T12:01:04.000Z",
        setupId,
        workerId: "cscw_0000000000000000000000000000000000000000000",
      }),
    ).resolves.toEqual({ outcome: "leased" });
    await expect(
      repository.start(
        startInput(
          accountB,
          "cst_000000000000000000002",
          "223456789012345678901",
          1,
        ),
      ),
    ).resolves.toEqual({ outcome: "number_unavailable" });

    await expect(
      repository.claimCleanup({
        claimedAt: "2026-07-31T12:03:01.000Z",
        setupId,
        workerId: "cscw_0000000000000000000000000000000000000000000",
      }),
    ).resolves.toEqual({ outcome: "claimed" });
    await expect(
      repository.releaseCleanupLease({
        failureCode: "timed_out",
        observedAt: "2026-07-31T12:03:02.000Z",
        setupId,
        workerId: "cscw_0000000000000000000000000000000000000000000",
      }),
    ).resolves.toBe(true);
    await expect(
      repository.cancel({
        cancelledAt: "2026-07-31T12:03:03.000Z",
        clerkUserId: "user_setupa",
        setupId,
      }),
    ).resolves.toMatchObject({
      cleanupState: "retrying",
      outcome: "replay",
      state: "cancelled",
    });
    await expect(
      repository.claimCleanup({
        claimedAt: "2026-07-31T12:03:04.000Z",
        setupId,
        workerId: "cscw_1111111111111111111111111111111111111111111",
      }),
    ).resolves.toEqual({ outcome: "claimed" });
    await expect(
      repository.finishCleanup({
        observedAt: "2026-07-31T12:03:05.000Z",
        setupId,
        workerId: "cscw_1111111111111111111111111111111111111111111",
      }),
    ).resolves.toBe(true);

    const replacement = await repository.start(
      startInput(
        accountB,
        "cst_000000000000000000002",
        "223456789012345678901",
        1,
      ),
    );
    expect(replacement.outcome).toBe("created");
    await expect(
      repository.cancel({
        cancelledAt: "2026-07-31T12:03:06.000Z",
        clerkUserId: "user_setupa",
        setupId,
      }),
    ).resolves.toEqual({
      cleanupState: "complete",
      outcome: "replay",
      setupId,
      state: "cancelled",
    });

    const sensitiveRows = await database.query<{
      key_count: number;
      provider_session_count: number;
      released_at: Date | null;
    }>(
      `SELECT
         reservations.released_at,
         (
           SELECT count(*)::integer
           FROM public.connection_setup_key_envelopes
           WHERE connection_setup_id = $1
         ) AS key_count,
         (
           SELECT count(*)::integer
           FROM public.connection_setup_provider_sessions
           WHERE connection_setup_id = $1
         ) AS provider_session_count
       FROM public.whatsapp_number_reservations AS reservations
       WHERE reservations.connection_setup_id = $1`,
      [setupId],
    );
    expect(sensitiveRows.rows).toEqual([
      {
        key_count: 0,
        provider_session_count: 0,
        released_at: new Date("2026-07-31T12:03:05.000Z"),
      },
    ]);
  });

  test("expires incomplete setups exactly at 15 minutes and recovers cleanup work", async () => {
    const repository = makeConnectionSetupRepository(provider);
    const setupId = "cst_000000000000000000001";
    await repository.start(
      startInput(accountA, setupId, "123456789012345678901", 1),
    );

    await expect(
      repository.expire({
        limit: 100,
        observedAt: "2026-07-31T12:14:59.999Z",
      }),
    ).resolves.toEqual([]);
    await expect(
      repository.expire({
        limit: 100,
        observedAt: "2026-07-31T12:15:00.000Z",
      }),
    ).resolves.toEqual([setupId]);
    await expect(
      repository.claimProvisioning({
        claimedAt: "2026-07-31T12:15:01.000Z",
        setupId,
        workerId: "cspw_0000000000000000000000000000000000000000000",
      }),
    ).resolves.toEqual({ outcome: "not_pending" });
    await expect(
      repository.listCleanupCandidates({
        limit: 100,
        observedAt: "2026-07-31T12:15:01.000Z",
      }),
    ).resolves.toEqual([setupId]);

    const persisted = await database.query<{
      cleanup_state: string;
      state: string;
    }>(
      `SELECT state, cleanup_state
       FROM public.connection_setups
       WHERE id = $1`,
      [setupId],
    );
    expect(persisted.rows).toEqual([
      { cleanup_state: "pending", state: "expired" },
    ]);
  });
});
