import { generateOpenApiDocument } from "@whatsapp-mcp/contracts/openapi";
import { type DrillEvidence, validateDrillEvidence } from "./recovery-drills";

export const requiredPublicApiRestPaths = [
  "/v1/connections",
  "/v1/connections/{connection_id}/contacts",
  "/v1/connections/{connection_id}/groups",
  "/v1/connections/{connection_id}/conversations",
  "/v1/connections/{connection_id}/conversations/{conversation_id}/messages",
  "/v1/connections/{connection_id}/messages/search",
  "/v1/connections/{connection_id}/messages/{message_id}/media/{media_id}",
  "/v1/connections/{connection_id}/send-operations",
  "/v1/connections/{connection_id}/send-operations/{send_operation_id}",
] as const;

export const requiredPublicApiManagementPaths = [
  "/v1/api-keys",
  "/v1/api-keys/{api_key_id}",
] as const;

export const requiredPublicApiOperations = [
  { method: "get", path: "/v1/connections" },
  { method: "get", path: "/v1/connections/{connection_id}/contacts" },
  { method: "get", path: "/v1/connections/{connection_id}/groups" },
  { method: "get", path: "/v1/connections/{connection_id}/conversations" },
  {
    method: "get",
    path: "/v1/connections/{connection_id}/conversations/{conversation_id}/messages",
  },
  { method: "post", path: "/v1/connections/{connection_id}/messages/search" },
  {
    method: "get",
    path: "/v1/connections/{connection_id}/messages/{message_id}/media/{media_id}",
  },
  { method: "post", path: "/v1/connections/{connection_id}/send-operations" },
  {
    method: "get",
    path: "/v1/connections/{connection_id}/send-operations/{send_operation_id}",
  },
  { method: "post", path: "/v1/api-keys" },
  { method: "get", path: "/v1/api-keys" },
  { method: "delete", path: "/v1/api-keys/{api_key_id}" },
] as const;

export const requiredPublicApiGuideTopics = [
  "Getting started",
  "Server-side authentication",
  "Permissions",
  "Pagination",
  "Problem Details",
  "Idempotency",
  "Ambiguous sends",
  "Retention and history coverage",
  "Restore invalidation",
  "Privacy",
] as const;

export const requiredPublicApiRestoreChecks = [
  "api_keys_revoked",
  "api_key_digests_cleared",
  "api_key_hmac_rotated",
  "predecessor_hmac_rejected",
] as const;

const attestationNames = [
  "repositoryFormatPassed",
  "repositoryLintPassed",
  "repositoryTypecheckPassed",
  "repositoryTestsPassed",
  "repositoryBuildPassed",
  "databaseMigrationCheckPassed",
  "migratedPostgresPassed",
  "workerManifestsPassed",
  "infrastructureValidationPassed",
  "deploymentManifestsPassed",
  "observabilityValidationPassed",
  "browserToWorkerPassed",
  "lifecycleRecoveryPassed",
  "productionBundleInspectionPassed",
  "docsSmokePassed",
] as const;

export type PublicApiReleaseAttestation = (typeof attestationNames)[number];

export interface PublicApiReleaseGateInput {
  readonly now: Date;
  readonly openApiDocument: unknown;
  readonly weekly: unknown;
  readonly quarterly: unknown;
  readonly repositoryFormatPassed: boolean;
  readonly repositoryLintPassed: boolean;
  readonly repositoryTypecheckPassed: boolean;
  readonly repositoryTestsPassed: boolean;
  readonly repositoryBuildPassed: boolean;
  readonly databaseMigrationCheckPassed: boolean;
  readonly migratedPostgresPassed: boolean;
  readonly workerManifestsPassed: boolean;
  readonly infrastructureValidationPassed: boolean;
  readonly deploymentManifestsPassed: boolean;
  readonly observabilityValidationPassed: boolean;
  readonly browserToWorkerPassed: boolean;
  readonly lifecycleRecoveryPassed: boolean;
  readonly productionBundleInspectionPassed: boolean;
  readonly docsSmokePassed: boolean;
}

const attestationBlockers: Record<PublicApiReleaseAttestation, string> = {
  repositoryFormatPassed: "repository format check did not pass",
  repositoryLintPassed: "repository lint did not pass",
  repositoryTypecheckPassed: "repository typecheck did not pass",
  repositoryTestsPassed: "repository tests did not pass",
  repositoryBuildPassed: "repository build did not pass",
  databaseMigrationCheckPassed: "database migration check did not pass",
  migratedPostgresPassed: "migrated Postgres suite did not pass",
  workerManifestsPassed: "Worker manifest validation did not pass",
  infrastructureValidationPassed: "infrastructure validation did not pass",
  deploymentManifestsPassed: "deployment manifest validation did not pass",
  observabilityValidationPassed: "observability validation did not pass",
  browserToWorkerPassed: "browser-to-Worker suite did not pass",
  lifecycleRecoveryPassed: "lifecycle and recovery suite did not pass",
  productionBundleInspectionPassed:
    "production bundle inspection did not exclude test markers",
  docsSmokePassed: "deployed docs.normal.fast smoke did not pass",
};

const evidenceRecord = (evidence: unknown): Partial<DrillEvidence> =>
  typeof evidence === "object" && evidence !== null && !Array.isArray(evidence)
    ? (evidence as Partial<DrillEvidence>)
    : {};

export const inspectPublicApiOpenApiDocument = (
  document: unknown,
): string[] => {
  if (
    typeof document !== "object" ||
    document === null ||
    Array.isArray(document)
  )
    return ["OpenAPI document is not an object"];
  const blockers: string[] = [];
  const openApi = document as {
    info?: { description?: unknown };
    openapi?: unknown;
    paths?: unknown;
  };
  if (openApi.openapi !== "3.1.0")
    blockers.push("OpenAPI document is not version 3.1.0");
  const description =
    typeof openApi.info?.description === "string"
      ? openApi.info.description
      : "";
  for (const topic of requiredPublicApiGuideTopics) {
    if (!description.includes(`## ${topic}`))
      blockers.push(`OpenAPI reference is missing ${topic} guidance`);
  }
  if (
    typeof openApi.paths !== "object" ||
    openApi.paths === null ||
    Array.isArray(openApi.paths)
  ) {
    blockers.push("OpenAPI document is missing paths");
    return blockers;
  }
  const paths = openApi.paths as Record<string, unknown>;
  for (const path of [
    ...requiredPublicApiRestPaths,
    ...requiredPublicApiManagementPaths,
  ]) {
    if (!(path in paths)) blockers.push(`OpenAPI document is missing ${path}`);
  }
  for (const operation of requiredPublicApiOperations) {
    const item = paths[operation.path];
    if (typeof item !== "object" || item === null || Array.isArray(item))
      continue;
    if (!(operation.method in item))
      blockers.push(
        `OpenAPI document is missing ${operation.method.toUpperCase()} ${operation.path}`,
      );
  }
  return blockers;
};

export const inspectPublicApiRestoreEvidence = (
  evidence: unknown,
): string[] => {
  const recorded = evidenceRecord(evidence);
  const checks =
    typeof recorded.checks === "object" && recorded.checks !== null
      ? recorded.checks
      : {};
  return requiredPublicApiRestoreChecks
    .filter((check) => checks[check] !== true)
    .map((check) => `restore check ${check} did not pass`);
};

const evidenceAgeMs = (evidence: Partial<DrillEvidence>, now: Date) =>
  now.getTime() - Date.parse(evidence.completed_at ?? "");

export const evaluatePublicApiReleaseGate = (
  input: PublicApiReleaseGateInput,
) => {
  const weekly = evidenceRecord(input.weekly);
  const quarterly = evidenceRecord(input.quarterly);
  const blockers = [
    ...inspectPublicApiOpenApiDocument(input.openApiDocument),
    ...validateDrillEvidence(input.weekly, input.now),
    ...validateDrillEvidence(input.quarterly, input.now),
    ...inspectPublicApiRestoreEvidence(input.weekly),
  ];
  if (weekly.drill !== "weekly_restore")
    blockers.push("weekly evidence has the wrong drill kind");
  if (evidenceAgeMs(weekly, input.now) > 8 * 86_400_000)
    blockers.push("weekly recovery evidence is stale");
  if (quarterly.drill !== "quarterly_game_day")
    blockers.push("quarterly evidence has the wrong drill kind");
  if (evidenceAgeMs(quarterly, input.now) > 100 * 86_400_000)
    blockers.push("quarterly recovery evidence is stale");
  for (const name of attestationNames) {
    if (!input[name]) blockers.push(attestationBlockers[name]);
  }
  return { open: blockers.length === 0, blockers: [...new Set(blockers)] };
};

const required = (name: string) => {
  const value = process.env[name];
  if (!value || /example|placeholder|replace/iu.test(value))
    throw new Error(`${name} is unavailable`);
  return value;
};

const passed = (name: string) => required(name) === "passed";

export const runPublicApiReleaseGate = async (
  options: {
    readonly now?: Date;
    readonly openApiDocument?: unknown;
    readonly readEvidence?: (path: string) => Promise<unknown>;
  } = {},
) => {
  const readEvidence =
    options.readEvidence ??
    (async (path: string) => JSON.parse(await Bun.file(path).text()));
  const [weekly, quarterly] = await Promise.all([
    readEvidence(required("WEEKLY_RECOVERY_EVIDENCE")),
    readEvidence(required("QUARTERLY_GAME_DAY_EVIDENCE")),
  ]);
  const result = evaluatePublicApiReleaseGate({
    now: options.now ?? new Date(),
    openApiDocument: options.openApiDocument ?? generateOpenApiDocument(),
    weekly,
    quarterly,
    repositoryFormatPassed: passed("PUBLIC_API_FORMAT_CHECK"),
    repositoryLintPassed: passed("PUBLIC_API_LINT"),
    repositoryTypecheckPassed: passed("PUBLIC_API_TYPECHECK"),
    repositoryTestsPassed: passed("PUBLIC_API_TEST"),
    repositoryBuildPassed: passed("PUBLIC_API_BUILD"),
    databaseMigrationCheckPassed: passed("PUBLIC_API_DATABASE_CHECK"),
    migratedPostgresPassed: passed("PUBLIC_API_MIGRATED_POSTGRES"),
    workerManifestsPassed: passed("PUBLIC_API_WORKER_MANIFESTS"),
    infrastructureValidationPassed: passed("PUBLIC_API_INFRASTRUCTURE"),
    deploymentManifestsPassed: passed("PUBLIC_API_DEPLOYMENT_MANIFESTS"),
    observabilityValidationPassed: passed("PUBLIC_API_OBSERVABILITY"),
    browserToWorkerPassed: passed("PUBLIC_API_BROWSER_SUITE"),
    lifecycleRecoveryPassed: passed("PUBLIC_API_LIFECYCLE_SUITE"),
    productionBundleInspectionPassed: passed("PRODUCTION_BUNDLE_INSPECTION"),
    docsSmokePassed: passed("PUBLIC_API_DOCS_SMOKE"),
  });
  if (!result.open)
    throw new Error(
      `public API release gate failed: ${result.blockers.join("; ")}`,
    );
  return result;
};

if (import.meta.main) {
  await runPublicApiReleaseGate();
  console.info(JSON.stringify({ public_api_release_gate: "passed" }));
}
