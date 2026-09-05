import { describe, expect, test } from "bun:test";
import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  makeRefreshCredentialStore,
  runRotatingDeploymentSmoke,
} from "./mcp-smoke-credentials";

const config = {
  apiOrigin: "https://api.example.test",
  docsOrigin: "https://docs.example.test",
  refreshSecretId: "production/mcp-smoke-refresh",
  smokeSecret: "smoke-secret",
  webOrigin: "https://web.example.test",
};

describe("rotating deployment MCP smoke credentials", () => {
  test("reads the exact current version instead of a stale default value", async () => {
    const currentVersionId = "b".repeat(64);
    const predecessorVersionId = "a".repeat(64);
    const client = {
      send: async (command: unknown) => {
        if (command instanceof DescribeSecretCommand) {
          return {
            VersionIdsToStages: {
              [currentVersionId]: ["AWSCURRENT"],
              [predecessorVersionId]: ["AWSPREVIOUS"],
            },
          };
        }
        if (command instanceof GetSecretValueCommand) {
          return command.input.VersionId === currentVersionId &&
            command.input.VersionStage === "AWSCURRENT"
            ? {
                SecretString: "current-refresh",
                VersionId: currentVersionId,
                VersionStages: ["AWSCURRENT"],
              }
            : {
                SecretString: "consumed-predecessor",
                VersionId: predecessorVersionId,
                VersionStages: ["AWSPREVIOUS"],
              };
        }
        throw new Error("unexpected command");
      },
    } as unknown as SecretsManagerClient;

    const store = makeRefreshCredentialStore(config.refreshSecretId, client);

    expect(await store.read()).toBe("current-refresh");
  });

  test("persists the descendant before using the ephemeral access token", async () => {
    const persisted: string[] = [];
    const events: string[] = [];
    const result = await runRotatingDeploymentSmoke(config, {
      fetch: async (_input, init) => {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("refresh_token")).toBe("current-refresh");
        expect(body.get("client_id")).toBe("deployment-smoke");
        expect(body.get("resource")).toBe("https://api.example.test/mcp");
        events.push("exchange");
        return Response.json({
          access_token: "ephemeral-access",
          refresh_token: "descendant-refresh",
          token_type: "bearer",
        });
      },
      smoke: async (smokeConfig) => {
        events.push("smoke");
        expect(smokeConfig.mcpAccessToken).toBe("ephemeral-access");
        expect(smokeConfig.docsOrigin).toBe("https://docs.example.test");
        expect(persisted).toEqual(["current-refresh", "descendant-refresh"]);
        return { status: "ok" as const } as Awaited<
          ReturnType<typeof import("./deployment-smoke").runDeploymentSmoke>
        >;
      },
      store: {
        persist: async (credential) => {
          persisted.push(credential);
          events.push(`persist:${credential}`);
        },
        read: async () => "current-refresh",
      },
    });

    expect(result.status).toBe("ok");
    expect(events).toEqual([
      "persist:current-refresh",
      "exchange",
      "persist:descendant-refresh",
      "smoke",
    ]);
    expect(persisted).not.toContain("ephemeral-access");
  });

  test("does not consume the credential when durable persistence is unavailable", async () => {
    let exchanges = 0;
    await expect(
      runRotatingDeploymentSmoke(config, {
        fetch: async () => {
          exchanges += 1;
          return new Response();
        },
        store: {
          persist: async () => {
            throw new Error("sensitive store detail");
          },
          read: async () => "current-refresh",
        },
      }),
    ).rejects.toThrow("mcp smoke credential store unavailable");
    expect(exchanges).toBe(0);
  });

  test("fails closed after descendant persistence failure without running smoke", async () => {
    let writes = 0;
    let smokeRuns = 0;
    await expect(
      runRotatingDeploymentSmoke(config, {
        fetch: async () =>
          Response.json({
            access_token: "must-not-leak-access",
            refresh_token: "must-not-leak-descendant",
            token_type: "bearer",
          }),
        smoke: async () => {
          smokeRuns += 1;
          throw new Error("unreachable");
        },
        store: {
          persist: async () => {
            writes += 1;
            if (writes === 2) throw new Error("must-not-leak-store-detail");
          },
          read: async () => "must-not-leak-current",
        },
      }),
    ).rejects.toThrow("mcp smoke credential persistence failed");
    expect(smokeRuns).toBe(0);
  });

  test("reports invalid or reused credentials without raw OAuth diagnostics", async () => {
    const current = "must-not-leak-current";
    let exchanges = 0;
    let error: Error | undefined;
    try {
      await runRotatingDeploymentSmoke(config, {
        fetch: async () => {
          exchanges += 1;
          return Response.json(
            { error: "invalid_grant", error_description: current },
            { status: 400 },
          );
        },
        store: {
          persist: async () => undefined,
          read: async () => current,
        },
      });
    } catch (cause) {
      error = cause as Error;
    }
    expect(exchanges).toBe(1);
    expect(error?.message).toContain("invalid or reused");
    expect(error?.message).not.toContain(current);
    expect(error?.message).not.toContain("invalid_grant");
  });
});
