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

const accountId = "10000000-0000-4000-8000-000000000084";
const authorizationId = "40000000-0000-4000-8000-000000000084";
const apiKeyId = "50000000-0000-4000-8000-000000000084";
const connectionId = "20000000-0000-4000-8000-000000000084";
const otherConnectionId = "20000000-0000-4000-8000-000000000085";
const connectionPublicId = "con_123456789012345678984";
const otherConnectionPublicId = "con_123456789012345678985";
const contactPublicId = "ctc_123456789012345678984";
const conversationId = "70000000-0000-4000-8000-000000000084";
const conversationPublicId = "cvs_123456789012345678984";
const otherConversationPublicId = "cvs_123456789012345678985";
const newestMessagePublicId = "msg_123456789012345678986";
const middleMessagePublicId = "msg_123456789012345678985";
const oldestMessagePublicId = "msg_123456789012345678984";
const expiredMessagePublicId = "msg_123456789012345678983";
const tombstonePublicId = "msg_123456789012345678987";
const oauthSubject = "B".repeat(43);
const clerkUserId = "user_messages84";
const observedAt = new Date("2026-08-17T12:00:00.000Z");
const newestAt = new Date("2026-08-17T11:59:00.000Z");
const middleAt = new Date("2026-08-17T11:58:00.000Z");
const oldestAt = new Date("2026-08-17T11:57:00.000Z");
const expiredAt = new Date("2026-07-01T12:00:00.000Z");
const apiKeyPublicId = "apk_123456789012345678984";
const contactLocator = `di1_${"m".repeat(43)}`;

describe("API Key Stored Messages", () => {
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
          ($1, $2, '30000000-0000-4000-8000-000000000084', 'Bright Badger',
           $3, '1234', 'connected', $5, $6),
          ($7, $2, '30000000-0000-4000-8000-000000000085', 'Calm Falcon',
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
       ) VALUES
         ($1, $3, $4, $2, 'direct', $5, $6, $7, 'inbound'),
         ('70000000-0000-4000-8000-000000000085', $3, $8, $9, 'direct',
          $5, $6, $7, 'inbound')`,
      [
        conversationId,
        conversationPublicId,
        accountId,
        connectionId,
        contactLocator,
        contactPublicId,
        newestAt,
        otherConnectionId,
        otherConversationPublicId,
      ],
    );
    await database.query(
      `INSERT INTO public.stored_messages (
         id, personal_account_id, whatsapp_connection_id, conversation_id,
         public_id, message_identity, direction, sent_at, content_type,
         content_ciphertext_version, content_key_version, content_nonce,
         content_ciphertext, received_at, webhook_item_identity, deleted_at
       ) VALUES
         ('71000000-0000-4000-8000-000000000086', $1, $2, $3,
          $4, $8, 'inbound', $9, 'text', 1, 1,
          decode(repeat('11',12),'hex'), decode(repeat('12',32),'hex'), $9, $8, NULL),
         ('71000000-0000-4000-8000-000000000085', $1, $2, $3,
          $5, $10, 'outbound', $11, 'text', 1, 1,
          decode(repeat('13',12),'hex'), decode(repeat('14',32),'hex'), $11, $10, NULL),
         ('71000000-0000-4000-8000-000000000084', $1, $2, $3,
          $6, $12, 'inbound', $13, 'text', 1, 1,
          decode(repeat('15',12),'hex'), decode(repeat('16',32),'hex'), $13, $12, NULL),
         ('71000000-0000-4000-8000-000000000083', $1, $2, $3,
          $7, $14, 'inbound', $15, 'text', 1, 1,
          decode(repeat('17',12),'hex'), decode(repeat('18',32),'hex'), $15, $14, NULL),
         ('71000000-0000-4000-8000-000000000087', $1, $2, $3,
          $16, $17, 'inbound', $18, NULL, NULL, NULL,
          NULL, NULL, $18, $17, $18)`,
      [
        accountId,
        connectionId,
        conversationId,
        newestMessagePublicId,
        middleMessagePublicId,
        oldestMessagePublicId,
        expiredMessagePublicId,
        `wi1_${"N".repeat(43)}`,
        newestAt,
        `wi1_${"M".repeat(43)}`,
        middleAt,
        `wi1_${"O".repeat(43)}`,
        oldestAt,
        `wi1_${"E".repeat(43)}`,
        expiredAt,
        tombstonePublicId,
        `wi1_${"T".repeat(43)}`,
        new Date("2026-08-17T11:56:00.000Z"),
      ],
    );
    await database.query(
      `INSERT INTO public.ingestion_gaps (
         personal_account_id, whatsapp_connection_id, cause,
         history_window_started_at, starts_at, ends_at, detected_at, updated_at
       ) VALUES
         ($1, $2, 'processing_failure', $3, $4, NULL, $5, $5),
         ($1, $2, 'restore_loss', $3, $6, $7, $5, $5)`,
      [
        accountId,
        connectionId,
        new Date("2026-07-01T00:00:00.000Z"),
        new Date("2026-08-17T11:00:00.000Z"),
        observedAt,
        new Date("2026-07-02T00:00:00.000Z"),
        new Date("2026-07-03T00:00:00.000Z"),
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
      reverifiedAt: new Date("2026-08-17T11:59:00.000Z"),
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
      name: "Message automation",
      permissions: ["connections:read", "messages:read"],
      publicId: apiKeyPublicId,
      reverifiedAt: new Date("2026-08-17T11:59:00.000Z"),
    });
    expect(created).toMatchObject({ outcome: "created" });
    repository = makeMcpToolRepository(provider);
  });

  afterEach(async () => {
    await database.close();
  });

  const mcpAuthorization = {
    authorizationId,
    clientId: "approved-client",
    oauthSubject,
  };

  const readApi = (
    input: {
      readonly connectionPublicId?: string;
      readonly conversationPublicId?: string;
      readonly cursorPublicId?: string | null;
      readonly cursorSentAt?: string | null;
      readonly limit?: number;
      readonly permissions?: ReadonlyArray<string>;
    } = {},
  ) =>
    repository.readApiKeyMessages({
      apiKeyGrantId: apiKeyId,
      connectionPublicId: input.connectionPublicId ?? connectionPublicId,
      conversationPublicId: input.conversationPublicId ?? conversationPublicId,
      cursorPublicId: input.cursorPublicId ?? null,
      cursorSentAt: input.cursorSentAt ?? null,
      limit: input.limit ?? 20,
      observedAt,
      permissions: input.permissions ?? ["connections:read", "messages:read"],
      personalAccountId: accountId,
    });

  test("reads the same newest retained page through MCP and API Key grants", async () => {
    const mcpPage = await repository.readMessages({
      ...mcpAuthorization,
      auditLogId: "50000000-0000-4000-8000-000000000184",
      connectionPublicId,
      conversationPublicId,
      cursorPublicId: null,
      cursorSentAt: null,
      dailyRecordLimit: 10_000,
      limit: 20,
      observedAt,
    });
    const apiPage = await readApi();

    expect(mcpPage).toMatchObject({ outcome: "success" });
    if (mcpPage?.outcome !== "success") {
      throw new Error("expected MCP message page");
    }
    expect(apiPage?.messages.map((message) => message.publicId)).toEqual(
      mcpPage.page.messages.map((message) => message.publicId),
    );
    expect(apiPage?.messages.map((message) => message.publicId)).toEqual([
      newestMessagePublicId,
      middleMessagePublicId,
      oldestMessagePublicId,
      tombstonePublicId,
    ]);
    expect(apiPage?.messages.some((message) => message.deleted)).toBe(true);
    expect(
      apiPage?.messages.find((message) => message.deleted)?.content,
    ).toBeNull();
    expect(JSON.stringify(apiPage)).not.toContain(expiredMessagePublicId);
    expect(apiPage).toMatchObject({
      conversation: {
        kind: "direct",
        publicId: conversationPublicId,
        recipientId: contactPublicId,
      },
      hasOlder: false,
      historyStartReason: "retention_policy",
      gaps: [{ cause: "processing_failure", endsAt: null }],
    });
    expect(apiPage?.gaps.map((gap) => gap.cause)).not.toContain("restore_loss");
  });

  test("pages older Stored Messages with a deterministic sent_at and handle cursor", async () => {
    const first = await readApi({ limit: 2 });
    expect(first?.messages.map((message) => message.publicId)).toEqual([
      newestMessagePublicId,
      middleMessagePublicId,
    ]);
    expect(first?.hasOlder).toBe(true);
    const older = await readApi({
      cursorPublicId: middleMessagePublicId,
      cursorSentAt: first?.messages[1]?.sentAt ?? null,
      limit: 2,
    });
    expect(older?.messages.map((message) => message.publicId)).toEqual([
      oldestMessagePublicId,
      tombstonePublicId,
    ]);
  });

  test("loads API Key messages only for a selected Connection conversation with messages:read", async () => {
    await expect(
      readApi({ connectionPublicId: otherConnectionPublicId }),
    ).resolves.toBeNull();
    await expect(
      readApi({ conversationPublicId: otherConversationPublicId }),
    ).resolves.toBeNull();
    await expect(
      readApi({ permissions: ["connections:read", "directory:read"] }),
    ).resolves.toBeNull();
  });

  test("omits excluded recipients without disclosing the exclusion", async () => {
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
    const exclusions = makeRecipientExclusionRepository(provider);
    const prepared = await exclusions.prepareTransition({
      clerkUserId,
      connectionPublicId,
      excluded: true,
      expectedExcluded: false,
      idempotencyKey: "idem-messages-84-exclude",
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

    const excluded = await readApi();
    expect(excluded).toBeNull();
  });

  test("shares returned-record quota with MCP read_messages", async () => {
    const apiAuditLogId = "50000000-0000-4000-8000-000000000284";
    const mcpAuditLogId = "50000000-0000-4000-8000-000000000285";
    await expect(
      repository.beginProtectedOperation({
        apiKey: {
          grantId: apiKeyId,
          name: "Message automation",
          publicId: apiKeyPublicId,
        },
        auditLogId: apiAuditLogId,
        channel: "api",
        connectionPublicId,
        hourLimit: 10,
        keyHourLimit: 10,
        keyMinuteLimit: 10,
        minuteLimit: 10,
        observedAt,
        operationName: "read_messages",
        permissions: ["connections:read", "messages:read"],
        personalAccountId: accountId,
        requiredPermission: "messages:read",
      }),
    ).resolves.toMatchObject({ outcome: "started" });
    await expect(
      repository.completeApiKeyMessageRecordRead({
        apiKeyGrantId: apiKeyId,
        auditLogId: apiAuditLogId,
        dailyRecordLimit: 2,
        observedAt,
        personalAccountId: accountId,
        resultCount: 2,
      }),
    ).resolves.toEqual({ outcome: "success" });

    await expect(
      repository.beginProtectedOperation({
        authorization: mcpAuthorization,
        auditLogId: mcpAuditLogId,
        channel: "mcp",
        hourLimit: 10,
        minuteLimit: 10,
        observedAt,
        operationName: "read_messages",
      }),
    ).resolves.toMatchObject({ outcome: "started" });
    await expect(
      repository.completeMessageRecordRead({
        ...mcpAuthorization,
        auditLogId: mcpAuditLogId,
        dailyRecordLimit: 2,
        observedAt,
        resultCount: 1,
      }),
    ).resolves.toMatchObject({ outcome: "record_quota_exhausted" });
  });
});
