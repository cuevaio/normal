import { describe, expect, test } from "bun:test";
import { isMissingWorkerError } from "./bootstrap-recovery-worker-secrets";

describe("production deployment order", () => {
  test("deploys every coordinator before the public API", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    ).text();
    const provider = workflow.indexOf("Deploy provider control");
    const deletion = workflow.indexOf("Deploy deletion coordinator");
    const restore = workflow.indexOf("Deploy restore coordinator");
    const operations = workflow.indexOf("Deploy operations control");
    const gameDay = workflow.indexOf("Deploy recovery game day");
    const verifier = workflow.indexOf("Deploy recovery verifier");
    const recovery = workflow.indexOf("Deploy recovery control");
    const api = workflow.indexOf("Deploy API");
    expect(provider).toBeGreaterThan(-1);
    expect(deletion).toBeGreaterThan(provider);
    expect(restore).toBeGreaterThan(deletion);
    expect(operations).toBeGreaterThan(restore);
    expect(gameDay).toBeGreaterThan(operations);
    expect(verifier).toBeGreaterThan(gameDay);
    expect(recovery).toBeGreaterThan(verifier);
    expect(api).toBeGreaterThan(recovery);
    expect(
      workflow.match(
        /bun run --cwd apps\/recovery-control wrangler deploy --env production/gu,
      ),
    ).toHaveLength(1);
  });

  test("keeps migration and matching API promotion in one workflow", async () => {
    const workflows = new Bun.Glob("*.yml");
    const migrationOwners: string[] = [];

    for await (const workflow of workflows.scan(
      new URL("../.github/workflows", import.meta.url).pathname,
    )) {
      const source = await Bun.file(
        new URL(`../.github/workflows/${workflow}`, import.meta.url),
      ).text();
      if (source.includes("bun run db:migrate")) migrationOwners.push(workflow);
    }

    expect(migrationOwners).toEqual(["deploy-production.yml"]);
    const deployment = await Bun.file(
      new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    ).text();
    expect(deployment.indexOf("bun run db:migrate")).toBeLessThan(
      deployment.indexOf("Deploy API"),
    );
  });

  test("bootstraps exact recovery secrets without deploying the bootstrap versions", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    ).text();
    const bootstrap = await Bun.file(
      new URL("bootstrap-recovery-worker-secrets.ts", import.meta.url),
    ).text();

    expect(workflow).toContain("bootstrap_recovery_secrets");
    expect(workflow).toContain(
      "bun scripts/bootstrap-recovery-worker-secrets.ts",
    );
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain(
      "github.event.workflow_run.head_branch == 'main'",
    );
    expect(workflow).toContain(
      'git merge-base --is-ancestor "$(git rev-parse HEAD)" origin/main',
    );
    expect(bootstrap).toContain('"versions",\n    "upload"');
    expect(bootstrap).toContain(
      '["versions", "secret", "bulk", "--name", worker.name]',
    );
    expect(bootstrap).toContain("Fail-closed secret bootstrap; never deploy");
    expect(bootstrap).not.toContain('"deploy"');
    for (const name of [
      "whatsapp-mcp-recovery-game-day",
      "whatsapp-mcp-operations-control",
      "whatsapp-mcp-recovery-verifier",
      "whatsapp-mcp-recovery-control",
    ]) {
      expect(bootstrap).toContain(name);
    }
    for (const name of [
      "NEON_RECOVERY_API_KEY",
      "OBSERVABILITY_QUERY_TOKEN",
      "PAGER_DESTINATION_ADDRESS",
      "PAGER_RECEIPT_TOKEN",
      "PAGER_WEBHOOK_TOKEN",
      "QUARTERLY_RECEIPT_SECRET",
      "RECOVERY_EVIDENCE_TOKEN",
      "RECOVERY_VERIFIER_DATABASE_PASSWORD",
    ]) {
      expect(bootstrap).toContain(name);
      expect(workflow).toContain(name);
    }
  });

  test("recognizes current and legacy Wrangler missing Worker errors", () => {
    const workerName = "whatsapp-mcp-recovery-game-day";

    expect(
      isMissingWorkerError(`Worker "${workerName}" not found.`, workerName),
    ).toBe(true);
    expect(
      isMissingWorkerError(
        `Worker ${workerName} not found (10007)`,
        workerName,
      ),
    ).toBe(true);
    expect(
      isMissingWorkerError("Authentication error (10000)", workerName),
    ).toBe(false);
    expect(
      isMissingWorkerError('Worker "whatsapp-mcp-api" not found.', workerName),
    ).toBe(false);
  });

  test("admits production authority only from main", async () => {
    for (const workflow of [
      "deploy-production.yml",
      "launch-gate.yml",
      "observability-canary.yml",
      "public-api-release-gate.yml",
      "recovery-drills.yml",
      "rotate-production-content-credentials.yml",
    ]) {
      const source = await Bun.file(
        new URL(`../.github/workflows/${workflow}`, import.meta.url),
      ).text();
      expect(source).toContain("github.ref == 'refs/heads/main'");
    }
  });

  test("uses redirect modes supported by the Cloudflare Workers runtime", async () => {
    const runtimeRoots = [
      "apps/api/src",
      "apps/operations-control/src",
      "apps/provider-control/src",
      "apps/recovery-control/src",
      "apps/recovery-game-day/src",
      "apps/recovery-verifier/src",
      "packages/neon-recovery/src",
      "packages/wasender/src",
    ] as const;

    for (const root of runtimeRoots) {
      const glob = new Bun.Glob("**/*.ts");
      for await (const path of glob.scan(
        new URL(`../${root}`, import.meta.url).pathname,
      )) {
        const source = await Bun.file(
          new URL(`../${root}/${path}`, import.meta.url),
        ).text();
        expect(source).not.toContain('redirect: "error"');
      }
    }
  });
});
