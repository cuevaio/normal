import {
  type AuthRequest,
  OAuthError,
  type OAuthHelpers,
  OAuthProvider,
} from "@cloudflare/workers-oauth-provider";
import { Config, ConfigProvider, Data, Effect, Redacted } from "effect";
import { decodeBase64Url, encodeBase64Url } from "./base64-url";
import { oauthClientCacheRecordFor } from "./oauth-client-cache";
import type {
  OAuthAuthorizationRequestCompletedEvent,
  OAuthProtocolRequestFailedEvent,
  OAuthRefreshCompletedEvent,
} from "./services";

export const OAUTH_SCOPES = [
  "connections:read",
  "directory:read",
  "messages:read",
  "messages:send",
] as const;

const AUTHORIZATION_REQUEST_TTL_SECONDS = 10 * 60;
const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;

export interface AllowlistedOAuthClient {
  readonly allowedScopes?: ReadonlyArray<(typeof OAUTH_SCOPES)[number]>;
  readonly clientClass: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: ReadonlyArray<string>;
}

const OAUTH_CLIENTS: ReadonlyArray<AllowlistedOAuthClient> = [
  {
    allowedScopes: ["connections:read"],
    clientClass: "deployment_smoke",
    clientId: "deployment-smoke",
    clientName: "Normal deployment smoke",
    redirectUris: ["http://127.0.0.1/oauth/callback"],
  },
  {
    clientClass: "claude",
    clientId: "claude",
    clientName: "Claude",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  },
  {
    clientClass: "chatgpt",
    clientId: "chatgpt",
    clientName: "ChatGPT",
    redirectUris: [
      "https://chatgpt.com/connector/oauth/djePJ1RTfjI5",
      "https://chatgpt.com/connector_platform_oauth_redirect",
    ],
  },
];

const isAllowedRedirectUri = (
  redirectUri: string,
  registeredUris: ReadonlyArray<string>,
): boolean =>
  registeredUris.some((registeredUri) => {
    if (!registeredUri.startsWith("http://127.0.0.1/")) {
      return redirectUri === registeredUri;
    }
    if (!redirectUri.startsWith("http://127.0.0.1:")) return false;
    try {
      const requested = new URL(redirectUri);
      const registered = new URL(registeredUri);
      return (
        requested.protocol === "http:" &&
        registered.protocol === "http:" &&
        requested.hostname === "127.0.0.1" &&
        registered.hostname === "127.0.0.1" &&
        requested.username === "" &&
        requested.password === "" &&
        requested.port !== "" &&
        Number(requested.port) > 0 &&
        requested.pathname === registered.pathname &&
        requested.search === registered.search &&
        requested.hash === registered.hash
      );
    } catch {
      return false;
    }
  });

const isAllowedScope = (
  scope: string,
  client: AllowlistedOAuthClient,
): boolean =>
  (client.allowedScopes ?? OAUTH_SCOPES).includes(
    scope as (typeof OAUTH_SCOPES)[number],
  );

const chatGptFallbackRedirectUris = OAUTH_CLIENTS.find(
  (client) => client.clientId === "chatgpt",
)?.redirectUris ?? ["https://chatgpt.com/connector_platform_oauth_redirect"];
const CLAUDE_METADATA_CLIENT_ID =
  "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

const isChatGptClientMetadataId = (clientId: string): boolean => {
  try {
    const url = new URL(clientId);
    return (
      url.protocol === "https:" &&
      url.hostname === "chatgpt.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname.startsWith("/oauth/") &&
      url.pathname.endsWith("/client.json")
    );
  } catch {
    return false;
  }
};

const isChatGptRedirectUri = (redirectUri: string): boolean => {
  try {
    const url = new URL(redirectUri);
    return (
      url.protocol === "https:" &&
      url.hostname === "chatgpt.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
};

const isSupportedChatGptTokenEndpointAuthMethod = (method: string): boolean =>
  method === "none" || method === "private_key_jwt";

interface DynamicOAuthClientPolicy {
  readonly clientClass: string;
  readonly clientName: string;
  readonly fallbackRedirectUris: ReadonlyArray<string>;
  readonly isRedirectUri: (redirectUri: string) => boolean;
  readonly isTokenEndpointAuthMethodSupported: (method: string) => boolean;
}

const dynamicOAuthClientPolicyFor = (
  clientId: string,
): DynamicOAuthClientPolicy | undefined => {
  if (isChatGptClientMetadataId(clientId)) {
    return {
      clientClass: "chatgpt",
      clientName: "ChatGPT",
      fallbackRedirectUris: chatGptFallbackRedirectUris,
      isRedirectUri: isChatGptRedirectUri,
      isTokenEndpointAuthMethodSupported:
        isSupportedChatGptTokenEndpointAuthMethod,
    };
  }
  if (clientId === CLAUDE_METADATA_CLIENT_ID) {
    return {
      clientClass: "claude",
      clientName: "Claude",
      fallbackRedirectUris: [CLAUDE_REDIRECT_URI],
      isRedirectUri: (redirectUri) => redirectUri === CLAUDE_REDIRECT_URI,
      isTokenEndpointAuthMethodSupported: (method) => method === "none",
    };
  }
  return undefined;
};

const loadDynamicOAuthClient = async (
  clientId: string,
  helpers: OAuthHelpers,
): Promise<AllowlistedOAuthClient | undefined> => {
  const policy = dynamicOAuthClientPolicyFor(clientId);
  if (!policy) return undefined;
  const metadata = await helpers.lookupClient(clientId);
  if (
    !metadata ||
    metadata.clientId !== clientId ||
    !policy.isTokenEndpointAuthMethodSupported(
      metadata.tokenEndpointAuthMethod,
    ) ||
    metadata.redirectUris.length === 0 ||
    metadata.redirectUris.some(
      (redirectUri) => !policy.isRedirectUri(redirectUri),
    )
  ) {
    return undefined;
  }
  return {
    clientClass: policy.clientClass,
    clientId,
    clientName: policy.clientName,
    redirectUris: metadata.redirectUris,
  };
};

export interface OAuthConfiguration {
  readonly clients: ReadonlyArray<AllowlistedOAuthClient>;
  readonly consentOrigin: string;
  readonly issuer: string;
  readonly protocolEncryptionKey: Redacted.Redacted<string>;
  readonly resource: string;
}

export interface OAuthKv {
  readonly delete: (key: string) => Promise<void>;
  readonly get: (
    key: string,
    options?: unknown,
  ) => Promise<string | null | unknown>;
  readonly put: (
    key: string,
    value: string,
    options?: { readonly expirationTtl?: number },
  ) => Promise<void>;
}

interface OAuthEnvironment {
  readonly OAUTH_KV: OAuthKv;
  readonly OAUTH_PROVIDER?: OAuthHelpers | undefined;
  readonly [binding: string]: unknown;
}

interface OAuthHandlerOptions {
  readonly applicationHandler: (
    request: Request,
    environment: OAuthEnvironment,
    context: ExecutionContext,
  ) => Promise<Response>;
  readonly configuration: OAuthConfiguration;
  readonly environment: OAuthEnvironment;
  readonly isAuthorizationActive: (input: {
    readonly authorizationId: string;
    readonly clientId?: string | undefined;
    readonly oauthSubject: string;
  }) => Promise<boolean>;
  readonly now?: (() => Date) | undefined;
  readonly refreshCredentials: RefreshCredentialPersistence;
  readonly telemetry: (
    event:
      | OAuthAuthorizationRequestCompletedEvent
      | OAuthProtocolRequestFailedEvent
      | OAuthRefreshCompletedEvent,
  ) => void;
}

export interface RefreshCredentialInput {
  readonly clientId: string;
  readonly credentialHash: Uint8Array;
  readonly oauthSubject: string;
  readonly observedAt: Date;
}

export interface RefreshCredentialPersistence {
  readonly register: (input: RefreshCredentialInput) => Promise<boolean>;
  readonly rotate: <Value>(
    input: RefreshCredentialInput,
    issue: () => Promise<{
      readonly credentialHash: Uint8Array;
      readonly value: Value;
    }>,
  ) => Promise<
    | { readonly outcome: "invalid" | "reuse" }
    | { readonly outcome: "rotated"; readonly value: Value }
  >;
}

class InvalidOAuthConfiguration extends Data.TaggedError(
  "InvalidOAuthConfiguration",
) {}

const environmentConfigProvider = (environment: Record<string, unknown>) =>
  ConfigProvider.fromMap(
    new Map(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  );

const isExactHttpsOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === value
    );
  } catch {
    return false;
  }
};

export const loadOAuthConfiguration = (
  environment: Record<string, unknown>,
): Effect.Effect<OAuthConfiguration, unknown> =>
  Config.all({
    apiAudience: Config.string("CLERK_API_AUDIENCE").pipe(
      Config.validate({
        message: "CLERK_API_AUDIENCE must be an exact HTTPS origin",
        validation: isExactHttpsOrigin,
      }),
    ),
    consentOrigin: Config.string("CLERK_AUTHORIZED_PARTY").pipe(
      Config.validate({
        message: "CLERK_AUTHORIZED_PARTY must be an exact HTTPS origin",
        validation: isExactHttpsOrigin,
      }),
    ),
    issuer: Config.string("OAUTH_ISSUER").pipe(
      Config.validate({
        message: "OAUTH_ISSUER must be an exact HTTPS origin",
        validation: isExactHttpsOrigin,
      }),
    ),
    protocolEncryptionKey: Config.redacted(
      "OAUTH_PROTOCOL_ENCRYPTION_KEY",
    ).pipe(
      Config.validate({
        message:
          "OAUTH_PROTOCOL_ENCRYPTION_KEY must be a 32-byte hexadecimal secret",
        validation: (value) => /^[a-f0-9]{64}$/iu.test(Redacted.value(value)),
      }),
    ),
    resource: Config.string("OAUTH_RESOURCE"),
  }).pipe(
    Effect.flatMap((configuration) =>
      Effect.try({
        try: () => {
          const resource = new URL(configuration.resource);
          if (
            resource.protocol !== "https:" ||
            resource.username !== "" ||
            resource.password !== "" ||
            configuration.apiAudience !== configuration.issuer ||
            resource.origin !== configuration.issuer ||
            resource.pathname !== "/mcp" ||
            resource.search !== "" ||
            resource.hash !== "" ||
            resource.toString() !== configuration.resource
          ) {
            throw new InvalidOAuthConfiguration();
          }
          return {
            clients: OAUTH_CLIENTS,
            consentOrigin: configuration.consentOrigin,
            issuer: configuration.issuer,
            protocolEncryptionKey: configuration.protocolEncryptionKey,
            resource: configuration.resource,
          };
        },
        catch: () => new InvalidOAuthConfiguration(),
      }),
    ),
    Effect.withConfigProvider(environmentConfigProvider(environment)),
  );

const jsonError = (): Response =>
  new Response(JSON.stringify({ error: "invalid_authorization_request" }), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status: 400,
  });

const hexToBytes = (value: string): Uint8Array =>
  Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );

const randomSecret = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
};

const hashLookup = async (secret: string): Promise<string> => {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return encodeBase64Url(new Uint8Array(hash));
};

const hashCredential = async (secret: string): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
  );

export const sealAuthorizationRequest = async (
  request: AuthRequest,
  client: AllowlistedOAuthClient,
  configuration: OAuthConfiguration,
  kv: OAuthKv,
): Promise<string> => {
  const lookupSecret = randomSecret();
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(Redacted.value(configuration.protocolEncryptionKey)),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      clientClass: client.clientClass,
      clientId: client.clientId,
      clientName: client.clientName,
      expiresAt: Date.now() + AUTHORIZATION_REQUEST_TTL_SECONDS * 1_000,
      request,
      version: 1,
    }),
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      additionalData: new TextEncoder().encode(configuration.resource),
      iv,
      name: "AES-GCM",
      tagLength: 128,
    },
    key,
    plaintext,
  );
  const keyHash = await hashLookup(lookupSecret);
  await kv.put(
    `oauth:authorization-request:${keyHash}`,
    JSON.stringify({
      ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
      iv: encodeBase64Url(iv),
      version: 1,
    }),
    { expirationTtl: AUTHORIZATION_REQUEST_TTL_SECONDS },
  );
  return lookupSecret;
};

export interface OpenedAuthorizationRequest {
  readonly client: AllowlistedOAuthClient;
  readonly expiresAt: number;
  readonly request: AuthRequest;
}

const isAuthRequest = (value: unknown): value is AuthRequest => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const request = value as Record<string, unknown>;
  return (
    request.responseType === "code" &&
    typeof request.clientId === "string" &&
    typeof request.redirectUri === "string" &&
    Array.isArray(request.scope) &&
    request.scope.every((scope) => typeof scope === "string") &&
    typeof request.state === "string" &&
    typeof request.codeChallenge === "string" &&
    request.codeChallengeMethod === "S256" &&
    (typeof request.resource === "string" ||
      (Array.isArray(request.resource) &&
        request.resource.every((resource) => typeof resource === "string")))
  );
};

export const openAuthorizationRequest = async (
  handoff: string,
  configuration: OAuthConfiguration,
  kv: OAuthKv,
  consume = false,
): Promise<OpenedAuthorizationRequest> => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(handoff)) {
    throw new Error("invalid authorization handoff");
  }
  const keyHash = await hashLookup(handoff);
  const keyName = `oauth:authorization-request:${keyHash}`;
  const serialized = await kv.get(keyName);
  if (typeof serialized !== "string") {
    throw new Error("authorization handoff unavailable");
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(serialized);
  } catch {
    throw new Error("invalid authorization handoff");
  }
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    Array.isArray(envelope)
  ) {
    throw new Error("invalid authorization handoff");
  }
  const record = envelope as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.iv !== "string" ||
    typeof record.ciphertext !== "string"
  ) {
    throw new Error("invalid authorization handoff");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(Redacted.value(configuration.protocolEncryptionKey)),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      additionalData: new TextEncoder().encode(configuration.resource),
      iv: decodeBase64Url(record.iv),
      name: "AES-GCM",
      tagLength: 128,
    },
    key,
    decodeBase64Url(record.ciphertext),
  );
  const opened = JSON.parse(new TextDecoder().decode(plaintext)) as Record<
    string,
    unknown
  >;
  const client = configuration.clients.find(
    (candidate) =>
      candidate.clientId === opened.clientId &&
      candidate.clientClass === opened.clientClass &&
      candidate.clientName === opened.clientName,
  );
  const dynamicPolicy =
    typeof opened.clientId === "string"
      ? dynamicOAuthClientPolicyFor(opened.clientId)
      : undefined;
  const dynamicClient =
    dynamicPolicy &&
    opened.clientClass === dynamicPolicy.clientClass &&
    opened.clientName === dynamicPolicy.clientName &&
    isAuthRequest(opened.request) &&
    opened.request.clientId === opened.clientId &&
    dynamicPolicy.isRedirectUri(opened.request.redirectUri)
      ? ({
          clientClass: dynamicPolicy.clientClass,
          clientId: opened.clientId,
          clientName: dynamicPolicy.clientName,
          redirectUris: [opened.request.redirectUri],
        } satisfies AllowlistedOAuthClient)
      : undefined;
  const trustedClient = client ?? dynamicClient;
  if (
    opened.version !== 1 ||
    !trustedClient ||
    typeof opened.expiresAt !== "number" ||
    !Number.isSafeInteger(opened.expiresAt) ||
    opened.expiresAt <= Date.now() ||
    !isAuthRequest(opened.request) ||
    opened.request.clientId !== trustedClient.clientId ||
    !isAllowedRedirectUri(
      opened.request.redirectUri,
      trustedClient.redirectUris,
    ) ||
    opened.request.resource !== configuration.resource ||
    opened.request.scope.length === 0 ||
    opened.request.scope.some((scope) => !isAllowedScope(scope, trustedClient))
  ) {
    throw new Error("invalid authorization handoff");
  }
  if (consume) {
    await kv.delete(keyName);
  }
  return {
    client: trustedClient,
    expiresAt: opened.expiresAt,
    request: opened.request,
  };
};

const requestedParameter = (url: URL, name: string): string | undefined => {
  const values = url.searchParams.getAll(name);
  return values.length === 1 && values[0] !== "" ? values[0] : undefined;
};

const clientInfoFor = (client: AllowlistedOAuthClient) =>
  oauthClientCacheRecordFor(client);

export const makeOAuthClientRegistryKv = (
  kv: OAuthKv,
  clients: ReadonlyArray<AllowlistedOAuthClient>,
): OAuthKv => {
  const registry = new Map(
    clients.map((client) => [client.clientId, clientInfoFor(client)]),
  );
  return new Proxy(kv, {
    get: (target, property) => {
      if (property === "get") {
        return async (key: string, options?: unknown) => {
          if (key.startsWith("client:")) {
            const clientId = key.slice("client:".length);
            const client = registry.get(clientId);
            const dynamicPolicy = dynamicOAuthClientPolicyFor(clientId);
            const stored =
              client === undefined && dynamicPolicy
                ? await target.get(key, { type: "json" })
                : null;
            const dynamicClient =
              typeof stored === "object" &&
              stored !== null &&
              !Array.isArray(stored) &&
              (stored as Record<string, unknown>).clientId === clientId &&
              (stored as Record<string, unknown>).tokenEndpointAuthMethod ===
                "none" &&
              Array.isArray((stored as Record<string, unknown>).redirectUris) &&
              (
                (stored as Record<string, unknown>)
                  .redirectUris as ReadonlyArray<unknown>
              ).length > 0 &&
              (
                (stored as Record<string, unknown>)
                  .redirectUris as ReadonlyArray<unknown>
              ).every(
                (redirectUri) =>
                  typeof redirectUri === "string" &&
                  dynamicPolicy?.isRedirectUri(redirectUri) === true,
              )
                ? stored
                : null;
            const trustedClient = client ?? dynamicClient;
            if (!trustedClient) return null;
            const wantsJson =
              options === "json" ||
              (typeof options === "object" &&
                options !== null &&
                (options as { readonly type?: unknown }).type === "json");
            return wantsJson ? trustedClient : JSON.stringify(trustedClient);
          }
          return target.get(key, options);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

const makeAllowlistedEnvironment = (
  environment: OAuthEnvironment,
  clients: ReadonlyArray<AllowlistedOAuthClient>,
): OAuthEnvironment => {
  const allowlistedKv = makeOAuthClientRegistryKv(
    environment.OAUTH_KV,
    clients,
  );
  return new Proxy(environment, {
    get: (target, property) =>
      property === "OAUTH_KV" ? allowlistedKv : Reflect.get(target, property),
  });
};

const makeAuthorizationHandler = (
  options: OAuthHandlerOptions,
): ExportedHandler<OAuthEnvironment> => ({
  fetch: async (request, environment, context) => {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/oauth/authorize") {
      if (url.pathname.startsWith("/oauth/")) {
        return new Response(JSON.stringify({ error: "not_found" }), {
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
          },
          status: 404,
        });
      }
      return options.applicationHandler(request, environment, context);
    }

    let clientClass: string | undefined;
    try {
      const clientId = requestedParameter(url, "client_id");
      const redirectUri = requestedParameter(url, "redirect_uri");
      const resource = requestedParameter(url, "resource");
      const responseType = requestedParameter(url, "response_type");
      const codeChallenge = requestedParameter(url, "code_challenge");
      const codeChallengeMethod = requestedParameter(
        url,
        "code_challenge_method",
      );
      const requestedScope = requestedParameter(url, "scope")
        ?.split(" ")
        .filter(Boolean);
      const client =
        options.configuration.clients.find(
          (candidate) => candidate.clientId === clientId,
        ) ??
        (clientId && environment.OAUTH_PROVIDER
          ? await loadDynamicOAuthClient(clientId, environment.OAUTH_PROVIDER)
          : undefined);
      clientClass = client?.clientClass;
      if (
        !client ||
        !redirectUri ||
        !isAllowedRedirectUri(redirectUri, client.redirectUris) ||
        resource !== options.configuration.resource ||
        responseType !== "code" ||
        !codeChallenge ||
        !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge) ||
        codeChallengeMethod !== "S256" ||
        !requestedScope ||
        requestedScope.length === 0 ||
        new Set(requestedScope).size !== requestedScope.length ||
        requestedScope.some((scope) => !isAllowedScope(scope, client)) ||
        !environment.OAUTH_PROVIDER
      ) {
        throw new Error("invalid authorization request");
      }

      if (dynamicOAuthClientPolicyFor(client.clientId)) {
        await options.environment.OAUTH_KV.put(
          `client:${client.clientId}`,
          JSON.stringify(clientInfoFor(client)),
          { expirationTtl: 90 * 24 * 60 * 60 },
        );
      }

      const parsed = await environment.OAUTH_PROVIDER.parseAuthRequest(request);
      const handoff = await sealAuthorizationRequest(
        parsed,
        client,
        options.configuration,
        options.environment.OAUTH_KV,
      );
      const consent = new URL(
        "/oauth/consent",
        options.configuration.consentOrigin,
      );
      consent.searchParams.set("request", handoff);
      options.telemetry({
        clientClass,
        event: "oauth.authorization.request.completed",
        outcome: "accepted",
        service: "api",
      });
      return Response.redirect(consent.toString(), 302);
    } catch {
      options.telemetry({
        clientClass,
        event: "oauth.authorization.request.completed",
        outcome: "invalid_request",
        service: "api",
      });
      return jsonError();
    }
  },
});

const addNoStore = (response: Response, issuer?: string): Response => {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  const challenge = headers.get("www-authenticate");
  if (challenge !== null && issuer !== undefined) {
    headers.set(
      "www-authenticate",
      challenge.replace(
        /resource_metadata="[^"]+"/,
        `resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`,
      ),
    );
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

interface TokenRequest {
  readonly clientId: string;
  readonly grantType: "authorization_code" | "refresh_token";
  readonly refreshToken?: string | undefined;
}

const parseTokenRequest = async (
  request: Request,
  configuration: OAuthConfiguration,
): Promise<TokenRequest | null> => {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    url.origin !== configuration.issuer ||
    url.pathname !== "/oauth/token" ||
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/x-www-form-urlencoded"
  ) {
    return null;
  }
  try {
    const body = new URLSearchParams();
    for (const [name, value] of await request.clone().formData()) {
      if (typeof value !== "string") return null;
      body.append(name, value);
    }
    const grantTypes = body.getAll("grant_type");
    const clientIds = body.getAll("client_id");
    const authorization = request.headers.get("authorization");
    let clientId: string | undefined;
    if (authorization?.startsWith("Basic ")) {
      if (clientIds.length !== 0 || body.has("client_secret")) return null;
      const credentials = atob(authorization.slice("Basic ".length));
      const separator = credentials.indexOf(":");
      if (separator === -1) return null;
      clientId = decodeURIComponent(
        credentials.slice(0, separator).replace(/\+/gu, " "),
      );
    } else if (clientIds.length === 1) {
      clientId = clientIds[0];
    }
    if (
      grantTypes.length !== 1 ||
      clientId === undefined ||
      !["authorization_code", "refresh_token"].includes(grantTypes[0] ?? "") ||
      (!configuration.clients.some(
        (candidate) => candidate.clientId === clientId,
      ) &&
        !dynamicOAuthClientPolicyFor(clientId))
    ) {
      return null;
    }
    const grantType = grantTypes[0] as TokenRequest["grantType"];
    const refreshTokens = body.getAll("refresh_token");
    if (
      grantType === "refresh_token" &&
      (refreshTokens.length !== 1 || refreshTokens[0] === "")
    ) {
      return null;
    }
    return {
      clientId,
      grantType,
      refreshToken:
        grantType === "refresh_token" ? refreshTokens[0] : undefined,
    };
  } catch {
    return null;
  }
};

interface IssuedTokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
}

const readIssuedTokenPair = async (
  response: Response,
): Promise<IssuedTokenPair | null> => {
  if (response.status !== 200) return null;
  try {
    const body = (await response.clone().json()) as Record<string, unknown>;
    return typeof body.access_token === "string" &&
      body.access_token !== "" &&
      typeof body.refresh_token === "string" &&
      body.refresh_token !== ""
      ? {
          accessToken: body.access_token,
          refreshToken: body.refresh_token,
        }
      : null;
  } catch {
    return null;
  }
};

const oauthTokenError = (
  error: "invalid_grant" | "temporarily_unavailable",
  status: 400 | 503,
): Response =>
  new Response(JSON.stringify({ error }), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status,
  });

const oauthSubjectFromRefreshToken = (token: string): string | null => {
  const parts = token.split(":");
  return parts.length === 3 && /^[A-Za-z0-9_-]{43}$/.test(parts[0] ?? "")
    ? (parts[0] ?? null)
    : null;
};

export const accessAuthorizationFrom = (
  context: ExecutionContext,
): {
  readonly authorizationId: string;
  readonly clientId?: string | undefined;
  readonly oauthSubject: string;
} | null => {
  const props = (context as ExecutionContext & { readonly props?: unknown })
    .props;
  if (typeof props !== "object" || props === null || Array.isArray(props)) {
    return null;
  }
  const value = props as Record<string, unknown>;
  const clientId = value.clientId;
  return typeof value.authorizationId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value.authorizationId,
    ) &&
    (clientId === undefined || typeof clientId === "string") &&
    typeof value.oauthSubject === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.oauthSubject)
    ? {
        authorizationId: value.authorizationId,
        ...(clientId === undefined ? {} : { clientId }),
        oauthSubject: value.oauthSubject,
      }
    : null;
};

const invalidAccessToken = (): Response =>
  new Response(JSON.stringify({ error: "invalid_token" }), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": 'Bearer error="invalid_token"',
    },
    status: 401,
  });

const isOAuthProviderRequest = (
  request: Request,
  configuration: OAuthConfiguration,
): boolean => {
  const url = new URL(request.url);
  const issuer = new URL(configuration.issuer);
  const isIssuer =
    url.origin === issuer.origin ||
    (url.protocol === "http:" &&
      url.host === issuer.host &&
      request.headers.get("x-forwarded-proto") === "https");
  return (
    isIssuer &&
    (url.pathname === "/oauth/authorize" ||
      url.pathname === "/oauth/token" ||
      url.pathname === "/oauth/register" ||
      url.pathname === "/v1/oauth/consent/inspect" ||
      url.pathname === "/v1/oauth/consent/decision" ||
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp" ||
      url.pathname === "/mcp" ||
      url.pathname.startsWith("/mcp/"))
  );
};

const normalizeForwardedIssuerRequest = (
  request: Request,
  issuer: string,
): Request => {
  const url = new URL(request.url);
  const issuerUrl = new URL(issuer);
  if (
    url.protocol !== "http:" ||
    url.host !== issuerUrl.host ||
    request.headers.get("x-forwarded-proto") !== "https"
  ) {
    return request;
  }
  return new Request(
    `${issuerUrl.origin}${url.pathname}${url.search}${url.hash}`,
    request,
  );
};

export const createOAuthHandler = (
  options: OAuthHandlerOptions,
): ((request: Request, context: ExecutionContext) => Promise<Response>) => {
  const allowlistedEnvironment = makeAllowlistedEnvironment(
    options.environment,
    options.configuration.clients,
  );
  const makeProvider = (clientIdMetadataDocumentEnabled: boolean) =>
    new OAuthProvider<OAuthEnvironment>({
      accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
      allowImplicitFlow: false,
      allowPlainPKCE: false,
      apiHandler: {
        fetch: async (request, environment, context) => {
          const authorization = accessAuthorizationFrom(context);
          if (authorization === null) return invalidAccessToken();
          try {
            if (!(await options.isAuthorizationActive(authorization))) {
              return invalidAccessToken();
            }
          } catch {
            return invalidAccessToken();
          }
          return options.applicationHandler(request, environment, context);
        },
      },
      apiRoute: options.configuration.resource,
      authorizeEndpoint: `${options.configuration.issuer}/oauth/authorize`,
      clientIdMetadataDocumentEnabled,
      defaultHandler: makeAuthorizationHandler(options),
      onError: (error) => {
        options.telemetry({
          code: error.code,
          event: "oauth.protocol.request.failed",
          service: "api",
          status: error.status,
        });
      },
      refreshTokenTTL: 90 * 24 * 60 * 60,
      resourceMetadata: {
        authorization_servers: [options.configuration.issuer],
        bearer_methods_supported: ["header"],
        resource: options.configuration.resource,
        resource_name: "Normal",
        scopes_supported: [...OAUTH_SCOPES],
      },
      scopesSupported: [...OAUTH_SCOPES],
      tokenEndpoint: `${options.configuration.issuer}/oauth/token`,
      tokenExchangeCallback: async (exchange) => {
        const props =
          typeof exchange.props === "object" &&
          exchange.props !== null &&
          !Array.isArray(exchange.props)
            ? (exchange.props as Record<string, unknown>)
            : {};
        const authorizationId = props.authorizationId;
        const clientId = props.clientId;
        const oauthSubject = props.oauthSubject;
        if (
          typeof authorizationId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
            authorizationId,
          ) ||
          (clientId !== undefined &&
            (typeof clientId !== "string" || clientId !== exchange.clientId)) ||
          typeof oauthSubject !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/.test(oauthSubject) ||
          exchange.userId !== oauthSubject ||
          !(await options.isAuthorizationActive({
            authorizationId,
            clientId: exchange.clientId,
            oauthSubject,
          }))
        ) {
          throw new OAuthError("invalid_grant", {
            description: "The MCP Authorization is not active.",
          });
        }
        const tokenProperties = {
          accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
          accessTokenProps: {
            ...props,
            clientId: exchange.clientId,
          },
        };
        return exchange.grantType === "authorization_code"
          ? {
              ...tokenProperties,
              refreshTokenTTL: 90 * 24 * 60 * 60,
            }
          : tokenProperties;
      },
    });
  const authorizationProvider = makeProvider(true);
  const tokenProvider = makeProvider(false);

  return async (request, context) => {
    if (!isOAuthProviderRequest(request, options.configuration)) {
      return options.applicationHandler(request, options.environment, context);
    }
    const providerRequest = normalizeForwardedIssuerRequest(
      request,
      options.configuration.issuer,
    );
    const tokenRequest = await parseTokenRequest(
      providerRequest,
      options.configuration,
    );
    if (
      tokenRequest?.grantType === "refresh_token" &&
      tokenRequest.refreshToken !== undefined
    ) {
      const oauthSubject = oauthSubjectFromRefreshToken(
        tokenRequest.refreshToken,
      );
      const clientClass =
        options.configuration.clients.find(
          (candidate) => candidate.clientId === tokenRequest.clientId,
        )?.clientClass ??
        dynamicOAuthClientPolicyFor(tokenRequest.clientId)?.clientClass;
      if (oauthSubject === null) {
        return oauthTokenError("invalid_grant", 400);
      }
      try {
        const rotation = await options.refreshCredentials.rotate(
          {
            clientId: tokenRequest.clientId,
            credentialHash: await hashCredential(tokenRequest.refreshToken),
            oauthSubject,
            observedAt: (options.now ?? (() => new Date()))(),
          },
          async () => {
            const dynamicPolicy = dynamicOAuthClientPolicyFor(
              tokenRequest.clientId,
            );
            if (dynamicPolicy) {
              const cachedClient = await allowlistedEnvironment.OAUTH_KV.get(
                `client:${tokenRequest.clientId}`,
                { type: "json" },
              );
              if (cachedClient === null) {
                await options.environment.OAUTH_KV.put(
                  `client:${tokenRequest.clientId}`,
                  JSON.stringify(
                    clientInfoFor({
                      clientClass: dynamicPolicy.clientClass,
                      clientId: tokenRequest.clientId,
                      clientName: dynamicPolicy.clientName,
                      redirectUris: dynamicPolicy.fallbackRedirectUris,
                    }),
                  ),
                  { expirationTtl: 90 * 24 * 60 * 60 },
                );
              }
            }
            const response = addNoStore(
              await tokenProvider.fetch(
                providerRequest,
                allowlistedEnvironment,
                context,
              ),
              options.configuration.issuer,
            );
            const pair = await readIssuedTokenPair(response);
            if (pair === null) {
              throw new Error("OAuth provider did not issue a token pair");
            }
            return {
              credentialHash: await hashCredential(pair.refreshToken),
              value: response,
            };
          },
        );
        options.telemetry({
          clientClass,
          event: "oauth.refresh.completed",
          outcome: rotation.outcome,
          service: "api",
        });
        return rotation.outcome === "rotated"
          ? rotation.value
          : oauthTokenError("invalid_grant", 400);
      } catch {
        options.telemetry({
          clientClass,
          event: "oauth.refresh.completed",
          outcome: "unavailable",
          service: "api",
        });
        return oauthTokenError("temporarily_unavailable", 503);
      }
    }

    const response = addNoStore(
      await (tokenRequest?.grantType === "authorization_code"
        ? tokenProvider
        : authorizationProvider
      ).fetch(providerRequest, allowlistedEnvironment, context),
      options.configuration.issuer,
    );
    if (tokenRequest?.grantType !== "authorization_code") {
      return response;
    }
    const pair = await readIssuedTokenPair(response);
    if (pair === null) return response;
    const oauthSubject = oauthSubjectFromRefreshToken(pair.refreshToken);
    if (oauthSubject === null) {
      return oauthTokenError("temporarily_unavailable", 503);
    }
    try {
      const registered = await options.refreshCredentials.register({
        clientId: tokenRequest.clientId,
        credentialHash: await hashCredential(pair.refreshToken),
        oauthSubject,
        observedAt: (options.now ?? (() => new Date()))(),
      });
      return registered ? response : oauthTokenError("invalid_grant", 400);
    } catch {
      return oauthTokenError("temporarily_unavailable", 503);
    }
  };
};
