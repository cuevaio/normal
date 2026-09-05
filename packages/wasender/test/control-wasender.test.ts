import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import {
  makeWasenderSessionLifecycle,
  type ProviderNeutralFailure,
  type SessionAuthority,
  type SetupMarker,
  type WasenderLifecycleTelemetryEvent,
  type WebhookEndpoint,
  type WhatsAppNumber,
} from "../src/control";
import { WebshareProxySelectionError } from "../src/webshare";

const credential = Redacted.make("pat_0123456789abcdef0123456789abcdef");
const referenceSecret = Redacted.make(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const setupMarker = "cst_0123456789abcdefghijk" as SetupMarker;
const phoneNumber = Redacted.make("+15550123456") as WhatsAppNumber;
const webhookEndpoint = Redacted.make(
  "https://api.example.test/webhooks/wasender/30000000-0000-4000-8000-000000000041",
) as WebhookEndpoint;
const proxyUrl = "socks5://proxy-one:password-one@p.webshare.io:10000";
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

const providerSession = (overrides: Record<string, unknown> = {}) => ({
  account_protection: true,
  api_key: "session_credential",
  created_at: "2026-07-30T12:00:00Z",
  id: 41,
  ignore_groups: false,
  log_messages: false,
  name: setupMarker,
  phone_number: "+15550123456",
  read_incoming_messages: false,
  status: "NEED_SCAN",
  updated_at: "2026-07-30T12:00:00Z",
  webhook_enabled: true,
  webhook_events: webhookEvents,
  webhook_url: Redacted.value(webhookEndpoint),
  webhook_secret: "webhook_secret",
  ...overrides,
});

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

const runFailure = async <A>(
  effect: Effect.Effect<A, ProviderNeutralFailure>,
) => Effect.runPromise(Effect.flip(effect));

const verifySessionNumber = async (userId: string) => {
  const lifecycle = makeWasenderSessionLifecycle(
    { credential, referenceSecret },
    {
      fetch: async (request) => {
        if (request.url.endsWith("/api/whatsapp-sessions")) {
          return json({
            success: true,
            data: [providerSession({ api_key: undefined })],
          });
        }
        if (request.url.endsWith("/api/whatsapp-sessions/41")) {
          return json({ success: true, data: providerSession() });
        }
        if (request.url.endsWith("/api/user")) {
          return json({ success: true, data: { id: userId } });
        }
        return json({}, { status: 500 });
      },
    },
  );
  const [listed] = await Effect.runPromise(
    lifecycle.listSessions({ setupMarker }),
  );
  if (listed === undefined) throw new Error("expected provider session");
  return Effect.runPromise(
    lifecycle.verifySessionNumber({
      phoneNumber,
      session: listed.session,
    }),
  );
};

describe("real Wasender lifecycle adapter", () => {
  test("creates one safely configured provider session with protected outputs", async () => {
    const requests: Request[] = [];
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async (request) => {
          requests.push(request);
          return requests.length === 1
            ? json({ success: true, data: [] })
            : json({ success: true, data: providerSession() });
        },
      },
    );

    const result = await Effect.runPromise(
      lifecycle.createSession({ phoneNumber, setupMarker, webhookEndpoint }),
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[1]?.method).toBe("POST");
    expect(requests[1]?.url).toBe(
      "https://api.wapi.crafter.run/api/whatsapp-sessions",
    );
    expect(requests[1]?.headers.get("authorization")).toBe(
      `Bearer ${Redacted.value(credential)}`,
    );
    expect(await requests[1]?.json()).toEqual({
      account_protection: true,
      ignore_groups: false,
      log_messages: false,
      name: setupMarker,
      phone_number: "+15550123456",
      read_incoming_messages: false,
      webhook_enabled: true,
      webhook_events: webhookEvents,
      webhook_url: Redacted.value(webhookEndpoint),
    });
    expect(result.connectionState).toBe("connecting");
    expect(JSON.stringify(result)).not.toContain("41");
    expect(JSON.stringify(result)).not.toContain("session_credential");
    expect(JSON.stringify(result)).not.toContain("webhook_secret");
    expect(Redacted.value(result.authority as SessionAuthority)).toContain(
      "session_credential",
    );
  });

  test("assigns an unused proxy while creating a provider session", async () => {
    const requests: Request[] = [];
    const reservations: string[] = [];
    const releases: string[] = [];
    const responses = [
      json({ success: true, data: [] }),
      json({ success: true, data: [] }),
      json({
        success: true,
        data: providerSession({ proxy_url: proxyUrl }),
      }),
    ];
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async (request) => {
          requests.push(request);
          return responses.shift() ?? json({}, { status: 500 });
        },
        proxySelector: {
          select: async (input) => {
            expect(input.setupMarker).toBe(setupMarker);
            expect(input.occupiedProxyUrls).toEqual([]);
            return Redacted.make(proxyUrl);
          },
        },
        proxyAllocationCoordinator: {
          release: async (marker) => {
            releases.push(String(marker));
          },
          reserve: async (marker) => {
            reservations.push(String(marker));
          },
        },
      },
    );

    await Effect.runPromise(
      lifecycle.createSession({ phoneNumber, setupMarker, webhookEndpoint }),
    );

    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "POST",
    ]);
    expect(await requests[2]?.json()).toMatchObject({ proxy_url: proxyUrl });
    expect(reservations).toEqual([setupMarker]);
    expect(releases).toEqual([setupMarker]);
  });

  test("loads session details before treating proxies as unoccupied", async () => {
    const assignedProxy = new URL(proxyUrl);
    assignedProxy.port = "10001";
    const assignedProxyUrl = assignedProxy.href;
    const otherSummary = providerSession({
      api_key: undefined,
      id: 42,
      name: "other",
      proxy_url: undefined,
    });
    const otherDetail = providerSession({
      id: 42,
      name: "other",
      proxy_url: assignedProxyUrl,
    });
    const responses = [
      json({ success: true, data: [otherSummary] }),
      json({ success: true, data: [otherSummary] }),
      json({ success: true, data: otherDetail }),
      json({
        success: true,
        data: providerSession({ proxy_url: proxyUrl }),
      }),
    ];
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => responses.shift() ?? json({}, { status: 500 }),
        proxySelector: {
          select: async (input) => {
            expect(input.occupiedProxyUrls.map(Redacted.value)).toEqual([
              assignedProxyUrl,
            ]);
            return Redacted.make(proxyUrl);
          },
        },
      },
    );

    await Effect.runPromise(
      lifecycle.createSession({ phoneNumber, setupMarker, webhookEndpoint }),
    );

    expect(responses).toEqual([]);
  });

  test("reconciles before retrying a transient proxy-list failure", async () => {
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => json({ success: true, data: [] }),
        proxySelector: {
          select: async () => {
            throw new WebshareProxySelectionError(true);
          },
        },
      },
    );

    const failure = await runFailure(
      lifecycle.createSession({ phoneNumber, setupMarker, webhookEndpoint }),
    );

    expect(failure).toMatchObject({
      code: "unavailable",
      operation: "lifecycle-write",
      retryDecision: "reconcile_before_repeat",
    });
  });

  test("maps empty paid proxy inventory to provider capacity unavailability", async () => {
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => json({ success: true, data: [] }),
        proxySelector: {
          select: async () => {
            throw new WebshareProxySelectionError(false, true);
          },
        },
      },
    );

    const failure = await runFailure(
      lifecycle.createSession({ phoneNumber, setupMarker, webhookEndpoint }),
    );

    expect(failure).toMatchObject({
      code: "source_rejected",
      operation: "lifecycle-write",
      retryDecision: "do_not_retry",
    });
  });

  test("maps an unavailable allocation snapshot to a retryable lifecycle write", async () => {
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => {
          calls += 1;
          return calls === 1
            ? json({ success: true, data: [] })
            : json({}, { status: 503 });
        },
        random: () => 0,
        sleep: async () => undefined,
        proxySelector: {
          select: async () => Redacted.make(proxyUrl),
        },
      },
    );

    const failure = await runFailure(
      lifecycle.createSession({ phoneNumber, setupMarker, webhookEndpoint }),
    );

    expect(calls).toBe(4);
    expect(failure).toMatchObject({
      code: "unavailable",
      operation: "lifecycle-write",
      retryDecision: "reconcile_before_repeat",
    });
  });

  test("preserves a permanent allocation snapshot failure", async () => {
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => {
          calls += 1;
          return calls === 1
            ? json({ success: true, data: [] })
            : json({ success: true, data: { malformed: true } });
        },
        proxySelector: {
          select: async () => Redacted.make(proxyUrl),
        },
      },
    );

    const failure = await runFailure(
      lifecycle.createSession({ phoneNumber, setupMarker, webhookEndpoint }),
    );

    expect(calls).toBe(2);
    expect(failure).toMatchObject({
      code: "invalid_response",
      operation: "lifecycle-write",
      retryDecision: "do_not_retry",
    });
  });

  test("repairs a missing proxy without reusing another session's assignment", async () => {
    const otherProxyUrl = "socks5://proxy-two:password-two@p.webshare.io:10001";
    const targetWithoutProxy = providerSession({ proxy_url: null });
    const other = providerSession({
      api_key: undefined,
      id: 42,
      name: "other",
      proxy_url: otherProxyUrl,
    });
    const requests: Request[] = [];
    const responses = [
      json({ success: true, data: [targetWithoutProxy, other] }),
      json({ success: true, data: targetWithoutProxy }),
      json({ success: true, data: [targetWithoutProxy, other] }),
      json({
        success: true,
        data: { ...other, api_key: "session_credential" },
      }),
      json({
        success: true,
        data: providerSession({ proxy_url: proxyUrl }),
      }),
      json({
        success: true,
        data: providerSession({ proxy_url: proxyUrl }),
      }),
    ];
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async (request) => {
          requests.push(request);
          return responses.shift() ?? json({}, { status: 500 });
        },
        proxySelector: {
          select: async (input) => {
            expect(input.currentProxyUrl).toBeUndefined();
            expect(
              input.occupiedProxyUrls.map((value) => Redacted.value(value)),
            ).toEqual([otherProxyUrl]);
            return Redacted.make(proxyUrl);
          },
        },
      },
    );

    await Effect.runPromise(
      lifecycle.repairSessionConfiguration({ setupMarker, webhookEndpoint }),
    );

    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "GET",
      "PUT",
      "GET",
    ]);
    expect(await requests[4]?.json()).toMatchObject({ proxy_url: proxyUrl });
  });

  test("reports a missing proxy as configuration drift", async () => {
    const responses = [
      json({
        success: true,
        data: [providerSession({ api_key: undefined, proxy_url: null })],
      }),
      json({ success: true, data: providerSession({ proxy_url: null }) }),
      json({
        success: true,
        data: [providerSession({ api_key: undefined, proxy_url: null })],
      }),
    ];
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => responses.shift() ?? json({}, { status: 500 }),
        proxySelector: {
          select: async () => Redacted.make(proxyUrl),
        },
      },
    );

    const failure = await runFailure(
      lifecycle.reconcileSession({ requireConnectReady: true, setupMarker }),
    );

    expect(failure.code).toBe("integrity_failed");
  });

  test("reports a duplicate proxy assignment as configuration drift", async () => {
    const configured = providerSession({ proxy_url: proxyUrl });
    const responses = [
      json({
        success: true,
        data: [providerSession({ api_key: undefined, proxy_url: proxyUrl })],
      }),
      json({ success: true, data: configured }),
      json({
        success: true,
        data: [
          providerSession({ api_key: undefined, proxy_url: proxyUrl }),
          providerSession({
            api_key: undefined,
            id: 42,
            name: "other",
            proxy_url: proxyUrl,
          }),
        ],
      }),
      json({
        success: true,
        data: providerSession({ id: 42, name: "other", proxy_url: proxyUrl }),
      }),
    ];
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => responses.shift() ?? json({}, { status: 500 }),
        proxySelector: {
          select: async ({ occupiedProxyUrls }) =>
            Redacted.make(
              occupiedProxyUrls.some(
                (value) => Redacted.value(value) === proxyUrl,
              )
                ? "socks5://proxy-three:password-three@p.webshare.io:10002"
                : proxyUrl,
            ),
        },
      },
    );

    const failure = await runFailure(
      lifecycle.reconcileSession({ setupMarker, webhookEndpoint }),
    );

    expect(failure.code).toBe("integrity_failed");
  });

  test("reports a stale proxy assignment as configuration drift", async () => {
    const staleProxyUrl =
      "socks5://stale-proxy:stale-password@p.webshare.io:10003";
    const responses = [
      json({
        success: true,
        data: [
          providerSession({ api_key: undefined, proxy_url: staleProxyUrl }),
        ],
      }),
      json({
        success: true,
        data: providerSession({ proxy_url: staleProxyUrl }),
      }),
      json({
        success: true,
        data: [
          providerSession({ api_key: undefined, proxy_url: staleProxyUrl }),
        ],
      }),
    ];
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => responses.shift() ?? json({}, { status: 500 }),
        proxySelector: {
          select: async () => Redacted.make(proxyUrl),
        },
      },
    );

    const failure = await runFailure(
      lifecycle.reconcileSession({ setupMarker, webhookEndpoint }),
    );

    expect(failure.code).toBe("integrity_failed");
  });

  test("repairs group webhook delivery on an existing provider session", async () => {
    const requests: Request[] = [];
    const responses = [
      json({
        success: true,
        data: [providerSession({ api_key: undefined, ignore_groups: true })],
      }),
      json({
        success: true,
        data: providerSession({ ignore_groups: true }),
      }),
      json({ success: true, data: providerSession() }),
      json({ success: true, data: providerSession() }),
    ];
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async (request) => {
          requests.push(request);
          return responses.shift() ?? json({}, { status: 500 });
        },
      },
    );

    const result = await Effect.runPromise(
      lifecycle.repairSessionConfiguration({ setupMarker, webhookEndpoint }),
    );

    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "PUT",
      "GET",
    ]);
    expect(await requests[2]?.json()).toMatchObject({
      ignore_groups: false,
      webhook_events: expect.arrayContaining(["messages-group.received"]),
    });
    expect(result.connectionState).toBe("connecting");
  });

  test("adopts one deterministic marker and reports duplicates for quarantine", async () => {
    const responses = [
      json({
        success: true,
        data: [
          providerSession({ api_key: undefined }),
          providerSession({ api_key: undefined, id: 42, name: "other" }),
        ],
      }),
      json({ success: true, data: providerSession() }),
      json({
        success: true,
        data: [
          providerSession({ api_key: undefined }),
          providerSession({ api_key: undefined, id: 43 }),
        ],
      }),
      json({ success: true, data: providerSession() }),
      json({ success: true, data: providerSession({ id: 43 }) }),
    ];
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => responses[calls++] ?? json({}, { status: 500 }),
      },
    );

    const adopted = await Effect.runPromise(
      lifecycle.createSession({ phoneNumber, setupMarker, webhookEndpoint }),
    );
    const duplicates = await Effect.runPromise(
      lifecycle.reconcileSession({ setupMarker }),
    );

    expect(adopted.connectionState).toBe("connecting");
    expect(duplicates.outcome).toBe("duplicates");
    if (duplicates.outcome === "duplicates") {
      expect(duplicates.sessions).toHaveLength(2);
      expect(duplicates.sessions[0]?.session).not.toBe(
        duplicates.sessions[1]?.session,
      );
    }
    expect(calls).toBe(5);
  });

  test("rejects a reconciled marker with a different webhook configuration", async () => {
    const responses = [
      json({
        success: true,
        data: [providerSession({ api_key: undefined })],
      }),
      json({
        success: true,
        data: providerSession({
          webhook_url:
            "https://api.example.test/webhooks/wasender/30000000-0000-4000-8000-000000000099",
        }),
      }),
    ];
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => responses[calls++] ?? json({}, { status: 500 }),
      },
    );

    const failure = await runFailure(
      lifecycle.reconcileSession({ setupMarker, webhookEndpoint }),
    );

    expect(failure.code).toBe("integrity_failed");
    expect(failure.retryDecision).toBe("do_not_retry");
  });

  test("rejects a reconciled marker with broader provider retention or read settings", async () => {
    for (const unsafeSetting of [
      { log_messages: true },
      { read_incoming_messages: true },
    ]) {
      const responses = [
        json({
          success: true,
          data: [providerSession({ api_key: undefined })],
        }),
        json({
          success: true,
          data: providerSession(unsafeSetting),
        }),
      ];
      let calls = 0;
      const lifecycle = makeWasenderSessionLifecycle(
        { credential, referenceSecret },
        {
          fetch: async () => responses[calls++] ?? json({}, { status: 500 }),
        },
      );

      const failure = await runFailure(
        lifecycle.reconcileSession({ setupMarker, webhookEndpoint }),
      );

      expect(failure.code).toBe("integrity_failed");
      expect(failure.retryDecision).toBe("do_not_retry");
    }
  });

  test("normalizes provider states that require a new connection flow", async () => {
    const responses = [
      json({
        success: true,
        data: [
          providerSession({ api_key: undefined, status: "LOGGED_OUT" }),
          providerSession({
            api_key: undefined,
            id: 42,
            status: "expired",
          }),
        ],
      }),
      json({ success: true, data: providerSession({ status: "LOGGED_OUT" }) }),
      json({
        success: true,
        data: providerSession({ id: 42, status: "expired" }),
      }),
    ];
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => responses[calls++] ?? json({}, { status: 500 }),
      },
    );

    const sessions = await Effect.runPromise(
      lifecycle.listSessions({ setupMarker }),
    );

    expect(sessions.map(({ connectionState }) => connectionState)).toEqual([
      "reconnect_required",
      "reconnect_required",
    ]);
  });

  test("quarantines duplicate markers instead of creating another session", async () => {
    const responses = [
      json({
        success: true,
        data: [
          providerSession({ api_key: undefined }),
          providerSession({ api_key: undefined, id: 43 }),
        ],
      }),
      json({ success: true, data: providerSession() }),
      json({ success: true, data: providerSession({ id: 43 }) }),
    ];
    const methods: string[] = [];
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async (request) => {
          methods.push(request.method);
          return responses[calls++] ?? json({}, { status: 500 });
        },
      },
    );

    const failure = await runFailure(
      lifecycle.createSession({ phoneNumber, setupMarker, webhookEndpoint }),
    );

    expect(failure.code).toBe("integrity_failed");
    expect(failure.retryDecision).toBe("do_not_retry");
    expect(methods).toEqual(["GET", "GET", "GET"]);
  });

  test.each([
    ["personal account", "15550123456@s.whatsapp.net"],
    ["business account linked device", "15550123456:12@s.whatsapp.net"],
  ])("verifies a matching %s number from provider user info", async (_, id) => {
    await expect(verifySessionNumber(id)).resolves.toEqual({
      outcome: "match",
    });
  });

  test.each([
    ["different business account", "15550123457:12@s.whatsapp.net", "mismatch"],
    ["ambiguous linked-device identity", "123456789@lid", "unverified"],
  ] as const)("fails closed for %s", async (_, id, outcome) => {
    await expect(verifySessionNumber(id)).resolves.toEqual({ outcome });
  });

  test("honors bounded throttling delay within the safe-read retry budget", async () => {
    const sleeps: number[] = [];
    const telemetry: WasenderLifecycleTelemetryEvent[] = [];
    let calls = 0;
    let now = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => {
          calls += 1;
          return calls === 1
            ? json({ message: "slow down", retry_after: 60 }, { status: 429 })
            : json({ success: true, data: [] });
        },
        now: () => now,
        random: () => 0,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          now += milliseconds;
        },
        telemetry: (event) => telemetry.push(event),
      },
    );

    expect(
      await Effect.runPromise(lifecycle.listSessions({ setupMarker })),
    ).toEqual([]);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([5_000]);
    expect(telemetry.map(({ outcome }) => outcome)).toEqual([
      "throttled",
      "success",
    ]);
    expect(JSON.stringify(telemetry)).not.toContain("slow down");
    expect(JSON.stringify(telemetry)).not.toContain(setupMarker);
  });

  test("retries a retryable status with a malformed provider body", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    let now = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => {
          calls += 1;
          return calls === 1
            ? new Response("<html>temporarily unavailable</html>", {
                status: 503,
              })
            : json({ success: true, data: [] });
        },
        now: () => now,
        random: () => 0,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          now += milliseconds;
        },
      },
    );

    expect(
      await Effect.runPromise(lifecycle.listSessions({ setupMarker })),
    ).toEqual([]);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([125]);
  });

  test("classifies malformed bounded responses without exposing provider data", async () => {
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => json({ success: true, data: { secret: "raw" } }),
      },
    );

    const failure = await runFailure(lifecycle.listSessions({ setupMarker }));

    expect(failure).toEqual({
      _tag: "ProviderNeutralFailure",
      code: "invalid_response",
      operation: "safe-read",
      retryAfterMs: null,
      retryDecision: "do_not_retry",
    });
    expect(JSON.stringify(failure)).not.toContain("raw");
  });

  test("does not repeat an ambiguous create timeout", async () => {
    let calls = 0;
    const reservations: string[] = [];
    const releases: string[] = [];
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => {
          calls += 1;
          if (calls <= 2) return json({ success: true, data: [] });
          throw new DOMException("timed out", "AbortError");
        },
        proxyAllocationCoordinator: {
          release: async (marker) => {
            releases.push(String(marker));
          },
          reserve: async (marker) => {
            reservations.push(String(marker));
          },
        },
        proxySelector: {
          select: async () => Redacted.make(proxyUrl),
        },
      },
    );

    const failure = await runFailure(
      lifecycle.createSession({ phoneNumber, setupMarker, webhookEndpoint }),
    );

    expect(calls).toBe(3);
    expect(reservations).toEqual([setupMarker]);
    expect(releases).toEqual([]);
    expect(failure).toEqual({
      _tag: "ProviderNeutralFailure",
      code: "timed_out",
      operation: "lifecycle-write",
      retryAfterMs: null,
      retryDecision: "reconcile_before_repeat",
    });
  });

  test("connects by opaque locator with one lifecycle write", async () => {
    const responses = [
      json({ success: true, data: [] }),
      json({ success: true, data: providerSession() }),
      json({
        success: true,
        data: [providerSession({ api_key: undefined })],
      }),
      json({ success: true, data: providerSession() }),
      json({ success: true, data: { status: "NEED_SCAN" } }),
    ];
    const requests: Request[] = [];
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async (request) => {
          requests.push(request);
          return responses[calls++] ?? json({}, { status: 500 });
        },
      },
    );
    const created = await Effect.runPromise(
      lifecycle.createSession({ phoneNumber, setupMarker, webhookEndpoint }),
    );

    const connected = await Effect.runPromise(
      lifecycle.connectSession({ session: created.session }),
    );

    expect(connected.connectionState).toBe("connecting");
    expect(requests.map(({ method }) => method)).toEqual([
      "GET",
      "POST",
      "GET",
      "GET",
      "POST",
    ]);
    expect(requests[4]?.url).toBe(
      "https://api.wapi.crafter.run/api/whatsapp-sessions/41/connect",
    );
    expect(await requests[4]?.json()).toEqual({ linkMethod: "qr" });
  });

  test("refuses to connect a session with a stale proxy assignment", async () => {
    const staleProxy = new URL(proxyUrl);
    staleProxy.port = "10003";
    const staleProxyUrl = staleProxy.href;
    const staleSummary = providerSession({
      api_key: undefined,
      proxy_url: staleProxyUrl,
    });
    const staleDetail = providerSession({ proxy_url: staleProxyUrl });
    const responses = [
      json({ success: true, data: [staleSummary] }),
      json({ success: true, data: staleDetail }),
      json({ success: true, data: [staleSummary] }),
      json({ success: true, data: staleDetail }),
      json({ success: true, data: [staleSummary] }),
    ];
    const requests: Request[] = [];
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async (request) => {
          requests.push(request);
          return responses.shift() ?? json({}, { status: 500 });
        },
        proxySelector: {
          select: async () => Redacted.make(proxyUrl),
        },
      },
    );
    const sessions = await Effect.runPromise(
      lifecycle.listSessions({ setupMarker }),
    );
    const session = sessions[0];
    if (!session) throw new Error("missing session fixture");

    const failure = await runFailure(
      lifecycle.connectSession({ session: session.session }),
    );

    expect(failure).toMatchObject({
      code: "integrity_failed",
      operation: "lifecycle-write",
      retryDecision: "do_not_retry",
    });
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
  });

  test("disconnects by opaque locator with one lifecycle write", async () => {
    const responses = [
      json({
        success: true,
        data: [providerSession({ api_key: undefined, status: "connected" })],
      }),
      json({
        success: true,
        data: providerSession({ status: "connected" }),
      }),
      json({
        success: true,
        data: [providerSession({ api_key: undefined, status: "connected" })],
      }),
      json({
        success: true,
        data: providerSession({ status: "connected" }),
      }),
      json({
        success: true,
        data: { status: "disconnected" },
      }),
    ];
    const requests: Request[] = [];
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async (request) => {
          requests.push(request);
          return responses[calls++] ?? json({}, { status: 500 });
        },
        proxySelector: {
          select: async () => {
            throw new Error("disconnect must not inspect proxy inventory");
          },
        },
      },
    );
    const sessions = await Effect.runPromise(
      lifecycle.listSessions({ setupMarker }),
    );
    const session = sessions[0];
    if (!session) throw new Error("missing session fixture");

    const disconnected = await Effect.runPromise(
      lifecycle.disconnectSession({ session: session.session }),
    );

    expect(disconnected.connectionState).toBe("disconnected");
    expect(requests.map(({ method }) => method)).toEqual([
      "GET",
      "GET",
      "GET",
      "GET",
      "POST",
    ]);
    expect(requests[4]?.url).toBe(
      "https://api.wapi.crafter.run/api/whatsapp-sessions/41/disconnect",
    );
  });

  test("does not repeat an ambiguous disconnect timeout", async () => {
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => {
          calls += 1;
          if (calls === 1) {
            return json({
              success: true,
              data: [
                providerSession({ api_key: undefined, status: "connected" }),
              ],
            });
          }
          if (calls === 2 || calls === 4) {
            return json({
              success: true,
              data: providerSession({ status: "connected" }),
            });
          }
          if (calls === 3) {
            return json({
              success: true,
              data: [
                providerSession({ api_key: undefined, status: "connected" }),
              ],
            });
          }
          throw new DOMException("timed out", "AbortError");
        },
      },
    );
    const sessions = await Effect.runPromise(
      lifecycle.listSessions({ setupMarker }),
    );
    const session = sessions[0];
    if (!session) throw new Error("missing session fixture");

    const failure = await runFailure(
      lifecycle.disconnectSession({ session: session.session }),
    );

    expect(calls).toBe(5);
    expect(failure).toMatchObject({
      code: "timed_out",
      operation: "lifecycle-write",
      retryDecision: "reconcile_before_repeat",
    });
  });

  test("rejects oversized provider JSON before parsing or retrying", async () => {
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => {
          calls += 1;
          return new Response("x".repeat(1_048_577), { status: 200 });
        },
      },
    );

    const failure = await runFailure(lifecycle.listSessions({ setupMarker }));

    expect(calls).toBe(1);
    expect(failure.code).toBe("response_too_large");
    expect(failure.retryDecision).toBe("do_not_retry");
  });

  test("reconciles between delete attempts until absence is observed", async () => {
    const listPresent = () =>
      json({
        success: true,
        data: [providerSession({ api_key: undefined })],
      });
    const responses = [
      listPresent(),
      json({ success: true, data: providerSession() }),
      listPresent(),
      new Response(null, { status: 204 }),
      listPresent(),
      listPresent(),
      new Response(null, { status: 204 }),
      json({ success: true, data: [] }),
    ];
    const methods: string[] = [];
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async (request) => {
          methods.push(request.method);
          return responses[calls++] ?? json({}, { status: 500 });
        },
      },
    );
    const reconciliation = await Effect.runPromise(
      lifecycle.listSessions({ setupMarker }),
    );
    const session = reconciliation[0];
    if (!session) throw new Error("missing session fixture");

    const first = await Effect.runPromise(
      lifecycle.deleteSession({ session: session.session }),
    );
    const second = await Effect.runPromise(
      lifecycle.deleteSession({ session: session.session }),
    );

    expect(first).toEqual({ state: "present" });
    expect(second).toEqual({ state: "absent" });
    expect(methods).toEqual([
      "GET",
      "GET",
      "GET",
      "DELETE",
      "GET",
      "GET",
      "DELETE",
      "GET",
    ]);
  });

  test("keeps a failed post-delete reconciliation in the write ambiguity class", async () => {
    const listPresent = () =>
      json({
        success: true,
        data: [providerSession({ api_key: undefined })],
      });
    const responses = [
      listPresent(),
      json({ success: true, data: providerSession() }),
      listPresent(),
      new Response(null, { status: 204 }),
      json({ success: true, data: { malformed: true } }),
    ];
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => responses[calls++] ?? json({}, { status: 500 }),
      },
    );
    const sessions = await Effect.runPromise(
      lifecycle.listSessions({ setupMarker }),
    );
    const session = sessions[0];
    if (!session) throw new Error("missing session fixture");

    const failure = await runFailure(
      lifecycle.deleteSession({ session: session.session }),
    );

    expect(failure).toEqual({
      _tag: "ProviderNeutralFailure",
      code: "invalid_response",
      operation: "lifecycle-write",
      retryAfterMs: null,
      retryDecision: "reconcile_before_repeat",
    });
    expect(calls).toBe(5);
  });

  test("reconciles an ambiguous successful delete before repeating the side effect", async () => {
    const listPresent = () =>
      json({
        success: true,
        data: [providerSession({ api_key: undefined })],
      });
    const responses: Array<Response | Error> = [
      listPresent(),
      json({ success: true, data: providerSession() }),
      listPresent(),
      new Error("connection closed after Wasender accepted deletion"),
      json({ success: true, data: [] }),
    ];
    const methods: string[] = [];
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async (request) => {
          methods.push(request.method);
          const response = responses[calls++] ?? json({}, { status: 500 });
          if (response instanceof Error) throw response;
          return response;
        },
      },
    );
    const sessions = await Effect.runPromise(
      lifecycle.listSessions({ setupMarker }),
    );
    const session = sessions[0];
    if (!session) throw new Error("missing session fixture");

    const ambiguous = await runFailure(
      lifecycle.deleteSession({ session: session.session }),
    );
    const reconciled = await Effect.runPromise(
      lifecycle.deleteSession({ session: session.session }),
    );

    expect(ambiguous).toMatchObject({
      operation: "lifecycle-write",
      retryDecision: "reconcile_before_repeat",
    });
    expect(reconciled).toEqual({ state: "absent" });
    expect(methods).toEqual(["GET", "GET", "GET", "DELETE", "GET"]);
    expect(methods.filter((method) => method === "DELETE")).toHaveLength(1);
  });

  test("returns ephemeral SVG QR bytes without retaining the provider payload", async () => {
    const responses = [
      json({
        success: true,
        data: [providerSession({ api_key: undefined })],
      }),
      json({ success: true, data: providerSession() }),
      json({
        success: true,
        data: [providerSession({ api_key: undefined })],
      }),
      json({ success: true, data: { qrCode: "provider-qr-payload" } }),
    ];
    let calls = 0;
    const lifecycle = makeWasenderSessionLifecycle(
      { credential, referenceSecret },
      {
        fetch: async () => responses[calls++] ?? json({}, { status: 500 }),
      },
    );
    const sessions = await Effect.runPromise(
      lifecycle.listSessions({ setupMarker }),
    );
    const session = sessions[0];
    if (!session) throw new Error("missing session fixture");

    const observation = await Effect.runPromise(
      lifecycle.getQrCode({ session: session.session }),
    );

    expect(observation.state).toBe("available");
    if (observation.state === "available") {
      const image = new TextDecoder().decode(observation.image);
      expect(image.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(
        true,
      );
      expect(image).not.toContain("provider-qr-payload");
      expect(observation.expiresAt).toBeNull();
    }
  });
});
