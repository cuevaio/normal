import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { serializedOpenApiDocument } from "@whatsapp-mcp/contracts/openapi-artifact";
import { type ProblemCode, problemTitles } from "@whatsapp-mcp/contracts/rest";
import { SCALAR_BUNDLE_PUBLIC_PATH } from "../src/scalar-bundle";
import { scalarConfiguration } from "../src/scalar-configuration";
import {
  CONTENT_SECURITY_POLICY,
  OPENAPI_CACHE_CONTROL,
  SCALAR_BUNDLE_CACHE_CONTROL,
} from "../src/static-headers";

const distRoot = join(import.meta.dir, "../dist");
const vercelManifest = (await Bun.file(
  join(import.meta.dir, "../vercel.json"),
).json()) as {
  readonly buildCommand?: string;
  readonly framework?: string;
  readonly headers?: ReadonlyArray<{
    readonly headers: ReadonlyArray<{
      readonly key: string;
      readonly value: string;
    }>;
    readonly source: string;
  }>;
  readonly installCommand?: string;
  readonly outputDirectory?: string;
  readonly rewrites?: unknown;
  readonly routes?: unknown;
};

const headerValue = (source: string, key: string): string | undefined =>
  vercelManifest.headers
    ?.find((entry) => entry.source === source)
    ?.headers.find((header) => header.key === key)?.value;

describe("static Scalar documentation", () => {
  test("publishes the generated OpenAPI 3.1 document without secrets", async () => {
    const openApi = await Bun.file(join(distRoot, "openapi.json")).text();
    expect(openApi).toBe(serializedOpenApiDocument());
    const document = JSON.parse(openApi) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        "/v1/api-keys",
        "/v1/api-keys/{api_key_id}",
        "/v1/connections",
        "/v1/connections/{connection_id}/send-operations",
      ]),
    );
    expect(openApi).not.toMatch(
      /normal_apk_[A-Za-z0-9_-]{21}\.[A-Za-z0-9_-]+/u,
    );
    expect(openApi).not.toContain("+1555");
    expect(openApi).not.toContain("temporary-secret");
    expect(openApi).not.toContain("TEST_LAYER_SENTINEL");
  });

  test("self-hosts the pinned Scalar bundle and disables request execution", async () => {
    const html = await Bun.file(join(distRoot, "index.html")).text();
    expect(html).toContain(SCALAR_BUNDLE_PUBLIC_PATH);
    expect(html).not.toContain("cdn.jsdelivr.net");
    expect(html).not.toContain("cdn.scalar.com");
    expect(html).not.toContain("proxy.scalar.com");
    expect(html).not.toContain("registry.scalar.com");
    expect(scalarConfiguration.hideTestRequestButton).toBe(true);
    expect(scalarConfiguration.persistAuth).toBe(false);
    expect(scalarConfiguration.hideClientButton).toBe(true);
    expect(scalarConfiguration.telemetry).toBe(false);
    expect(scalarConfiguration.hiddenClients).toEqual({ js: true });
    expect(scalarConfiguration.defaultHttpClient).toEqual({
      clientKey: "curl",
      targetKey: "shell",
    });
    expect("proxyUrl" in scalarConfiguration).toBe(false);
    expect("agent" in scalarConfiguration).toBe(false);
    expect(
      await Bun.file(join(distRoot, SCALAR_BUNDLE_PUBLIC_PATH)).exists(),
    ).toBe(true);
  });

  test("keeps Problem Details type URLs and robots reachable", async () => {
    for (const code of Object.keys(problemTitles) as ProblemCode[]) {
      const nested = Bun.file(join(distRoot, "problems", code, "index.html"));
      const flat = Bun.file(join(distRoot, "problems", `${code}.html`));
      const page = (await nested.exists())
        ? await nested.text()
        : await flat.text();
      expect(page).toContain(problemTitles[code]);
      expect(page).toContain(`https://docs.normal.fast/problems/${code}`);
    }
    expect(await Bun.file(join(distRoot, "robots.txt")).text()).toContain(
      "Allow: /",
    );
  });

  test("declares CSP, immutable Scalar caching, and no Vercel proxy", () => {
    expect(vercelManifest.framework).toBe("astro");
    expect(vercelManifest.outputDirectory).toBe("dist");
    expect(vercelManifest.installCommand).toBe(
      "cd ../.. && bun install --frozen-lockfile",
    );
    expect(vercelManifest.buildCommand).toContain(
      "bun x turbo run build --filter=@whatsapp-mcp/docs",
    );
    expect(vercelManifest.rewrites).toBeUndefined();
    expect(vercelManifest.routes).toBeUndefined();
    expect(headerValue("/vendor/scalar/(.*)", "Cache-Control")).toBe(
      SCALAR_BUNDLE_CACHE_CONTROL,
    );
    expect(headerValue("/openapi.json", "Cache-Control")).toBe(
      OPENAPI_CACHE_CONTROL,
    );
    expect(headerValue("/(.*)", "Content-Security-Policy")).toBe(
      CONTENT_SECURITY_POLICY,
    );
    expect(headerValue("/(.*)", "Referrer-Policy")).toBe("no-referrer");
  });

  test("does not ship test markers in the static output", async () => {
    const inspect = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await inspect(path);
          continue;
        }
        if (!entry.isFile()) continue;
        const contents = await Bun.file(path).text();
        expect(contents).not.toContain(
          "TEST_LAYER_SENTINEL_DO_NOT_INCLUDE_IN_PRODUCTION",
        );
        expect(contents).not.toContain("temporary-secret");
      }
    };
    await inspect(distRoot);
  });
});
