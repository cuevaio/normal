import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  ACCOUNT_INSIGHTS_WINDOW_DAYS,
  type AccountInsightsRepository,
  makeAccountInsightsRepository,
  utcCalendarDate,
} from "../src/account-insights";
import { makeMcpAuthorizationRepository } from "../src/mcp-authorization";
import { createMigratedDatabase } from "./support/migrated-database";

const accountId = "10000000-0000-4000-8000-000000000091";
const authorizationId = "40000000-0000-4000-8000-000000000091";
const connectedId = "20000000-0000-4000-8000-000000000091";
const disconnectedId = "20000000-0000-4000-8000-000000000092";
const connectedPublicId = "con_123456789012345678991";
const disconnectedPublicId = "con_123456789012345678992";
const clerkUserId = "user_insights91";
const otherAccountId = "10000000-0000-4000-8000-000000000093";
const otherAuthorizationId = "40000000-0000-4000-8000-000000000093";
const otherConnectionId = "20000000-0000-4000-8000-000000000093";
const otherConnectionPublicId = "con_123456789012345678993";
const otherClerkUserId = "user_insights93";
const observedAt = new Date("2026-08-22T18:00:00.000Z");
const currentMessageAt = new Date("2026-08-20T11:00:00.000Z");
const todayMessageAt = new Date("2026-08-22T16:00:00.000Z");
const previousMessageAt = new Date("2026-07-10T12:00:00.000Z");
const staleMessageAt = new Date("2026-06-01T12:00:00.000Z");
const expiredAt = new Date("2026-08-18T12:00:00.000Z");
const activeConversationAt = new Date("2026-08-21T09:00:00.000Z");
const quietConversationAt = new Date("2026-07-01T09:00:00.000Z");
const contactLocator = `di1_${"i".repeat(43)}`;
const groupLocator = `wi1_${"g".repeat(43)}`;
const otherLocator = `di1_${"o".repeat(43)}`;

describe("Account insights repository", () => {
  let database: PGlite;
  let repository: AccountInsightsRepository;

  beforeEach(async () => {
    database = await createMigratedDatabase();
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
         ($1, $3, '30000000-0000-4000-8000-000000000091', 'Bright Badger',
          $4, '1234', 'connected', $6, $7),
         ($2, $3, '30000000-0000-4000-8000-000000000092', 'Calm Falcon',
          $5, '5678', 'disconnected', $6, $7)`,
      [
        connectedId,
        disconnectedId,
        accountId,
        connectedPublicId,
        disconnectedPublicId,
        observedAt,
        new Date("2026-07-01T00:00:00.000Z"),
      ],
    );
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
    await makeMcpAuthorizationRepository(provider).create({
      authorizationId,
      authorizedAt: new Date("2026-06-01T12:00:00.000Z"),
      clientClass: "approved",
      clientId: "approved-client",
      clientName: "Approved MCP Client",
      clerkUserId,
      connectionIds: [connectedPublicId],
      expiresAt: new Date("2026-08-30T12:00:00.000Z"),
      oauthSubject: "A".repeat(43),
      reverifiedAt: new Date("2026-06-01T11:59:00.000Z"),
      scopes: ["connections:read", "messages:send"],
    });
    await database.query(
      `SELECT * FROM public.admit_personal_account_for_clerk(
        $1, $2, 2, $3, decode('0304', 'hex'), 6
      )`,
      [
        otherClerkUserId,
        otherAccountId,
        "arn:aws:kms:us-east-1:111122223333:key/content-root-key",
      ],
    );
    await database.query(
      `INSERT INTO public.whatsapp_connections (
         id, personal_account_id, webhook_ingress_id,
         display_name_fallback, public_id, number_suffix, state,
         state_changed_at, created_at
       ) VALUES ($1, $2, '30000000-0000-4000-8000-000000000093',
         'Kind Otter', $3, '9999', 'connected', $4, $5)`,
      [
        otherConnectionId,
        otherAccountId,
        otherConnectionPublicId,
        observedAt,
        new Date("2026-07-01T00:00:00.000Z"),
      ],
    );
    await makeMcpAuthorizationRepository(provider).create({
      authorizationId: otherAuthorizationId,
      authorizedAt: new Date("2026-06-01T12:00:00.000Z"),
      clientClass: "approved",
      clientId: "other-client",
      clientName: "Other MCP Client",
      clerkUserId: otherClerkUserId,
      connectionIds: [otherConnectionPublicId],
      expiresAt: new Date("2026-08-30T12:00:00.000Z"),
      oauthSubject: "B".repeat(43),
      reverifiedAt: new Date("2026-06-01T11:59:00.000Z"),
      scopes: ["connections:read"],
    });
    await database.query(
      `INSERT INTO public.whatsapp_conversations (
         id, personal_account_id, whatsapp_connection_id, public_id, kind,
         recipient_locator, recipient_public_id, last_activity_at,
         last_activity_direction
       ) VALUES
         ('70000000-0000-4000-8000-000000000091', $1, $2,
          'cvs_123456789012345678991', 'direct', $4, 'ctc_123456789012345678991',
          $6, 'inbound'),
         ('70000000-0000-4000-8000-000000000092', $1, $2,
          'cvs_123456789012345678992', 'group', $5, 'grp_123456789012345678991',
          $7, 'outbound'),
         ('70000000-0000-4000-8000-000000000093', $3, $8,
          'cvs_123456789012345678993', 'direct', $9, 'ctc_123456789012345678993',
          $6, 'inbound')`,
      [
        accountId,
        connectedId,
        otherAccountId,
        contactLocator,
        groupLocator,
        activeConversationAt,
        quietConversationAt,
        otherConnectionId,
        otherLocator,
      ],
    );
    const insertMessage = async (input: {
      readonly account: string;
      readonly connection: string;
      readonly conversation: string;
      readonly contentExpiredAt?: Date;
      readonly deletedAt?: Date;
      readonly direction: "inbound" | "outbound";
      readonly id: string;
      readonly identity: string;
      readonly publicId: string;
      readonly sentAt: Date;
    }) => {
      const retained =
        input.deletedAt === undefined && input.contentExpiredAt === undefined;
      await database.query(
        `INSERT INTO public.stored_messages (
           id, personal_account_id, whatsapp_connection_id, conversation_id,
           public_id, message_identity, direction, sent_at, content_type,
           content_ciphertext_version, content_key_version, content_nonce,
           content_ciphertext, received_at, webhook_item_identity, deleted_at,
           content_expired_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           CASE WHEN $9 THEN 'text' END,
           CASE WHEN $9 THEN 1 END,
           CASE WHEN $9 THEN 1 END,
           CASE WHEN $9 THEN decode(repeat('11', 12), 'hex') END,
           CASE WHEN $9 THEN decode(repeat('12', 32), 'hex') END,
           $8, $6, $10, $11
         )`,
        [
          input.id,
          input.account,
          input.connection,
          input.conversation,
          input.publicId,
          input.identity,
          input.direction,
          input.sentAt,
          retained,
          input.deletedAt ?? null,
          input.contentExpiredAt ?? null,
        ],
      );
    };
    await insertMessage({
      account: accountId,
      connection: connectedId,
      conversation: "70000000-0000-4000-8000-000000000091",
      direction: "inbound",
      id: "71000000-0000-4000-8000-000000000091",
      identity: `wi1_${"N".repeat(43)}`,
      publicId: "msg_123456789012345678991",
      sentAt: currentMessageAt,
    });
    await insertMessage({
      account: accountId,
      connection: connectedId,
      conversation: "70000000-0000-4000-8000-000000000091",
      direction: "outbound",
      id: "71000000-0000-4000-8000-000000000092",
      identity: `wi1_${"M".repeat(43)}`,
      publicId: "msg_123456789012345678992",
      sentAt: currentMessageAt,
    });
    await insertMessage({
      account: accountId,
      connection: connectedId,
      conversation: "70000000-0000-4000-8000-000000000091",
      direction: "inbound",
      id: "71000000-0000-4000-8000-000000000093",
      identity: `wi1_${"P".repeat(43)}`,
      publicId: "msg_123456789012345678993",
      sentAt: todayMessageAt,
    });
    await insertMessage({
      account: accountId,
      connection: connectedId,
      conversation: "70000000-0000-4000-8000-000000000091",
      direction: "inbound",
      id: "71000000-0000-4000-8000-000000000094",
      identity: `wi1_${"S".repeat(43)}`,
      publicId: "msg_123456789012345678994",
      sentAt: previousMessageAt,
    });
    await insertMessage({
      account: accountId,
      connection: connectedId,
      conversation: "70000000-0000-4000-8000-000000000091",
      direction: "inbound",
      id: "71000000-0000-4000-8000-000000000095",
      identity: `wi1_${"Z".repeat(43)}`,
      publicId: "msg_123456789012345678995",
      sentAt: staleMessageAt,
    });
    await insertMessage({
      account: accountId,
      connection: connectedId,
      conversation: "70000000-0000-4000-8000-000000000091",
      deletedAt: currentMessageAt,
      direction: "inbound",
      id: "71000000-0000-4000-8000-000000000096",
      identity: `wi1_${"T".repeat(43)}`,
      publicId: "msg_123456789012345678996",
      sentAt: currentMessageAt,
    });
    await insertMessage({
      account: accountId,
      connection: connectedId,
      conversation: "70000000-0000-4000-8000-000000000091",
      contentExpiredAt: expiredAt,
      direction: "outbound",
      id: "71000000-0000-4000-8000-000000000097",
      identity: `wi1_${"E".repeat(43)}`,
      publicId: "msg_123456789012345678997",
      sentAt: expiredAt,
    });
    await insertMessage({
      account: otherAccountId,
      connection: otherConnectionId,
      conversation: "70000000-0000-4000-8000-000000000093",
      direction: "inbound",
      id: "71000000-0000-4000-8000-000000000098",
      identity: `wi1_${"X".repeat(43)}`,
      publicId: "msg_123456789012345678998",
      sentAt: currentMessageAt,
    });
    repository = makeAccountInsightsRepository(provider);
  });

  afterEach(async () => {
    await database.close();
  });

  test("returns tenant-scoped counts without content or other Personal Accounts", async () => {
    const insights = await repository.readForUser(clerkUserId, observedAt);

    expect(insights).not.toBeNull();
    if (insights === null) throw new Error("expected insights");
    expect(insights.windowDays).toBe(ACCOUNT_INSIGHTS_WINDOW_DAYS);
    expect(insights.generatedAt).toEqual(observedAt);
    expect(insights.connections).toEqual({
      connected: 1,
      needsAttention: 1,
      total: 2,
    });
    expect(insights.messages).toEqual({
      inbound: 2,
      outbound: 1,
      previousInbound: 1,
      previousOutbound: 0,
    });
    expect(insights.conversations).toEqual({
      active: 1,
      direct: 1,
      group: 1,
      total: 2,
    });
    expect(insights.authorizations).toEqual({ active: 1 });
    expect(insights.sends).toEqual({
      confirmed: 0,
      failed: 0,
      unknown: 0,
    });
    expect(insights.series).toHaveLength(ACCOUNT_INSIGHTS_WINDOW_DAYS);
    expect(insights.series[0]?.date).toBe("2026-07-24");
    expect(insights.series.at(-1)?.date).toBe(utcCalendarDate(observedAt));
    expect(
      insights.series.find((point) => point.date === "2026-08-20"),
    ).toEqual({
      date: "2026-08-20",
      inbound: 1,
      outbound: 1,
    });
    expect(
      insights.series.find((point) => point.date === "2026-08-22"),
    ).toEqual({
      date: "2026-08-22",
      inbound: 1,
      outbound: 0,
    });
    expect(JSON.stringify(insights)).not.toMatch(
      /Bright Badger|phone|credential|ciphertext|wi1_|di1_|msg_|ctc_|payload/iu,
    );

    const other = await repository.readForUser(otherClerkUserId, observedAt);
    expect(other?.connections).toEqual({
      connected: 1,
      needsAttention: 0,
      total: 1,
    });
    expect(other?.messages).toEqual({
      inbound: 1,
      outbound: 0,
      previousInbound: 0,
      previousOutbound: 0,
    });
    expect(other?.conversations).toEqual({
      active: 1,
      direct: 1,
      group: 0,
      total: 1,
    });
  });

  test("returns null for an unknown Clerk identity", async () => {
    expect(
      await repository.readForUser("user_missing_insights", observedAt),
    ).toBeNull();
  });
});
