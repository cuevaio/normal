import { describe, expect, test } from "bun:test";
import { makeRequestConnectionManager } from "../src/request-connection";

describe("request connection manager", () => {
  test("reuses one connection within a request and closes it afterward", async () => {
    let connectCount = 0;
    let closeCount = 0;
    const manager = makeRequestConnectionManager({
      close: async () => {
        closeCount += 1;
      },
      connect: async (key: string) => ({ id: ++connectCount, key }),
    });

    await manager.run(async () => {
      const first = await manager.withConnection(
        "database",
        async (client) => client.id,
      );
      const second = await manager.withConnection(
        "database",
        async (client) => client.id,
      );
      expect(first).toBe(second);
      expect(connectCount).toBe(1);
      expect(closeCount).toBe(0);
    });

    expect(closeCount).toBe(1);
  });

  test("keeps unscoped calls isolated", async () => {
    let connectCount = 0;
    let closeCount = 0;
    const manager = makeRequestConnectionManager({
      close: async () => {
        closeCount += 1;
      },
      connect: async () => ({ id: ++connectCount }),
    });

    await manager.withConnection("database", async () => undefined);
    await manager.withConnection("database", async () => undefined);

    expect(connectCount).toBe(2);
    expect(closeCount).toBe(2);
  });

  test("isolates deferred work after the request scope closes", async () => {
    let connectCount = 0;
    let closeCount = 0;
    const releaseDeferred = Promise.withResolvers<void>();
    let deferred: Promise<number> | undefined;
    const manager = makeRequestConnectionManager({
      close: async () => {
        closeCount += 1;
      },
      connect: async () => ({ id: ++connectCount }),
    });

    await manager.run(async () => {
      await manager.withConnection("database", async () => undefined);
      deferred = (async () => {
        await releaseDeferred.promise;
        return manager.withConnection("database", async (client) => client.id);
      })();
    });

    expect(connectCount).toBe(1);
    expect(closeCount).toBe(1);
    releaseDeferred.resolve();
    await expect(deferred).resolves.toBe(2);
    expect(connectCount).toBe(2);
    expect(closeCount).toBe(2);
  });

  test("isolates concurrent uses while reusing idle scoped connections", async () => {
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    let closeCount = 0;
    let connectCount = 0;
    const manager = makeRequestConnectionManager({
      close: async () => {
        closeCount += 1;
      },
      connect: async () => ({ id: ++connectCount }),
    });

    await manager.run(async () => {
      const first = manager.withConnection("database", async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
      });
      await firstEntered.promise;
      const second = manager.withConnection("database", async () => {
        secondEntered.resolve();
      });
      await secondEntered.promise;
      await second;
      expect(closeCount).toBe(1);
      releaseFirst.resolve();
      await first;
      await manager.withConnection("database", async () => undefined);
      expect(closeCount).toBe(1);
    });

    expect(connectCount).toBe(2);
    expect(closeCount).toBe(2);
  });

  test("reuses a scoped connection after a callback fails", async () => {
    const manager = makeRequestConnectionManager({
      close: async () => undefined,
      connect: async () => ({ id: 1 }),
    });

    await manager.run(async () => {
      await expect(
        manager.withConnection("database", async () => {
          throw new Error("query failed");
        }),
      ).rejects.toThrow("query failed");
      await expect(
        manager.withConnection("database", async (client) => client.id),
      ).resolves.toBe(1);
    });
  });

  test("keeps different scoped connections independent", async () => {
    const releaseFirst = Promise.withResolvers<void>();
    const firstEntered = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    let connectCount = 0;
    const manager = makeRequestConnectionManager({
      close: async () => undefined,
      connect: async () => ({ id: ++connectCount }),
    });

    await manager.run(async () => {
      const first = manager.withConnection("api", async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
      });
      await firstEntered.promise;
      const second = manager.withConnection("webhook", async () => {
        secondEntered.resolve();
      });
      await secondEntered.promise;
      releaseFirst.resolve();
      await Promise.all([first, second]);
    });

    expect(connectCount).toBe(2);
  });

  test("waits for acquired work before closing its connection", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let closeCount = 0;
    const manager = makeRequestConnectionManager({
      close: async () => {
        closeCount += 1;
      },
      connect: async () => ({ id: 1 }),
    });

    const scope = manager.run(async () => {
      void manager.withConnection("database", async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
    });
    await entered.promise;
    expect(closeCount).toBe(0);
    release.resolve();
    await scope;
    expect(closeCount).toBe(1);
  });
});
