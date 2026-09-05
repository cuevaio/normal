import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, test, vi } from "vitest";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

const webhookEvents = [
  "contacts.update",
  "contacts.upsert",
  "groups.update",
  "groups.upsert",
  "message-receipt.update",
  "message.sent",
  "messages-group.received",
  "messages-personal.received",
  "messages.delete",
  "messages.received",
  "messages.update",
  "messages.upsert",
  "session.status",
];

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

  test("creates a safely configured provider session without a proxy", async () => {
    const setupMarker = "cst_0123456789abcdefghijk";
    const webhookUrl =
      "https://api.example.test/webhooks/wasender/30000000-0000-4000-8000-000000000041";
    let createBody: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.method === "POST") {
        createBody = (await request.json()) as Record<string, unknown>;
        return json({
          data: {
            ...createBody,
            api_key: "session_credential",
            created_at: "2026-08-25T22:00:00Z",
            id: 41,
            status: "NEED_SCAN",
            updated_at: "2026-08-25T22:00:00Z",
            webhook_secret: "webhook_secret",
          },
          success: true,
        });
      }
      return json({ data: [], success: true });
    });

    const result = await exports.default.createSession({
      phoneNumber: "+15550123456",
      setupMarker,
      webhookUrl,
    });

    expect(result).toMatchObject({ ok: true });
    expect(createBody).toMatchObject({
      account_protection: true,
      ignore_groups: false,
      log_messages: false,
      name: setupMarker,
      phone_number: "+15550123456",
      read_incoming_messages: false,
      webhook_enabled: true,
      webhook_events: webhookEvents,
      webhook_url: webhookUrl,
    });
    expect(createBody).not.toHaveProperty("proxy_url");
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
