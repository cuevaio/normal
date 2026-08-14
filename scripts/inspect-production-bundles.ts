import { readdir } from "node:fs/promises";
import { join } from "node:path";

const forbiddenMarkers = [
  "TEST_LAYER_SENTINEL_DO_NOT_INCLUDE_IN_PRODUCTION",
  "TEST_FAULT_INJECTOR_DO_NOT_INCLUDE_IN_PRODUCTION",
  "signed-test-user",
  "4242424242424242424242424242424242424242424242424242424242424242",
  "x-test-failure",
  "temporary-secret",
  "test-webhook-secret",
  "connection-webhook-secret",
] as const;
const roots = [
  "apps/api/dist",
  "apps/deletion-coordinator/dist",
  "apps/provider-control/dist",
  "apps/restore-coordinator/dist",
  "apps/web/.next/server",
  "apps/web/.next/static",
];

const forbiddenImplementationPatterns = [
  /(?:^|[\\/])tests?[\\/](?:support|fixtures|layers?)(?:[\\/]|$)/iu,
  /makeInMemory[A-Za-z0-9_]*/u,
  /(?:Deterministic|Fake|Test)Clock/u,
  /fault[_-]?injector/iu,
  /(?:authorization|auth)[_-]?disabled/iu,
  /replace-with-[a-z0-9-]+/iu,
  /\b(?:sk|pk)_live_[A-Za-z0-9_-]{20,}\b/u,
] as const;

const inspect = async (path: string): Promise<void> => {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      await inspect(entryPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const contents = await Bun.file(entryPath).text();
    for (const marker of forbiddenMarkers) {
      if (contents.includes(marker)) {
        throw new Error(
          `Prohibited production implementation found at production artifact ${entryPath}`,
        );
      }
    }
    if (
      forbiddenImplementationPatterns.some((pattern) => pattern.test(contents))
    ) {
      throw new Error(
        `Prohibited production implementation found at production artifact ${entryPath}`,
      );
    }
  }
};

export const inspectArtifactRoots = async (
  artifactRoots: ReadonlyArray<string>,
): Promise<void> => {
  await Promise.all(artifactRoots.map(inspect));
};

const inspectForForbiddenAuthority = async (
  path: string,
  forbiddenValues: ReadonlyArray<string>,
): Promise<void> => {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      await inspectForForbiddenAuthority(entryPath, forbiddenValues);
      continue;
    }
    if (!entry.isFile()) continue;
    const contents = await Bun.file(entryPath).text();
    for (const forbiddenValue of forbiddenValues) {
      if (contents.includes(forbiddenValue)) {
        throw new Error(
          `Forbidden production authority reference found at production artifact ${entryPath}`,
        );
      }
    }
  }
};

const inspectProductionBundles = async (): Promise<void> => {
  await inspectArtifactRoots(roots);
  await Promise.all([
    inspectForForbiddenAuthority("apps/api/dist", [
      "WASENDER_API_CREDENTIAL",
      "WASENDER_REFERENCE_SECRET",
    ]),
    inspectForForbiddenAuthority("apps/web/.next/server", [
      "API_KEY_HMAC_SECRET",
      "MCP_CURSOR_HMAC_SECRET",
      "SEND_FINGERPRINT_HMAC_SECRET",
      "WASENDER_API_CREDENTIAL",
      "WASENDER_REFERENCE_SECRET",
      "WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET",
    ]),
    inspectForForbiddenAuthority("apps/provider-control/dist", [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "DATABASE_URL",
      "HYPERDRIVE",
      "API_KEY_HMAC_SECRET",
      "KMS_CONTENT_ROOT_KEY_ARN",
      "MCP_CURSOR_HMAC_SECRET",
      "STORED_MEDIA",
      "WEBHOOK_INGRESS",
      "WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET",
    ]),
    inspectForForbiddenAuthority("apps/deletion-coordinator/dist", [
      "API_KEY_HMAC_SECRET",
      "KMS_CONTENT_ROOT_KEY_ARN",
      "MCP_CURSOR_HMAC_SECRET",
      "WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET",
      "STORED_MEDIA",
      "WEBHOOK_INGRESS",
    ]),
  ]);
  console.info(
    "Production outputs and source maps contain no prohibited plaintext, test Layers, fakes, or fault injectors.",
  );
};

if (import.meta.main) await inspectProductionBundles();
