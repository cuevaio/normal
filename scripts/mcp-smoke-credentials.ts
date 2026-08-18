import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  type DeploymentSmokeConfig,
  runDeploymentSmoke,
} from "./deployment-smoke";

interface RefreshCredentialStore {
  readonly read: () => Promise<string>;
  readonly persist: (credential: string) => Promise<void>;
}

interface Dependencies {
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly store?: RefreshCredentialStore;
  readonly smoke?: typeof runDeploymentSmoke;
}

export interface RotatingDeploymentSmokeConfig {
  readonly apiOrigin: string;
  readonly clientId: string;
  readonly docsOrigin: string;
  readonly refreshSecretId: string;
  readonly smokeSecret: string;
  readonly webOrigin: string;
}

const remediation = "reauthorize the deployment-smoke MCP Authorization";

const fail = (outcome: string): never => {
  throw new Error(
    `mcp smoke credential ${outcome}; remediate by: ${remediation}`,
  );
};

const makeStore = (secretId: string): RefreshCredentialStore => {
  const client = new SecretsManagerClient({ region: "us-east-1" });
  const versionId = async (credential: string) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(credential),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  return {
    read: async () => {
      const response = await client.send(
        new GetSecretValueCommand({ SecretId: secretId }),
      );
      if (!response.SecretString) return fail("store unavailable");
      return response.SecretString;
    },
    persist: async (credential) => {
      await client.send(
        new PutSecretValueCommand({
          ClientRequestToken: await versionId(credential),
          SecretId: secretId,
          SecretString: credential,
        }),
      );
    },
  };
};

const readTokenPair = async (response: Response) => {
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    if (body?.error === "invalid_grant") return fail("invalid or reused");
    return fail("exchange unavailable");
  }
  if (
    typeof body?.access_token !== "string" ||
    typeof body.refresh_token !== "string" ||
    body.token_type !== "bearer"
  )
    return fail("exchange unavailable");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
  };
};

export const runRotatingDeploymentSmoke = async (
  config: RotatingDeploymentSmokeConfig,
  dependencies: Dependencies = {},
) => {
  const apiOrigin = new URL(config.apiOrigin).origin;
  const store = dependencies.store ?? makeStore(config.refreshSecretId);
  const fetch =
    dependencies.fetch ??
    ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  let current: string;
  try {
    current = await store.read();
    // Prove write authority before consuming the one-time refresh credential.
    await store.persist(current);
  } catch {
    return fail("store unavailable");
  }

  let response: Response;
  try {
    response = await fetch(`${apiOrigin}/oauth/token`, {
      body: new URLSearchParams({
        client_id: config.clientId,
        grant_type: "refresh_token",
        refresh_token: current,
        resource: `${apiOrigin}/mcp`,
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
  } catch {
    return fail("exchange unavailable");
  }
  const pair = await readTokenPair(response);
  try {
    await store.persist(pair.refreshToken);
  } catch {
    return fail("persistence failed");
  }

  const smokeConfig: DeploymentSmokeConfig = {
    apiOrigin,
    docsOrigin: new URL(config.docsOrigin).origin,
    mcpAccessToken: pair.accessToken,
    smokeSecret: config.smokeSecret,
    webOrigin: config.webOrigin,
  };
  return (dependencies.smoke ?? runDeploymentSmoke)(smokeConfig);
};

const required = (name: string): string => {
  const value = process.env[name];
  if (!value || /example|placeholder|replace/iu.test(value))
    throw new Error(`${name} is unavailable`);
  return value;
};

if (import.meta.main) {
  runRotatingDeploymentSmoke({
    apiOrigin: required("SMOKE_API_ORIGIN"),
    clientId: required("SMOKE_MCP_CLIENT_ID"),
    docsOrigin: required("SMOKE_DOCS_ORIGIN"),
    refreshSecretId: required("SMOKE_MCP_REFRESH_SECRET_ID"),
    smokeSecret: required("SMOKE_CHECK_SECRET"),
    webOrigin: required("SMOKE_WEB_ORIGIN"),
  })
    .then((result) => console.info(JSON.stringify(result)))
    .catch((error: unknown) => {
      console.error(
        error instanceof Error ? error.message : "mcp smoke credential failed",
      );
      process.exitCode = 1;
    });
}
