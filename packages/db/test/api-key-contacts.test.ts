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

const accountId = "10000000-0000-4000-8000-000000000081";
const authorizationId = "40000000-0000-4000-8000-000000000081";
const apiKeyId = "50000000-0000-4000-8000-000000000081";
const connectionId = "20000000-0000-4000-8000-000000000081";
const otherConnectionId = "20000000-0000-4000-8000-000000000082";
const connectionPublicId = "con_123456789012345678981";
const otherConnectionPublicId = "con_123456789012345678982";
const contactPublicId = "ctc_123456789012345678981";
const oauthSubject = "A".repeat(43);
const clerkUserId = "user_contacts81";
const observedAt = new Date("2026-08-15T12:00:00.000Z");
const apiKeyPublicId = "apk_123456789012345678981";
const nameIndex = `di1_${"n".repeat(43)}`;
const phoneIndex = `di1_${"p".repeat(43)}`;
const identityIndex = `di1_${"i".repeat(43)}`;

describe("API Key Directory contacts", () => {
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
          ($1, $2, '30000000-0000-4000-8000-000000000081', 'Bright Badger',
           $3, '1234', 'connected', $5),
          ($6, $2, '30000000-0000-4000-8000-000000000082', 'Calm Falcon',
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
      `INSERT INTO public.directory_contacts (
         personal_account_id, whatsapp_connection_id, public_id,
         provider_identity_index, provider_identity_ciphertext_version,
         provider_identity_key_version, provider_identity_nonce,
         provider_identity_ciphertext, display_name_ciphertext_version,
         display_name_key_version, display_name_nonce, display_name_ciphertext,
         display_name_sort,
         phone_ciphertext_version, phone_key_version, phone_nonce,
         phone_ciphertext, name_prefix_indexes, phone_index, active, received_at
       ) VALUES (
         $1, $2, $3, $4, 1, 1,
         decode(repeat('07', 12), 'hex'), decode(repeat('08', 32), 'hex'),
         1, 1, decode(repeat('09', 12), 'hex'), decode(repeat('0a', 32), 'hex'),
         'ada',
         1, 1, decode(repeat('0b', 12), 'hex'), decode(repeat('0c', 32), 'hex'),
         ARRAY[$5::public.directory_blind_index], $6, true, $7
       )`,
      [
        accountId,
        connectionId,
        contactPublicId,
        identityIndex,
        nameIndex,
        phoneIndex,
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
      scopes: ["connections:read", "directory:read"],
    });
    const created = await makeApiKeyRepository(provider).create({
      clerkUserId,
      connectionIds: [connectionPublicId],
      createdAt: observedAt,
      credentialDigest: new Uint8Array(32).fill(7),
      credentialHint: `normal_${apiKeyPublicId}.…wxyz`,
      expiresAt: null,
      id: apiKeyId,
      name: "Directory automation",
      permissions: ["connections:read", "directory:read"],
      publicId: apiKeyPublicId,
      reverifiedAt: new Date("2026-08-15T11:59:00.000Z"),
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

  test("lists the same selected contact through MCP and API Key grants", async () => {
    const mcpPage = await repository.listEncryptedContacts({
      ...mcpAuthorization,
      connectionPublicId,
      cursorDisplayNameSort: null,
      cursorPublicId: null,
      limit: 21,
      observedAt,
      searchIndex: null,
      searchKind: null,
    });
    const apiPage = await repository.listApiKeyEncryptedContacts({
      apiKeyGrantId: apiKeyId,
      connectionPublicId,
      cursorDisplayNameSort: null,
      cursorPublicId: null,
      limit: 21,
      observedAt,
      permissions: ["connections:read", "directory:read"],
      personalAccountId: accountId,
      searchIndex: null,
      searchKind: null,
    });

    expect(mcpPage?.contacts.map((contact) => contact.publicId)).toEqual([
      contactPublicId,
    ]);
    expect(apiPage?.contacts.map((contact) => contact.publicId)).toEqual([
      contactPublicId,
    ]);
    expect(apiPage?.contacts[0]?.displayNameSort).toBe("ada");
    expect(apiPage?.contacts[0]?.conversationPublicId).toBeNull();
    expect(apiPage).toMatchObject({
      asOf: observedAt.toISOString(),
      partial: false,
      stale: false,
    });
  });

  test("loads API Key contact material only for a selected Connection with directory:read", async () => {
    await expect(
      repository.loadApiKeyContactReadMaterial({
        apiKeyGrantId: apiKeyId,
        connectionPublicId,
        observedAt,
        personalAccountId: accountId,
        permissions: ["connections:read", "directory:read"],
      }),
    ).resolves.toMatchObject({
      personalAccountId: accountId,
      whatsappConnectionId: connectionId,
    });
    await expect(
      repository.loadApiKeyContactReadMaterial({
        apiKeyGrantId: apiKeyId,
        connectionPublicId: otherConnectionPublicId,
        observedAt,
        personalAccountId: accountId,
        permissions: ["connections:read", "directory:read"],
      }),
    ).resolves.toBeNull();
    await expect(
      repository.loadApiKeyContactReadMaterial({
        apiKeyGrantId: apiKeyId,
        connectionPublicId,
        observedAt,
        personalAccountId: accountId,
        permissions: ["connections:read"],
      }),
    ).resolves.toBeNull();
  });

  test("applies name and phone search indexes and keyset pagination", async () => {
    await expect(
      repository.listApiKeyEncryptedContacts({
        apiKeyGrantId: apiKeyId,
        connectionPublicId,
        cursorDisplayNameSort: null,
        cursorPublicId: null,
        limit: 21,
        observedAt,
        permissions: ["connections:read", "directory:read"],
        personalAccountId: accountId,
        searchIndex: nameIndex,
        searchKind: "name",
      }),
    ).resolves.toMatchObject({
      contacts: [expect.objectContaining({ publicId: contactPublicId })],
    });
    await expect(
      repository.listApiKeyEncryptedContacts({
        apiKeyGrantId: apiKeyId,
        connectionPublicId,
        cursorDisplayNameSort: null,
        cursorPublicId: null,
        limit: 21,
        observedAt,
        permissions: ["connections:read", "directory:read"],
        personalAccountId: accountId,
        searchIndex: phoneIndex,
        searchKind: "phone",
      }),
    ).resolves.toMatchObject({
      contacts: [expect.objectContaining({ publicId: contactPublicId })],
    });
    await expect(
      repository.listApiKeyEncryptedContacts({
        apiKeyGrantId: apiKeyId,
        connectionPublicId,
        cursorDisplayNameSort: "ada",
        cursorPublicId: contactPublicId,
        limit: 1,
        observedAt,
        permissions: ["connections:read", "directory:read"],
        personalAccountId: accountId,
        searchIndex: null,
        searchKind: null,
      }),
    ).resolves.toMatchObject({ contacts: [] });
  });

  test("omits excluded contacts with the same empty-page shape as a miss", async () => {
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
      idempotencyKey: "idem-contacts-81-exclude",
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

    const excludedPage = await repository.listApiKeyEncryptedContacts({
      apiKeyGrantId: apiKeyId,
      connectionPublicId,
      cursorDisplayNameSort: null,
      cursorPublicId: null,
      limit: 21,
      observedAt,
      permissions: ["connections:read", "directory:read"],
      personalAccountId: accountId,
      searchIndex: null,
      searchKind: null,
    });
    const unknownSearch = await repository.listApiKeyEncryptedContacts({
      apiKeyGrantId: apiKeyId,
      connectionPublicId,
      cursorDisplayNameSort: null,
      cursorPublicId: null,
      limit: 21,
      observedAt,
      permissions: ["connections:read", "directory:read"],
      personalAccountId: accountId,
      searchIndex: `di1_${"x".repeat(43)}`,
      searchKind: "phone",
    });

    expect(excludedPage).toEqual(unknownSearch);
    expect(excludedPage).toMatchObject({
      asOf: observedAt.toISOString(),
      contacts: [],
      partial: false,
      stale: false,
    });
    expect(JSON.stringify(excludedPage)).not.toContain(contactPublicId);
    expect(JSON.stringify(excludedPage)).not.toContain("excluded");
  });
});
