import { describe, expect, test } from "bun:test";

const read = (path: string) =>
  Bun.file(new URL(`../${path}`, import.meta.url)).text();

describe("production MCP smoke credential infrastructure", () => {
  test("restricts workflow identity and secret authority", async () => {
    const template = JSON.parse(
      await read("infra/aws/mcp-smoke-credential.template.json"),
    );
    const role = template.Resources.McpSmokeCredentialRole.Properties;
    const trust = role.AssumeRolePolicyDocument.Statement[0];
    const substitution = (name: string) => `${"$"}{${name}}`;
    expect(trust.Condition.StringEquals).toEqual({
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": [
        {
          "Fn::Sub": `repo:${substitution("GitHubRepositoryIdentity")}:environment:production`,
        },
        {
          "Fn::Sub": `repo:${substitution("GitHubRepositoryIdentity")}:environment:production-launch-gate`,
        },
      ],
    });
    expect(role.Policies[0].PolicyDocument.Statement).toEqual([
      {
        Action: [
          "secretsmanager:DescribeSecret",
          "secretsmanager:GetSecretValue",
          "secretsmanager:PutSecretValue",
        ],
        Effect: "Allow",
        Resource: { Ref: "McpSmokeRefreshCredential" },
      },
    ]);
  });

  test("both workflows serialize and use the shared rotating path", async () => {
    const deployment = await read(".github/workflows/deploy-production.yml");
    const launchGate = await read(".github/workflows/launch-gate.yml");
    const publicApiReleaseGate = await read(
      ".github/workflows/public-api-release-gate.yml",
    );
    for (const workflow of [deployment, launchGate, publicApiReleaseGate]) {
      expect(workflow).toContain("group: production");
      expect(workflow).toContain("id-token: write");
      expect(workflow).toContain("AWS_MCP_SMOKE_CREDENTIAL_ROLE_ARN");
      expect(workflow).toContain("MCP_SMOKE_REFRESH_SECRET_ID");
      expect(workflow).not.toContain("MCP_SMOKE_ACCESS_TOKEN");
      expect(workflow).not.toMatch(/\$GITHUB_(?:ENV|OUTPUT)/u);
    }
  });
});
