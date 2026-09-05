import { describe, expect, test } from "bun:test";

describe("CI database test topology", () => {
  test("requires every database shard while preserving the complete local suite", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/ci.yml", import.meta.url),
    ).text();
    const packageJson = await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json();

    expect(packageJson.scripts.test).toBe(
      "bun test scripts/*.test.ts && turbo run test --cache-dir=.turbo/cache",
    );
    expect(packageJson.scripts["test:without-db"]).toBe(
      "bun test scripts/*.test.ts && turbo run test --filter=!@whatsapp-mcp/db --cache-dir=.turbo/cache",
    );
    expect(workflow).toContain("bun run test:without-db");
    expect(workflow).toContain('shard: ["1/4", "2/4", "3/4", "4/4"]');
    expect(workflow).toMatch(
      /bun run --cwd packages\/db test --shard=\$\{\{ matrix\.shard \}\}/u,
    );
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).not.toContain("continue-on-error");
  });

  test("automatic production deployment still requires complete CI", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    ).text();

    expect(workflow).toContain("workflows: [CI]");
    expect(workflow).toContain(
      "github.event.workflow_run.conclusion == 'success'",
    );
  });
});
