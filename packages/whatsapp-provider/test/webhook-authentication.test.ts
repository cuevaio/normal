import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import { authenticateWasenderWebhook } from "../src/webhook";

const encoder = new TextEncoder();
const authority = Redacted.make(
  JSON.stringify({
    sessionCredential: "session-credential",
    webhookVerificationSecret: "connection-webhook-secret",
  }),
);

const payload = (value: unknown) => encoder.encode(JSON.stringify(value));

describe("Wasender webhook authentication", () => {
  test("verifies the connection secret and every supplied session identity", async () => {
    const result = await Effect.runPromise(
      authenticateWasenderWebhook({
        authority,
        payload: payload({
          data: { session_id: "session-credential" },
          event: "session.status",
          sessionId: "session-credential",
        }),
        signature: "connection-webhook-secret",
      }),
    );

    expect(result).toBe("authenticated");
  });

  test("accepts a valid connection secret when the payload supplies no session identity", async () => {
    const result = await Effect.runPromise(
      authenticateWasenderWebhook({
        authority,
        payload: payload({
          data: { messages: [] },
          event: "messages.upsert",
        }),
        signature: "connection-webhook-secret",
      }),
    );

    expect(result).toBe("authenticated");
  });

  test("rejects a wrong secret, mismatched session, malformed JSON, and invalid authority", async () => {
    const results = await Promise.all([
      Effect.runPromise(
        authenticateWasenderWebhook({
          authority,
          payload: payload({ event: "messages.upsert" }),
          signature: "wrong-secret",
        }),
      ),
      Effect.runPromise(
        authenticateWasenderWebhook({
          authority,
          payload: payload({
            event: "messages.update",
            sessionId: "another-session",
          }),
          signature: "connection-webhook-secret",
        }),
      ),
      Effect.runPromise(
        authenticateWasenderWebhook({
          authority,
          payload: encoder.encode("{"),
          signature: "connection-webhook-secret",
        }),
      ),
      Effect.runPromise(
        authenticateWasenderWebhook({
          authority: Redacted.make("not-json"),
          payload: payload({ event: "messages.upsert" }),
          signature: "connection-webhook-secret",
        }),
      ),
    ]);

    expect(results).toEqual([
      "authentication_failed",
      "session_mismatch",
      "invalid_payload",
      "invalid_authority",
    ]);
  });

  test("rejects conflicting or non-string session identity fields", async () => {
    const results = await Promise.all([
      Effect.runPromise(
        authenticateWasenderWebhook({
          authority,
          payload: payload({
            data: { sessionId: "another-session" },
            sessionId: "session-credential",
          }),
          signature: "connection-webhook-secret",
        }),
      ),
      Effect.runPromise(
        authenticateWasenderWebhook({
          authority,
          payload: payload({ sessionId: 123 }),
          signature: "connection-webhook-secret",
        }),
      ),
    ]);

    expect(results).toEqual(["session_mismatch", "invalid_payload"]);
  });
});
