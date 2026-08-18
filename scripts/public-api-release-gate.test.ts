import { describe, expect, test } from "bun:test";
import { generateOpenApiDocument } from "@whatsapp-mcp/contracts/openapi";
import {
  evaluatePublicApiReleaseGate,
  inspectPublicApiOpenApiDocument,
  inspectPublicApiRestoreEvidence,
  requiredPublicApiGuideTopics,
  requiredPublicApiManagementPaths,
  requiredPublicApiOperations,
  requiredPublicApiRestPaths,
  runPublicApiReleaseGate,
} from "./public-api-release-gate";
import type { DrillEvidence } from "./recovery-drills";

const monthly: DrillEvidence = {
  version: 1,
  drill: "monthly_restore",
  environment: "production",
  started_at: "2026-08-01T00:00:00.000Z",
  completed_at: "2026-08-01T00:12:00.000Z",
  source_point_at: "2026-07-17T00:00:00.000Z",
  serving: false,
  achieved_rpo_seconds: 120,
  achieved_rto_seconds: 720,
  achieved_first_party_availability_percent: 99.7,
  objectives: {
    recovery_time_seconds: 14_400,
    neon_recovery_point_seconds: 300,
    deletion_marker_loss: 0,
    first_party_availability_percent: 99.5,
  },
  dependencies: { wasender_percent: 98.1, whatsapp_percent: 97.4 },
  checks: {
    schema_compatible: true,
    rls_isolated: true,
    sampled_keys_usable: true,
    invariants_valid: true,
    quotas_valid: true,
    audit_valid: true,
    current_time_expiry_applied: true,
    deletion_markers_replayed: true,
    deleted_identifiers_absent: true,
    api_keys_revoked: true,
    api_key_digests_cleared: true,
    api_key_hmac_rotated: true,
    predecessor_hmac_rejected: true,
  },
};

const quarterly: DrillEvidence = {
  ...monthly,
  drill: "quarterly_game_day",
  checks: {
    ...monthly.checks,
    endpoint_rotation: true,
    oauth_kv_reconstructed: true,
    immutable_queue_replay: true,
    kms_access: true,
    r2_access: true,
    media_loss_failed_closed: true,
    alert_delivered: true,
    deletion_gate_bypass_denied: true,
  },
};

const completeOpenApiDocument = {
  openapi: "3.1.0",
  info: {
    description: requiredPublicApiGuideTopics
      .map((topic) => `## ${topic}`)
      .join("\n"),
  },
  paths: Object.fromEntries(
    [...requiredPublicApiRestPaths, ...requiredPublicApiManagementPaths].map(
      (path) => [
        path,
        Object.fromEntries(
          requiredPublicApiOperations
            .filter((operation) => operation.path === path)
            .map((operation) => [operation.method, {}]),
        ),
      ],
    ),
  ),
};

const passingInput = {
  now: new Date("2026-08-03T00:00:00.000Z"),
  openApiDocument: completeOpenApiDocument,
  monthly,
  quarterly,
  repositoryFormatPassed: true,
  repositoryLintPassed: true,
  repositoryTypecheckPassed: true,
  repositoryTestsPassed: true,
  repositoryBuildPassed: true,
  databaseMigrationCheckPassed: true,
  migratedPostgresPassed: true,
  workerManifestsPassed: true,
  infrastructureValidationPassed: true,
  deploymentManifestsPassed: true,
  observabilityValidationPassed: true,
  browserToWorkerPassed: true,
  lifecycleRecoveryPassed: true,
  productionBundleInspectionPassed: true,
  docsSmokePassed: true,
};

const read = (path: string) =>
  Bun.file(new URL(`../${path}`, import.meta.url)).text();

describe("public API release gate", () => {
  test("opens only when every required gate and restore check passes", () => {
    expect(evaluatePublicApiReleaseGate(passingInput)).toEqual({
      open: true,
      blockers: [],
    });
  });

  test("fails closed when any repository quality gate is missing", () => {
    const result = evaluatePublicApiReleaseGate({
      ...passingInput,
      repositoryFormatPassed: false,
      repositoryLintPassed: false,
      repositoryTypecheckPassed: false,
      repositoryTestsPassed: false,
      repositoryBuildPassed: false,
    });
    expect(result.open).toBe(false);
    expect(result.blockers).toEqual([
      "repository format check did not pass",
      "repository lint did not pass",
      "repository typecheck did not pass",
      "repository tests did not pass",
      "repository build did not pass",
    ]);
  });

  test("fails closed when database, infrastructure, or browser gates are missing", () => {
    const result = evaluatePublicApiReleaseGate({
      ...passingInput,
      databaseMigrationCheckPassed: false,
      migratedPostgresPassed: false,
      workerManifestsPassed: false,
      infrastructureValidationPassed: false,
      deploymentManifestsPassed: false,
      observabilityValidationPassed: false,
      browserToWorkerPassed: false,
      lifecycleRecoveryPassed: false,
    });
    expect(result.open).toBe(false);
    expect(result.blockers).toEqual([
      "database migration check did not pass",
      "migrated Postgres suite did not pass",
      "Worker manifest validation did not pass",
      "infrastructure validation did not pass",
      "deployment manifest validation did not pass",
      "observability validation did not pass",
      "browser-to-Worker suite did not pass",
      "lifecycle and recovery suite did not pass",
    ]);
  });

  test("fails closed when bundle inspection or docs smoke is missing", () => {
    const result = evaluatePublicApiReleaseGate({
      ...passingInput,
      productionBundleInspectionPassed: false,
      docsSmokePassed: false,
    });
    expect(result.open).toBe(false);
    expect(result.blockers).toEqual([
      "production bundle inspection did not exclude test markers",
      "deployed docs.normal.fast smoke did not pass",
    ]);
  });

  test("fails closed when the OpenAPI document is incomplete", () => {
    expect(inspectPublicApiOpenApiDocument(null)).toEqual([
      "OpenAPI document is not an object",
    ]);
    expect(
      inspectPublicApiOpenApiDocument({
        openapi: "3.0.0",
        info: { description: "" },
        paths: {
          "/v1/connections": { get: {} },
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        "OpenAPI document is not version 3.1.0",
        "OpenAPI reference is missing Getting started guidance",
        "OpenAPI document is missing /v1/connections/{connection_id}/messages/search",
        "OpenAPI document is missing /v1/connections/{connection_id}/send-operations/{send_operation_id}",
      ]),
    );
  });

  test("fails closed when restore invalidation or HMAC rotation evidence is missing", () => {
    expect(inspectPublicApiRestoreEvidence(monthly)).toEqual([]);
    expect(
      inspectPublicApiRestoreEvidence({
        ...monthly,
        checks: {
          ...monthly.checks,
          api_keys_revoked: false,
          api_key_hmac_rotated: undefined,
        },
      }),
    ).toEqual([
      "restore check api_keys_revoked did not pass",
      "restore check api_key_hmac_rotated did not pass",
    ]);
  });

  test("fails closed on stale recovery evidence", () => {
    const result = evaluatePublicApiReleaseGate({
      ...passingInput,
      quarterly: { ...quarterly, completed_at: "2026-03-01T00:00:00.000Z" },
    });
    expect(result.open).toBe(false);
    expect(result.blockers).toContain("quarterly recovery evidence is stale");
  });

  test("does not treat a passing sibling gate as a substitute for a failed one", () => {
    const result = evaluatePublicApiReleaseGate({
      ...passingInput,
      repositoryTestsPassed: false,
      repositoryBuildPassed: true,
      docsSmokePassed: true,
    });
    expect(result.open).toBe(false);
    expect(result.blockers).toEqual(["repository tests did not pass"]);
  });

  test("CLI fails closed when an attestation is unavailable", async () => {
    const previous = { ...process.env };
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.MONTHLY_RECOVERY_EVIDENCE = "monthly.json";
    process.env.QUARTERLY_GAME_DAY_EVIDENCE = "quarterly.json";
    process.env.PUBLIC_API_FORMAT_CHECK = "passed";
    await expect(
      runPublicApiReleaseGate({
        now: passingInput.now,
        openApiDocument: completeOpenApiDocument,
        readEvidence: async (path) =>
          path === "monthly.json" ? monthly : quarterly,
      }),
    ).rejects.toThrow("PUBLIC_API_LINT is unavailable");
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
  });

  test("workflow reruns every quality gate and never skips a failure", async () => {
    const workflow = await read(
      ".github/workflows/public-api-release-gate.yml",
    );
    expect(workflow).toContain("group: production");
    expect(workflow).toContain("environment: production");
    expect(workflow).not.toContain("continue-on-error");
    expect(workflow).not.toMatch(/\|\|\s*true|ignore-?failure|skip-checks/iu);
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("AWS_MCP_SMOKE_CREDENTIAL_ROLE_ARN");
    expect(workflow).not.toContain("MCP_SMOKE_ACCESS_TOKEN");
    expect(workflow).not.toMatch(/\$GITHUB_(?:ENV|OUTPUT)/u);
    for (const command of [
      "bun run format:check",
      "bun run lint",
      "bun run typecheck",
      "bun run validate:infra",
      "bun run test",
      "bun run build",
      "bun run manifests:validate",
      "bun run observability:validate",
      "bun run infra:validate",
      "bun run --cwd packages/db test",
      "bun run db:check",
      "bun run inspect:bundles",
      "bun run deploy:smoke",
      "bun run release:public-api",
    ]) {
      expect(workflow).toContain(command);
    }
    expect(workflow).toContain("PUBLIC_API_DOCS_SMOKE: passed");
    expect(workflow).toContain("PRODUCTION_BUNDLE_INSPECTION: passed");
  });

  test("live generated OpenAPI is inspected by the release gate without weakening paths", () => {
    const blockers = inspectPublicApiOpenApiDocument(generateOpenApiDocument());
    const requiredSearch =
      "OpenAPI document is missing /v1/connections/{connection_id}/messages/search";
    const requiredSendStatus =
      "OpenAPI document is missing /v1/connections/{connection_id}/send-operations/{send_operation_id}";
    if (blockers.length > 0) {
      expect(blockers).toEqual(
        expect.arrayContaining([requiredSearch, requiredSendStatus]),
      );
    }
  });
});
