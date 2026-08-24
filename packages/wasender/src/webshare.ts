import { Redacted } from "effect";
import { maximumJsonResponseBytes } from "./common";
import type { SetupMarker } from "./control";

const websharePlanListUrl =
  "https://proxy.webshare.io/api/v2/subscription/plan/?page_size=100";
const webshareProxyListUrl =
  "https://proxy.webshare.io/api/v2/proxy/list/?mode=backbone&page_size=100";
const proxyHostname = "p.webshare.io";
const proxyCountry = "CO";
const proxyCount = 20;
const requestAttemptTimeoutMs = 5_000;
const requestTotalTimeoutMs = 10_000;
const maximumAttempts = 3;

type Fetch = (request: Request) => Promise<Response>;

export class WebshareProxySelectionError extends Error {
  readonly retryable: boolean;

  constructor(retryable: boolean) {
    super("Webshare proxy selection failed");
    this.name = "WebshareProxySelectionError";
    this.retryable = retryable;
  }
}

export interface WebshareProxySelector {
  readonly select: (input: {
    readonly currentProxyUrl?: Redacted.Redacted<string> | undefined;
    readonly occupiedProxyUrls: ReadonlyArray<Redacted.Redacted<string>>;
    readonly setupMarker: SetupMarker;
  }) => Promise<Redacted.Redacted<string>>;
}

export interface WebshareProxySelectorConfig {
  readonly apiKey: Redacted.Redacted<string>;
}

export interface WebshareProxySelectorDependencies {
  readonly fetch?: Fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface WebshareProxy {
  readonly id: string;
  readonly password: string;
  readonly port: number;
  readonly url: string;
  readonly username: string;
  readonly valid: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readBoundedJson = async (response: Response): Promise<unknown> => {
  if (!response.body) throw new WebshareProxySelectionError(false);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maximumJsonResponseBytes) {
      try {
        await reader.cancel();
      } catch {
        // The size violation remains authoritative if stream cleanup fails.
      }
      throw new WebshareProxySelectionError(false);
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new WebshareProxySelectionError(false);
  }
};

const proxyUrl = (username: string, password: string, port: number): string => {
  const url = new URL(`socks5://${proxyHostname}:${port}`);
  url.username = username;
  url.password = password;
  return url.href;
};

const parseProxy = (value: unknown): WebshareProxy | null => {
  if (!isRecord(value)) return null;
  const { country_code, id, password, port, username, valid } = value;
  if (
    country_code !== proxyCountry ||
    typeof id !== "string" ||
    id.length === 0 ||
    typeof username !== "string" ||
    username.length === 0 ||
    typeof password !== "string" ||
    password.length === 0 ||
    !Number.isSafeInteger(port) ||
    (port as number) < 9_999 ||
    (port as number) > 19_999 ||
    typeof valid !== "boolean"
  ) {
    return null;
  }
  return {
    id,
    password,
    port: port as number,
    url: proxyUrl(username, password, port as number),
    username,
    valid,
  };
};

const markerIndex = async (
  setupMarker: SetupMarker,
  length: number,
): Promise<number> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(String(setupMarker)),
    ),
  );
  const value =
    (((digest[0] ?? 0) << 24) |
      ((digest[1] ?? 0) << 16) |
      ((digest[2] ?? 0) << 8) |
      (digest[3] ?? 0)) >>>
    0;
  return value % length;
};

export const makeWebshareProxySelector = (
  config: WebshareProxySelectorConfig,
  dependencies: WebshareProxySelectorDependencies = {},
): WebshareProxySelector => {
  const apiKey = Redacted.value(config.apiKey);
  if (
    !/^[\x21-\x7e]{1,4096}$/u.test(apiKey) ||
    /replace|example|placeholder/iu.test(apiKey)
  ) {
    throw new RangeError("Webshare API key is invalid");
  }
  const fetchRequest = dependencies.fetch ?? ((request) => fetch(request));
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const loadBody = async (url: string): Promise<unknown> => {
    const startedAt = Date.now();
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      const remaining = requestTotalTimeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) break;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(requestAttemptTimeoutMs, remaining),
      );
      let response: Response;
      try {
        response = await fetchRequest(
          new Request(url, {
            headers: {
              accept: "application/json",
              authorization: `Token ${apiKey}`,
            },
            signal: controller.signal,
          }),
        );
      } catch {
        clearTimeout(timer);
        if (attempt === maximumAttempts) break;
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }
      if (response.ok) {
        try {
          const body = await readBoundedJson(response);
          clearTimeout(timer);
          return body;
        } catch (cause) {
          clearTimeout(timer);
          if (
            cause instanceof WebshareProxySelectionError &&
            !cause.retryable
          ) {
            throw cause;
          }
          if (attempt === maximumAttempts) break;
          const delay = 250 * 2 ** (attempt - 1);
          if (Date.now() - startedAt + delay >= requestTotalTimeoutMs) break;
          await sleep(delay);
          continue;
        }
      }
      clearTimeout(timer);
      try {
        await response.body?.cancel();
      } catch {
        // The HTTP status remains authoritative if stream cleanup fails.
      }
      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      if (!retryable || attempt === maximumAttempts) {
        throw new WebshareProxySelectionError(retryable);
      }
      const retryAfter = response.headers.get("retry-after")?.trim();
      const delay =
        retryAfter !== undefined && /^\d+$/u.test(retryAfter)
          ? Math.min(Number(retryAfter) * 1_000, 2_000)
          : 250 * 2 ** (attempt - 1);
      if (Date.now() - startedAt + delay >= requestTotalTimeoutMs) break;
      await sleep(delay);
    }
    throw new WebshareProxySelectionError(true);
  };

  const loadPlanId = async (): Promise<number> => {
    const body = await loadBody(websharePlanListUrl);
    if (
      !isRecord(body) ||
      !Array.isArray(body.results) ||
      body.count !== body.results.length ||
      body.next !== null
    ) {
      throw new WebshareProxySelectionError(false);
    }
    const active = body.results.filter(
      (value) => isRecord(value) && value.status === "active",
    );
    if (active.length !== 1) throw new WebshareProxySelectionError(false);
    const plan = active[0];
    if (!isRecord(plan)) throw new WebshareProxySelectionError(false);
    const countries = plan.proxy_countries;
    if (
      !Number.isSafeInteger(plan.id) ||
      plan.proxy_type !== "shared" ||
      plan.proxy_subtype !== "isp" ||
      plan.proxy_count !== proxyCount ||
      plan.automatic_refresh_frequency !== 0 ||
      !isRecord(countries) ||
      Object.keys(countries).length !== 1 ||
      countries[proxyCountry] !== proxyCount
    ) {
      throw new WebshareProxySelectionError(false);
    }
    return plan.id as number;
  };

  const loadProxies = async (): Promise<ReadonlyArray<WebshareProxy>> => {
    const planId = await loadPlanId();
    const url = new URL(webshareProxyListUrl);
    url.searchParams.set("plan_id", String(planId));
    const body = await loadBody(url.href);
    if (!isRecord(body) || !Array.isArray(body.results)) {
      throw new WebshareProxySelectionError(false);
    }
    const count = body.count;
    const parsed = body.results.map(parseProxy);
    if (
      !Number.isSafeInteger(count) ||
      count !== body.results.length ||
      body.next !== null ||
      parsed.includes(null)
    ) {
      throw new WebshareProxySelectionError(false);
    }
    const valid = (parsed as WebshareProxy[])
      .filter((proxy) => proxy.valid)
      .sort(
        (left, right) =>
          left.port - right.port || left.id.localeCompare(right.id),
      );
    if (count !== proxyCount || valid.length !== proxyCount) {
      throw new WebshareProxySelectionError(false);
    }
    if (new Set(valid.map((proxy) => proxy.url)).size !== valid.length) {
      throw new WebshareProxySelectionError(false);
    }
    return valid;
  };

  return {
    select: async ({ currentProxyUrl, occupiedProxyUrls, setupMarker }) => {
      const proxies = await loadProxies();
      const occupied = new Set(
        occupiedProxyUrls.map((value) => Redacted.value(value)),
      );
      const current =
        currentProxyUrl === undefined
          ? undefined
          : Redacted.value(currentProxyUrl);
      if (
        current !== undefined &&
        proxies.some((proxy) => proxy.url === current) &&
        !occupied.has(current)
      ) {
        return Redacted.make(current);
      }
      const start = await markerIndex(setupMarker, proxies.length);
      for (let offset = 0; offset < proxies.length; offset += 1) {
        const proxy = proxies[(start + offset) % proxies.length];
        if (proxy !== undefined && !occupied.has(proxy.url)) {
          return Redacted.make(proxy.url);
        }
      }
      throw new WebshareProxySelectionError(true);
    },
  };
};
