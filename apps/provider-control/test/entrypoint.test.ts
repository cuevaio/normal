import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, test, vi } from "vitest";

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
