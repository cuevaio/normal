import { afterEach, describe, expect, test, vi } from "vitest";
import { createProductionHandler } from "../src/production";
import { validEnvironment } from "./support/production";

const authorizationUrl = (
  overrides: Readonly<Record<string, string>> = {},
): string => {
  const url = new URL("https://api.example.test/oauth/authorize");
  const parameters = {
    client_id: "claude",
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    resource: "https://api.example.test/mcp",
    response_type: "code",
    scope: "connections:read messages:send",
    state: "client-state",
    ...overrides,
  };
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
};

const environmentWithInspectableKv = () => {
  const values = new Map<string, string>();
  const environment = {
    ...validEnvironment(),
    OAUTH_KV: {
      delete: async (key: string) => {
        values.delete(key);
      },
      get: async (key: string, options?: unknown) => {
        const value = values.get(key);
        if (value === undefined) {
          return null;
        }
        return typeof options === "object" &&
          options !== null &&
          (options as { type?: unknown }).type === "json"
          ? JSON.parse(value)
          : value;
      },
      put: async (key: string, value: string) => {
        values.set(key, value);
      },
    },
  };
  return { environment, values };
};

describe("production OAuth boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("publishes authorization-server metadata for the exact issuer", async () => {
    const response = await createProductionHandler(validEnvironment())(
      new Request(
        "https://api.example.test/.well-known/oauth-authorization-server",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({
      authorization_endpoint: "https://api.example.test/oauth/authorize",
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      issuer: "https://api.example.test",
      response_types_supported: ["code"],
      scopes_supported: [
        "connections:read",
        "directory:read",
        "messages:read",
        "messages:send",
      ],
      token_endpoint: "https://api.example.test/oauth/token",
    });
  });

  test("publishes metadata behind an HTTPS-terminating development proxy", async () => {
    const handler = createProductionHandler(validEnvironment());
    const response = await handler(
      new Request(
        "http://api.example.test/.well-known/oauth-authorization-server",
        { headers: { "x-forwarded-proto": "https" } },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      issuer: "https://api.example.test",
    });

    const challenge = await handler(
      new Request("http://api.example.test/mcp", {
        headers: { "x-forwarded-proto": "https" },
      }),
    );
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://api.example.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test("publishes protected-resource metadata for the production MCP resource", async () => {
    const response = await createProductionHandler(validEnvironment())(
      new Request(
        "https://api.example.test/.well-known/oauth-protected-resource/mcp",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
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
  });

  test("admits an allowlisted client with its exact redirect and seals the consent handoff", async () => {
    const { environment, values } = environmentWithInspectableKv();
    const response = await createProductionHandler(environment)(
      new Request(authorizationUrl(), { redirect: "manual" }),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://app.example.test");
    expect(location.pathname).toBe("/oauth/consent");
    expect(location.searchParams.get("request")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.has("client_id")).toBe(false);
    expect(location.searchParams.has("redirect_uri")).toBe(false);

    const stored = [...values.entries()];
    expect(stored.some(([key]) => key.startsWith("client:"))).toBe(false);
    const handoff = stored.find(([key]) =>
      key.startsWith("oauth:authorization-request:"),
    );
    expect(handoff).toBeDefined();
    expect(handoff?.[0]).not.toContain(location.searchParams.get("request"));
    expect(handoff?.[1]).not.toContain("claude");
    expect(handoff?.[1]).not.toContain(
      "https://claude.ai/api/mcp/auth_callback",
    );
  });

  test("admits the deployment smoke client on an ephemeral loopback port", async () => {
    const response = await createProductionHandler(validEnvironment())(
      new Request(
        authorizationUrl({
          client_id: "deployment-smoke",
          redirect_uri: "http://127.0.0.1:54321/oauth/callback",
          scope: "connections:read",
        }),
        { redirect: "manual" },
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/oauth/consent");
  });

  test("rejects elevated scopes for the deployment smoke client", async () => {
    const response = await createProductionHandler(validEnvironment())(
      new Request(
        authorizationUrl({
          client_id: "deployment-smoke",
          redirect_uri: "http://127.0.0.1:54321/oauth/callback",
          scope: "connections:read messages:send",
        }),
        { redirect: "manual" },
      ),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  test.each([
    "http://127.0.0.1/oauth/callback",
    "http://127.0.0.1:0/oauth/callback",
    "http://127.1:54321/oauth/callback",
    "http://2130706433:54321/oauth/callback",
    "http://0x7f000001:54321/oauth/callback",
    "http://localhost:54321/oauth/callback",
    "http://127.0.0.1:54321/other",
    "http://127.0.0.1:54321/oauth/callback?next=attacker",
    "https://127.0.0.1:54321/oauth/callback",
  ])(
    "rejects an unregistered deployment smoke redirect at %s",
    async (redirectUri) => {
      const response = await createProductionHandler(validEnvironment())(
        new Request(
          authorizationUrl({
            client_id: "deployment-smoke",
            redirect_uri: redirectUri,
            scope: "connections:read",
          }),
          { redirect: "manual" },
        ),
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    },
  );

  test.each([
    "https://chatgpt.com/connector/oauth/djePJ1RTfjI5",
    "https://chatgpt.com/connector_platform_oauth_redirect",
  ])(
    "admits the source-defined ChatGPT public client at %s",
    async (redirectUri) => {
      const response = await createProductionHandler(validEnvironment())(
        new Request(
          authorizationUrl({
            client_id: "chatgpt",
            redirect_uri: redirectUri,
          }),
          { redirect: "manual" },
        ),
      );

      expect(response.status).toBe(302);
    },
  );

  test("admits a ChatGPT metadata client that prefers private key JWT", async () => {
    const clientId = "https://chatgpt.com/oauth/i3RmSsEOeX9b/client.json";
    const redirectUri = "https://chatgpt.com/connector/oauth/i3RmSsEOeX9b";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        expect(input.toString()).toBe(clientId);
        return Response.json({
          client_id: clientId,
          client_name: "ChatGPT",
          grant_types: ["authorization_code", "refresh_token"],
          jwks_uri: "https://chatgpt.com/oauth/jwks.json",
          redirect_uris: [redirectUri],
          response_types: ["code"],
          token_endpoint_auth_method: "private_key_jwt",
          token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
        });
      }),
    );
    const { environment, values } = environmentWithInspectableKv();
    const response = await createProductionHandler(environment)(
      new Request(
        authorizationUrl({
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: "connections:read directory:read messages:read messages:send",
        }),
        { redirect: "manual" },
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/oauth/consent");
    expect(
      JSON.parse(values.get(`client:${clientId}`) ?? "null"),
    ).toMatchObject({
      clientId,
      redirectUris: [redirectUri],
      tokenEndpointAuthMethod: "none",
    });
  });

  test("admits the reviewed Claude metadata client", async () => {
    const clientId = "https://claude.ai/oauth/mcp-oauth-client-metadata";
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        expect(input.toString()).toBe(clientId);
        return Response.json({
          client_id: clientId,
          client_name: "Claude",
          client_uri: "https://claude.ai",
          grant_types: [
            "authorization_code",
            "refresh_token",
            "urn:ietf:params:oauth:grant-type:jwt-bearer",
          ],
          redirect_uris: [redirectUri],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        });
      }),
    );
    const { environment, values } = environmentWithInspectableKv();
    const response = await createProductionHandler(environment)(
      new Request(
        authorizationUrl({
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: "connections:read directory:read messages:read messages:send",
        }),
        { redirect: "manual" },
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/oauth/consent");
    expect(
      JSON.parse(values.get(`client:${clientId}`) ?? "null"),
    ).toMatchObject({
      clientId,
      redirectUris: [redirectUri],
      tokenEndpointAuthMethod: "none",
    });
  });

  test.each([
    ["malformed", { response_type: "" }],
    ["unregistered client", { client_id: "unregistered-client" }],
    [
      "open redirect",
      { redirect_uri: "https://attacker.example.test/callback" },
    ],
    ["mismatched resource", { resource: "https://other.example.test/mcp" }],
    ["missing PKCE", { code_challenge: "" }],
    ["malformed PKCE", { code_challenge: "too-short" }],
    ["plain PKCE", { code_challenge_method: "plain" }],
    ["unsupported scope", { scope: "connections:read admin" }],
  ] as const)("rejects %s before consent", async (_name, overrides) => {
    const { environment, values } = environmentWithInspectableKv();
    const response = await createProductionHandler(environment)(
      new Request(authorizationUrl(overrides), { redirect: "manual" }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "invalid_authorization_request",
    });
    expect(
      [...values.keys()].some((key) =>
        key.startsWith("oauth:authorization-request:"),
      ),
    ).toBe(false);
  });

  test("does not expose dynamic client registration", async () => {
    const response = await createProductionHandler(validEnvironment())(
      new Request("https://api.example.test/oauth/register", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(404);
  });

  test("does not treat a stale KV client record as allowlisted", async () => {
    const { environment, values } = environmentWithInspectableKv();
    values.set(
      "client:unregistered-client",
      JSON.stringify({
        clientId: "unregistered-client",
        redirectUris: ["https://attacker.example.test/callback"],
        tokenEndpointAuthMethod: "none",
      }),
    );

    const response = await createProductionHandler(environment)(
      new Request("https://api.example.test/oauth/token", {
        body: new URLSearchParams({
          client_id: "unregistered-client",
          code: "not-an-authorization-code",
          code_verifier: "A".repeat(43),
          grant_type: "authorization_code",
          redirect_uri: "https://attacker.example.test/callback",
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  });
});
