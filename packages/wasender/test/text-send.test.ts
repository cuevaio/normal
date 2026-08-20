import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import type { SessionAuthority } from "../src/control";
import {
  deriveIdentityRecipientRouteKeys,
  deriveRecipientRouteKeys,
  sealIdentityRecipientRoute,
  sealRecipientRoute,
} from "../src/recipient-route";
import type {
  ContactLocator,
  TextSendTelemetryEvent,
  WasenderIdentityProtectionKey,
  WasenderRecipientRoute,
} from "../src/session";
import { makeWasenderTextSendingWithRuntime } from "../src/text-send";
import {
  importWebhookIdentityKey,
  makeWasenderWebhookNormalization,
} from "../src/webhook";

const authority = Redacted.make(
  "session-api-key-do-not-log",
) as SessionAuthority;
const recipient = "opaque-directory-recipient" as ContactLocator;
const routeKeys = await deriveRecipientRouteKeys(Redacted.value(authority));
const recipientRoute = Redacted.make(
  await sealRecipientRoute(routeKeys, "contact", "15551234567"),
) as WasenderRecipientRoute;
const identityKey = Redacted.make(
  new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1)),
) as WasenderIdentityProtectionKey;
const webhookIdentityKey = await Effect.runPromise(
  importWebhookIdentityKey(new Uint8Array(Redacted.value(identityKey))),
);
const identityRouteKeys =
  await deriveIdentityRecipientRouteKeys(webhookIdentityKey);
const identityRecipientRoute = Redacted.make(
  await sealIdentityRecipientRoute(
    identityRouteKeys,
    "contact",
    "15551234567@s.whatsapp.net",
  ),
) as WasenderRecipientRoute;
const usernameRecipientRoute = Redacted.make(
  await sealRecipientRoute(routeKeys, "contact", "@jane_doe"),
) as WasenderRecipientRoute;
const exactText = "  cafe\u0301\nsecond line  ";

interface RecordedAttempt {
  readonly body: string;
  readonly headers: Headers;
  readonly method: string;
  readonly redirect: "error" | "follow" | "manual" | undefined;
  readonly signal: AbortSignal | null;
  readonly url: string;
}

const makeHarness = (options: {
  readonly fetch: (attempt: RecordedAttempt) => Promise<Response> | Response;
  readonly recipientRoute?: WasenderRecipientRoute;
  readonly timeoutImmediately?: boolean;
}) => {
  const attempts: Array<RecordedAttempt> = [];
  const telemetry: Array<TextSendTelemetryEvent> = [];
  let now = 1_000;

  const sending = makeWasenderTextSendingWithRuntime(
    {
      authority,
      identityKey,
      resolveRecipient: (requestedRecipient) =>
        requestedRecipient === recipient
          ? (options.recipientRoute ?? recipientRoute)
          : null,
      telemetry: {
        emit: (event) => {
          telemetry.push(event);
        },
      },
    },
    {
      clearTimeout: () => undefined,
      fetch: async (input, init) => {
        const attempt: RecordedAttempt = {
          body: typeof init?.body === "string" ? init.body : "",
          headers: new Headers(init?.headers),
          method: init?.method ?? "GET",
          redirect: init?.redirect,
          signal: init?.signal ?? null,
          url: String(input),
        };
        attempts.push(attempt);
        return options.fetch(attempt);
      },
      now: () => {
        now += 7;
        return now;
      },
      setTimeout: (callback, milliseconds) => {
        expect(milliseconds).toBe(15_000);
        if (options.timeoutImmediately) {
          queueMicrotask(callback);
        }
        return 1;
      },
    },
  );

  return { attempts, sending, telemetry };
};

const send = (sending: ReturnType<typeof makeHarness>["sending"]) =>
  Effect.runPromise(sending.sendText({ recipient, text: exactText }));

describe("real Wasender text-send adapter", () => {
  test("sends a recipient route created from the webhook identity key", async () => {
    const harness = makeHarness({
      fetch: () =>
        Response.json({
          data: {
            jid: "15551234567@s.whatsapp.net",
            msgId: 100_000,
            status: "in_progress",
          },
          success: true,
        }),
      recipientRoute: identityRecipientRoute,
    });

    await expect(send(harness.sending)).resolves.toEqual({
      outcome: "provider_acknowledgement",
      status: "accepted",
    });
    expect(harness.attempts).toHaveLength(1);
    expect(harness.attempts[0]?.body).toBe(
      JSON.stringify({ to: "+15551234567", text: exactText }),
    );
  });

  test("sends the resolved provider identity and exact text once", async () => {
    const harness = makeHarness({
      fetch: () =>
        new Response(
          JSON.stringify({
            data: {
              jid: "15551234567@s.whatsapp.net",
              msgId: 100_000,
              status: "in_progress",
            },
            success: true,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        ),
    });

    await expect(send(harness.sending)).resolves.toEqual({
      outcome: "provider_acknowledgement",
      status: "accepted",
    });
    expect(harness.attempts).toHaveLength(1);
    expect(harness.attempts[0]).toMatchObject({
      body: JSON.stringify({
        to: "+15551234567",
        text: exactText,
      }),
      method: "POST",
      redirect: "manual",
      url: "https://www.wasenderapi.com/api/send-message",
    });
    expect(harness.attempts[0]?.headers.get("authorization")).toBe(
      "Bearer session-api-key-do-not-log",
    );
    expect(harness.attempts[0]?.headers.get("content-type")).toBe(
      "application/json",
    );
    expect(harness.attempts[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("sends a documented username and accepts a resolved direct JID acknowledgement", async () => {
    const harness = makeHarness({
      fetch: () =>
        Response.json({
          data: {
            jid: "15551234567@s.whatsapp.net",
            msgId: 100_001,
            status: "in_progress",
          },
          success: true,
        }),
      recipientRoute: usernameRecipientRoute,
    });

    await expect(send(harness.sending)).resolves.toEqual({
      outcome: "provider_acknowledgement",
      status: "accepted",
    });
    expect(harness.attempts[0]?.body).toBe(
      JSON.stringify({ to: "@jane_doe", text: exactText }),
    );
  });

  test("does not treat a username alias response as stable recipient identity", async () => {
    const harness = makeHarness({
      fetch: () =>
        Response.json({
          data: {
            key: {
              fromMe: true,
              id: "message-id-via-username",
              remoteJid: "15551234567@s.whatsapp.net",
            },
            status: 2,
          },
          success: true,
        }),
      recipientRoute: usernameRecipientRoute,
    });

    await expect(send(harness.sending)).resolves.toEqual({
      outcome: "provider_acknowledgement",
      status: "accepted",
    });
  });

  test("rejects acknowledgement for a different username", async () => {
    const harness = makeHarness({
      fetch: () =>
        Response.json({
          data: {
            jid: "@different_user",
            msgId: 100_002,
            status: "in_progress",
          },
          success: true,
        }),
      recipientRoute: usernameRecipientRoute,
    });

    await expect(send(harness.sending)).resolves.toEqual({
      outcome: "ambiguous",
      reason: "invalid_response",
    });
  });

  test("returns protected identity evidence only for the resolved recipient", async () => {
    const harness = makeHarness({
      fetch: () =>
        Response.json({
          data: {
            key: {
              fromMe: true,
              id: "message-id-456",
              remoteJid: "15551234567@s.whatsapp.net",
            },
            status: 2,
          },
          success: true,
        }),
    });

    const result = await send(harness.sending);

    expect(result).toMatchObject({
      outcome: "identity_evidence",
      status: "sent",
    });
    expect(result).toHaveProperty("messageIdentity");
    expect(JSON.stringify(result)).not.toContain("message-id-456");
    expect(JSON.stringify(result)).not.toContain("15551234567@s.whatsapp.net");
    expect(harness.attempts).toHaveLength(1);

    const webhookKey = await Effect.runPromise(
      importWebhookIdentityKey(new Uint8Array(Redacted.value(identityKey))),
    );
    const normalized = await Effect.runPromise(
      makeWasenderWebhookNormalization(webhookKey).normalize({
        payload: new TextEncoder().encode(
          JSON.stringify({
            event: "messages.update",
            data: {
              key: {
                fromMe: true,
                id: "message-id-456",
                remoteJid: "15551234567@s.whatsapp.net",
              },
              update: { status: 2 },
            },
          }),
        ),
        receivedAt: "2026-08-03T12:00:00.000Z",
      }),
    );
    expect(normalized.items[0]).toMatchObject({
      kind: "send_evidence",
      messageIdentity:
        result.outcome === "identity_evidence"
          ? result.messageIdentity
          : "unreachable",
    });
  });

  test("treats mismatched identity evidence as an ambiguous response", async () => {
    const harness = makeHarness({
      fetch: () =>
        Response.json({
          data: {
            key: {
              fromMe: true,
              id: "message-id-456",
              remoteJid: "a-different-recipient@s.whatsapp.net",
            },
            status: 2,
          },
          success: true,
        }),
    });

    await expect(send(harness.sending)).resolves.toEqual({
      outcome: "ambiguous",
      reason: "invalid_response",
    });
    expect(harness.attempts).toHaveLength(1);
  });

  test("makes one attempt when the provider times out", async () => {
    const harness = makeHarness({
      fetch: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      timeoutImmediately: true,
    });

    await expect(send(harness.sending)).resolves.toEqual({
      outcome: "ambiguous",
      reason: "timed_out",
    });
    expect(harness.attempts).toHaveLength(1);
  });

  test("makes one attempt when the connection is lost", async () => {
    const harness = makeHarness({
      fetch: () => Promise.reject(new TypeError("connection closed")),
    });

    await expect(send(harness.sending)).resolves.toEqual({
      outcome: "ambiguous",
      reason: "connection_lost",
    });
    expect(harness.attempts).toHaveLength(1);
  });

  test("makes one attempt and reports bounded throttling", async () => {
    const harness = makeHarness({
      fetch: () =>
        Response.json(
          {
            message: "rate limited",
            retry_after: 60,
          },
          { status: 429 },
        ),
    });

    const result = await send(harness.sending);

    expect(result).toMatchObject({
      outcome: "definitive_failure",
      reason: "throttled",
    });
    expect(result).toHaveProperty("retryAfterMs");
    if (result.outcome !== "definitive_failure") {
      throw new Error("expected definitive throttling");
    }
    expect(Number(result.retryAfterMs)).toBe(5_000);
    expect(harness.attempts).toHaveLength(1);
  });

  test("makes one attempt for a malformed success response", async () => {
    const harness = makeHarness({
      fetch: () =>
        new Response("this is not json", {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    });

    await expect(send(harness.sending)).resolves.toEqual({
      outcome: "ambiguous",
      reason: "invalid_response",
    });
    expect(harness.attempts).toHaveLength(1);
  });

  test("rejects an undocumented message-only success response", async () => {
    const harness = makeHarness({
      fetch: () =>
        Response.json({
          message: "Message sent successfully",
          success: true,
        }),
    });

    await expect(send(harness.sending)).resolves.toEqual({
      outcome: "ambiguous",
      reason: "invalid_response",
    });
    expect(harness.attempts).toHaveLength(1);
  });

  test("rejects a structurally incomplete success response", async () => {
    const harness = makeHarness({
      fetch: () =>
        Response.json({
          data: { key: "not-an-identity-object" },
          success: true,
        }),
    });

    await expect(send(harness.sending)).resolves.toEqual({
      outcome: "ambiguous",
      reason: "invalid_response",
    });
    expect(harness.attempts).toHaveLength(1);
  });

  test("makes one attempt for a server error", async () => {
    const harness = makeHarness({
      fetch: () => Response.json({ message: "unavailable" }, { status: 503 }),
    });

    await expect(send(harness.sending)).resolves.toEqual({
      outcome: "ambiguous",
      reason: "unavailable",
    });
    expect(harness.attempts).toHaveLength(1);
  });

  test("maps complete pre-send rejections without exposing provider errors", async () => {
    const authentication = makeHarness({
      fetch: () =>
        Response.json(
          { message: "provider credential details" },
          { status: 401 },
        ),
    });
    const recipientRejection = makeHarness({
      fetch: () =>
        Response.json(
          { errors: { to: ["provider recipient details"] } },
          { status: 422 },
        ),
    });

    await expect(send(authentication.sending)).resolves.toEqual({
      outcome: "definitive_failure",
      reason: "authentication_failed",
      retryAfterMs: null,
    });
    await expect(send(recipientRejection.sending)).resolves.toEqual({
      outcome: "definitive_failure",
      reason: "recipient_rejected",
      retryAfterMs: null,
    });
    expect(authentication.attempts).toHaveLength(1);
    expect(recipientRejection.attempts).toHaveLength(1);
  });

  test("bounds response bytes and emits content-free telemetry", async () => {
    const oversized = makeHarness({
      fetch: () => new Response(`{"padding":"${"x".repeat(1_048_576)}"}`),
    });

    await expect(send(oversized.sending)).resolves.toEqual({
      outcome: "ambiguous",
      reason: "invalid_response",
    });
    expect(oversized.attempts).toHaveLength(1);
    expect(oversized.telemetry).toEqual([
      {
        attemptCount: 1,
        durationMs: 7,
        operationClass: "text-send",
        outcome: "ambiguous",
        responseBytes: 1_048_576,
      },
    ]);
    const serializedTelemetry = JSON.stringify(oversized.telemetry);
    expect(serializedTelemetry).not.toContain(exactText);
    expect(serializedTelemetry).not.toContain("15551234567");
    expect(serializedTelemetry).not.toContain("session-api-key");
  });

  test("does not invoke Wasender when the domain recipient cannot be resolved", async () => {
    const harness = makeHarness({
      fetch: () => Response.json({ success: true }),
    });

    const result = await Effect.runPromise(
      harness.sending.sendText({
        recipient: "unknown-recipient" as ContactLocator,
        text: exactText,
      }),
    );

    expect(result).toEqual({
      outcome: "definitive_failure",
      reason: "recipient_rejected",
      retryAfterMs: null,
    });
    expect(harness.attempts).toHaveLength(0);
  });

  test("does not invoke Wasender with a tampered recipient route", async () => {
    const route = Redacted.value(recipientRoute);
    const tampered = Redacted.make(
      `${route.slice(0, -1)}${route.endsWith("A") ? "B" : "A"}`,
    ) as WasenderRecipientRoute;
    const harness = makeHarness({
      fetch: () => Response.json({ success: true }),
      recipientRoute: tampered,
    });

    await expect(send(harness.sending)).resolves.toEqual({
      outcome: "definitive_failure",
      reason: "recipient_rejected",
      retryAfterMs: null,
    });
    expect(harness.attempts).toHaveLength(0);
    expect(harness.telemetry).toEqual([
      {
        attemptCount: 0,
        durationMs: 7,
        operationClass: "text-send",
        outcome: "definitive_failure",
        responseBytes: null,
      },
    ]);
  });

  test("fails closed on invalid per-connection authority", () => {
    const runtime = {
      clearTimeout: () => undefined,
      fetch: () => Promise.resolve(Response.json({ success: true })),
      now: () => 0,
      setTimeout: () => 1,
    };
    const baseOptions = {
      identityKey,
      resolveRecipient: () => recipientRoute,
      telemetry: { emit: () => undefined },
    };

    expect(() =>
      makeWasenderTextSendingWithRuntime(
        {
          ...baseOptions,
          authority: Redacted.make("") as SessionAuthority,
        },
        runtime,
      ),
    ).toThrow("Wasender session authority is invalid");
    expect(() =>
      makeWasenderTextSendingWithRuntime(
        {
          ...baseOptions,
          authority,
          identityKey: Redacted.make(
            new Uint8Array(31),
          ) as WasenderIdentityProtectionKey,
        },
        runtime,
      ),
    ).toThrow("Wasender identity protection key must contain 32 bytes");
  });
});
