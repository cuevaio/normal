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

const accountId = "10000000-0000-4000-8000-000000000083";
const authorizationId = "40000000-0000-4000-8000-000000000083";
const apiKeyId = "50000000-0000-4000-8000-000000000083";
const connectionId = "20000000-0000-4000-8000-000000000083";
const otherConnectionId = "20000000-0000-4000-8000-000000000084";
const connectionPublicId = "con_123456789012345678983";
const otherConnectionPublicId = "con_123456789012345678984";
const contactPublicId = "ctc_123456789012345678983";
const groupPublicId = "grp_123456789012345678983";
const newerConversationId = "70000000-0000-4000-8000-000000000083";
const olderConversationId = "70000000-0000-4000-8000-000000000084";
const groupConversationId = "70000000-0000-4000-8000-000000000085";
const silentConversationId = "70000000-0000-4000-8000-000000000086";
const newerConversationPublicId = "cvs_123456789012345678983";
const olderConversationPublicId = "cvs_123456789012345678984";
const groupConversationPublicId = "cvs_123456789012345678985";
const silentConversationPublicId = "cvs_123456789012345678986";
const oauthSubject = "A".repeat(43);
const clerkUserId = "user_conversations83";
const observedAt = new Date("2026-08-17T12:00:00.000Z");
const earlierAt = new Date("2026-08-17T11:00:00.000Z");
const apiKeyPublicId = "apk_123456789012345678983";
const contactLocator = `di1_${"c".repeat(43)}`;
const olderLocator = `di1_${"o".repeat(43)}`;
const groupLocator = `wi1_${"g".repeat(43)}`;
const silentLocator = `di1_${"s".repeat(43)}`;

describe("API Key WhatsApp Conversations", () => {
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
          state_changed_at
        ) VALUES
          ($1, $2, '30000000-0000-4000-8000-000000000083', 'Bright Badger',
           $3, '1234', 'connected', $5),
          ($6, $2, '30000000-0000-4000-8000-000000000084', 'Calm Falcon',
           $4, '5678', 'connected', $5)`,
      [
        connectionId,
        accountId,
        connectionPublicId,
        otherConnectionPublicId,
        observedAt,
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
      `INSERT INTO public.directory_contact_projections (
         personal_account_id, whatsapp_connection_id, as_of, stale, partial,
         snapshot_observed_at
       ) VALUES ($1, $2, $3, false, false, $3)`,
      [accountId, connectionId, observedAt],
    );
    await database.query(
      `INSERT INTO public.whatsapp_group_directory_states (
         personal_account_id, whatsapp_connection_id, as_of, snapshot_observed_at,
         stale, partial, updated_at
       ) VALUES ($1, $2, $3, $3, false, false, $3)`,
      [accountId, connectionId, observedAt],
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
      `INSERT INTO public.whatsapp_groups (
         id, personal_account_id, whatsapp_connection_id, public_id,
         provider_locator, display_name_ciphertext_version,
         display_name_key_version, display_name_nonce,
         display_name_ciphertext, provider_identity_ciphertext_version,
         provider_identity_key_version, provider_identity_nonce,
         provider_identity_ciphertext, joined, last_observed_at,
         created_at, updated_at
       ) VALUES (
         '60000000-0000-4000-8000-000000000083', $1, $2, $3, $4, 1, 1,
         decode(repeat('0d', 12), 'hex'), decode(repeat('0e', 32), 'hex'),
         1, 1, decode(repeat('0f', 12), 'hex'), decode(repeat('10', 32), 'hex'),
         true, $5, $5, $5
       )`,
      [accountId, connectionId, groupPublicId, groupLocator, observedAt],
    );
    await database.query(
      `INSERT INTO public.whatsapp_conversations (
         id, personal_account_id, whatsapp_connection_id, public_id, kind,
         recipient_locator, recipient_public_id, last_activity_at,
         last_activity_direction
       ) VALUES
         ($1, $7, $8, $2, 'direct', $9, $10, $11, 'inbound'),
         ($3, $7, $8, $4, 'direct', $12, 'ctc_123456789012345678984', $13, 'outbound'),
         ($5, $7, $8, $6, 'group', $14, $15, $13, 'inbound'),
         ($16, $7, $8, $17, 'direct', $18, 'ctc_123456789012345678986', $11, 'inbound')`,
      [
        newerConversationId,
        newerConversationPublicId,
        olderConversationId,
        olderConversationPublicId,
        groupConversationId,
        groupConversationPublicId,
        accountId,
        connectionId,
        contactLocator,
        contactPublicId,
        observedAt,
        olderLocator,
        earlierAt,
        groupLocator,
        groupPublicId,
        silentConversationId,
        silentConversationPublicId,
        silentLocator,
      ],
    );
    await database.query(
      `INSERT INTO public.stored_messages (
         id, personal_account_id, whatsapp_connection_id, conversation_id,
         public_id, message_identity, direction, sent_at, content_type,
         content_ciphertext_version, content_key_version, content_nonce,
         content_ciphertext, received_at, webhook_item_identity
       ) VALUES
         ('71000000-0000-4000-8000-000000000083', $1, $2, $3,
          'msg_123456789012345678983', $6, 'inbound', $7, 'text', 1, 1,
          decode(repeat('11',12),'hex'), decode(repeat('12',32),'hex'), $7, $6),
         ('71000000-0000-4000-8000-000000000084', $1, $2, $4,
          'msg_123456789012345678984', $8, 'outbound', $9, 'text', 1, 1,
          decode(repeat('13',12),'hex'), decode(repeat('14',32),'hex'), $9, $8),
         ('71000000-0000-4000-8000-000000000085', $1, $2, $5,
          'msg_123456789012345678985', $10, 'inbound', $9, 'text', 1, 1,
          decode(repeat('15',12),'hex'), decode(repeat('16',32),'hex'), $9, $10)`,
      [
        accountId,
        connectionId,
        newerConversationId,
        olderConversationId,
        groupConversationId,
        `wi1_${"N".repeat(43)}`,
        observedAt,
        `wi1_${"O".repeat(43)}`,
        earlierAt,
        `wi1_${"G".repeat(43)}`,
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
      name: "Conversation automation",
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

  const listApi = (
    input: {
      readonly connectionPublicId?: string;
      readonly cursorActivityAt?: string | null;
      readonly cursorPublicId?: string | null;
      readonly kind?: "all" | "direct" | "group";
      readonly limit?: number;
      readonly permissions?: ReadonlyArray<string>;
    } = {},
  ) =>
    repository.listApiKeyChats({
      apiKeyGrantId: apiKeyId,
      connectionPublicId: input.connectionPublicId ?? connectionPublicId,
      cursorActivityAt: input.cursorActivityAt ?? null,
      cursorPublicId: input.cursorPublicId ?? null,
      kind: input.kind ?? "all",
      limit: input.limit ?? 21,
      observedAt,
      permissions: input.permissions ?? ["connections:read", "messages:read"],
      personalAccountId: accountId,
    });

  test("lists the same activity-ordered conversations through MCP and API Key grants", async () => {
    const mcpPage = await repository.listChats({
      ...mcpAuthorization,
      connectionPublicId,
      cursorActivityAt: null,
      cursorPublicId: null,
      kind: "all",
      limit: 21,
      observedAt,
    });
    const apiPage = await listApi();

    expect(mcpPage?.chats.map((chat) => chat.conversationId)).toEqual([
      newerConversationPublicId,
      olderConversationPublicId,
      groupConversationPublicId,
    ]);
    expect(apiPage?.chats.map((chat) => chat.conversationId)).toEqual(
      mcpPage?.chats.map((chat) => chat.conversationId),
    );
    expect(apiPage?.chats.map((chat) => chat.kind)).toEqual([
      "direct",
      "direct",
      "group",
    ]);
    expect(apiPage?.chats[0]).toMatchObject({
      conversationId: newerConversationPublicId,
      displayName: { keyVersion: 1 },
      lastActivityDirection: "inbound",
      recipientId: contactPublicId,
    });
    expect(apiPage).toMatchObject({
      asOf: observedAt.toISOString(),
      partial: false,
      stale: false,
    });
    expect(JSON.stringify(apiPage)).not.toContain(silentConversationPublicId);
  });

  test("filters by kind and pages by Conversation Activity then handle", async () => {
    await expect(listApi({ kind: "direct" })).resolves.toMatchObject({
      chats: [
        { conversationId: newerConversationPublicId },
        { conversationId: olderConversationPublicId },
      ],
    });
    await expect(listApi({ kind: "group" })).resolves.toMatchObject({
      chats: [{ conversationId: groupConversationPublicId }],
    });
    const first = await listApi({ limit: 1 });
    expect(first?.chats.map((chat) => chat.conversationId)).toEqual([
      newerConversationPublicId,
    ]);
    await expect(
      listApi({
        cursorActivityAt: first?.chats[0]?.lastActivityAt ?? null,
        cursorPublicId: newerConversationPublicId,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      chats: [{ conversationId: olderConversationPublicId }],
    });
  });

  test("loads API Key conversations only for a selected Connection with messages:read", async () => {
    await expect(
      listApi({ connectionPublicId: otherConnectionPublicId }),
    ).resolves.toBeNull();
    await expect(
      listApi({ permissions: ["connections:read", "directory:read"] }),
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
      idempotencyKey: "idem-conversations-83-exclude",
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

    const excludedPage = await listApi();

    expect(excludedPage?.chats.map((chat) => chat.conversationId)).toEqual([
      olderConversationPublicId,
      groupConversationPublicId,
    ]);
    expect(JSON.stringify(excludedPage)).not.toContain(contactPublicId);
    expect(JSON.stringify(excludedPage)).not.toContain(
      newerConversationPublicId,
    );
    expect(JSON.stringify(excludedPage)).not.toContain("excluded");
  });
});
