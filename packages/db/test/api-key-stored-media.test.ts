import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { makeApiKeyRepository } from "../src/api-key";
import { makeMcpAuthorizationRepository } from "../src/mcp-authorization";
import {
  type McpToolConnectionProvider,
  type McpToolRepository,
  makeMcpToolRepository,
} from "../src/mcp-tool";
import { runMigrations } from "../src/migrations";
import type { PersonalAccountConnectionProvider } from "../src/personal-account";
import { makeRecipientExclusionRepository } from "../src/recipient-exclusion";

const accountId = "10000000-0000-4000-8000-000000000086";
const authorizationId = "40000000-0000-4000-8000-000000000086";
const apiKeyId = "50000000-0000-4000-8000-000000000086";
const connectionId = "20000000-0000-4000-8000-000000000086";
const otherConnectionId = "20000000-0000-4000-8000-000000000087";
const connectionPublicId = "con_123456789012345678986";
const otherConnectionPublicId = "con_123456789012345678987";
const contactPublicId = "ctc_123456789012345678986";
const conversationId = "70000000-0000-4000-8000-000000000086";
const conversationPublicId = "cvs_123456789012345678986";
const messageId = "71000000-0000-4000-8000-000000000086";
const messagePublicId = "msg_123456789012345678986";
const otherMessagePublicId = "msg_123456789012345678987";
const mediaId = "72000000-0000-4000-8000-000000000086";
const mediaPublicId = "med_123456789012345678986";
const oversizedMediaPublicId = "med_123456789012345678987";
const oauthSubject = "B".repeat(43);
const clerkUserId = "user_media86";
const observedAt = new Date("2026-08-18T12:00:00.000Z");
const apiKeyPublicId = "apk_123456789012345678986";
const contactLocator = `di1_${"s".repeat(43)}`;

describe("API Key Stored Media", () => {
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
        clerkUserId,
        accountId,
        "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      ],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connections (
          id, personal_account_id, webhook_ingress_id,
          display_name_fallback, public_id, number_suffix, state,
          state_changed_at, created_at
        ) VALUES
          ($1, $2, '30000000-0000-4000-8000-000000000086', 'Bright Badger',
           $3, '1234', 'connected', $5, $6),
          ($7, $2, '30000000-0000-4000-8000-000000000087', 'Calm Falcon',
           $4, '5678', 'connected', $5, $6)`,
      [
        connectionId,
        accountId,
        connectionPublicId,
        otherConnectionPublicId,
        observedAt,
        new Date("2026-07-01T00:00:00.000Z"),
        otherConnectionId,
      ],
    );
    for (const id of [connectionId, otherConnectionId]) {
      await database.query(
        `INSERT INTO public.whatsapp_connection_key_envelopes (
           personal_account_id, whatsapp_connection_id, account_key_version,
           key_version, nonce, ciphertext
         ) VALUES (
            $1, $2, 1, 1,
            decode(repeat('03', 12), 'hex'), decode(repeat('04', 32), 'hex')
          )`,
        [accountId, id],
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
        [accountId, id],
      );
    }
    await database.query(
      `INSERT INTO public.directory_contacts (
         personal_account_id, whatsapp_connection_id, public_id,
         provider_identity_index, provider_identity_ciphertext_version,
         provider_identity_key_version, provider_identity_nonce,
         provider_identity_ciphertext, display_name_ciphertext_version,
         display_name_key_version, display_name_nonce, display_name_ciphertext,
         display_name_sort,
         phone_ciphertext_version, phone_key_version, phone_nonce,
         phone_ciphertext, active, received_at
       ) VALUES (
         $1, $2, $3, $4, 1, 1,
         decode(repeat('07', 12), 'hex'), decode(repeat('08', 32), 'hex'),
         1, 1, decode(repeat('09', 12), 'hex'), decode(repeat('0a', 32), 'hex'),
         'ada',
         1, 1, decode(repeat('0b', 12), 'hex'), decode(repeat('0c', 32), 'hex'),
         true, $5
       )`,
      [accountId, connectionId, contactPublicId, contactLocator, observedAt],
    );
    await database.query(
      `INSERT INTO public.whatsapp_conversations (
         id, personal_account_id, whatsapp_connection_id, public_id, kind,
         recipient_locator, recipient_public_id, last_activity_at,
         last_activity_direction
       ) VALUES ($1, $2, $3, $4, 'direct', $5, $6, $7, 'inbound')`,
      [
        conversationId,
        accountId,
        connectionId,
        conversationPublicId,
        contactLocator,
        contactPublicId,
        observedAt,
      ],
    );
    await database.query(
      `INSERT INTO public.stored_messages (
         id, personal_account_id, whatsapp_connection_id, conversation_id,
         public_id, message_identity, direction, sent_at, content_type,
         content_ciphertext_version, content_key_version, content_nonce,
         content_ciphertext, received_at, webhook_item_identity
       ) VALUES
         ($1, $2, $3, $4, $5, $6, 'inbound', $7, 'image', 1, 1,
          decode(repeat('11',12),'hex'), decode(repeat('12',32),'hex'), $7, $6),
         ('71000000-0000-4000-8000-000000000087', $2, $3, $4, $8, $9, 'inbound',
          $7, 'image', 1, 1,
          decode(repeat('15',12),'hex'), decode(repeat('16',32),'hex'), $7, $9)`,
      [
        messageId,
        accountId,
        connectionId,
        conversationId,
        messagePublicId,
        `wi1_${"S".repeat(43)}`,
        observedAt,
        otherMessagePublicId,
        `wi1_${"T".repeat(43)}`,
      ],
    );
    await database.query(
      `INSERT INTO public.stored_media (
         id, personal_account_id, whatsapp_connection_id, stored_message_id,
         public_id, state, media_type, object_key, plaintext_size_bytes, sha256,
         metadata_ciphertext_version, metadata_key_version, metadata_nonce,
         metadata_ciphertext
       ) VALUES
         ($1, $2, $3, $4, $5, 'ready', 'image', 'opaque-object', 15, repeat('a',64),
          1, 1, decode(repeat('13',12),'hex'), decode(repeat('14',32),'hex')),
         ('72000000-0000-4000-8000-000000000087', $2, $3,
          '71000000-0000-4000-8000-000000000087', $6, 'ready', 'image',
          'opaque-oversized', 16777217, repeat('b',64),
          1, 1, decode(repeat('17',12),'hex'), decode(repeat('18',32),'hex'))`,
      [
        mediaId,
        accountId,
        connectionId,
        messageId,
        mediaPublicId,
        oversizedMediaPublicId,
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
      expiresAt: new Date("2026-11-15T12:00:00.000Z"),
      oauthSubject,
      reverifiedAt: new Date("2026-08-18T11:59:00.000Z"),
      scopes: ["connections:read", "messages:read"],
    });
    const created = await makeApiKeyRepository(provider).create({
      clerkUserId,
      connectionIds: [connectionPublicId],
      createdAt: observedAt,
      credentialDigest: new Uint8Array(32).fill(7),
      credentialHint: `normal_${apiKeyPublicId}.…wxyz`,
      expiresAt: null,
      id: apiKeyId,
      name: "Media automation",
      permissions: ["connections:read", "messages:read"],
      publicId: apiKeyPublicId,
      reverifiedAt: new Date("2026-08-18T11:59:00.000Z"),
    });
    expect(created).toMatchObject({ outcome: "created" });
    repository = makeMcpToolRepository(provider);
  });

  afterEach(async () => {
    await database.close();
  });

  const startRead = (auditLogId: string) =>
    repository.beginProtectedOperation({
      apiKey: {
        grantId: apiKeyId,
        name: "Media automation",
        publicId: apiKeyPublicId,
      },
      auditLogId,
      channel: "api",
      connectionPublicId,
      hourLimit: 10,
      keyHourLimit: 10,
      keyMinuteLimit: 10,
      minuteLimit: 10,
      observedAt,
      operationName: "read_stored_media",
      personalAccountId: accountId,
      requiredPermission: "messages:read",
    });

  const reserve = (
    input: {
      readonly auditLogId?: string;
      readonly connectionPublicId?: string;
      readonly dailyByteLimit?: number;
      readonly mediaPublicId?: string;
      readonly messagePublicId?: string;
      readonly permissions?: ReadonlyArray<string>;
    } = {},
  ) =>
    repository.reserveApiKeyStoredMediaRead({
      apiKeyGrantId: apiKeyId,
      auditLogId: input.auditLogId ?? "50000000-0000-4000-8000-000000000186",
      connectionPublicId: input.connectionPublicId ?? connectionPublicId,
      dailyByteLimit: input.dailyByteLimit ?? 15,
      mediaPublicId: input.mediaPublicId ?? mediaPublicId,
      messagePublicId: input.messagePublicId ?? messagePublicId,
      observedAt,
      permissions: input.permissions ?? ["connections:read", "messages:read"],
      personalAccountId: accountId,
    });

  test("atomically reauthorizes and reserves protected Stored Media bytes", async () => {
    const auditLogId = "50000000-0000-4000-8000-000000000186";
    await expect(startRead(auditLogId)).resolves.toMatchObject({
      outcome: "started",
    });
    await expect(reserve({ auditLogId })).resolves.toMatchObject({
      material: {
        mediaId,
        objectKey: "opaque-object",
        plaintextSizeBytes: 15,
      },
      outcome: "ready",
    });
    const log = await database.query(
      `SELECT channel,outcome,media_bytes_reserved,tool_name
       FROM public.tool_call_logs WHERE id=$1`,
      [auditLogId],
    );
    expect(log.rows).toEqual([
      {
        channel: "api",
        media_bytes_reserved: 15,
        outcome: "started",
        tool_name: "read_stored_media",
      },
    ]);
    await repository.failStoredMediaRead({
      auditLogId,
      completedAt: new Date(observedAt.getTime() + 1_000),
      errorCode: "resource_unavailable",
    });
    const failed = await database.query(
      `SELECT outcome,error_code,result_count,media_bytes_reserved
       FROM public.tool_call_logs WHERE id=$1`,
      [auditLogId],
    );
    expect(failed.rows).toEqual([
      {
        error_code: "resource_unavailable",
        media_bytes_reserved: 0,
        outcome: "execution_error",
        result_count: 0,
      },
    ]);
  });

  test("hides unknown, unselected, excluded, mismatched, and oversized media", async () => {
    const auditLogId = "50000000-0000-4000-8000-000000000187";
    await expect(startRead(auditLogId)).resolves.toMatchObject({
      outcome: "started",
    });
    await expect(
      reserve({
        auditLogId,
        messagePublicId: "msg_000000000000000000000",
      }),
    ).resolves.toEqual({ outcome: "not_found" });
    await expect(
      reserve({
        auditLogId,
        connectionPublicId: otherConnectionPublicId,
      }),
    ).resolves.toEqual({ outcome: "not_found" });
    await expect(
      reserve({
        auditLogId,
        messagePublicId: otherMessagePublicId,
      }),
    ).resolves.toEqual({ outcome: "not_found" });
    await expect(
      reserve({
        auditLogId,
        mediaPublicId: oversizedMediaPublicId,
        messagePublicId: otherMessagePublicId,
      }),
    ).resolves.toEqual({ outcome: "not_found" });
    await expect(
      reserve({
        auditLogId,
        permissions: ["connections:read", "messages:send"],
      }),
    ).resolves.toEqual({ outcome: "not_found" });

    const provider = {
      withConnection: async <Value>(
        use: (connection: PGlite) => Promise<Value>,
      ) => {
        await database.exec("SET ROLE whatsapp_api_runtime");
        try {
          return await use(database);
        } finally {
          await database.exec("RESET ROLE");
        }
      },
    };
    const exclusions = makeRecipientExclusionRepository(provider);
    const prepared = await exclusions.prepareTransition({
      clerkUserId,
      connectionPublicId,
      excluded: true,
      expectedExcluded: false,
      idempotencyKey: "idem-media-86-exclude",
      recipientPublicId: contactPublicId,
    });
    expect(prepared).toMatchObject({ outcome: "prepared" });
    await expect(
      exclusions.finalizeTransition({
        clerkUserId,
        connectionPublicId,
        observedAt: observedAt.toISOString(),
        recipientPublicId: contactPublicId,
        transitionId: prepared?.transitionId ?? "",
      }),
    ).resolves.toMatchObject({ excluded: true });
    await expect(reserve({ auditLogId })).resolves.toEqual({
      outcome: "not_found",
    });
  });

  test("shares decrypted-media-byte quota with MCP", async () => {
    const mcpAuditLogId = "50000000-0000-4000-8000-000000000188";
    const apiAuditLogId = "50000000-0000-4000-8000-000000000189";
    await expect(
      repository.reserveStoredMediaRead({
        authorizationId,
        oauthSubject,
        clientId: "approved-client",
        auditLogId: mcpAuditLogId,
        connectionPublicId,
        dailyByteLimit: 15,
        mediaPublicId,
        messagePublicId,
        observedAt,
      }),
    ).resolves.toMatchObject({ plaintextSizeBytes: 15 });
    await expect(startRead(apiAuditLogId)).resolves.toMatchObject({
      outcome: "started",
    });
    await expect(
      reserve({ auditLogId: apiAuditLogId, dailyByteLimit: 15 }),
    ).resolves.toMatchObject({
      outcome: "quota_exhausted",
    });
    const log = await database.query(
      `SELECT media_bytes_reserved FROM public.tool_call_logs WHERE id=$1`,
      [apiAuditLogId],
    );
    expect(log.rows).toEqual([{ media_bytes_reserved: 0 }]);
  });
});
