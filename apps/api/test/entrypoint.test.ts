import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

describe("API Worker entrypoint", () => {
  test("serves the health canary through the configured Worker export", async () => {
    const response = await exports.default.fetch(
      "https://api.example.test/health",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: "api", status: "ok" });
  });

  test("serves OAuth metadata through the configured Worker export", async () => {
    const protectedResourceResponse = await exports.default.fetch(
      "https://api.example.test/.well-known/oauth-protected-resource/mcp",
    );

    expect(protectedResourceResponse.status).toBe(200);
    expect(await protectedResourceResponse.json()).toEqual({
      authorization_servers: ["https://api.example.test"],
      bearer_methods_supported: ["header"],
      resource: "https://api.example.test/mcp",
      resource_name: "Normal",
      scopes_supported: [
        "connections:read",
        "directory:read",
        "messages:read",
        "messages:send",
      ],
    });

    const authorizationServerResponse = await exports.default.fetch(
      "https://api.example.test/.well-known/oauth-authorization-server",
    );
    expect(authorizationServerResponse.status).toBe(200);
    expect(await authorizationServerResponse.json()).toMatchObject({
      client_id_metadata_document_supported: true,
    });
  });

  test("challenges the protected MCP resource with its metadata URL", async () => {
    const response = await exports.default.fetch(
      new Request("https://api.example.test/mcp", {
        body: JSON.stringify({
          id: "request-1",
          jsonrpc: "2.0",
          method: "tools/list",
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://api.example.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test("routes API Key-shaped MCP credentials before OAuth validation", async () => {
    const response = await exports.default.fetch(
      new Request("https://api.example.test/mcp", {
        body: JSON.stringify({
          id: "request-1",
          jsonrpc: "2.0",
          method: "tools/list",
        }),
        headers: {
          authorization: "bearer normal_apk_invalid",
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token"',
    );
    expect(await response.json()).toEqual({ error: "invalid_token" });
  });

  test("admits only an exact allowlisted OAuth request through real Worker KV", async () => {
    const url = new URL("https://api.example.test/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: "claude",
      code_challenge: "A".repeat(43),
      code_challenge_method: "S256",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      resource: "https://api.example.test/mcp",
      response_type: "code",
      scope: "connections:read",
      state: "worker-state",
    }).toString();

    const accepted = await exports.default.fetch(
      new Request(url, { redirect: "manual" }),
    );
    expect(accepted.status).toBe(302);
    const consent = new URL(accepted.headers.get("location") ?? "");
    const lookupSecret = consent.searchParams.get("request") ?? "";
    const lookupHash = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(lookupSecret),
      ),
    );
    const encodedHash = btoa(String.fromCharCode(...lookupHash))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    const sealed = await env.OAUTH_KV.get(
      `oauth:authorization-request:${encodedHash}`,
    );
    expect(sealed).not.toBeNull();
    expect(sealed).not.toContain("claude");
    expect(sealed).not.toContain("client.example.test");

    url.searchParams.set(
      "redirect_uri",
      "https://attacker.example.test/callback",
    );
    const rejected = await exports.default.fetch(
      new Request(url, { redirect: "manual" }),
    );
    expect(rejected.status).toBe(400);
    expect(rejected.headers.get("location")).toBeNull();
  });
});
