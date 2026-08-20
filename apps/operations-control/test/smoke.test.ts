import { describe, expect, test } from "vitest";
import { verifySampledKeys } from "../src/smoke";

const environment = {
  API_ORIGIN: "https://api.normal.fast",
  SMOKE_CHECK_SECRET: "a".repeat(64),
} as Parameters<typeof verifySampledKeys>[0];

describe("production sampled key canary", () => {
  test("allows pending KV state to propagate for longer than thirty seconds", async () => {
    let polls = 0;
    const result = await verifySampledKeys(
      environment,
      async (_input, init) => {
        if (init?.method === "POST")
          return Response.json(
            { canary_id: `smk_${"a".repeat(43)}` },
            { status: 202 },
          );
        polls += 1;
        return Response.json(
          polls === 61
            ? { status: "complete", subsystems: ["r2-kms"] }
            : { status: "pending", subsystems: [] },
        );
      },
      async () => undefined,
    );

    expect(result).toBe(true);
    expect(polls).toBe(61);
  });
});
