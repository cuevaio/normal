import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, test, vi } from "vitest";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

const websharePlan = () =>
  json({
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
      },
    ],
  });

const proxyCredential = (kind: "pass" | "user", index: number) =>
  `${kind}_${index}_fixture`;

const webshareProxies = () =>
  json({
    count: 20,
    next: null,
    results: Array.from({ length: 20 }, (_, index) => ({
      country_code: "CO",
      id: `b-${index + 1}`,
      password: proxyCredential("pass", index + 1),
      port: 10_000 + index,
      username: proxyCredential("user", index + 1),
      valid: true,
    })),
  });

describe("provider-control Worker entrypoint", () => {
  test("serves the health canary through its service-binding entrypoint", async () => {
    const response = await exports.default.fetch(
      "https://provider-control.internal/health",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: "provider-control",
      status: "ok",
    });
  });

  test("exposes lifecycle authority through RPC without returning the account credential", async () => {
    const requests: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      requests.push(request);
      return new Response(JSON.stringify({ data: [], success: true }), {
        headers: { "content-type": "application/json" },
      });
    });

    const result = await exports.default.reconcileSession({
      setupMarker: "cst_0123456789abcdefghijk",
    });

    expect(result).toEqual({
      ok: true,
      value: { outcome: "absent" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer pat_0123456789abcdef0123456789abcdef",
    );
    expect(JSON.stringify(result)).not.toContain(
      "pat_0123456789abcdef0123456789abcdef",
    );
  });

  test("rejects malformed RPC calls before provider access", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");

    const result = await exports.default.reconcileSession({
      setupMarker: "",
    });

    expect(result).toEqual({
      error: {
        _tag: "ProviderControlFailure",
        code: "invalid_request",
        operation: "boundary",
        retryAfterMs: null,
        retryDecision: "do_not_retry",
      },
      ok: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("serializes provider allocation operations through one gate", async () => {
    const requests: Request[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      requests.push(request);
      if (requests.length === 1) {
        markFirstStarted();
        await firstRelease;
      }
      return new Response(JSON.stringify({ data: [], success: true }), {
        headers: { "content-type": "application/json" },
      });
    });

    const first = exports.default.reconcileSession({
      setupMarker: "cst_0123456789abcdefghijk",
    });
    await firstStarted;
    const second = exports.default.reconcileSession({
      setupMarker: "cst_0123456789abcdefghijl",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(requests).toHaveLength(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(requests).toHaveLength(2);
  });

  test("quarantines the pool after an ambiguous proxy allocation write", async () => {
    let providerWrites = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.url.includes("/subscription/plan/")) return websharePlan();
      if (request.url.includes("/proxy/list/")) return webshareProxies();
      if (request.method === "POST") {
        providerWrites += 1;
        throw new DOMException("timed out", "AbortError");
      }
      return json({ data: [], success: true });
    });

    const first = await exports.default.createSession({
      phoneNumber: "+15550123456",
      setupMarker: "cst_0123456789abcdefghijk",
      webhookUrl:
        "https://api.example.test/webhooks/wasender/30000000-0000-4000-8000-000000000041",
    });
    const second = await exports.default.createSession({
      phoneNumber: "+15550123457",
      setupMarker: "cst_0123456789abcdefghijl",
      webhookUrl:
        "https://api.example.test/webhooks/wasender/30000000-0000-4000-8000-000000000042",
    });

    expect(first).toMatchObject({
      error: {
        code: "timed_out",
        operation: "lifecycle-write",
        retryDecision: "reconcile_before_repeat",
      },
      ok: false,
    });
    expect(second).toEqual({
      error: {
        _tag: "ProviderControlFailure",
        code: "unavailable",
        operation: "lifecycle-write",
        retryAfterMs: null,
        retryDecision: "reconcile_before_repeat",
      },
      ok: false,
    });
    expect(providerWrites).toBe(1);
  });

  test("does not expose lifecycle operations over HTTP", async () => {
    const response = await exports.default.fetch(
      new Request("https://provider-control.invalid/lifecycle/reconcile", {
        body: JSON.stringify({
          setupMarker: "cst_0123456789abcdefghijk",
        }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
