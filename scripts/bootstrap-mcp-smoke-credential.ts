import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  type BootstrapRefreshCredentialStore,
  makeRefreshCredentialStore,
} from "./mcp-smoke-credentials";

const clientId = "deployment-smoke";
const callbackPath = "/oauth/callback";
const authorizationTimeoutMs = 10 * 60 * 1_000;

interface BootstrapConfig {
  readonly apiOrigin: string;
}

interface AuthorizeInput {
  readonly authorizationUrlFor: (redirectUri: string) => URL;
  readonly state: string;
}

interface BootstrapDependencies {
  readonly authorize?:
    | ((input: AuthorizeInput) => Promise<{
        readonly code: string;
        readonly redirectUri: string;
      }>)
    | undefined;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly randomSecret?: (() => string) | undefined;
  readonly store: BootstrapRefreshCredentialStore;
}

const randomSecret = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
};

const challengeFor = async (verifier: string): Promise<string> =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");

const openBrowser = async (url: string): Promise<void> => {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "linux"
        ? ["xdg-open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : null;
  if (command === null) {
    console.info(`Open this authorization URL in a browser:\n${url}`);
    return;
  }
  const child = Bun.spawn(command, { stderr: "ignore", stdout: "ignore" });
  if ((await child.exited) !== 0) {
    console.info(`Open this authorization URL in a browser:\n${url}`);
  }
};

const authorizeLocally = async ({
  authorizationUrlFor,
  state,
}: AuthorizeInput): Promise<{
  readonly code: string;
  readonly redirectUri: string;
}> => {
  let resolveGrant: (code: string) => void = () => undefined;
  let rejectGrant: (cause: Error) => void = () => undefined;
  const grant = new Promise<string>((resolve, reject) => {
    resolveGrant = resolve;
    rejectGrant = reject;
  });
  const server = Bun.serve({
    fetch: (request) => {
      const url = new URL(request.url);
      if (
        request.method !== "GET" ||
        url.hostname !== "127.0.0.1" ||
        url.pathname !== callbackPath ||
        url.searchParams.get("state") !== state
      ) {
        return new Response("Invalid authorization callback.", {
          headers: { "cache-control": "no-store" },
          status: 400,
        });
      }
      const code = url.searchParams.get("code");
      if (url.searchParams.has("error") || !code) {
        rejectGrant(new Error("authorization denied"));
        return new Response("Authorization was not completed.", {
          headers: { "cache-control": "no-store" },
          status: 400,
        });
      }
      resolveGrant(code);
      return new Response("Authorization received. Return to the terminal.", {
        headers: { "cache-control": "no-store" },
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  if (server.port === undefined) {
    server.stop(true);
    throw new Error("local callback unavailable");
  }
  const redirectUri = `http://127.0.0.1:${server.port}${callbackPath}`;
  const timeout = setTimeout(
    () => rejectGrant(new Error("authorization timed out")),
    authorizationTimeoutMs,
  );
  try {
    await openBrowser(authorizationUrlFor(redirectUri).toString());
    return { code: await grant, redirectUri };
  } finally {
    clearTimeout(timeout);
    await server.stop();
  }
};

const readTokenPair = async (
  response: Response,
): Promise<{ readonly refreshToken: string }> => {
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (
    !response.ok ||
    typeof body?.access_token !== "string" ||
    typeof body.refresh_token !== "string" ||
    body.token_type !== "bearer"
  ) {
    throw new Error("token exchange failed");
  }
  return { refreshToken: body.refresh_token };
};

export const runMcpSmokeCredentialBootstrap = async (
  config: BootstrapConfig,
  dependencies: BootstrapDependencies,
): Promise<{ readonly status: "ok" }> => {
  const apiOrigin = new URL(config.apiOrigin).origin;
  const fetch =
    dependencies.fetch ??
    ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const makeSecret = dependencies.randomSecret ?? randomSecret;

  try {
    await dependencies.store.assertAvailable();
  } catch {
    throw new Error("MCP smoke credential store is unavailable");
  }

  const verifier = makeSecret();
  const state = makeSecret();
  const challenge = await challengeFor(verifier);
  const authorizationUrlFor = (redirectUri: string) => {
    const url = new URL("/oauth/authorize", apiOrigin);
    url.search = new URLSearchParams({
      client_id: clientId,
      code_challenge: challenge,
      code_challenge_method: "S256",
      redirect_uri: redirectUri,
      resource: `${apiOrigin}/mcp`,
      response_type: "code",
      scope: "connections:read",
      state,
    }).toString();
    return url;
  };

  let grant: { readonly code: string; readonly redirectUri: string };
  try {
    grant = await (dependencies.authorize ?? authorizeLocally)({
      authorizationUrlFor,
      state,
    });
  } catch {
    throw new Error("MCP smoke authorization was not completed");
  }

  let response: Response;
  try {
    response = await fetch(`${apiOrigin}/oauth/token`, {
      body: new URLSearchParams({
        client_id: clientId,
        code: grant.code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: grant.redirectUri,
        resource: `${apiOrigin}/mcp`,
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
  } catch {
    throw new Error("MCP smoke token exchange is unavailable");
  }
  const pair = await readTokenPair(response);
  try {
    await dependencies.store.persist(pair.refreshToken);
  } catch {
    throw new Error("MCP smoke credential persistence failed");
  }
  return { status: "ok" };
};

const required = (name: string): string => {
  const value = process.env[name];
  if (!value || /example|placeholder|replace/iu.test(value)) {
    throw new Error(`${name} is unavailable`);
  }
  return value;
};

const assumeSmokeRole = async (
  roleArn: string,
): Promise<SecretsManagerClient> => {
  const child = Bun.spawn(
    [
      "aws",
      "sts",
      "assume-role",
      "--role-arn",
      roleArn,
      "--role-session-name",
      "production-mcp-smoke-bootstrap",
      "--duration-seconds",
      "900",
      "--output",
      "json",
      "--query",
      "Credentials",
    ],
    {
      env: { ...process.env, AWS_PAGER: "" },
      stderr: "ignore",
      stdout: "pipe",
    },
  );
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) {
    throw new Error("MCP smoke AWS role assumption failed");
  }
  const credentials = JSON.parse(output) as Record<string, unknown>;
  if (
    typeof credentials.AccessKeyId !== "string" ||
    typeof credentials.SecretAccessKey !== "string" ||
    typeof credentials.SessionToken !== "string"
  ) {
    throw new Error("MCP smoke AWS role assumption failed");
  }
  return new SecretsManagerClient({
    credentials: {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    },
    region: "us-east-1",
  });
};

if (import.meta.main) {
  const apiOrigin = required("SMOKE_API_ORIGIN");
  const secretId = required("SMOKE_MCP_REFRESH_SECRET_ID");
  assumeSmokeRole(required("AWS_MCP_SMOKE_CREDENTIAL_ROLE_ARN"))
    .then((client) =>
      runMcpSmokeCredentialBootstrap(
        { apiOrigin },
        { store: makeRefreshCredentialStore(secretId, client) },
      ),
    )
    .then((result) => console.info(JSON.stringify(result)))
    .catch((error: unknown) => {
      console.error(
        error instanceof Error
          ? error.message
          : "MCP smoke credential bootstrap failed",
      );
      process.exitCode = 1;
    });
}
