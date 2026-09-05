import { describe, expect, test } from "bun:test";
import { runMcpSmokeCredentialBootstrap } from "./bootstrap-mcp-smoke-credential";

describe("MCP smoke credential bootstrap", () => {
  test("uses dedicated PKCE consent and persists only the refresh credential", async () => {
    const events: string[] = [];
    const persisted: string[] = [];
    const secrets = ["v".repeat(43), "s".repeat(43)];

    const result = await runMcpSmokeCredentialBootstrap(
      { apiOrigin: "https://api.example.test" },
      {
        authorize: async ({ authorizationUrlFor, state }) => {
          events.push("authorize");
          expect(state).toBe("s".repeat(43));
          const url = authorizationUrlFor(
            "http://127.0.0.1:54321/oauth/callback",
          );
          expect(url.origin).toBe("https://api.example.test");
          expect(url.pathname).toBe("/oauth/authorize");
          expect(url.searchParams.get("client_id")).toBe("deployment-smoke");
          expect(url.searchParams.get("redirect_uri")).toBe(
            "http://127.0.0.1:54321/oauth/callback",
          );
          expect(url.searchParams.get("scope")).toBe("connections:read");
          expect(url.searchParams.get("code_challenge_method")).toBe("S256");
          expect(url.searchParams.get("code_challenge")).toMatch(
            /^[A-Za-z0-9_-]{43}$/,
          );
          return {
            code: "authorization-code",
            redirectUri: "http://127.0.0.1:54321/oauth/callback",
          };
        },
        fetch: async (input, init) => {
          events.push("exchange");
          expect(input).toBe("https://api.example.test/oauth/token");
          const body = new URLSearchParams(String(init?.body));
          expect(body.get("client_id")).toBe("deployment-smoke");
          expect(body.get("code")).toBe("authorization-code");
          expect(body.get("code_verifier")).toBe("v".repeat(43));
          expect(body.get("grant_type")).toBe("authorization_code");
          expect(body.get("redirect_uri")).toBe(
            "http://127.0.0.1:54321/oauth/callback",
          );
          return Response.json({
            access_token: "must-not-persist-access",
            refresh_token: "new-refresh",
            token_type: "bearer",
          });
        },
        randomSecret: () => secrets.shift() ?? "unreachable",
        store: {
          assertAvailable: async () => {
            events.push("available");
          },
          persist: async (credential) => {
            events.push(`persist:${credential}`);
            persisted.push(credential);
          },
        },
      },
    );

    expect(result).toEqual({ status: "ok" });
    expect(events).toEqual([
      "available",
      "authorize",
      "exchange",
      "persist:new-refresh",
    ]);
    expect(persisted).not.toContain("must-not-persist-access");
    expect(persisted).not.toContain("authorization-code");
  });
});
