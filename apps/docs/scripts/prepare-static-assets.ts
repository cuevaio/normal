import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { writeOpenApiArtifact } from "@whatsapp-mcp/contracts/openapi-artifact";
import {
  SCALAR_BUNDLE_FILE_NAME,
  SCALAR_BUNDLE_PUBLIC_DIRECTORY,
} from "../src/scalar-bundle";

const require = createRequire(import.meta.url);
const packageDirectory = dirname(
  require.resolve("@scalar/api-reference/package.json"),
);
const bundleCandidates = [
  join(packageDirectory, "dist/browser/standalone.js"),
  join(packageDirectory, "dist/standalone.js"),
  join(packageDirectory, "browser/standalone.js"),
];

const sourceBundle = (
  await Promise.all(
    bundleCandidates.map(async (candidate) =>
      (await Bun.file(candidate).exists()) ? candidate : null,
    ),
  )
).find((candidate) => candidate !== null);

if (sourceBundle === undefined) {
  throw new Error(
    "Pinned @scalar/api-reference browser bundle was not found in the installed package.",
  );
}

const publicDirectory = join(
  import.meta.dir,
  `../public${SCALAR_BUNDLE_PUBLIC_DIRECTORY}`,
);
await mkdir(publicDirectory, { recursive: true });
await cp(sourceBundle, join(publicDirectory, SCALAR_BUNDLE_FILE_NAME));
const openApiPath = await writeOpenApiArtifact();
console.info(`Copied Scalar bundle from ${sourceBundle}`);
console.info(`Wrote OpenAPI artifact to ${openApiPath}`);
