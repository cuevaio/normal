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
const matchingMessagePublicId = "msg_123456789012345678986";
const otherMessagePublicId = "msg_123456789012345678987";
const oauthSubject = "C".repeat(43);
const clerkUserId = "user_search86";
const observedAt = new Date("2026-08-17T12:00:00.000Z");
const matchingAt = new Date("2026-08-17T11:59:00.000Z");
const otherAt = new Date("2026-08-17T11:58:00.000Z");
const apiKeyPublicId = "apk_123456789012345678986";
const contactLocator = `di1_${"s".repeat(43)}`;
const tokenA = `msi1_${"A".repeat(43)}`;
const tokenB = `msi1_${"B".repeat(43)}`;

describe("API Key Stored Message search", () => {
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
      `INSERT INTO public.message_search_backfill_coverage
       (personal_account_id, whatsapp_connection_id, index_version, state, searchable_from)
       VALUES ($1, $2, 1, 'complete', $3)`,
      [accountId, connectionId, new Date("2026-07-01T00:00:00.000Z")],
    );
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
        matchingAt,
      ],
    );
    await database.query(
      `INSERT INTO public.stored_messages (
         id, personal_account_id, whatsapp_connection_id, conversation_id,
         public_id, message_identity, direction, sent_at, content_type,
         content_ciphertext_version, content_key_version, content_nonce,
         content_ciphertext, received_at, webhook_item_identity,
         message_search_index_version, message_search_tokens
       ) VALUES
         ('71000000-0000-4000-8000-000000000086', $1, $2, $3,
          $4, $6, 'inbound', $8, 'text', 1, 1,
          decode(repeat('11',12),'hex'), decode(repeat('12',32),'hex'), $8, $6,
          1, $10::public.message_search_token[]),
         ('71000000-0000-4000-8000-000000000087', $1, $2, $3,
          $5, $7, 'outbound', $9, 'text', 1, 1,
          decode(repeat('13',12),'hex'), decode(repeat('14',32),'hex'), $9, $7,
          1, $11::public.message_search_token[])`,
      [
        accountId,
        connectionId,
        conversationId,
        matchingMessagePublicId,
        otherMessagePublicId,
        `wi1_${"S".repeat(43)}`,
        `wi1_${"T".repeat(43)}`,
        matchingAt,
        otherAt,
        `{${tokenA},${tokenB}}`,
        `{${tokenA}}`,
      ],
    );
    await database.query(
      `INSERT INTO public.ingestion_gaps (
         personal_account_id, whatsapp_connection_id, cause,
         history_window_started_at, starts_at, ends_at, detected_at, updated_at
       ) VALUES ($1, $2, 'processing_failure', $3, $4, NULL, $5, $5)`,
      [
        accountId,
        connectionId,
        new Date("2026-07-01T00:00:00.000Z"),
        new Date("2026-08-17T11:00:00.000Z"),
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
      name: "Search automation",
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

  const searchApi = (
    input: {
      readonly after?: string | null;
      readonly before?: string | null;
      readonly connectionPublicId?: string;
      readonly conversationPublicId?: string | null;
      readonly direction?: "all" | "inbound" | "outbound";
      readonly permissions?: ReadonlyArray<string>;
      readonly searchTokens?: ReadonlyArray<string> | null;
    } = {},
  ) =>
    repository.searchApiKeyMessages({
      after: input.after ?? null,
      apiKeyGrantId: apiKeyId,
      before: input.before ?? null,
      connectionPublicId: input.connectionPublicId ?? connectionPublicId,
      conversationPublicId: input.conversationPublicId ?? null,
      cursorPublicId: null,
      cursorSentAt: null,
      direction: input.direction ?? "all",
      limit: 20,
      observedAt,
      permissions: input.permissions ?? ["connections:read", "messages:read"],
      personalAccountId: accountId,
      searchTokens:
        input.searchTokens === undefined
          ? [tokenB, tokenA]
          : input.searchTokens,
    });

  test("returns the same indexed AND matches through MCP and API Key grants", async () => {
    const material = await searchApi({ searchTokens: null });
    expect(material).toMatchObject({
      messages: [],
      coverage: { backfillComplete: true },
      messageSearchKey: { keyVersion: 1 },
    });
    expect(JSON.stringify(material)).not.toContain(tokenA);
    expect(JSON.stringify(material)).not.toContain("invoice");

    const mcpPage = await repository.searchMessages({
      ...mcpAuthorization,
      after: null,
      before: null,
      connectionPublicId,
      conversationPublicId: null,
      cursorPublicId: null,
      cursorSentAt: null,
      direction: "all",
      limit: 20,
      observedAt,
      searchTokens: [tokenB, tokenA],
    });
    const apiPage = await searchApi();

    expect(apiPage?.messages.map((message) => message.publicId)).toEqual(
      mcpPage?.messages.map((message) => message.publicId),
    );
    expect(apiPage?.messages.map((message) => message.publicId)).toEqual([
      matchingMessagePublicId,
    ]);
    expect(apiPage).toMatchObject({
      coverage: {
        backfillComplete: true,
        gaps: [{ cause: "processing_failure", endsAt: null }],
        historyStartReason: "retention_policy",
      },
    });
    expect(JSON.stringify(apiPage)).not.toContain(otherMessagePublicId);
    expect(JSON.stringify(apiPage)).not.toContain(tokenA);
    expect(JSON.stringify(apiPage)).not.toContain("invoice");
  });

  test("loads API Key search only for a selected Connection with messages:read", async () => {
    await expect(
      searchApi({ connectionPublicId: otherConnectionPublicId }),
    ).resolves.toBeNull();
    await expect(
      searchApi({ permissions: ["connections:read", "directory:read"] }),
    ).resolves.toBeNull();
    await expect(
      searchApi({ conversationPublicId: "cvs_123456789012345678999" }),
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
      idempotencyKey: "idem-search-86-exclude",
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

    await expect(searchApi()).resolves.toMatchObject({ messages: [] });
    await expect(searchApi({ conversationPublicId })).resolves.toBeNull();
  });

  test("shares returned-record quota with MCP search_messages", async () => {
    const apiAuditLogId = "50000000-0000-4000-8000-000000000286";
    const mcpAuditLogId = "50000000-0000-4000-8000-000000000287";
    await expect(
      repository.beginProtectedOperation({
        apiKey: {
          grantId: apiKeyId,
          name: "Search automation",
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
        operationName: "search_messages",
        personalAccountId: accountId,
        requiredPermission: "messages:read",
      }),
    ).resolves.toMatchObject({ outcome: "started" });
    await expect(
      repository.completeApiKeyMessageRecordRead({
        apiKeyGrantId: apiKeyId,
        auditLogId: apiAuditLogId,
        dailyRecordLimit: 1,
        observedAt,
        personalAccountId: accountId,
        resultCount: 1,
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
        operationName: "search_messages",
      }),
    ).resolves.toMatchObject({ outcome: "started" });
    await expect(
      repository.completeMessageRecordRead({
        ...mcpAuthorization,
        auditLogId: mcpAuditLogId,
        dailyRecordLimit: 1,
        observedAt,
        resultCount: 1,
      }),
    ).resolves.toMatchObject({ outcome: "record_quota_exhausted" });
  });
});
