import { sql } from "drizzle-orm";
import {
  makeDatabase,
  makeQueryConnection,
  type QueryConnection,
} from "./database";
import { assertExpectedSchemaVersion } from "./readiness";
import { withPgRequestConnection } from "./request-connection";

const READINESS_TTL_MS = 15_000;

const withClient = <Value>(
  connectionString: string,
  use: (client: QueryConnection) => Promise<Value>,
): Promise<Value> =>
  withPgRequestConnection(connectionString, (client) =>
    use(makeQueryConnection(client)),
  );

export const makeDatabaseReadinessChecker = (dependencies: {
  readonly now: () => number;
  readonly verify: (
    connectionString: string,
    branchId: string | undefined,
    allowLegacyMigrationTable: boolean,
  ) => Promise<void>;
}) => {
  const successfulChecks = new Map<string, number>();
  return async (
    connectionString: string,
    branchId?: string,
    allowLegacyMigrationTable = false,
  ): Promise<void> => {
    const key = JSON.stringify({
      allowLegacyMigrationTable,
      branchId,
      connectionString,
    });
    const now = dependencies.now();
    const checkedAt = successfulChecks.get(key);
    if (
      checkedAt !== undefined &&
      now >= checkedAt &&
      now - checkedAt < READINESS_TTL_MS
    ) {
      return;
    }
    await dependencies.verify(
      connectionString,
      branchId,
      allowLegacyMigrationTable,
    );
    successfulChecks.set(key, dependencies.now());
  };
};

export const checkDatabaseReadiness = makeDatabaseReadinessChecker({
  now: Date.now,
  verify: (connectionString, branchId, allowLegacyMigrationTable) =>
    withClient(connectionString, (client) =>
      assertExpectedSchemaVersion(client, branchId, allowLegacyMigrationTable),
    ),
});

export const checkRestrictedDatabaseAccess = (
  connectionString: string,
): Promise<void> =>
  withClient(connectionString, async (client) => {
    const db = makeDatabase(client);
    const result = await db.execute<{
      bypass_rls: boolean;
      owns_tenant_table: boolean;
      superuser: boolean;
    }>(sql`SELECT
         role.rolbypassrls AS bypass_rls,
         role.rolsuper AS superuser,
         EXISTS (
           SELECT 1
           FROM pg_catalog.pg_class relation
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
           WHERE namespace.nspname = 'app'
             AND relation.relkind IN ('r', 'p')
             AND relation.relowner = role.oid
         ) AS owns_tenant_table
       FROM pg_catalog.pg_roles role
       WHERE role.rolname = current_user`);
    const role = result[0];
    if (!role || role.bypass_rls || role.superuser || role.owns_tenant_table)
      throw new Error("database runtime role is not restricted");
  });
