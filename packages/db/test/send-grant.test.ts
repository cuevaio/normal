import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { makeApiKeyRepository } from "../src/api-key";
import { makeMcpAuthorizationRepository } from "../src/mcp-authorization";
import {
  apiSendGrant,
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
import { makeWhatsAppConnectionRepository } from "../src/whatsapp-connection";

const accountId = "10000000-0000-4000-8000-000000000087";
const authorizationId = "40000000-0000-4000-8000-000000000087";
const apiKeyIdA = "50000000-0000-4000-8000-000000000087";
const apiKeyIdB = "50000000-0000-4000-8000-000000000088";
const connectionId = "20000000-0000-4000-8000-000000000087";
const connectionPublicId = "con_123456789012345678987";
const contactPublicId = "ctc_123456789012345678987";
const oauthSubject = "A".repeat(43);
const clerkUserId = "user_sendgrant87";
const observedAt = new Date("2026-08-15T12:00:00.000Z");
const apiKeyPublicIdA = "apk_123456789012345678987";
const apiKeyPublicIdB = "apk_123456789012345678988";

const encrypt = async () => ({
  ciphertext: new Uint8Array(32).fill(20),
  keyVersion: 1,
  nonce: new Uint8Array(12).fill(21),
});

describe("Send Operation grant identities", () => {
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
        clerkUserId,
        accountId,
        "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      ],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connections (
          id, personal_account_id, webhook_ingress_id,
          display_name_fallback, public_id, number_suffix, state,
          state_changed_at
        ) VALUES (
          $1, $2, '30000000-0000-4000-8000-000000000087', 'Bright Badger',
          $3, '1234', 'connected', $4
        )`,
      [connectionId, accountId, connectionPublicId, observedAt],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connection_key_envelopes (
         personal_account_id, whatsapp_connection_id, account_key_version,
         key_version, nonce, ciphertext
       ) VALUES (
          $1, $2, 1, 1,
          decode(repeat('03', 12), 'hex'), decode(repeat('04', 32), 'hex')
        )`,
      [accountId, connectionId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connection_secrets (
         personal_account_id, whatsapp_connection_id, credential_ciphertext,
         credential_ciphertext_version, credential_key_version, credential_nonce,
         message_search_key_ciphertext_version, message_search_key_version,
         message_search_key_nonce, message_search_key_ciphertext
       ) VALUES (
         $1, $2,
         decode(repeat('05', 32), 'hex'), 1, 1,
          decode(repeat('06', 12), 'hex'), 1, 1,
          decode(repeat('11', 12), 'hex'), decode(repeat('12', 32), 'hex')
       )`,
      [accountId, connectionId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connection_provider_sessions (
         personal_account_id, whatsapp_connection_id,
         locator_ciphertext_version, locator_key_version,
         locator_nonce, locator_ciphertext,
         authority_ciphertext_version, authority_key_version,
         authority_nonce, authority_ciphertext, created_at, updated_at
       ) VALUES (
         $1, $2,
         1, 1, decode(repeat('0d', 12), 'hex'), decode(repeat('0e', 32), 'hex'),
         1, 1, decode(repeat('0f', 12), 'hex'), decode(repeat('10', 32), 'hex'),
         $3, $3
       )`,
      [accountId, connectionId, observedAt],
    );
    await database.query(
      `INSERT INTO public.directory_contact_projections (
         personal_account_id, whatsapp_connection_id, as_of, stale, partial
       ) VALUES ($1, $2, $3, false, false)`,
      [accountId, connectionId, observedAt],
    );
    await database.query(
      `INSERT INTO public.directory_contacts (
         personal_account_id, whatsapp_connection_id, public_id,
         provider_identity_index, provider_identity_ciphertext_version,
         provider_identity_key_version, provider_identity_nonce,
         provider_identity_ciphertext, display_name_sort, active,
         received_at
       ) VALUES (
         $1, $2, $3, $4, 1, 1,
         decode(repeat('11', 12), 'hex'), decode(repeat('12', 32), 'hex'),
         '', true, $5
       )`,
      [
        accountId,
        connectionId,
        contactPublicId,
        `di1_${"A".repeat(43)}`,
        observedAt,
      ],
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
    await makeMcpAuthorizationRepository(provider).create({
      authorizationId,
      authorizedAt: observedAt,
      clientClass: "approved",
      clientId: "approved-client",
      clientName: "Approved MCP Client",
      clerkUserId,
      connectionIds: [connectionPublicId],
      expiresAt: new Date("2026-11-13T12:00:00.000Z"),
      oauthSubject,
      reverifiedAt: new Date("2026-08-15T11:59:00.000Z"),
      scopes: ["connections:read", "messages:send"],
    });
    const apiKeys = makeApiKeyRepository(provider);
    const first = await apiKeys.create({
      clerkUserId,
      connectionIds: [connectionPublicId],
      createdAt: observedAt,
      credentialDigest: new Uint8Array(32).fill(7),
      credentialHint: `normal_${apiKeyPublicIdA}.…wxyz`,
      expiresAt: null,
      id: apiKeyIdA,
      name: "Automation A",
      permissions: ["connections:read", "messages:send"],
      publicId: apiKeyPublicIdA,
      reverifiedAt: new Date("2026-08-15T11:59:00.000Z"),
    });
    const second = await apiKeys.create({
      clerkUserId,
      connectionIds: [connectionPublicId],
      createdAt: observedAt,
      credentialDigest: new Uint8Array(32).fill(8),
      credentialHint: `normal_${apiKeyPublicIdB}.…wxyz`,
      expiresAt: null,
      id: apiKeyIdB,
      name: "Automation B",
      permissions: ["connections:read", "messages:send"],
      publicId: apiKeyPublicIdB,
      reverifiedAt: new Date("2026-08-15T11:59:00.000Z"),
    });
    expect(first).toMatchObject({ outcome: "created" });
    expect(second).toMatchObject({ outcome: "created" });
    repository = makeMcpToolRepository(provider);
    sends = makePgAtomicSendRepository(provider);
  });

  afterEach(async () => {
    await database.close();
  });

  const mcpGrant = mcpSendGrant({
    authorizationId,
    clientId: "approved-client",
    oauthSubject,
  });
  const apiGrantA = apiSendGrant({
    grantId: apiKeyIdA,
    name: "Automation A",
    permissions: ["connections:read", "messages:send"],
    personalAccountId: accountId,
    publicId: apiKeyPublicIdA,
  });
  const apiGrantB = apiSendGrant({
    grantId: apiKeyIdB,
    name: "Automation B",
    permissions: ["connections:read", "messages:send"],
    personalAccountId: accountId,
    publicId: apiKeyPublicIdB,
  });

  const commitInput = (
    grant: ReturnType<typeof apiSendGrant> | ReturnType<typeof mcpSendGrant>,
    overrides: {
      readonly auditLogId: string;
      readonly fingerprint: string;
      readonly idempotencyKey: string;
      readonly sendId: string;
      readonly sendPublicId: string;
    },
  ) => ({
    connectionPublicId,
    grant,
    hourRequestLimit: 100,
    minuteRequestLimit: 100,
    observedAt,
    pendingExpiresAt: new Date("2026-08-22T12:00:00.000Z"),
    recipientPublicId: contactPublicId,
    sendDailyLimit: 100,
    sendPerMinuteLimit: 100,
    ...overrides,
  });

  test("records an API Key grant without exposing internal IDs on the receipt", async () => {
    const created = await sends.commit(
      commitInput(apiGrantA, {
        auditLogId: "51000000-0000-4000-8000-000000000087",
        fingerprint: `sf1_${"A".repeat(43)}`,
        idempotencyKey: "123456789012345678987",
        sendId: "60000000-0000-4000-8000-000000000087",
        sendPublicId: "snd_123456789012345678987",
      }),
      encrypt,
    );
    expect(created).toMatchObject({
      outcome: "created",
      receipt: {
        publicId: "snd_123456789012345678987",
        status: "processing",
      },
    });
    if (created.outcome !== "created") {
      throw new Error("expected a created Send Operation");
    }
    expect(created.receipt).toEqual({
      createdAt: observedAt,
      publicId: "snd_123456789012345678987",
      status: "processing",
      statusChangedAt: observedAt,
    });

    const persisted = await database.query<{
      api_key_id: string | null;
      grant_type: string;
      mcp_authorization_id: string | null;
    }>(
      `SELECT grant_type, mcp_authorization_id, api_key_id
       FROM public.send_operations
       WHERE public_id = 'snd_123456789012345678987'`,
    );
    expect(persisted.rows[0]).toEqual({
      api_key_id: apiKeyIdA,
      grant_type: "api",
      mcp_authorization_id: null,
    });

    const audit = await database.query<{
      api_key_id: string | null;
      channel: string;
      mcp_authorization_id: string | null;
      tool_name: string;
    }>(
      `SELECT channel, tool_name, mcp_authorization_id, api_key_id
       FROM public.tool_call_logs
       WHERE id = '51000000-0000-4000-8000-000000000087'`,
    );
    expect(audit.rows[0]).toEqual({
      api_key_id: apiKeyIdA,
      channel: "api",
      mcp_authorization_id: null,
      tool_name: "send_text_message",
    });
  });

  test("replays exact API Key sends and isolates bindings across grant kinds", async () => {
    const first = commitInput(apiGrantA, {
      auditLogId: "51000000-0000-4000-8000-000000000088",
      fingerprint: `sf1_${"B".repeat(43)}`,
      idempotencyKey: "123456789012345678988",
      sendId: "60000000-0000-4000-8000-000000000088",
      sendPublicId: "snd_123456789012345678988",
    });
    expect(await sends.commit(first, encrypt)).toMatchObject({
      outcome: "created",
    });
    expect(
      await sends.commit(
        {
          ...first,
          auditLogId: "51000000-0000-4000-8000-000000000089",
        },
        async () => {
          throw new Error("exact API Key replay must not encrypt");
        },
      ),
    ).toMatchObject({
      outcome: "replay",
      receipt: { publicId: "snd_123456789012345678988" },
    });
    expect(
      await sends.commit(
        {
          ...first,
          auditLogId: "51000000-0000-4000-8000-00000000008a",
          fingerprint: `sf1_${"C".repeat(43)}`,
        },
        async () => {
          throw new Error("changed API Key payload must not encrypt");
        },
      ),
    ).toEqual({ outcome: "idempotency_conflict" });

    const otherKey = await sends.commit(
      commitInput(apiGrantB, {
        auditLogId: "51000000-0000-4000-8000-00000000008b",
        fingerprint: `sf1_${"B".repeat(43)}`,
        idempotencyKey: first.idempotencyKey,
        sendId: "60000000-0000-4000-8000-00000000008b",
        sendPublicId: "snd_12345678901234567898b",
      }),
      encrypt,
    );
    expect(otherKey).toMatchObject({
      outcome: "created",
      receipt: { publicId: "snd_12345678901234567898b" },
    });

    const mcpSameKey = await sends.commit(
      commitInput(mcpGrant, {
        auditLogId: "51000000-0000-4000-8000-00000000008c",
        fingerprint: `sf1_${"B".repeat(43)}`,
        idempotencyKey: first.idempotencyKey,
        sendId: "60000000-0000-4000-8000-00000000008c",
        sendPublicId: "snd_12345678901234567898c",
      }),
      encrypt,
    );
    expect(mcpSameKey).toMatchObject({
      outcome: "created",
      receipt: { publicId: "snd_12345678901234567898c" },
    });

    await expect(
      repository.getSendStatus({
        connectionPublicId,
        grant: apiGrantA,
        observedAt,
        sendPublicId: "snd_123456789012345678988",
      }),
    ).resolves.toMatchObject({
      publicId: "snd_123456789012345678988",
      status: "processing",
    });
    await expect(
      repository.getSendStatus({
        connectionPublicId,
        grant: apiGrantB,
        observedAt,
        sendPublicId: "snd_123456789012345678988",
      }),
    ).resolves.toBeNull();
    await expect(
      repository.getSendStatus({
        connectionPublicId,
        grant: mcpGrant,
        observedAt,
        sendPublicId: "snd_123456789012345678988",
      }),
    ).resolves.toBeNull();
    await expect(
      repository.getSendStatus({
        connectionPublicId,
        grant: apiGrantA,
        observedAt,
        sendPublicId: "snd_12345678901234567898c",
      }),
    ).resolves.toBeNull();
    await expect(
      repository.getSendStatus({
        connectionPublicId: "con_123456789012345678999",
        grant: apiGrantA,
        observedAt,
        sendPublicId: "snd_123456789012345678988",
      }),
    ).resolves.toBeNull();
  });

  test("keeps Send Status readable after disconnection and hides it after revocation", async () => {
    const created = await sends.commit(
      commitInput(apiGrantA, {
        auditLogId: "51000000-0000-4000-8000-000000000093",
        fingerprint: `sf1_${"E".repeat(43)}`,
        idempotencyKey: "123456789012345678993",
        sendId: "60000000-0000-4000-8000-000000000093",
        sendPublicId: "snd_123456789012345678993",
      }),
      encrypt,
    );
    expect(created).toMatchObject({
      outcome: "created",
      receipt: { publicId: "snd_123456789012345678993" },
    });

    await database.query(
      `UPDATE public.whatsapp_connections
       SET state = 'disconnected'
       WHERE public_id = $1`,
      [connectionPublicId],
    );
    await expect(
      repository.getSendStatus({
        connectionPublicId,
        grant: apiGrantA,
        observedAt,
        sendPublicId: "snd_123456789012345678993",
      }),
    ).resolves.toMatchObject({
      publicId: "snd_123456789012345678993",
      status: "processing",
    });

    const revoked = await makeApiKeyRepository({
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    }).revoke({
      clerkUserId,
      publicId: apiKeyPublicIdA,
      revokedAt: new Date("2026-08-15T12:01:00.000Z"),
    });
    expect(revoked).toMatchObject({
      revokedAt: new Date("2026-08-15T12:01:00.000Z"),
    });
    await expect(
      repository.getSendStatus({
        connectionPublicId,
        grant: apiGrantA,
        observedAt: new Date("2026-08-15T12:02:00.000Z"),
        sendPublicId: "snd_123456789012345678993",
      }),
    ).resolves.toBeNull();
  });

  test("rejects new sends after disconnection and after Connection Deletion", async () => {
    await database.query(
      `UPDATE public.whatsapp_connections
       SET state = 'disconnected'
       WHERE public_id = $1`,
      [connectionPublicId],
    );
    expect(
      await sends.commit(
        commitInput(apiGrantA, {
          auditLogId: "51000000-0000-4000-8000-000000000091",
          fingerprint: `sf1_${"D".repeat(43)}`,
          idempotencyKey: "123456789012345678991",
          sendId: "60000000-0000-4000-8000-000000000091",
          sendPublicId: "snd_123456789012345678991",
        }),
        encrypt,
      ),
    ).toEqual({ outcome: "connection_unavailable" });

    const deleted = await makeWhatsAppConnectionRepository({
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    }).finishDeletion({
      clerkUserId,
      deletionMarkerId: "d".repeat(64),
      publicId: connectionPublicId,
      requestedAt: "2026-08-15T12:05:00.000Z",
    });
    expect(deleted).toMatchObject({ publicId: connectionPublicId });

    const afterDeletion = await sends.commit(
      commitInput(apiGrantA, {
        auditLogId: "51000000-0000-4000-8000-000000000092",
        fingerprint: `sf1_${"E".repeat(43)}`,
        idempotencyKey: "123456789012345678992",
        sendId: "60000000-0000-4000-8000-000000000092",
        sendPublicId: "snd_123456789012345678992",
      }),
      encrypt,
    );
    const unknownConnection = await sends.commit(
      {
        ...commitInput(apiGrantB, {
          auditLogId: "51000000-0000-4000-8000-000000000093",
          fingerprint: `sf1_${"F".repeat(43)}`,
          idempotencyKey: "123456789012345678993",
          sendId: "60000000-0000-4000-8000-000000000093",
          sendPublicId: "snd_123456789012345678993",
        }),
        connectionPublicId: "con_999999999999999999999",
      },
      encrypt,
    );
    expect(afterDeletion).toEqual({ outcome: "authorization_denied" });
    expect(unknownConnection).toEqual(afterDeletion);
  });

  test("keeps sends on a remaining selected Connection after another is deleted", async () => {
    const retainedPublicId = "con_123456789012345678994";
    const retainedConnectionId = "20000000-0000-4000-8000-000000000094";
    const retainedKeyId = "50000000-0000-4000-8000-000000000094";
    const retainedKeyPublicId = "apk_123456789012345678994";
    await database.query(
      `INSERT INTO public.whatsapp_connections (
          id, personal_account_id, webhook_ingress_id,
          display_name_fallback, public_id, number_suffix, state,
          state_changed_at
        ) VALUES (
          $1, $2, '30000000-0000-4000-8000-000000000094', 'Calm Falcon',
          $3, '5678', 'connected', $4
        )`,
      [retainedConnectionId, accountId, retainedPublicId, observedAt],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connection_key_envelopes (
         personal_account_id, whatsapp_connection_id, account_key_version,
         key_version, nonce, ciphertext
       ) VALUES (
          $1, $2, 1, 1,
          decode(repeat('13', 12), 'hex'), decode(repeat('14', 32), 'hex')
        )`,
      [accountId, retainedConnectionId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connection_secrets (
         personal_account_id, whatsapp_connection_id, credential_ciphertext,
         credential_ciphertext_version, credential_key_version, credential_nonce,
         message_search_key_ciphertext_version, message_search_key_version,
         message_search_key_nonce, message_search_key_ciphertext
       ) VALUES (
         $1, $2,
         decode(repeat('15', 32), 'hex'), 1, 1,
          decode(repeat('16', 12), 'hex'), 1, 1,
          decode(repeat('17', 12), 'hex'), decode(repeat('18', 32), 'hex')
       )`,
      [accountId, retainedConnectionId],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connection_provider_sessions (
         personal_account_id, whatsapp_connection_id,
         locator_ciphertext_version, locator_key_version,
         locator_nonce, locator_ciphertext,
         authority_ciphertext_version, authority_key_version,
         authority_nonce, authority_ciphertext, created_at, updated_at
       ) VALUES (
         $1, $2,
         1, 1, decode(repeat('1b', 12), 'hex'), decode(repeat('1c', 32), 'hex'),
         1, 1, decode(repeat('1d', 12), 'hex'), decode(repeat('1e', 32), 'hex'),
         $3, $3
       )`,
      [accountId, retainedConnectionId, observedAt],
    );
    await database.query(
      `INSERT INTO public.directory_contact_projections (
         personal_account_id, whatsapp_connection_id, as_of, stale, partial
       ) VALUES ($1, $2, $3, false, false)`,
      [accountId, retainedConnectionId, observedAt],
    );
    await database.query(
      `INSERT INTO public.directory_contacts (
         personal_account_id, whatsapp_connection_id, public_id,
         provider_identity_index, provider_identity_ciphertext_version,
         provider_identity_key_version, provider_identity_nonce,
         provider_identity_ciphertext, display_name_sort, active,
         received_at
       ) VALUES (
         $1, $2, $3, $4, 1, 1,
         decode(repeat('19', 12), 'hex'), decode(repeat('1a', 32), 'hex'),
         '', true, $5
       )`,
      [
        accountId,
        retainedConnectionId,
        "ctc_123456789012345678994",
        `di1_${"B".repeat(43)}`,
        observedAt,
      ],
    );
    const apiKeys = makeApiKeyRepository({
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    });
    expect(
      await apiKeys.create({
        clerkUserId,
        connectionIds: [connectionPublicId, retainedPublicId],
        createdAt: observedAt,
        credentialDigest: new Uint8Array(32).fill(9),
        credentialHint: `normal_${retainedKeyPublicId}.…wxyz`,
        expiresAt: null,
        id: retainedKeyId,
        name: "Both Connections",
        permissions: ["connections:read", "messages:send"],
        publicId: retainedKeyPublicId,
        reverifiedAt: new Date("2026-08-15T11:59:00.000Z"),
      }),
    ).toMatchObject({ outcome: "created" });
    const retainedGrant = apiSendGrant({
      grantId: retainedKeyId,
      name: "Both Connections",
      permissions: ["connections:read", "messages:send"],
      personalAccountId: accountId,
      publicId: retainedKeyPublicId,
    });

    await makeWhatsAppConnectionRepository({
      withConnection: async (use) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    }).finishDeletion({
      clerkUserId,
      deletionMarkerId: "e".repeat(64),
      publicId: connectionPublicId,
      requestedAt: "2026-08-15T12:06:00.000Z",
    });

    expect(
      await sends.commit(
        commitInput(retainedGrant, {
          auditLogId: "51000000-0000-4000-8000-000000000094",
          fingerprint: `sf1_${"G".repeat(43)}`,
          idempotencyKey: "123456789012345678994",
          sendId: "60000000-0000-4000-8000-000000000094",
          sendPublicId: "snd_123456789012345678994",
        }),
        encrypt,
      ),
    ).toEqual({ outcome: "authorization_denied" });
    expect(
      await sends.commit(
        {
          ...commitInput(retainedGrant, {
            auditLogId: "51000000-0000-4000-8000-000000000095",
            fingerprint: `sf1_${"H".repeat(43)}`,
            idempotencyKey: "123456789012345678995",
            sendId: "60000000-0000-4000-8000-000000000095",
            sendPublicId: "snd_123456789012345678995",
          }),
          connectionPublicId: retainedPublicId,
          recipientPublicId: "ctc_123456789012345678994",
        },
        encrypt,
      ),
    ).toMatchObject({
      outcome: "created",
      receipt: { publicId: "snd_123456789012345678995" },
    });
  });
});
