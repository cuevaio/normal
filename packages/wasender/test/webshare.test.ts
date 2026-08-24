import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";
import type { SetupMarker } from "../src/control";
import {
  makeWebshareProxySelector,
  WebshareProxySelectionError,
} from "../src/webshare";

const apiKey = Redacted.make("webshare_api_key_fixture");
const setupMarker = "cst_0123456789abcdefghijk" as SetupMarker;

const proxyCredential = (kind: "pass" | "user", index: number) =>
  `${kind}_${index}_fixture`;

const proxyUrl = (index: number, port: number) => {
  const url = new URL(`socks5://p.webshare.io:${port}`);
  url.username = proxyCredential("user", index);
  url.password = proxyCredential("pass", index);
  return url.href;
};

const response = (results: ReadonlyArray<Record<string, unknown>>) =>
  new Response(JSON.stringify({ count: results.length, next: null, results }), {
    headers: { "content-type": "application/json" },
  });

const proxy = (overrides: Record<string, unknown> = {}) => ({
  country_code: "CO",
  id: "b-1",
  password: proxyCredential("pass", 1),
  port: 10_000,
  username: proxyCredential("user", 1),
  valid: true,
  ...overrides,
});

const proxies = () =>
  Array.from({ length: 20 }, (_, index) =>
    proxy({
      id: `b-${index + 1}`,
      password: proxyCredential("pass", index + 1),
      port: 10_000 + index,
      username: proxyCredential("user", index + 1),
    }),
  );

const planResponse = (overrides: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      count: 1,
      next: null,
      results: [
        {
          automatic_refresh_frequency: 0,
          id: 14_141_301,
          proxy_count: 20,
          proxy_countries: { CO: 20 },
          proxy_subtype: "isp",
          proxy_type: "shared",
          status: "active",
          ...overrides,
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );

const fetchList =
  (results: ReadonlyArray<Record<string, unknown>>) =>
  async (request: Request) =>
    request.url.includes("/subscription/plan/")
      ? planResponse()
      : response(results);

describe("Webshare proxy selector", () => {
  test("uses the Colombian backbone hostname and preserves an assigned proxy", async () => {
    const authorizations: Array<string | null> = [];
    const selector = makeWebshareProxySelector(
      { apiKey },
      {
        fetch: async (request) => {
          authorizations.push(request.headers.get("authorization"));
          return fetchList(proxies())(request);
        },
      },
    );
    const current = Redacted.make(proxyUrl(1, 10_000));

    const selected = await selector.select({
      currentProxyUrl: current,
      occupiedProxyUrls: [],
      setupMarker,
    });

    expect(Redacted.value(selected)).toBe(Redacted.value(current));
    expect(authorizations).toEqual([
      "Token webshare_api_key_fixture",
      "Token webshare_api_key_fixture",
    ]);
  });

  test("skips a proxy already assigned to another session", async () => {
    const selector = makeWebshareProxySelector(
      { apiKey },
      {
        fetch: fetchList(proxies()),
      },
    );
    const first = Redacted.make(proxyUrl(1, 10_000));

    const selected = await selector.select({
      occupiedProxyUrls: [first],
      setupMarker,
    });

    expect(Redacted.value(selected)).not.toBe(Redacted.value(first));
    expect(Redacted.value(selected)).toContain("@p.webshare.io:");
  });

  test("fails closed when the assigned list is not Colombian", async () => {
    const selector = makeWebshareProxySelector(
      { apiKey },
      {
        fetch: fetchList(
          proxies().map((value, index) =>
            index === 0 ? { ...value, country_code: "US" } : value,
          ),
        ),
      },
    );

    const failure = await selector
      .select({ occupiedProxyUrls: [], setupMarker })
      .catch((cause) => cause);
    expect(failure).toBeInstanceOf(WebshareProxySelectionError);
    expect((failure as WebshareProxySelectionError).retryable).toBe(false);
  });

  test("retries a throttled proxy-list read within the bounded budget", async () => {
    let calls = 0;
    const delays: number[] = [];
    const selector = makeWebshareProxySelector(
      { apiKey },
      {
        fetch: async () => {
          calls += 1;
          if (calls === 1) return planResponse();
          return calls === 2
            ? new Response(null, { status: 429 })
            : response(proxies());
        },
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
      },
    );

    const selected = await selector.select({
      occupiedProxyUrls: [],
      setupMarker,
    });

    expect(Redacted.value(selected)).toContain("@p.webshare.io:");
    expect(calls).toBe(3);
    expect(delays).toEqual([250]);
  });

  test("fails closed when Auto-Refresh is enabled", async () => {
    const selector = makeWebshareProxySelector(
      { apiKey },
      {
        fetch: async (request) =>
          request.url.includes("/subscription/plan/")
            ? planResponse({ automatic_refresh_frequency: 3_600 })
            : response(proxies()),
      },
    );

    const failure = await selector
      .select({ occupiedProxyUrls: [], setupMarker })
      .catch((cause) => cause);

    expect(failure).toBeInstanceOf(WebshareProxySelectionError);
    expect((failure as WebshareProxySelectionError).retryable).toBe(false);
  });
});
