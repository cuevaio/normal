import { and, eq, sql } from "drizzle-orm";
import { makeDatabase, withPgQueryConnection } from "./database";
import type { PersonalAccountConnectionProvider } from "./personal-account";
import { personalAccountsInApp } from "./schema";
import { withTransaction } from "./transaction";

export const ACCOUNT_INSIGHTS_WINDOW_DAYS = 30;
export const ACCOUNT_INSIGHTS_ACTIVE_CONVERSATION_DAYS = 7;

export interface AccountInsightsSeriesPoint {
  readonly date: string;
  readonly inbound: number;
  readonly outbound: number;
}

export interface AccountInsights {
  readonly authorizations: {
    readonly active: number;
  };
  readonly connections: {
    readonly connected: number;
    readonly needsAttention: number;
    readonly total: number;
  };
  readonly conversations: {
    readonly active: number;
    readonly direct: number;
    readonly group: number;
    readonly total: number;
  };
  readonly generatedAt: Date;
  readonly messages: {
    readonly inbound: number;
    readonly outbound: number;
    readonly previousInbound: number;
    readonly previousOutbound: number;
  };
  readonly sends: {
    readonly confirmed: number;
    readonly failed: number;
    readonly unknown: number;
  };
  readonly series: ReadonlyArray<AccountInsightsSeriesPoint>;
  readonly windowDays: typeof ACCOUNT_INSIGHTS_WINDOW_DAYS;
}

export interface AccountInsightsRepository {
  readonly readForUser: (
    clerkUserId: string,
    observedAt: Date,
  ) => Promise<AccountInsights | null>;
}

const startOfUtcDay = (value: Date): Date =>
  new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );

const addUtcDays = (value: Date, days: number): Date => {
  const next = startOfUtcDay(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

export const utcCalendarDate = (value: Date): string => {
  const year = value.getUTCFullYear().toString().padStart(4, "0");
  const month = (value.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = value.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const accountInsightsWindow = (observedAt: Date) => {
  const today = startOfUtcDay(observedAt);
  const currentStart = addUtcDays(today, -(ACCOUNT_INSIGHTS_WINDOW_DAYS - 1));
  return {
    activeSince: new Date(
      observedAt.getTime() -
        ACCOUNT_INSIGHTS_ACTIVE_CONVERSATION_DAYS * 24 * 60 * 60 * 1000,
    ),
    currentStart,
    previousStart: addUtcDays(currentStart, -ACCOUNT_INSIGHTS_WINDOW_DAYS),
    today,
  };
};

const asCount = (value: unknown): number => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return Number(value);
  }
  throw new Error("invalid account insights count");
};

const emptySeries = (currentStart: Date): AccountInsightsSeriesPoint[] =>
  Array.from({ length: ACCOUNT_INSIGHTS_WINDOW_DAYS }, (_, index) => ({
    date: utcCalendarDate(addUtcDays(currentStart, index)),
    inbound: 0,
    outbound: 0,
  }));

const fillSeries = (
  currentStart: Date,
  rows: ReadonlyArray<{
    readonly date: string;
    readonly inbound: unknown;
    readonly outbound: unknown;
  }>,
): AccountInsightsSeriesPoint[] => {
  const series = emptySeries(currentStart);
  const byDate = new Map(series.map((point, index) => [point.date, index]));
  for (const row of rows) {
    const index = byDate.get(row.date);
    if (index === undefined) continue;
    const point = series[index];
    if (point === undefined) continue;
    series[index] = {
      date: point.date,
      inbound: asCount(row.inbound),
      outbound: asCount(row.outbound),
    };
  }
  return series;
};

export const makeAccountInsightsRepository = (
  provider: PersonalAccountConnectionProvider,
): AccountInsightsRepository => ({
  readForUser: (clerkUserId, observedAt) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        const context = await db.execute<{
          personal_account_id: string | null;
        }>(sql`
          SELECT public.bootstrap_personal_account_for_clerk(${clerkUserId})
            AS personal_account_id
        `);
        const personalAccountId = context[0]?.personal_account_id;
        if (typeof personalAccountId !== "string") return null;
        await db.execute(
          sql`SELECT set_config('public.personal_account_id', ${personalAccountId}, true)`,
        );
        const account = await db
          .select({ id: personalAccountsInApp.id })
          .from(personalAccountsInApp)
          .where(
            and(
              eq(personalAccountsInApp.id, personalAccountId),
              eq(personalAccountsInApp.state, "active"),
            ),
          );
        if (account.length !== 1) return null;

        const { activeSince, currentStart, previousStart } =
          accountInsightsWindow(observedAt);

        const [connectionCounts] = await db.execute<{
          connected: unknown;
          needs_attention: unknown;
          total: unknown;
        }>(sql`
          SELECT
            count(*) FILTER (WHERE state <> 'deleting')::int AS total,
            count(*) FILTER (WHERE state = 'connected')::int AS connected,
            count(*) FILTER (
              WHERE state IN ('disconnected', 'reconnect_required', 'degraded')
            )::int AS needs_attention
          FROM public.whatsapp_connections
        `);

        const [messageCounts] = await db.execute<{
          inbound: unknown;
          outbound: unknown;
          previous_inbound: unknown;
          previous_outbound: unknown;
        }>(sql`
          SELECT
            count(*) FILTER (
              WHERE direction = 'inbound'
                AND sent_at >= ${currentStart}
                AND sent_at <= ${observedAt}
            )::int AS inbound,
            count(*) FILTER (
              WHERE direction = 'outbound'
                AND sent_at >= ${currentStart}
                AND sent_at <= ${observedAt}
            )::int AS outbound,
            count(*) FILTER (
              WHERE direction = 'inbound'
                AND sent_at >= ${previousStart}
                AND sent_at < ${currentStart}
            )::int AS previous_inbound,
            count(*) FILTER (
              WHERE direction = 'outbound'
                AND sent_at >= ${previousStart}
                AND sent_at < ${currentStart}
            )::int AS previous_outbound
          FROM public.stored_messages
          WHERE deleted_at IS NULL
            AND content_expired_at IS NULL
            AND sent_at >= ${previousStart}
            AND sent_at <= ${observedAt}
        `);

        const [conversationCounts] = await db.execute<{
          active: unknown;
          direct: unknown;
          group_count: unknown;
          total: unknown;
        }>(sql`
          SELECT
            count(*)::int AS total,
            count(*) FILTER (WHERE kind = 'direct')::int AS direct,
            count(*) FILTER (WHERE kind = 'group')::int AS group_count,
            count(*) FILTER (WHERE last_activity_at >= ${activeSince})::int
              AS active
          FROM public.whatsapp_conversations
        `);

        const [sendCounts] = await db.execute<{
          confirmed: unknown;
          failed: unknown;
          unknown_count: unknown;
        }>(sql`
          SELECT
            count(*) FILTER (
              WHERE status IN ('sent', 'delivered', 'read')
            )::int AS confirmed,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE status = 'unknown')::int AS unknown_count
          FROM public.send_operations
          WHERE created_at >= ${currentStart}
            AND created_at <= ${observedAt}
        `);

        const [authorizationCounts] = await db.execute<{
          active: unknown;
        }>(sql`
          SELECT count(*)::int AS active
          FROM public.mcp_authorizations
          WHERE state = 'active'
            AND revoked_at IS NULL
            AND absolute_expires_at > ${observedAt}
        `);

        const seriesRows = await db.execute<{
          date: string;
          inbound: unknown;
          outbound: unknown;
        }>(sql`
          SELECT
            to_char((sent_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date,
            count(*) FILTER (WHERE direction = 'inbound')::int AS inbound,
            count(*) FILTER (WHERE direction = 'outbound')::int AS outbound
          FROM public.stored_messages
          WHERE deleted_at IS NULL
            AND content_expired_at IS NULL
            AND sent_at >= ${currentStart}
            AND sent_at <= ${observedAt}
          GROUP BY 1
          ORDER BY 1
        `);

        return {
          authorizations: {
            active: asCount(authorizationCounts?.active),
          },
          connections: {
            connected: asCount(connectionCounts?.connected),
            needsAttention: asCount(connectionCounts?.needs_attention),
            total: asCount(connectionCounts?.total),
          },
          conversations: {
            active: asCount(conversationCounts?.active),
            direct: asCount(conversationCounts?.direct),
            group: asCount(conversationCounts?.group_count),
            total: asCount(conversationCounts?.total),
          },
          generatedAt: observedAt,
          messages: {
            inbound: asCount(messageCounts?.inbound),
            outbound: asCount(messageCounts?.outbound),
            previousInbound: asCount(messageCounts?.previous_inbound),
            previousOutbound: asCount(messageCounts?.previous_outbound),
          },
          sends: {
            confirmed: asCount(sendCounts?.confirmed),
            failed: asCount(sendCounts?.failed),
            unknown: asCount(sendCounts?.unknown_count),
          },
          series: fillSeries(currentStart, seriesRows),
          windowDays: ACCOUNT_INSIGHTS_WINDOW_DAYS,
        };
      }),
    ),
});

const makePgConnectionProvider = (
  connectionString: string,
): PersonalAccountConnectionProvider => ({
  withConnection: (use) => withPgQueryConnection(connectionString, use),
});

export const makePgAccountInsightsRepository = (
  connectionString: string,
): AccountInsightsRepository =>
  makeAccountInsightsRepository(makePgConnectionProvider(connectionString));
