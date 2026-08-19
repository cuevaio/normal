import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { makeApiKeyRepository } from "../src/api-key";
import {
  type ConnectionSetupConnectionProvider,
  makeConnectionSetupRepository,
} from "../src/connection-setup";
import { makeMcpAuthorizationRepository } from "../src/mcp-authorization";
import { makeMcpToolRepository } from "../src/mcp-tool";
import { runMigrations } from "../src/migrations";
import {
  makePersonalAccountRepository,
  type PersonalAccountConnectionProvider,
} from "../src/personal-account";
import {
  makeWhatsAppConnectionRepository,
  type WhatsAppConnectionConnectionProvider,
} from "../src/whatsapp-connection";

const accountA = "10000000-0000-4000-8000-000000000031";
const accountB = "10000000-0000-4000-8000-000000000032";
const setupId = "cst_000000000000000000031";
const connectionId = "20000000-0000-4000-8000-000000000031";
const publicId = "con_000000000000000000031";
const createdAt = "2026-07-31T12:00:00.000Z";
const connectedAt = "2026-07-31T12:04:00.000Z";

describe("WhatsApp Connection repository", () => {
  let database: PGlite;
  let provider: ConnectionSetupConnectionProvider &
    PersonalAccountConnectionProvider &
    WhatsAppConnectionConnectionProvider;

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
    for (const [accountId, clerkUserId, fill] of [
      [accountA, "user_connectiona", 1],
      [accountB, "user_connectionb", 2],
    ] as const) {
      const account = await accounts.create({
        clerkUserId,
        keyCiphertext: new Uint8Array([fill, fill + 1, fill + 2]),
        keyVersion: 1,
        kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
        personalAccountId: accountId,
      });
      expect(account).toMatchObject({
        admissionState: "active",
        personalAccountId: accountId,
      });
    }

    const setups = makeConnectionSetupRepository(provider);
    await setups.start({
      accountKey: {
        ciphertext: "AQID",
        keyVersion: 1,
        kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
        personalAccountId: accountA,
        version: 1,
      },
      connectionKeyCiphertext: new Uint8Array(32).fill(3),
      connectionKeyNonce: new Uint8Array(12).fill(4),
      connectionKeyVersion: 1,
      createdAt,
      displayNameCiphertext: new Uint8Array(32).fill(20),
      displayNameCiphertextNonce: new Uint8Array(12).fill(21),
      displayNameCiphertextVersion: 1,
      displayNameKeyVersion: 1,
      idempotencyKey: "123456789012345678931",
      numberCiphertext: new Uint8Array(32).fill(5),
      numberCiphertextNonce: new Uint8Array(12).fill(6),
      numberCiphertextVersion: 1,
      numberKeyVersion: 1,
      numberToken: new Uint8Array(32).fill(7),
      personalAccountId: accountA,
      setupId,
    });
    await database.query(
      `UPDATE public.connection_setups
       SET webhook_ingress_id = $1
       WHERE id = $2`,
      ["30000000-0000-4000-8000-000000000031", setupId],
    );
    await setups.claimProvisioning({
      claimedAt: "2026-07-31T12:01:00.000Z",
      setupId,
      workerId: "cspw_0000000000000000000000000000000000000000031",
    });
    await setups.finishProvisioning({
      observedAt: "2026-07-31T12:01:01.000Z",
      outcome: "provisioned",
      sessions: [
        {
          authorityCiphertext: new Uint8Array(32).fill(8),
          authorityCiphertextVersion: 1,
          authorityKeyVersion: 1,
          authorityNonce: new Uint8Array(12).fill(9),
          locatorCiphertext: new Uint8Array(32).fill(10),
          locatorCiphertextVersion: 1,
          locatorKeyVersion: 1,
          locatorNonce: new Uint8Array(12).fill(11),
          ordinal: 0,
        },
      ],
      setupId,
      workerId: "cspw_0000000000000000000000000000000000000000031",
    });
  });

  afterEach(async () => {
    await database.close();
  });

  const activationInput = {
    accountKeyVersion: 1,
    authorityCiphertext: new Uint8Array(32).fill(12),
    authorityCiphertextVersion: 1,
    authorityKeyVersion: 1,
    authorityNonce: new Uint8Array(12).fill(13),
    connectionId,
    connectionKeyCiphertext: new Uint8Array(32).fill(14),
    connectionKeyNonce: new Uint8Array(12).fill(15),
    connectionKeyVersion: 1,
    connectedAt,
    displayNameCiphertext: new Uint8Array(32).fill(20),
    displayNameCiphertextVersion: 1,
    displayNameKeyVersion: 1,
    displayNameNonce: new Uint8Array(12).fill(21),
    locatorCiphertext: new Uint8Array(32).fill(16),
    locatorCiphertextVersion: 1,
    locatorKeyVersion: 1,
    locatorNonce: new Uint8Array(12).fill(17),
    messageSearchKeyCiphertext: new Uint8Array(48).fill(22),
    messageSearchKeyCiphertextVersion: 1,
    messageSearchKeyVersion: 1,
    messageSearchKeyNonce: new Uint8Array(12).fill(23),
    numberSuffix: "3456",
    personalAccountId: accountA,
    publicId,
    setupId,
    webhookIngressId: "30000000-0000-4000-8000-000000000031",
    webhookSecretCiphertext: new Uint8Array(48).fill(18),
    webhookSecretCiphertextVersion: 1,
    webhookSecretKeyVersion: 1,
    webhookSecretNonce: new Uint8Array(12).fill(19),
  } as const;

  test("loads activation material only for the owning signed-in User", async () => {
    const repository = makeWhatsAppConnectionRepository(provider);

    const owned = await repository.loadSetupForActivation({
      clerkUserId: "user_connectiona",
      observedAt: connectedAt,
      setupId,
    });
    const otherTenant = await repository.loadSetupForActivation({
      clerkUserId: "user_connectionb",
      observedAt: connectedAt,
      setupId,
    });

    expect(owned).toMatchObject({
      outcome: "provisioned",
      setup: {
        accountKey: {
          personalAccountId: accountA,
          version: 1,
        },
        personalAccountId: accountA,
        setupId,
        setupKey: {
          connectionId: setupId,
          personalAccountId: accountA,
          version: 1,
        },
        webhookIngressId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
      },
    });
    expect(otherTenant).toBeNull();
  });

  test("does not load or activate an incomplete Setup at its expiry", async () => {
    const repository = makeWhatsAppConnectionRepository(provider);
    const expiresAt = "2026-07-31T12:15:00.000Z";

    await expect(
      repository.loadSetupForActivation({
        clerkUserId: "user_connectiona",
        observedAt: expiresAt,
        setupId,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.activate({
        ...activationInput,
        connectedAt: expiresAt,
      }),
    ).rejects.toThrow();

    const counts = await database.query<{ connection_count: number }>(`
      SELECT count(*)::integer AS connection_count
      FROM public.whatsapp_connections
    `);
    expect(counts.rows).toEqual([{ connection_count: 0 }]);
  });

  test("atomically activates exactly one Connection and returns the idempotent winner", async () => {
    const repository = makeWhatsAppConnectionRepository(provider);

    const first = await repository.activate(activationInput);
    const storedSearchKey = await database.query<Record<string, unknown>>(
      `SELECT message_search_key_ciphertext_version, message_search_key_version,
        octet_length(message_search_key_nonce) AS nonce_bytes,
        octet_length(message_search_key_ciphertext) AS ciphertext_bytes
       FROM public.whatsapp_connection_secrets
       WHERE personal_account_id=$1 AND whatsapp_connection_id=$2`,
      [accountA, connectionId],
    );
    expect(storedSearchKey.rows).toEqual([
      {
        ciphertext_bytes: 48,
        message_search_key_ciphertext_version: 1,
        message_search_key_version: 1,
        nonce_bytes: 12,
      },
    ]);
    const searchCoverage = await database.query<Record<string, unknown>>(
      `SELECT state, searchable_from
       FROM public.message_search_backfill_coverage
       WHERE personal_account_id=$1 AND whatsapp_connection_id=$2`,
      [accountA, connectionId],
    );
    expect(searchCoverage.rows).toEqual([
      {
        searchable_from: new Date(connectedAt),
        state: "complete",
      },
    ]);
    await database.query(
      `DELETE FROM public.message_search_backfill_coverage
       WHERE personal_account_id=$1 AND whatsapp_connection_id=$2`,
      [accountA, connectionId],
    );
    const replay = await repository.activate({
      ...activationInput,
      connectionKeyCiphertext: new Uint8Array(32).fill(26),
      connectionKeyNonce: new Uint8Array(12).fill(27),
      connectionId: "20000000-0000-4000-8000-000000000099",
      displayNameCiphertext: new Uint8Array(32).fill(28),
      displayNameNonce: new Uint8Array(12).fill(29),
      publicId: "con_000000000000000000099",
      webhookIngressId: "30000000-0000-4000-8000-000000000099",
    });

    expect(first).toMatchObject({
      displayName: { fallback: null },
      numberSuffix: "3456",
      publicId,
      state: "connected",
      stateChangedAt: connectedAt,
    });
    expect(replay).toEqual(first);
    const replayCoverage = await database.query<Record<string, unknown>>(
      `SELECT whatsapp_connection_id, state
       FROM public.message_search_backfill_coverage
       WHERE personal_account_id=$1`,
      [accountA],
    );
    expect(replayCoverage.rows).toEqual([
      {
        state: "complete",
        whatsapp_connection_id: connectionId,
      },
    ]);

    const counts = await database.query<{
      connection_count: number;
      connection_key_count: number;
      provider_session_count: number;
      setup_state: string;
      webhook_secret_count: number;
    }>(`
      SELECT
        (SELECT count(*)::integer FROM public.whatsapp_connections)
          AS connection_count,
        (SELECT count(*)::integer FROM public.whatsapp_connection_key_envelopes)
          AS connection_key_count,
        (SELECT count(*)::integer FROM public.whatsapp_connection_provider_sessions)
          AS provider_session_count,
        (SELECT state FROM public.connection_setups WHERE id = '${setupId}')
          AS setup_state,
        (SELECT count(*)::integer FROM public.whatsapp_connection_secrets)
          AS webhook_secret_count
    `);
    expect(counts.rows).toEqual([
      {
        connection_count: 1,
        connection_key_count: 1,
        provider_session_count: 1,
        setup_state: "activated",
        webhook_secret_count: 1,
      },
    ]);
  });

  test("fails activation closed, retains the number reservation, and allows retry only after cleanup completes", async () => {
    const connections = makeWhatsAppConnectionRepository(provider);
    const setups = makeConnectionSetupRepository(provider);

    await expect(
      connections.failSetupActivation({
        failureCode: "scanned_number_mismatch",
        observedAt: connectedAt,
        personalAccountId: accountA,
        setupId,
      }),
    ).resolves.toBe(true);
    await expect(
      connections.loadSetupForActivation({
        clerkUserId: "user_connectiona",
        observedAt: connectedAt,
        setupId,
      }),
    ).resolves.toEqual({
      failureCode: "scanned_number_mismatch",
      outcome: "provisioning_failed",
    });

    const retained = await database.query<{
      cleanup_state: string;
      connection_count: number;
      reservation_count: number;
      setup_state: string;
    }>(
      `
      SELECT
        (SELECT cleanup_state FROM public.connection_setups WHERE id = $1) AS cleanup_state,
        (SELECT count(*)::integer FROM public.whatsapp_connections) AS connection_count,
        (SELECT count(*)::integer FROM public.whatsapp_number_reservations WHERE released_at IS NULL) AS reservation_count,
        (SELECT state FROM public.connection_setups WHERE id = $1) AS setup_state
    `,
      [setupId],
    );
    expect(retained.rows).toEqual([
      {
        cleanup_state: "pending",
        connection_count: 0,
        reservation_count: 1,
        setup_state: "provisioning_failed",
      },
    ]);

    await expect(
      setups.claimCleanup({
        claimedAt: "2026-07-31T12:04:30.000Z",
        setupId,
        workerId: "cscw_0000000000000000000000000000000000000000031",
      }),
    ).resolves.toEqual({ outcome: "claimed" });
    await expect(
      setups.renewCleanupLease({
        observedAt: "2026-07-31T12:04:30.500Z",
        setupId,
        workerId: "cscw_0000000000000000000000000000000000000000031",
      }),
    ).resolves.toBe(true);
    await expect(
      setups.releaseCleanupLease({
        failureCode: "timed_out",
        observedAt: "2026-07-31T12:04:31.000Z",
        setupId,
        workerId: "cscw_0000000000000000000000000000000000000000031",
      }),
    ).resolves.toBe(true);
    await expect(
      setups.claimCleanup({
        claimedAt: "2026-07-31T12:04:31.500Z",
        setupId,
        workerId: "cscw_0000000000000000000000000000000000000000032",
      }),
    ).resolves.toEqual({ outcome: "claimed" });
    await expect(
      setups.finishCleanup({
        observedAt: "2026-07-31T12:04:32.000Z",
        setupId,
        workerId: "cscw_0000000000000000000000000000000000000000032",
      }),
    ).resolves.toBe(true);

    await expect(
      setups.start({
        accountKey: {
          ciphertext: "AQID",
          keyVersion: 1,
          kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
          personalAccountId: accountA,
          version: 1,
        },
        connectionKeyCiphertext: new Uint8Array(32).fill(30),
        connectionKeyNonce: new Uint8Array(12).fill(31),
        connectionKeyVersion: 1,
        createdAt: "2026-07-31T12:05:00.000Z",
        displayNameCiphertext: new Uint8Array(32).fill(32),
        displayNameCiphertextNonce: new Uint8Array(12).fill(33),
        displayNameCiphertextVersion: 1,
        displayNameKeyVersion: 1,
        idempotencyKey: "123456789012345678932",
        numberCiphertext: new Uint8Array(32).fill(34),
        numberCiphertextNonce: new Uint8Array(12).fill(35),
        numberCiphertextVersion: 1,
        numberKeyVersion: 1,
        numberToken: new Uint8Array(32).fill(7),
        personalAccountId: accountA,
        setupId: "cst_000000000000000000099",
      }),
    ).resolves.toMatchObject({
      outcome: "created",
      setup: { state: "provisioning_pending" },
    });
  });

  test("rejects activation when the ingress does not belong to the Setup", async () => {
    const repository = makeWhatsAppConnectionRepository(provider);

    await expect(
      repository.activate({
        ...activationInput,
        webhookIngressId: "30000000-0000-4000-8000-000000000099",
      }),
    ).rejects.toThrow();

    const counts = await database.query<{ connection_count: number }>(`
      SELECT count(*)::integer AS connection_count
      FROM public.whatsapp_connections
    `);
    expect(counts.rows).toEqual([{ connection_count: 0 }]);
  });

  test("lists only safe normalized fields under the restricted tenant role", async () => {
    const repository = makeWhatsAppConnectionRepository(provider);
    await repository.activate(activationInput);

    await expect(
      repository.listForUser("user_connectiona"),
    ).resolves.toMatchObject([
      {
        displayName: { fallback: null },
        numberSuffix: "3456",
        publicId,
        state: "connected",
        stateChangedAt: connectedAt,
      },
    ]);
    await expect(repository.listForUser("user_connectionb")).resolves.toEqual(
      [],
    );

    const qrColumns = await database.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM information_schema.columns
      WHERE table_schema IN ('public', 'public')
        AND column_name ILIKE '%qr%'
    `);
    expect(qrColumns.rows).toEqual([{ count: 0 }]);
  });

  test("renames only the owning User's non-deleting Connection", async () => {
    const repository = makeWhatsAppConnectionRepository(provider);
    await repository.activate(activationInput);

    await expect(
      repository.rename({
        clerkUserId: "user_connectionb",
        displayNameCiphertext: new Uint8Array(32).fill(22),
        displayNameCiphertextVersion: 1,
        displayNameKeyVersion: 1,
        displayNameNonce: new Uint8Array(12).fill(23),
        publicId,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.rename({
        clerkUserId: "user_connectiona",
        displayNameCiphertext: new Uint8Array(32).fill(24),
        displayNameCiphertextVersion: 1,
        displayNameKeyVersion: 1,
        displayNameNonce: new Uint8Array(12).fill(25),
        publicId,
      }),
    ).resolves.toMatchObject({
      displayName: { fallback: null },
      numberSuffix: "3456",
      publicId,
      state: "connected",
      stateChangedAt: connectedAt,
    });
    await expect(
      repository.listForUser("user_connectiona"),
    ).resolves.toMatchObject([{ displayName: { fallback: null }, publicId }]);
  });

  test("makes Connection Deletion terminal and revokes keys and inventory atomically", async () => {
    const repository = makeWhatsAppConnectionRepository(provider);
    await repository.activate(activationInput);
    const authorizationId = "40000000-0000-4000-8000-000000000031";
    const oauthSubject = "A".repeat(43);
    const refreshCredentialHash = new Uint8Array(32).fill(30);
    const authorizations = makeMcpAuthorizationRepository(provider);
    expect(
      await authorizations.create({
        authorizationId,
        authorizedAt: new Date("2026-07-31T12:05:00.000Z"),
        clientClass: "approved",
        clientId: "approved-client",
        clientName: "Approved MCP Client",
        clerkUserId: "user_connectiona",
        connectionIds: [publicId],
        expiresAt: new Date("2026-10-29T12:05:00.000Z"),
        oauthSubject,
        reverifiedAt: new Date("2026-07-31T12:04:30.000Z"),
        scopes: ["connections:read", "messages:send"],
      }),
    ).toBe(true);
    expect(
      await authorizations.registerRefreshCredential({
        clientId: "approved-client",
        credentialHash: refreshCredentialHash,
        oauthSubject,
        observedAt: new Date("2026-07-31T12:05:01.000Z"),
      }),
    ).toBe(true);
    const apiKeyPublicId = "apk_000000000000000000031";
    const apiKeyDigest = new Uint8Array(32).fill(31);
    expect(
      await makeApiKeyRepository(provider).create({
        clerkUserId: "user_connectiona",
        connectionIds: [publicId],
        createdAt: new Date("2026-07-31T12:05:00.000Z"),
        credentialDigest: apiKeyDigest,
        credentialHint: `normal_${apiKeyPublicId}.…wxyz`,
        expiresAt: null,
        id: "50000000-0000-4000-8000-000000000031",
        name: "Lifecycle",
        permissions: ["connections:read"],
        publicId: apiKeyPublicId,
        reverifiedAt: new Date("2026-07-31T12:04:30.000Z"),
      }),
    ).toMatchObject({ outcome: "created" });

    const prepared = await repository.prepareDeletion({
      clerkUserId: "user_connectiona",
      publicId,
    });
    expect(prepared).toMatchObject({
      outcome: "prepared",
      connectionId,
      personalAccountId: accountA,
      providerLocator: { keyVersion: 1, version: 1 },
    });

    const deleted = await repository.finishDeletion({
      clerkUserId: "user_connectiona",
      deletionMarkerId: "a".repeat(64),
      publicId,
      requestedAt: "2026-07-31T12:08:00.000Z",
    });
    expect(deleted).toEqual({
      deletionMarkerId: "a".repeat(64),
      publicId,
      requestedAt: "2026-07-31T12:08:00.000Z",
    });
    await expect(repository.listForUser("user_connectiona")).resolves.toEqual(
      [],
    );
    await expect(
      repository.claimLifecycle({
        action: "reconnect",
        claimId: "70000000-0000-4000-8000-000000000031",
        clerkUserId: "user_connectiona",
        publicId,
        requestedAt: "2026-07-31T12:08:01.000Z",
      }),
    ).resolves.toBeNull();
    await expect(
      repository.prepareDeletion({ clerkUserId: "user_connectiona", publicId }),
    ).resolves.toEqual({
      deletionMarkerId: "a".repeat(64),
      outcome: "complete",
      publicId,
      requestedAt: "2026-07-31T12:08:00.000Z",
    });

    const state = await database.query<{
      api_key_digest: Uint8Array | null;
      api_key_grant_count: number;
      api_key_state: string;
      grant_count: number;
      key_ciphertext: Uint8Array | null;
      key_unavailable_at: Date | null;
      state: string;
    }>(`SELECT connections.state,
          keys.ciphertext AS key_ciphertext,
          keys.unavailable_at AS key_unavailable_at,
          (SELECT count(*)::integer FROM public.mcp_authorization_connections
           WHERE whatsapp_connection_id = connections.id) AS grant_count,
          (SELECT count(*)::integer FROM public.api_key_connections
           WHERE whatsapp_connection_id = connections.id) AS api_key_grant_count,
          api_keys.state AS api_key_state,
          api_keys.credential_digest AS api_key_digest
        FROM public.whatsapp_connections connections
        JOIN public.whatsapp_connection_key_envelopes keys
          ON keys.whatsapp_connection_id = connections.id
        JOIN public.api_keys api_keys
          ON api_keys.personal_account_id = connections.personal_account_id
        WHERE connections.id = '${connectionId}'`);
    expect(state.rows[0]).toMatchObject({
      api_key_digest: null,
      api_key_grant_count: 0,
      api_key_state: "revoked",
      grant_count: 0,
      key_ciphertext: null,
      state: "deleting",
    });
    expect(state.rows[0]?.key_unavailable_at).not.toBeNull();

    await expect(
      authorizations.isActive({
        authorizationId,
        clientId: "approved-client",
        observedAt: new Date("2026-07-31T12:08:01.000Z"),
        oauthSubject,
      }),
    ).resolves.toBe(false);
    let refreshIssueCount = 0;
    await expect(
      authorizations.rotateRefreshCredential(
        {
          clientId: "approved-client",
          credentialHash: refreshCredentialHash,
          oauthSubject,
          observedAt: new Date("2026-07-31T12:08:01.000Z"),
        },
        async () => {
          refreshIssueCount += 1;
          return {
            credentialHash: new Uint8Array(32).fill(32),
            value: "must-not-be-issued",
          };
        },
      ),
    ).resolves.toEqual({ outcome: "invalid" });
    expect(refreshIssueCount).toBe(0);
    await expect(
      makeMcpToolRepository(provider).listConnections({
        authorizationId,
        clientId: "approved-client",
        observedAt: new Date("2026-07-31T12:08:01.000Z"),
        oauthSubject,
      }),
    ).resolves.toEqual([]);
    await expect(
      makeApiKeyRepository(provider).authenticate({
        digest: apiKeyDigest,
        publicId: apiKeyPublicId,
      }),
    ).resolves.toBeNull();
  });

  test("purges a provider-absent Connection and permanently reserves its public handle", async () => {
    const repository = makeWhatsAppConnectionRepository(provider);
    const deletionRepository = makeWhatsAppConnectionRepository({
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_deletion_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    });
    await repository.activate(activationInput);
    await repository.finishDeletion({
      clerkUserId: "user_connectiona",
      deletionMarkerId: "b".repeat(64),
      publicId,
      requestedAt: "2026-07-31T12:08:00.000Z",
    });
    await database.exec("SET ROLE whatsapp_deletion_runtime");
    try {
      await expect(
        database.query("SELECT * FROM public.whatsapp_connections"),
      ).rejects.toThrow();
    } finally {
      await database.exec("RESET ROLE");
    }
    const webhookEventId = "50000000-0000-4000-8000-000000000031";
    await database.query(
      `INSERT INTO public.webhook_events(
         personal_account_id,whatsapp_connection_id,id,ciphertext_sha256,
         payload_bytes,received_at,source_expires_at
       ) VALUES ($1,$2,$3,$4,1,$5::timestamptz,$5::timestamptz + interval '7 days')`,
      [accountA, connectionId, webhookEventId, "c".repeat(64), connectedAt],
    );

    await expect(
      deletionRepository.listDeletionCandidates({
        limit: 10,
        observedAt: "2026-08-01T11:08:00.000Z",
      }),
    ).resolves.toEqual([
      {
        deadlineAt: "2026-08-01T12:08:00.000Z",
        deadlineRisk: true,
        deletionMarkerId: "b".repeat(64),
        requestedAt: "2026-07-31T12:08:00.000Z",
      },
    ]);

    await expect(
      deletionRepository.confirmProviderAbsence({
        confirmedAt: "2026-07-31T12:09:00.000Z",
        deletionMarkerId: "b".repeat(64),
      }),
    ).resolves.toBe(true);
    await expect(
      repository.listDeletionPurgeCandidates({
        limit: 10,
        observedAt: "2026-08-01T11:08:00.000Z",
      }),
    ).resolves.toEqual([
      {
        deadlineAt: "2026-08-01T12:08:00.000Z",
        deadlineRisk: true,
        deletionMarkerId: "b".repeat(64),
        requestedAt: "2026-07-31T12:08:00.000Z",
      },
    ]);
    await expect(
      deletionRepository.listDeletionCandidates({
        limit: 10,
        observedAt: "2026-08-01T11:08:00.000Z",
      }),
    ).resolves.toHaveLength(1);

    await expect(
      repository.prepareDeletionCleanup({
        deletionMarkerId: "b".repeat(64),
        limit: 100,
        requestedAt: "2026-07-31T12:09:00.000Z",
      }),
    ).resolves.toEqual({
      personalAccountId: accountA,
      storedMediaObjectKeys: [],
      webhookSourceObjectKeys: [`webhook-events/${webhookEventId}`],
    });

    await expect(
      repository.finishDeletionCleanup({
        deletionMarkerId: "b".repeat(64),
        providerAbsenceConfirmedAt: "2026-07-31T12:09:00.000Z",
      }),
    ).resolves.toBe(false);
    await expect(
      repository.finishWebhookSourceDeletion({
        deletionMarkerId: "b".repeat(64),
        objectKey: `webhook-events/${webhookEventId}`,
      }),
    ).resolves.toBe(true);

    await expect(
      repository.finishDeletionCleanup({
        deletionMarkerId: "b".repeat(64),
        providerAbsenceConfirmedAt: "2026-07-31T12:09:00.000Z",
      }),
    ).resolves.toBe(true);
    await expect(
      repository.finishDeletionCleanup({
        deletionMarkerId: "b".repeat(64),
        providerAbsenceConfirmedAt: "2026-07-31T12:10:00.000Z",
      }),
    ).resolves.toBe(true);

    const counts = await database.query<{
      connection_count: number;
      reservation_count: number;
      tombstone_count: number;
    }>(`SELECT
      (SELECT count(*)::integer FROM public.whatsapp_connections) AS connection_count,
      (SELECT count(*)::integer FROM public.whatsapp_number_reservations) AS reservation_count,
      (SELECT count(*)::integer FROM public.deleted_whatsapp_connection_handles) AS tombstone_count`);
    expect(counts.rows).toEqual([
      { connection_count: 0, reservation_count: 0, tombstone_count: 1 },
    ]);

    await expect(repository.activate(activationInput)).rejects.toThrow();
    await expect(
      deletionRepository.listDeletionCandidates({
        limit: 10,
        observedAt: "2026-08-01T11:08:00.000Z",
      }),
    ).resolves.toEqual([]);
  });

  test("serializes disconnect and reconnect claims while preserving retained identity", async () => {
    const repository = makeWhatsAppConnectionRepository(provider);
    await repository.activate(activationInput);

    const disconnect = await repository.claimLifecycle({
      action: "disconnect",
      claimId: "40000000-0000-4000-8000-000000000031",
      clerkUserId: "user_connectiona",
      publicId,
      requestedAt: "2026-07-31T12:05:00.000Z",
    });
    const concurrent = await repository.claimLifecycle({
      action: "disconnect",
      claimId: "40000000-0000-4000-8000-000000000032",
      clerkUserId: "user_connectiona",
      publicId,
      requestedAt: "2026-07-31T12:05:01.000Z",
    });

    expect(disconnect).toMatchObject({
      action: "disconnect",
      connection: {
        displayName: { fallback: null },
        numberSuffix: "3456",
        publicId,
        state: "degraded",
        stateChangedAt: "2026-07-31T12:05:00.000Z",
      },
      outcome: "claimed",
      setupMarker: setupId,
    });
    if (disconnect?.outcome !== "claimed") {
      throw new Error("expected claimed disconnect lifecycle");
    }
    expect(concurrent).toEqual({
      connection: disconnect.connection,
      outcome: "in_progress",
    });
    await expect(
      repository.finishLifecycle({
        claimId: "40000000-0000-4000-8000-000000000032",
        clerkUserId: "user_connectiona",
        observedAt: "2026-07-31T12:05:02.000Z",
        publicId,
        state: "connected",
      }),
    ).resolves.toBeNull();

    const disconnected = await repository.finishLifecycle({
      claimId: "40000000-0000-4000-8000-000000000031",
      clerkUserId: "user_connectiona",
      observedAt: "2026-07-31T12:05:03.000Z",
      publicId,
      state: "disconnected",
    });
    expect(disconnected).toMatchObject({
      publicId,
      state: "disconnected",
      stateChangedAt: "2026-07-31T12:05:03.000Z",
    });

    const replay = await repository.claimLifecycle({
      action: "disconnect",
      claimId: "40000000-0000-4000-8000-000000000033",
      clerkUserId: "user_connectiona",
      publicId,
      requestedAt: "2026-07-31T12:05:04.000Z",
    });
    expect(replay).toMatchObject({
      connection: { publicId, state: "disconnected" },
      outcome: "complete",
    });

    const reconnect = await repository.claimLifecycle({
      action: "reconnect",
      claimId: "40000000-0000-4000-8000-000000000034",
      clerkUserId: "user_connectiona",
      publicId,
      requestedAt: "2026-07-31T12:05:05.000Z",
    });
    expect(reconnect).toMatchObject({
      action: "reconnect",
      connection: {
        publicId,
        state: "connecting",
        stateChangedAt: "2026-07-31T12:05:05.000Z",
      },
      outcome: "claimed",
      setupMarker: setupId,
    });

    const reconnected = await repository.finishLifecycle({
      claimId: "40000000-0000-4000-8000-000000000034",
      clerkUserId: "user_connectiona",
      observedAt: "2026-07-31T12:05:06.000Z",
      publicId,
      state: "connected",
    });
    expect(reconnected).toMatchObject({
      numberSuffix: "3456",
      publicId,
      state: "connected",
    });

    const retained = await database.query<{
      connection_count: number;
      reservation_count: number;
      setup_count: number;
    }>(`
      SELECT
        (SELECT count(*)::integer FROM public.whatsapp_connections)
          AS connection_count,
        (SELECT count(*)::integer FROM public.whatsapp_number_reservations)
          AS reservation_count,
        (SELECT count(*)::integer FROM public.connection_setups)
          AS setup_count
    `);
    expect(retained.rows).toEqual([
      {
        connection_count: 1,
        reservation_count: 1,
        setup_count: 1,
      },
    ]);
  });

  test("keeps lifecycle claims tenant scoped and rejects stale completion regression", async () => {
    const repository = makeWhatsAppConnectionRepository(provider);
    await repository.activate(activationInput);

    await expect(
      repository.claimLifecycle({
        action: "disconnect",
        claimId: "40000000-0000-4000-8000-000000000035",
        clerkUserId: "user_connectionb",
        publicId,
        requestedAt: "2026-07-31T12:06:00.000Z",
      }),
    ).resolves.toBeNull();

    await repository.claimLifecycle({
      action: "disconnect",
      claimId: "40000000-0000-4000-8000-000000000036",
      clerkUserId: "user_connectiona",
      publicId,
      requestedAt: "2026-07-31T12:06:00.000Z",
    });
    await expect(
      repository.finishLifecycle({
        claimId: "40000000-0000-4000-8000-000000000036",
        clerkUserId: "user_connectiona",
        observedAt: "2026-07-31T12:05:59.000Z",
        publicId,
        state: "disconnected",
      }),
    ).resolves.toBeNull();
    await expect(repository.listForUser("user_connectiona")).resolves.toEqual([
      expect.objectContaining({
        publicId,
        state: "degraded",
        stateChangedAt: "2026-07-31T12:06:00.000Z",
      }),
    ]);
  });

  test("does not regress the state-change time when a later claim has an older timestamp", async () => {
    const repository = makeWhatsAppConnectionRepository(provider);
    await repository.activate(activationInput);

    await repository.claimLifecycle({
      action: "disconnect",
      claimId: "40000000-0000-4000-8000-000000000037",
      clerkUserId: "user_connectiona",
      publicId,
      requestedAt: "2026-07-31T12:07:00.000Z",
    });
    await repository.finishLifecycle({
      claimId: "40000000-0000-4000-8000-000000000037",
      clerkUserId: "user_connectiona",
      observedAt: "2026-07-31T12:07:01.000Z",
      publicId,
      state: "disconnected",
    });

    const reconnect = await repository.claimLifecycle({
      action: "reconnect",
      claimId: "40000000-0000-4000-8000-000000000038",
      clerkUserId: "user_connectiona",
      publicId,
      requestedAt: "2026-07-31T12:06:59.000Z",
    });

    expect(reconnect).toMatchObject({
      action: "reconnect",
      connection: {
        publicId,
        state: "connecting",
        stateChangedAt: "2026-07-31T12:07:01.000Z",
      },
      outcome: "claimed",
    });
  });

  test("counts an activated Setup and its Connection as one retained slot", async () => {
    const connections = makeWhatsAppConnectionRepository(provider);
    const setups = makeConnectionSetupRepository(provider);
    await connections.activate(activationInput);

    for (const [index, token] of [
      [32, 20],
      [33, 21],
    ] as const) {
      await expect(
        setups.start({
          accountKey: {
            ciphertext: "AQID",
            keyVersion: 1,
            kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
            personalAccountId: accountA,
            version: 1,
          },
          connectionKeyCiphertext: new Uint8Array(32).fill(token),
          connectionKeyNonce: new Uint8Array(12).fill(token),
          connectionKeyVersion: 1,
          createdAt,
          displayNameCiphertext: new Uint8Array(32).fill(token + 2),
          displayNameCiphertextNonce: new Uint8Array(12).fill(token + 3),
          displayNameCiphertextVersion: 1,
          displayNameKeyVersion: 1,
          idempotencyKey: `${index}3456789012345678931`,
          numberCiphertext: new Uint8Array(32).fill(token),
          numberCiphertextNonce: new Uint8Array(12).fill(token),
          numberCiphertextVersion: 1,
          numberKeyVersion: 1,
          numberToken: new Uint8Array(32).fill(token),
          personalAccountId: accountA,
          setupId: `cst_${String(index).padStart(21, "0")}`,
        }),
      ).resolves.toMatchObject({ outcome: "created" });
    }
  });
});
