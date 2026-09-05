import { describe, expect, test } from "bun:test";
import { makeDatabaseReadinessChecker } from "../src/connectivity";

describe("database readiness cache", () => {
  test("caches successful production readiness for fifteen seconds", async () => {
    let now = 1_000;
    let checks = 0;
    const check = makeDatabaseReadinessChecker({
      now: () => now,
      verify: async () => {
        checks += 1;
      },
    });

    await check("postgres://api", "br-serving");
    now = 15_999;
    await check("postgres://api", "br-serving");
    expect(checks).toBe(1);
    now = 16_000;
    await check("postgres://api", "br-serving");
    expect(checks).toBe(2);
  });

  test("never caches failed readiness", async () => {
    let checks = 0;
    const check = makeDatabaseReadinessChecker({
      now: () => 1_000,
      verify: async () => {
        checks += 1;
        if (checks === 1) throw new Error("restore replay required");
      },
    });

    await expect(check("postgres://api", "br-serving")).rejects.toThrow(
      "restore replay required",
    );
    await check("postgres://api", "br-serving");
    expect(checks).toBe(2);
  });

  test("binds successful readiness to connection, branch, and migration mode", async () => {
    let checks = 0;
    const check = makeDatabaseReadinessChecker({
      now: () => 1_000,
      verify: async () => {
        checks += 1;
      },
    });

    await check("postgres://api", "br-a", false);
    await check("postgres://api", "br-b", false);
    await check("postgres://webhook", "br-a", false);
    await check("postgres://api", "br-a", true);
    expect(checks).toBe(4);
  });

  test("rechecks when the clock moves backward", async () => {
    let now = 10_000;
    let checks = 0;
    const check = makeDatabaseReadinessChecker({
      now: () => now,
      verify: async () => {
        checks += 1;
      },
    });

    await check("postgres://api", "br-serving");
    now = 9_000;
    await check("postgres://api", "br-serving");
    expect(checks).toBe(2);
  });
});
