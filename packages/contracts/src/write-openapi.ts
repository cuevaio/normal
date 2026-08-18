import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateOpenApiDocument } from "./openapi";

export const serializedOpenApiDocument = (): string =>
  `${JSON.stringify(generateOpenApiDocument(), null, 2)}\n`;

export const openApiArtifactPath = (): string =>
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../apps/docs/public/openapi.json",
  );

export const writeOpenApiArtifact = async (
  path = openApiArtifactPath(),
): Promise<string> => {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, serializedOpenApiDocument());
  return path;
};

if (import.meta.main) {
  const path = await writeOpenApiArtifact();
  console.info(`Wrote OpenAPI artifact to ${path}`);
}
