import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import type { SessionAuthority } from "../src/control";
import { makeWasenderImageSendingWithRuntime } from "../src/image-send";
import {
  deriveRecipientRouteKeys,
  sealRecipientRoute,
} from "../src/recipient-route";
import {
  type ContactLocator,
  type ImageSendTelemetryEvent,
  makeVerifiedImageBytes,
  maximumOutboundImageBytes,
  type VerifiedImageBytes,
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
  scheduleTimeout?: (
    callback: () => void,
    milliseconds: number,
    attempt: number,
  ) => unknown,
) => {
  const attempts: Array<Attempt> = [];
  const telemetry: Array<ImageSendTelemetryEvent> = [];
  const timeouts: Array<number> = [];
  let now = 1_000;
  const sending = makeWasenderImageSendingWithRuntime(
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
      setTimeout: (callback, milliseconds) => {
        timeouts.push(milliseconds);
        return scheduleTimeout?.(callback, milliseconds, timeouts.length) ?? 1;
      },
    },
  );
  return { attempts, sending, telemetry, timeouts };
};

const acknowledgement = () =>
  Response.json({
    data: {
      jid: "15551234567@s.whatsapp.net",
      msgId: 100_000,
      status: "in_progress",
    },
    success: true,
  });

const send = (
  sending: ReturnType<typeof makeHarness>["sending"],
  bytes: VerifiedImageBytes,
  caption?: string,
) =>
  Effect.runPromise(
    sending.sendImage({
      bytes,
      ...(caption === undefined ? {} : { caption }),
      recipient,
    }),
  );

describe("real Wasender image-send adapter", () => {
  test("detects trusted MIME types, snapshots bytes, and enforces the exact byte limit", () => {
    const jpegSource = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const jpeg = makeVerifiedImageBytes(jpegSource);
    const png = makeVerifiedImageBytes(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const maximumJpeg = new Uint8Array(maximumOutboundImageBytes);
    maximumJpeg.set([0xff, 0xd8, 0xff]);

    jpegSource.fill(0);
    expect(Array.from(jpeg)).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    expect(jpeg.mimeType).toBe("image/jpeg");
    expect(png.mimeType).toBe("image/png");
    expect(makeVerifiedImageBytes(maximumJpeg).byteLength).toBe(5_000_000);
    expect(() =>
      makeVerifiedImageBytes(new Uint8Array(maximumOutboundImageBytes + 1)),
    ).toThrow(RangeError);
    expect(() => makeVerifiedImageBytes(new Uint8Array([1, 2, 3]))).toThrow(
      TypeError,
    );
  });

  test("uploads exact JPEG bytes once and sends one image with a caption", async () => {
    const image = makeVerifiedImageBytes(
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    );
    const temporaryUrl = "https://api.wapi.crafter.run/media/private-image.jpg";
    const harness = makeHarness((attempt) =>
      attempt.url.endsWith("/api/upload")
        ? Response.json({ publicUrl: temporaryUrl, success: true })
        : acknowledgement(),
    );

    await expect(
      send(harness.sending, image, "exact caption"),
    ).resolves.toEqual({
      outcome: "provider_acknowledgement",
      status: "accepted",
    });
    expect(harness.timeouts).toEqual([10_000, 15_000]);
    expect(harness.attempts).toHaveLength(2);
    expect(harness.attempts[0]).toMatchObject({
      body: image,
      method: "POST",
      redirect: "manual",
      url: "https://api.wapi.crafter.run/api/upload",
    });
    expect(harness.attempts[0]?.headers.get("content-type")).toBe("image/jpeg");
    expect(harness.attempts[1]).toMatchObject({
      body: JSON.stringify({
        to: "+15551234567",
        imageUrl: temporaryUrl,
        text: "exact caption",
      }),
      method: "POST",
      redirect: "manual",
      url: "https://api.wapi.crafter.run/api/send-message",
    });
    expect(JSON.stringify(harness.telemetry)).not.toContain(temporaryUrl);
    expect(JSON.stringify(harness.telemetry)).not.toContain("exact caption");
    expect(JSON.stringify(harness.telemetry)).not.toContain("session-api-key");
    expect(harness.telemetry).toEqual([
      {
        durationMs: 5,
        operationClass: "image-send",
        outcome: "provider_acknowledgement",
        responseBytes: 98,
        sendAttemptCount: 1,
        uploadAttemptCount: 1,
        uploadBytes: image.byteLength,
      },
    ]);
  });

  test("uses the detected PNG content type and omits text without a caption", async () => {
    const image = makeVerifiedImageBytes(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const temporaryUrl = "https://api.wapi.crafter.run/media/image.png";
    const harness = makeHarness((attempt) =>
      attempt.url.endsWith("/api/upload")
        ? Response.json({ publicUrl: temporaryUrl, success: true })
        : acknowledgement(),
    );

    await send(harness.sending, image);

    expect(harness.attempts[0]?.headers.get("content-type")).toBe("image/png");
    expect(harness.attempts[1]?.body).toBe(
      JSON.stringify({ to: "+15551234567", imageUrl: temporaryUrl }),
    );
  });

  test("rejects an upload URL outside the exact Wasender origin", async () => {
    const image = makeVerifiedImageBytes(new Uint8Array([0xff, 0xd8, 0xff]));
    const harness = makeHarness(() =>
      Response.json({
        publicUrl: "https://api.wapi.crafter.run.evil.test/image.jpg",
        success: true,
      }),
    );

    await expect(send(harness.sending, image)).resolves.toEqual({
      outcome: "definitive_failure",
      reason: "upload_failed",
      retryAfterMs: null,
    });
    expect(harness.attempts).toHaveLength(1);
  });

  test("treats upload transport failure as definitive without sending", async () => {
    const image = makeVerifiedImageBytes(new Uint8Array([0xff, 0xd8, 0xff]));
    const harness = makeHarness(() =>
      Promise.reject(new TypeError("upload connection closed")),
    );

    await expect(send(harness.sending, image)).resolves.toEqual({
      outcome: "definitive_failure",
      reason: "upload_failed",
      retryAfterMs: null,
    });
    expect(harness.attempts).toHaveLength(1);
    expect(harness.telemetry[0]).toMatchObject({
      operationClass: "image-send",
      sendAttemptCount: 0,
      uploadAttemptCount: 1,
    });
  });

  test("never retries an ambiguous image send", async () => {
    const image = makeVerifiedImageBytes(new Uint8Array([0xff, 0xd8, 0xff]));
    const harness = makeHarness((attempt) =>
      attempt.url.endsWith("/api/upload")
        ? Response.json({
            publicUrl: "https://api.wapi.crafter.run/media/image.jpg",
            success: true,
          })
        : Promise.reject(new TypeError("send connection closed")),
    );

    await expect(send(harness.sending, image)).resolves.toEqual({
      outcome: "ambiguous",
      reason: "connection_lost",
    });
    expect(harness.attempts).toHaveLength(2);
  });

  test("keeps the send timeout active while reading the response body", async () => {
    const image = makeVerifiedImageBytes(new Uint8Array([0xff, 0xd8, 0xff]));
    const harness = makeHarness(
      (attempt) => {
        if (attempt.url.endsWith("/api/upload")) {
          return Response.json({
            publicUrl: "https://api.wapi.crafter.run/media/image.jpg",
            success: true,
          });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"success":'));
              attempt.signal?.addEventListener("abort", () => {
                controller.error(new DOMException("aborted", "AbortError"));
              });
            },
          }),
        );
      },
      (callback, _milliseconds, attempt) => {
        if (attempt === 2) queueMicrotask(callback);
        return attempt;
      },
    );

    await expect(send(harness.sending, image)).resolves.toEqual({
      outcome: "ambiguous",
      reason: "timed_out",
    });
    expect(harness.timeouts).toEqual([10_000, 15_000]);
    expect(harness.attempts).toHaveLength(2);
  });
});
