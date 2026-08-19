import { and, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import { makeDatabase, withPgQueryConnection } from "./database";
import type { PersonalAccountConnectionProvider } from "./personal-account";
import {
  activityLogsInApp,
  mcpAuthorizationsInApp,
  personalAccountsInApp,
  sendOperationsInApp,
  whatsappConnectionsInApp,
} from "./schema";
import { withTransaction } from "./transaction";

export interface ActivityLogSummary {
  readonly apiKeyId: string | null;
  readonly authorizationId: string | null;
  readonly channel: "api" | "mcp";
  readonly clientId: string;
  readonly clientName: string;
  readonly completedAt: Date | null;
  readonly connectionId: string | null;
  readonly errorCode: string | null;
  readonly latencyMs: number | null;
  readonly mediaBytes: number;
  readonly outcome:
    | "started"
    | "success"
    | "execution_error"
    | "rate_limited"
    | "authorization_denied";
  readonly resultCount: number | null;
  readonly sendId: string | null;
  readonly startedAt: Date;
  readonly toolName: string;
}

export interface ActivityLogPage {
  readonly logs: ReadonlyArray<ActivityLogSummary>;
  readonly nextCursor: string | null;
}

export interface ActivityLogRepository {
  readonly listForUser: (
    clerkUserId: string,
    observedAt: Date,
    cursor: string | null,
    limit: number,
  ) => Promise<ActivityLogPage | null>;
  readonly purgeExpired: (limit: number) => Promise<number>;
}

export const makeActivityLogRepository = (
  provider: PersonalAccountConnectionProvider,
): ActivityLogRepository => ({
  listForUser: (clerkUserId, observedAt, cursor, limit) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw new Error("invalid Activity Log page limit");
        }
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

        const boundary =
          cursor === null
            ? undefined
            : (
                await db
                  .select({
                    publicId: activityLogsInApp.publicId,
                    startedAt: activityLogsInApp.startedAt,
                  })
                  .from(activityLogsInApp)
                  .where(
                    and(
                      eq(
                        activityLogsInApp.personalAccountId,
                        personalAccountId,
                      ),
                      eq(activityLogsInApp.publicId, cursor),
                    ),
                  )
              )[0];
        const result =
          cursor !== null && boundary === undefined
            ? []
            : await db
                .select({
                  apiKeyName: activityLogsInApp.apiKeyName,
                  apiKeyPublicId: activityLogsInApp.apiKeyPublicId,
                  authorizationPublicId: sql<
                    string | null
                  >`${mcpAuthorizationsInApp.publicId}`.as(
                    "authorization_public_id",
                  ),
                  channel: activityLogsInApp.channel,
                  clientId: mcpAuthorizationsInApp.clientId,
                  clientName: mcpAuthorizationsInApp.clientName,
                  completedAt: activityLogsInApp.completedAt,
                  connectionPublicId: sql<string | null>`COALESCE(
                    ${activityLogsInApp.connectionPublicId},
                    ${whatsappConnectionsInApp.publicId}
                  )`.as("connection_public_id"),
                  errorCode: activityLogsInApp.errorCode,
                  latencyMs: activityLogsInApp.latencyMs,
                  mediaBytesReserved: activityLogsInApp.mediaBytesReserved,
                  outcome: activityLogsInApp.outcome,
                  publicId: sql<string>`${activityLogsInApp.publicId}`.as(
                    "log_public_id",
                  ),
                  resultCount: activityLogsInApp.resultCount,
                  sendPublicId: sql<string | null>`COALESCE(
                    ${activityLogsInApp.sendPublicId}, ${sendOperationsInApp.publicId}
                  )`.as("send_public_id"),
                  startedAt: activityLogsInApp.startedAt,
                  toolName: activityLogsInApp.toolName,
                })
                .from(activityLogsInApp)
                .leftJoin(
                  mcpAuthorizationsInApp,
                  and(
                    eq(
                      mcpAuthorizationsInApp.personalAccountId,
                      activityLogsInApp.personalAccountId,
                    ),
                    eq(
                      mcpAuthorizationsInApp.id,
                      activityLogsInApp.mcpAuthorizationId,
                    ),
                  ),
                )
                .leftJoin(
                  sendOperationsInApp,
                  and(
                    eq(
                      sendOperationsInApp.personalAccountId,
                      activityLogsInApp.personalAccountId,
                    ),
                    eq(sendOperationsInApp.activityLogId, activityLogsInApp.id),
                  ),
                )
                .leftJoin(
                  whatsappConnectionsInApp,
                  and(
                    eq(
                      whatsappConnectionsInApp.personalAccountId,
                      sendOperationsInApp.personalAccountId,
                    ),
                    eq(
                      whatsappConnectionsInApp.id,
                      sendOperationsInApp.whatsappConnectionId,
                    ),
                  ),
                )
                .where(
                  and(
                    eq(activityLogsInApp.personalAccountId, personalAccountId),
                    gt(activityLogsInApp.expiresAt, observedAt.toISOString()),
                    boundary === undefined
                      ? undefined
                      : or(
                          lt(activityLogsInApp.startedAt, boundary.startedAt),
                          and(
                            eq(activityLogsInApp.startedAt, boundary.startedAt),
                            lt(activityLogsInApp.publicId, boundary.publicId),
                          ),
                        ),
                  ),
                )
                .orderBy(
                  desc(activityLogsInApp.startedAt),
                  desc(activityLogsInApp.publicId),
                )
                .limit(limit + 1);
        const pageRows = result.slice(0, limit);
        const logs: ActivityLogSummary[] = pageRows.map((row) => {
          const channel = row.channel === "api" ? "api" : "mcp";
          const apiKeyId = row.apiKeyPublicId;
          const clientId = apiKeyId ?? row.clientId ?? "";
          return {
            apiKeyId,
            authorizationId: row.authorizationPublicId,
            channel,
            clientId,
            clientName:
              apiKeyId !== null
                ? (row.apiKeyName ?? clientId)
                : (row.clientName ?? row.clientId ?? ""),
            completedAt:
              row.completedAt === null ? null : new Date(row.completedAt),
            connectionId: row.connectionPublicId,
            errorCode: row.errorCode,
            latencyMs: row.latencyMs,
            mediaBytes: Number(row.mediaBytesReserved),
            outcome: row.outcome as ActivityLogSummary["outcome"],
            resultCount: row.resultCount,
            sendId: row.sendPublicId,
            startedAt: new Date(row.startedAt),
            toolName: row.toolName,
          };
        });
        return {
          logs,
          nextCursor:
            result.length > limit ? (pageRows.at(-1)?.publicId ?? null) : null,
        };
      }),
    ),
  purgeExpired: (limit) =>
    provider.withConnection(async (connection) => {
      const result = await makeDatabase(connection).execute<{ purged: number }>(
        sql`SELECT public.purge_expired_tool_call_logs(${limit}) AS purged`,
      );
      return Number(result[0]?.purged ?? 0);
    }),
});

const makePgConnectionProvider = (
  connectionString: string,
): PersonalAccountConnectionProvider => ({
  withConnection: (use) => withPgQueryConnection(connectionString, use),
});

export const makePgActivityLogRepository = (
  connectionString: string,
): ActivityLogRepository =>
  makeActivityLogRepository(makePgConnectionProvider(connectionString));
