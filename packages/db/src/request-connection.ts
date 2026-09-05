import { AsyncLocalStorage } from "node:async_hooks";
import type { Client as PgClient } from "pg";

interface ConnectionScope<Client> {
  active: boolean;
  readonly activeUses: Set<Promise<void>>;
  readonly connections: Map<string, Array<ScopedConnection<Client>>>;
}

interface ScopedConnection<Client> {
  readonly client: Promise<Client>;
  inUse: boolean;
  readonly retained: boolean;
}

interface RequestConnectionManager<Client> {
  readonly run: <Value>(use: () => Promise<Value>) => Promise<Value>;
  readonly withConnection: <Value>(
    key: string,
    use: (client: Client) => Promise<Value>,
  ) => Promise<Value>;
}

export const makeRequestConnectionManager = <Client>(input: {
  readonly close: (client: Client) => Promise<void>;
  readonly connect: (key: string) => Promise<Client>;
}): RequestConnectionManager<Client> => {
  const storage = new AsyncLocalStorage<ConnectionScope<Client>>();

  const acquire = (scope: ConnectionScope<Client>, key: string) => {
    const connections = scope.connections.get(key) ?? [];
    const available = connections.find((connection) => !connection.inUse);
    if (available !== undefined) {
      available.inUse = true;
      return available;
    }
    const connected = {
      client: input.connect(key),
      inUse: true,
      retained: connections.length === 0,
    };
    connections.push(connected);
    scope.connections.set(key, connections);
    return connected;
  };

  return {
    run: async (use) => {
      if (storage.getStore() !== undefined) return use();
      const scope: ConnectionScope<Client> = {
        active: true,
        activeUses: new Set(),
        connections: new Map(),
      };
      return storage.run(scope, async () => {
        try {
          return await use();
        } finally {
          scope.active = false;
          await Promise.all(scope.activeUses);
          const clients = await Promise.allSettled(
            [...scope.connections.values()]
              .flat()
              .map((connection) => connection.client),
          );
          await Promise.allSettled(
            clients.flatMap((client) =>
              client.status === "fulfilled" ? [input.close(client.value)] : [],
            ),
          );
        }
      });
    },
    withConnection: async (key, use) => {
      const scope = storage.getStore();
      if (scope?.active === true) {
        const connection = acquire(scope, key);
        const release = Promise.withResolvers<void>();
        scope.activeUses.add(release.promise);
        try {
          return await use(await connection.client);
        } finally {
          try {
            if (connection.retained) {
              connection.inUse = false;
            } else {
              const connections = scope.connections.get(key);
              const index = connections?.indexOf(connection) ?? -1;
              if (index >= 0) connections?.splice(index, 1);
              const client = await connection.client;
              await input.close(client);
            }
          } finally {
            scope.activeUses.delete(release.promise);
            release.resolve();
          }
        }
      }
      const client = await input.connect(key);
      try {
        return await use(client);
      } finally {
        await input.close(client);
      }
    },
  };
};

interface PgConnectionOptions {
  readonly connectionString: string;
  readonly connectionTimeoutMillis: number;
  readonly queryTimeoutMillis: number;
}

const pgRequestConnections = makeRequestConnectionManager<PgClient>({
  close: (client) => client.end(),
  connect: async (key) => {
    const options = JSON.parse(key) as PgConnectionOptions;
    const { Client } = await import("pg");
    const client: PgClient = new Client({
      connectionString: options.connectionString,
      connectionTimeoutMillis: options.connectionTimeoutMillis,
      query_timeout: options.queryTimeoutMillis,
    });
    await client.connect();
    return client;
  },
});

export const withPgRequestConnectionScope = pgRequestConnections.run;

export const withPgRequestConnection = <Value>(
  connectionString: string,
  use: (client: PgClient) => Promise<Value>,
  queryTimeoutMillis = 5_000,
  connectionTimeoutMillis = 5_000,
): Promise<Value> =>
  pgRequestConnections.withConnection(
    JSON.stringify({
      connectionString,
      connectionTimeoutMillis,
      queryTimeoutMillis,
    } satisfies PgConnectionOptions),
    use,
  );
