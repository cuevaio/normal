import { describe, expect, test } from "bun:test";

const runbook = (name: string) =>
  Bun.file(new URL(`../docs/runbooks/${name}`, import.meta.url)).text();

describe("operator runbooks", () => {
  test("publishes an ordered deployment index and safe rollback matrix", async () => {
    const deployment = await runbook("deployment.md");

    expect(deployment).toContain("## Initial production deployment");
    expect(deployment).toContain("## Rollback decision matrix");
    expect(deployment).toContain("provider-control → API → web → docs");
    expect(deployment).toContain("Database migrations are forward-only");
    expect(deployment).toContain("bun run deploy:smoke");
    expect(deployment).toContain("## Public API release gate");
    expect(deployment).toContain("bun run release:public-api");
    expect(deployment).toContain("api_key_hmac_rotated");
  });

  test("covers required incidents with containment, recovery, and exit criteria", async () => {
    const incidents = await runbook("incident-response.md");

    for (const heading of [
      "Provider outage",
      "Webhook ingress failure",
      "Queue backlog",
      "Dead-letter replay",
      "Stored Media loss",
      "KMS failure",
      "Quota incident",
      "Partial deployment",
    ]) {
      expect(incidents).toContain(`## ${heading}`);
    }
    expect(incidents).toContain("Never retry an ambiguous Send Operation");
    expect(incidents).toContain("bun run ingestion:replay");
    expect(incidents).toContain("failed");
  });

  test("documents credential containment and least-privilege rotation", async () => {
    const security = await runbook("security-operations.md");

    for (const heading of [
      "Routine secret rotation",
      "Suspected credential leak",
      "Refresh-family compromise",
      "Break-glass operation",
      "Immutable audit review",
      "User API Key revocation",
      "API Key HMAC compromise",
    ]) {
      expect(security).toContain(`## ${heading}`);
    }
    expect(security).toContain("WASENDER_REFERENCE_SECRET");
    expect(security).toContain("DELETION_MARKER_HMAC_SECRET");
    expect(security).toContain("two-person");
  });

  test("preserves deletion evidence during escalation, recovery, and teardown", async () => {
    const deletion = await runbook("deletion-recovery.md");
    const teardown = await runbook("environment-teardown.md");

    expect(deletion).toContain(
      "## Stalled provider cleanup and 24-hour escalation",
    );
    expect(deletion).toContain(
      "## Marker validation and Deletion Capsule recovery",
    );
    expect(deletion).toContain("## Restore gate release criteria");
    expect(deletion).toContain(
      "Every restored API Key must already be revoked",
    );
    expect(deletion).toContain("API_KEY_HMAC_SECRET");
    expect(teardown).toContain("## Destruction order");
    expect(teardown).toContain("retire Vercel web and static docs deployments");
    expect(teardown).toContain("locked deletion-marker bucket");
    expect(teardown).toMatch(/immutable audit\s+evidence/);
    expect(teardown).toContain(
      "Never use `tofu destroy` against an unreviewed plan",
    );
  });
});
