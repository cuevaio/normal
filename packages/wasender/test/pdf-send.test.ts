import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import type { SessionAuthority } from "../src/control";
import { makeWasenderPdfSendingWithRuntime } from "../src/pdf-send";
import {
  deriveRecipientRouteKeys,
  sealRecipientRoute,
} from "../src/recipient-route";
import {
  type ContactLocator,
  makeVerifiedPdfBytes,
  type PdfSendTelemetryEvent,
  type WasenderIdentityProtectionKey,
  type WasenderRecipientRoute,
} from "../src/session";

const authority = Redacted.make(
  "session-api-key-do-not-log",
) as SessionAuthority;
const identityKey = Redacted.make(
  new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1)),
) as WasenderIdentityProtectionKey;
const recipient = "opaque-recipient" as ContactLocator;
const routeKeys = await deriveRecipientRouteKeys(Redacted.value(authority));
const route = Redacted.make(
  await sealRecipientRoute(routeKeys, "contact", "15551234567"),
) as WasenderRecipientRoute;
const sourceBytes = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
const pdf = makeVerifiedPdfBytes(sourceBytes);

interface Attempt {
  readonly body: RequestInit["body"];
  readonly headers: Headers;
  readonly method: string;
  readonly redirect: RequestInit["redirect"];
  readonly signal: AbortSignal | null;
  readonly url: string;
}

const makeHarness = (
  fetch: (attempt: Attempt) => Response | Promise<Response>,
) => {
  const attempts: Array<Attempt> = [];
  const telemetry: Array<PdfSendTelemetryEvent> = [];
  const timeouts: Array<number> = [];
  let now = 1_000;
  const sending = makeWasenderPdfSendingWithRuntime(
    {
      authority,
      identityKey,
      resolveRecipient: (value) => (value === recipient ? route : null),
      telemetry: { emit: (event) => telemetry.push(event) },
    },
    {
      clearTimeout: () => undefined,
      fetch: async (input, init) => {
        const attempt = {
          body: init?.body,
          headers: new Headers(init?.headers),
          method: init?.method ?? "GET",
          redirect: init?.redirect,
          signal: init?.signal ?? null,
          url: String(input),
        } satisfies Attempt;
        attempts.push(attempt);
        return fetch(attempt);
      },
      now: () => {
        now += 5;
        return now;
      },
      setTimeout: (_callback, milliseconds) => {
        timeouts.push(milliseconds);
        return 1;
      },
    },
  );
  return { attempts, sending, telemetry, timeouts };
};

const send = (sending: ReturnType<typeof makeHarness>["sending"]) =>
  Effect.runPromise(
    sending.sendPdf({ bytes: pdf, fileName: "report.pdf", recipient }),
  );

describe("real Wasender PDF-send adapter", () => {
  test("uploads raw PDF bytes, keeps the URL internal, and sends once", async () => {
    const temporaryUrl =
      "https://api.wapi.crafter.run/media/private-temporary-document.pdf";
    const harness = makeHarness((attempt) =>
      attempt.url.endsWith("/api/upload")
        ? Response.json({ publicUrl: temporaryUrl, success: true })
        : Response.json({
            data: {
              jid: "15551234567@s.whatsapp.net",
              msgId: 100_000,
              status: "in_progress",
            },
            success: true,
          }),
    );

    await expect(send(harness.sending)).resolves.toEqual({
      outcome: "provider_acknowledgement",
      status: "accepted",
    });
    expect(harness.timeouts).toEqual([10_000, 15_000]);
    expect(harness.attempts).toHaveLength(2);
    expect(harness.attempts[0]).toMatchObject({
      body: pdf,
      method: "POST",
      redirect: "manual",
      url: "https://api.wapi.crafter.run/api/upload",
    });
    expect(harness.attempts[0]?.headers.get("content-type")).toBe(
      "application/pdf",
    );
    expect(harness.attempts[0]?.headers.get("authorization")).toBe(
      `Bearer ${Redacted.value(authority)}`,
    );
    expect(harness.attempts[1]).toMatchObject({
      body: JSON.stringify({
        to: "+15551234567",
        documentUrl: temporaryUrl,
        fileName: "report.pdf",
      }),
      method: "POST",
      redirect: "manual",
      url: "https://api.wapi.crafter.run/api/send-message",
    });
    expect(harness.attempts[1]?.headers.get("authorization")).toBe(
      "Bearer session-api-key-do-not-log",
    );
    expect(JSON.stringify(harness.telemetry)).not.toContain(temporaryUrl);
    expect(JSON.stringify(harness.telemetry)).not.toContain("report.pdf");
    expect(JSON.stringify(harness.telemetry)).not.toContain("session-api-key");
    expect(harness.telemetry).toEqual([
      {
        durationMs: 5,
        operationClass: "pdf-send",
        outcome: "provider_acknowledgement",
        responseBytes: 98,
        sendAttemptCount: 1,
        uploadAttemptCount: 1,
        uploadBytes: pdf.byteLength,
      },
    ]);
  });

  test("rejects an upload URL outside the exact Wasender origin", async () => {
    const harness = makeHarness(() =>
      Response.json({
        publicUrl: "https://api.wapi.crafter.run.evil.test/document.pdf",
        success: true,
      }),
    );

    await expect(send(harness.sending)).resolves.toEqual({
      outcome: "definitive_failure",
      reason: "upload_failed",
      retryAfterMs: null,
    });
    expect(harness.attempts).toHaveLength(1);
  });

  test("treats a failed upload as definitive and never starts a send", async () => {
    const harness = makeHarness(() =>
      Promise.reject(new TypeError("upload connection closed")),
    );

    await expect(send(harness.sending)).resolves.toEqual({
      outcome: "definitive_failure",
      reason: "upload_failed",
      retryAfterMs: null,
    });
    expect(harness.attempts).toHaveLength(1);
    expect(harness.telemetry[0]).toMatchObject({
      sendAttemptCount: 0,
      uploadAttemptCount: 1,
    });
  });

  test("never retries an ambiguous document send", async () => {
    const harness = makeHarness((attempt) =>
      attempt.url.endsWith("/api/upload")
        ? Response.json({
            publicUrl: "https://api.wapi.crafter.run/media/document.pdf",
            success: true,
          })
        : Promise.reject(new TypeError("send connection closed")),
    );

    await expect(send(harness.sending)).resolves.toEqual({
      outcome: "ambiguous",
      reason: "connection_lost",
    });
    expect(harness.attempts).toHaveLength(2);
  });

  test("verifies and snapshots PDF bytes before they can be uploaded", () => {
    sourceBytes.fill(0);
    expect(new TextDecoder().decode(pdf)).toBe("%PDF-1.7\n%%EOF\n");
    expect(() => makeVerifiedPdfBytes(new Uint8Array([1, 2, 3]))).toThrow(
      RangeError,
    );
    expect(() =>
      makeVerifiedPdfBytes(new TextEncoder().encode("not-pdf!")),
    ).toThrow(TypeError);
  });
});
