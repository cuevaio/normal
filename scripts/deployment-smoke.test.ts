import { describe, expect, test } from "bun:test";
import { runDeploymentSmoke } from "./deployment-smoke";

const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const docsHome = () =>
  new Response(
    "<html>/vendor/scalar/1.65.1/standalone.js /openapi.json</html>",
    {
      headers: {
        "content-security-policy":
          "default-src 'self'; script-src 'self' 'nonce-normal-docs-scalar'",
        "content-type": "text/html",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      },
    },
  );

const docsOpenApi = () =>
  json({ openapi: "3.1.0", paths: { "/v1/connections": {} } }, 200, {
    "cache-control": "public, max-age=300, must-revalidate",
    "x-content-type-options": "nosniff",
  });

const smokeOrigins = {
  apiOrigin: "https://api.example.test",
  docsOrigin: "https://docs.example.test",
  webOrigin: "https://web.example.test",
} as const;

const respondDocs = (url: URL) => {
  if (url.origin !== "https://docs.example.test") return null;
  return url.pathname === "/openapi.json" ? docsOpenApi() : docsHome();
};

describe("deployed production smoke command", () => {
  test("validates public discovery and waits for the private canary", async () => {
    const requests: Array<{
      authorization: string | null;
      method: string;
      path: string;
    }> = [];
    let polls = 0;
    const fetch = async (input: string, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push({
        authorization: request.headers.get("authorization"),
        method: request.method,
        path: url.pathname,
      });
      if (url.origin === "https://web.example.test")
        return json({ service: "web", status: "ok" });
      const docs = respondDocs(url);
      if (docs) return docs;
      if (url.pathname === "/health")
        return json({ service: "api", status: "ok" });
      if (url.pathname === "/ready")
        return json({ service: "api", status: "ready" });
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return json({
          authorization_endpoint: `${url.origin}/oauth/authorize`,
          code_challenge_methods_supported: ["S256"],
          issuer: url.origin,
          scopes_supported: [
            "connections:read",
            "directory:read",
            "messages:read",
            "messages:send",
          ],
          token_endpoint: `${url.origin}/oauth/token`,
        });
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
        return json({
          authorization_servers: [url.origin],
          bearer_methods_supported: ["header"],
          resource: `${url.origin}/mcp`,
          scopes_supported: [
            "connections:read",
            "directory:read",
            "messages:read",
            "messages:send",
          ],
        });
      if (url.pathname === "/mcp") {
        const payload = (await request.json()) as { id: string };
        return new Response(
          `event: message\ndata: ${JSON.stringify({ id: payload.id, jsonrpc: "2.0", result: {} })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (request.method === "POST")
        return json({ canary_id: `smk_${"a".repeat(43)}` }, 202);
      polls += 1;
      return json({
        status: polls === 1 ? "pending" : "complete",
        subsystems:
          polls === 1
            ? []
            : ["database", "provider-control", "queue", "r2-kms"],
      });
    };

    const result = await runDeploymentSmoke(
      {
        ...smokeOrigins,
        mcpAccessToken: "mcp-secret",
        smokeSecret: "smoke-secret",
      },
      { fetch, pollDelayMs: 0 },
    );

    expect(result).toEqual({
      checks: [
        "web",
        "docs",
        "api",
        "oauth",
        "mcp",
        "database",
        "provider-control",
        "queue",
        "r2-kms",
      ],
      status: "ok",
    });
    expect(
      requests.find((request) => request.path === "/mcp")?.authorization,
    ).toBe("Bearer mcp-secret");
    expect(
      requests
        .filter((request) => request.path === "/_internal/deployment-smoke")
        .every((request) => request.authorization === "Bearer smoke-secret"),
    ).toBe(true);
  });

  test("reports only the safe subsystem and remediation command", async () => {
    const fetch = async (input: string) => {
      const url = new URL(input);
      const docs = respondDocs(url);
      if (docs) return docs;
      if (
        url.origin === "https://api.example.test" &&
        url.pathname === "/health"
      )
        return json({ service: "api", status: "unavailable" }, 503);
      return json({ service: "web", status: "ok" });
    };

    await expect(
      runDeploymentSmoke(
        {
          ...smokeOrigins,
          mcpAccessToken: "must-not-leak",
          smokeSecret: "must-not-leak-either",
        },
        { fetch, pollDelayMs: 0 },
      ),
    ).rejects.toThrow("api failed; remediate with: bun run deploy:smoke");
  });

  test("rejects a successful response whose health body is unavailable", async () => {
    const fetch = async (input: string) => {
      const url = new URL(input);
      if (url.origin === "https://web.example.test")
        return json({ service: "web", status: "ok" });
      const docs = respondDocs(url);
      if (docs) return docs;
      return json({ service: "api", status: "unavailable" });
    };

    await expect(
      runDeploymentSmoke(
        {
          ...smokeOrigins,
          mcpAccessToken: "must-not-leak",
          smokeSecret: "must-not-leak-either",
        },
        { fetch, pollDelayMs: 0 },
      ),
    ).rejects.toThrow("api failed; remediate with: bun run deploy:smoke");
  });

  test("reports an asynchronous R2/KMS failure without canary data", async () => {
    const fetch = async (input: string, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(input);
      if (url.origin === "https://web.example.test")
        return json({ service: "web", status: "ok" });
      const docs = respondDocs(url);
      if (docs) return docs;
      if (url.pathname === "/health")
        return json({ service: "api", status: "ok" });
      if (url.pathname === "/ready")
        return json({ service: "api", status: "ready" });
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return json({
          authorization_endpoint: `${url.origin}/oauth/authorize`,
          code_challenge_methods_supported: ["S256"],
          issuer: url.origin,
          scopes_supported: [
            "connections:read",
            "directory:read",
            "messages:read",
            "messages:send",
          ],
          token_endpoint: `${url.origin}/oauth/token`,
        });
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
        return json({
          authorization_servers: [url.origin],
          bearer_methods_supported: ["header"],
          resource: `${url.origin}/mcp`,
          scopes_supported: [
            "connections:read",
            "directory:read",
            "messages:read",
            "messages:send",
          ],
        });
      if (url.pathname === "/mcp") {
        const payload = (await request.json()) as { id: string };
        return json({ id: payload.id, jsonrpc: "2.0", result: {} });
      }
      if (request.method === "POST")
        return json({ canary_id: `smk_${"a".repeat(43)}` }, 202);
      return json({ status: "failed", subsystems: ["r2-kms"] });
    };
    await expect(
      runDeploymentSmoke(
        {
          ...smokeOrigins,
          mcpAccessToken: "hidden",
          smokeSecret: "hidden",
        },
        { fetch, pollDelayMs: 0 },
      ),
    ).rejects.toThrow("r2-kms failed; remediate with: bun run deploy:smoke");
  });

  test("rejects a docs origin that collides with the API", async () => {
    await expect(
      runDeploymentSmoke(
        {
          apiOrigin: "https://api.example.test",
          docsOrigin: "https://api.example.test",
          mcpAccessToken: "must-not-leak",
          smokeSecret: "must-not-leak-either",
          webOrigin: "https://web.example.test",
        },
        { fetch: async () => json({ service: "web", status: "ok" }) },
      ),
    ).rejects.toThrow("docs failed; remediate with: bun run deploy:smoke");
  });

  test("reports a static docs failure without leaking the document", async () => {
    const fetch = async (input: string) => {
      const url = new URL(input);
      if (url.origin === "https://web.example.test")
        return json({ service: "web", status: "ok" });
      return new Response("must-not-leak-openapi", {
        headers: { "content-type": "text/html" },
      });
    };

    let error: Error | undefined;
    try {
      await runDeploymentSmoke(
        {
          ...smokeOrigins,
          mcpAccessToken: "must-not-leak",
          smokeSecret: "must-not-leak-either",
        },
        { fetch, pollDelayMs: 0 },
      );
    } catch (cause) {
      error = cause as Error;
    }
    expect(error?.message).toBe(
      "docs failed; remediate with: bun run deploy:smoke",
    );
    expect(error?.message).not.toContain("must-not-leak-openapi");
  });
});
