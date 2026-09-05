import { sql } from "drizzle-orm";
import { drizzle, type PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import type { Client as PgClient } from "pg";
import { withPgRequestConnection } from "./request-connection";
import * as schema from "./schema";

export type Database = PgRemoteDatabase<typeof schema>;

export interface QueryConnection {
  readonly query: <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    text: string,
    values?: Array<unknown>,
  ) => Promise<{ readonly rows: Array<Row> }>;
}

export const makeDatabase = (client: QueryConnection): Database =>
  drizzle(
    async (text, values, method) => {
      const result = await client.query(text, values);
      return {
        rows:
          method === "all"
            ? result.rows.map((row) => Object.values(row))
            : result.rows,
      };
    },
    { schema },
  );

export const makeQueryConnection = (client: PgClient): QueryConnection => ({
  query: async (text, values) => {
    const result = await client.query(text, values);
    return { rows: result.rows };
  },
});

export const postgresErrorCode = (error: unknown): string => {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    const candidate = current as {
      readonly cause?: unknown;
      readonly code?: unknown;
    };
    if (
      typeof candidate.code === "string" &&
      /^[0-9A-Z]{5}$/.test(candidate.code)
    )
      return candidate.code;
    current = candidate.cause;
  }
  return "unknown";
};

export const postgresTextArray = (values: ReadonlyArray<string>) =>
  sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;

export const withPgQueryConnection = async <Value>(
  connectionString: string,
  use: (connection: QueryConnection) => Promise<Value>,
  queryTimeoutMillis = 5_000,
  connectionTimeoutMillis = 5_000,
): Promise<Value> =>
  withPgRequestConnection(
    connectionString,
    (client) => use(makeQueryConnection(client)),
    queryTimeoutMillis,
    connectionTimeoutMillis,
  );
