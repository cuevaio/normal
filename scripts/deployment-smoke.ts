export interface DeploymentSmokeConfig {
  readonly apiOrigin: string;
  readonly docsOrigin: string;
  readonly mcpAccessToken: string;
  readonly smokeSecret: string;
  readonly webOrigin: string;
}

interface Dependencies {
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly pollDelayMs?: number;
}

const remediation = "bun run deploy:smoke";
const scopes = [
  "connections:read",
  "directory:read",
  "messages:read",
  "messages:send",
];
const canaryPattern = /^smk_[A-Za-z0-9_-]{43}$/u;

const fail = (subsystem: string): never => {
  throw new Error(`${subsystem} failed; remediate with: ${remediation}`);
};

const sameStrings = (value: unknown, expected: ReadonlyArray<string>) =>
  Array.isArray(value) &&
  value.length === expected.length &&
  expected.every((item) => value.includes(item));

const requestJson = async (
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  subsystem: string,
  input: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> => {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch {
    return fail(subsystem);
  }
  if (!response.ok) return fail(subsystem);
  const body = await response.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return fail(subsystem);
  return body as Record<string, unknown>;
};

const requestMcpJson = async (
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  input: string,
  init: RequestInit,
): Promise<Record<string, unknown>> => {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch {
    return fail("mcp");
  }
  if (!response.ok) return fail("mcp");
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await response.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return fail("mcp");
    return body as Record<string, unknown>;
  }
  if (!contentType.includes("text/event-stream")) return fail("mcp");
  const text = await response.text().catch(() => "");
  for (const event of text.split(/\r?\n\r?\n/u)) {
    const lines = event.split(/\r?\n/u);
    if (!lines.some((line) => line === "event: message")) continue;
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    const body = await Promise.resolve()
      .then(() => JSON.parse(data) as unknown)
      .catch(() => null);
    if (typeof body === "object" && body !== null && !Array.isArray(body))
      return body as Record<string, unknown>;
  }
  return fail("mcp");
};

const header = (response: Response, name: string) =>
  response.headers.get(name)?.toLowerCase() ?? "";

const assertDocsReference = async (
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  docs: string,
): Promise<void> => {
  let home: Response;
  try {
    home = await fetch(`${docs}/`);
  } catch {
    return fail("docs");
  }
  const homeBody = await home.text().catch(() => "");
  if (
    !home.ok ||
    !header(home, "content-type").includes("text/html") ||
    !header(home, "content-security-policy").includes("default-src 'self'") ||
    !header(home, "content-security-policy").includes(
      "nonce-normal-docs-scalar",
    ) ||
    header(home, "referrer-policy") !== "no-referrer" ||
    header(home, "x-content-type-options") !== "nosniff" ||
    header(home, "x-frame-options") !== "deny" ||
    !homeBody.includes("/openapi.json") ||
    !homeBody.includes("/vendor/scalar/") ||
    homeBody.includes("cdn.scalar.com") ||
    homeBody.includes("proxy.scalar.com") ||
    homeBody.includes("registry.scalar.com") ||
    homeBody.includes("API_KEY_HMAC_SECRET")
  )
    return fail("docs");

  let openApi: Response;
  try {
    openApi = await fetch(`${docs}/openapi.json`);
  } catch {
    return fail("docs");
  }
  if (openApi.url) {
    try {
      if (new URL(openApi.url).origin !== docs) return fail("docs");
    } catch {
      return fail("docs");
    }
  }
  const openApiBody = await openApi.json().catch(() => null);
  if (
    !openApi.ok ||
    !header(openApi, "content-type").includes("application/json") ||
    header(openApi, "cache-control") !==
      "public, max-age=300, must-revalidate" ||
    header(openApi, "x-content-type-options") !== "nosniff" ||
    typeof openApiBody !== "object" ||
    openApiBody === null ||
    Array.isArray(openApiBody) ||
    (openApiBody as { openapi?: unknown }).openapi !== "3.1.0" ||
    typeof (openApiBody as { paths?: unknown }).paths !== "object" ||
    (openApiBody as { paths?: unknown }).paths === null ||
    !("/v1/connections" in (openApiBody as { paths: object }).paths)
  )
    return fail("docs");
};

const rpc = (method: string, id: string) => ({
  id,
  jsonrpc: "2.0",
  method,
  ...(method === "initialize"
    ? {
        params: {
          capabilities: {},
          clientInfo: { name: "deployment-smoke", version: "1" },
          protocolVersion: "2025-06-18",
        },
      }
    : {}),
});

export const runDeploymentSmoke = async (
  config: DeploymentSmokeConfig,
  dependencies: Dependencies = {},
) => {
  const fetch =
    dependencies.fetch ??
    ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const api = new URL(config.apiOrigin).origin;
  const docs = new URL(config.docsOrigin).origin;
  const web = new URL(config.webOrigin).origin;
  if (docs === api || docs === web || web === api) fail("docs");
  const webHealth = await requestJson(fetch, "web", `${web}/health`);
  if (webHealth.service !== "web" || webHealth.status !== "ok") fail("web");
  await assertDocsReference(fetch, docs);
  const apiHealth = await requestJson(fetch, "api", `${api}/health`);
  if (apiHealth.service !== "api" || apiHealth.status !== "ok") fail("api");
  const apiReadiness = await requestJson(fetch, "api", `${api}/ready`);
  if (apiReadiness.service !== "api" || apiReadiness.status !== "ready")
    fail("api");
  const authorization = await requestJson(
    fetch,
    "oauth",
    `${api}/.well-known/oauth-authorization-server`,
  );
  const resource = await requestJson(
    fetch,
    "oauth",
    `${api}/.well-known/oauth-protected-resource/mcp`,
  );
  if (
    authorization.issuer !== api ||
    authorization.authorization_endpoint !== `${api}/oauth/authorize` ||
    authorization.token_endpoint !== `${api}/oauth/token` ||
    !sameStrings(authorization.code_challenge_methods_supported, ["S256"]) ||
    !sameStrings(authorization.scopes_supported, scopes) ||
    "registration_endpoint" in authorization ||
    resource.resource !== `${api}/mcp` ||
    !sameStrings(resource.authorization_servers, [api]) ||
    !sameStrings(resource.bearer_methods_supported, ["header"]) ||
    !sameStrings(resource.scopes_supported, scopes)
  )
    fail("oauth");

  const mcpHeaders = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${config.mcpAccessToken}`,
    "content-type": "application/json",
  };
  for (const [method, id] of [
    ["initialize", "smoke-init"],
    ["tools/list", "smoke-discovery"],
  ] as const) {
    const body = await requestMcpJson(fetch, `${api}/mcp`, {
      body: JSON.stringify(rpc(method, id)),
      headers: mcpHeaders,
      method: "POST",
    });
    if (body.jsonrpc !== "2.0" || body.id !== id || !("result" in body))
      fail("mcp");
  }

  const smokeHeaders = { authorization: `Bearer ${config.smokeSecret}` };
  const started = await requestJson(
    fetch,
    "deployment-canary",
    `${api}/_internal/deployment-smoke`,
    {
      headers: smokeHeaders,
      method: "POST",
    },
  );
  const canaryId =
    typeof started.canary_id === "string" &&
    canaryPattern.test(started.canary_id)
      ? started.canary_id
      : fail("deployment-canary");

  const deadline = Date.now() + 180_000;
  while (Date.now() <= deadline) {
    const state = await requestJson(
      fetch,
      "deployment-canary",
      `${api}/_internal/deployment-smoke?id=${encodeURIComponent(canaryId)}`,
      { headers: smokeHeaders },
    );
    if (state.status === "complete") {
      const subsystems = Array.isArray(state.subsystems)
        ? state.subsystems
        : fail("deployment-canary");
      for (const required of [
        "database",
        "provider-control",
        "queue",
        "r2-kms",
      ])
        if (!subsystems.includes(required)) fail(required);
      return {
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
        status: "ok" as const,
      };
    }
    if (state.status === "failed") {
      const [subsystem] = Array.isArray(state.subsystems)
        ? state.subsystems
        : [];
      return fail(
        typeof subsystem === "string" ? subsystem : "deployment-canary",
      );
    }
    if (state.status !== "pending") fail("deployment-canary");
    await new Promise((resolve) =>
      setTimeout(resolve, dependencies.pollDelayMs ?? 500),
    );
  }
  return fail("queue");
};
