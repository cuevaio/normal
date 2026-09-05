import { Effect, Layer, Redacted } from "effect";
import { makeBoundedRetryAfterMs, maximumRetryAfterMs } from "./common";
import { providerOrigin } from "./provider-origin";
import {
  deriveIdentityRecipientRouteKeys,
  deriveRecipientRouteKeys,
  openIdentityRecipientRoute,
  openRecipientRoute,
} from "./recipient-route";
import type {
  PdfSending,
  PdfSendResult,
  WasenderPdfSendingOptions,
} from "./session";
import { PdfSending as PdfSendingTag } from "./session";
import {
  type BoundedBody,
  classifySendResponse,
  isProtectedString,
  type OutboundSendRuntime,
  productionOutboundSendRuntime,
  readBoundedBody,
} from "./text-send";

const uploadUrl = `${providerOrigin}/api/upload`;
const sendMessageUrl = `${providerOrigin}/api/send-message`;
/**
 * Origins an `/api/upload` response may name in `publicUrl`.
 *
 * An upload returns a URL on whichever origin served it, so this allow-list has to track the
 * call target above -- a list pinned to a different host rejects every upload and the send then
 * fails as `upload_failed` with nothing naming the cause. It stays an allow-list: the provider
 * origin and nothing else, so a response cannot point the document fetch wherever it likes.
 */
const publicMediaOrigins = new Set([providerOrigin]);

const contactIdentifier =
  /^(?:\+[1-9]\d{1,14}|[1-9]\d{6,14}|[1-9]\d{6,14}(?::\d{1,5})?@s\.whatsapp\.net|[1-9]\d{1,31}(?::\d{1,5})?@lid|@[A-Za-z0-9._-]{1,64})$/u;
const groupIdentifier = /^[1-9]\d{1,31}(?:-[1-9]\d{1,31})?@g\.us$/u;

export const providerDestination = (
  kind: "contact" | "group",
  identifier: string,
): string | null => {
  if (kind === "group")
    return groupIdentifier.test(identifier) ? identifier : null;
  if (!contactIdentifier.test(identifier)) return null;
  const phone =
    /^\+([1-9]\d{1,14})$/u.exec(identifier)?.[1] ??
    /^([1-9]\d{6,14})$/u.exec(identifier)?.[1] ??
    /^([1-9]\d{6,14})(?::\d{1,5})?@s\.whatsapp\.net$/u.exec(identifier)?.[1];
  return phone === undefined ? identifier : `+${phone}`;
};

const validFileName = (value: string): boolean =>
  value.length >= 5 &&
  value.length <= 255 &&
  value.toLowerCase().endsWith(".pdf") &&
  !/[\\/]/u.test(value) &&
  !Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });

const retryAfter = (
  response: Response,
): ReturnType<typeof makeBoundedRetryAfterMs> | null => {
  const value = response.headers.get("retry-after");
  if (value === null || !/^\d+$/u.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds)
    ? makeBoundedRetryAfterMs(Math.min(seconds * 1_000, maximumRetryAfterMs))
    : null;
};

export const uploadFailure = (response?: Response): PdfSendResult => {
  if (response?.status === 401 || response?.status === 403) {
    return {
      outcome: "definitive_failure",
      reason: "authentication_failed",
      retryAfterMs: null,
    };
  }
  if (response?.status === 429) {
    return {
      outcome: "definitive_failure",
      reason: "throttled",
      retryAfterMs: retryAfter(response),
    };
  }
  return {
    outcome: "definitive_failure",
    reason: "upload_failed",
    retryAfterMs: null,
  };
};

export const publicUrlFrom = (text: string | null): string | null => {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).success !== true ||
      typeof (value as Record<string, unknown>).publicUrl !== "string"
    ) {
      return null;
    }
    const raw = (value as Record<string, unknown>).publicUrl as string;
    if (raw.length === 0 || raw.length > 4_096) return null;
    const url = new URL(raw);
    return publicMediaOrigins.has(url.origin) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname.startsWith("/")
      ? url.href
      : null;
  } catch {
    return null;
  }
};

export const requestWithTimeout = async (
  runtime: OutboundSendRuntime,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ readonly body: BoundedBody; readonly response: Response }> => {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = runtime.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await runtime.fetch(input, {
      ...init,
      signal: controller.signal,
    });
    return { body: await readBoundedBody(response), response };
  } catch (error) {
    if (timedOut) throw new DOMException("aborted", "AbortError");
    throw error;
  } finally {
    runtime.clearTimeout(timeout);
  }
};

/** Internal transport seam used only by focused adapter tests. */
export const makeWasenderPdfSendingWithRuntime = (
  options: WasenderPdfSendingOptions,
  runtime: OutboundSendRuntime,
): PdfSending => {
  const authority = Redacted.value(options.authority);
  const identityKey = new Uint8Array(Redacted.value(options.identityKey));
  if (!isProtectedString(authority)) {
    throw new Error("Wasender session authority is invalid");
  }
  if (identityKey.byteLength !== 32) {
    throw new Error("Wasender identity protection key must contain 32 bytes");
  }
  const routeKeys = deriveRecipientRouteKeys(authority);
  const identityRouteKeys = crypto.subtle
    .importKey("raw", identityKey, { hash: "SHA-256", name: "HMAC" }, false, [
      "sign",
    ])
    .then(deriveIdentityRecipientRouteKeys);

  return {
    sendPdf: ({ bytes, fileName, recipient }) =>
      Effect.promise(async () => {
        const startedAt = runtime.now();
        let uploadAttemptCount: 0 | 1 = 0;
        let sendAttemptCount: 0 | 1 = 0;
        let responseBytes: number | null = null;
        let result: PdfSendResult = uploadFailure();

        try {
          const resolved = options.resolveRecipient(recipient);
          const route = resolved === null ? null : Redacted.value(resolved);
          const opened =
            route !== null && isProtectedString(route)
              ? ((await openIdentityRecipientRoute(
                  await identityRouteKeys,
                  route,
                )) ?? (await openRecipientRoute(await routeKeys, route)))
              : null;
          const destination =
            opened === null
              ? null
              : providerDestination(opened.kind, opened.identifier);

          if (destination === null) {
            result = {
              outcome: "definitive_failure",
              reason: "recipient_rejected",
              retryAfterMs: null,
            };
          } else if (!validFileName(fileName)) {
            result = uploadFailure();
          } else {
            uploadAttemptCount = 1;
            let uploadBody: BoundedBody;
            let uploadResponse: Response;
            try {
              ({ body: uploadBody, response: uploadResponse } =
                await requestWithTimeout(
                  runtime,
                  uploadUrl,
                  {
                    body: bytes,
                    headers: {
                      authorization: `Bearer ${authority}`,
                      "content-type": "application/pdf",
                    },
                    method: "POST",
                    redirect: "manual",
                  },
                  10_000,
                ));
            } catch {
              uploadResponse = new Response(null, { status: 503 });
              uploadBody = await readBoundedBody(uploadResponse);
            }
            responseBytes = uploadBody.bytes;
            const documentUrl = uploadResponse.ok
              ? publicUrlFrom(uploadBody.text)
              : null;

            if (documentUrl === null) {
              result = uploadFailure(uploadResponse);
            } else {
              sendAttemptCount = 1;
              try {
                const { body, response } = await requestWithTimeout(
                  runtime,
                  sendMessageUrl,
                  {
                    body: JSON.stringify({
                      to: destination,
                      documentUrl,
                      fileName,
                    }),
                    headers: {
                      authorization: `Bearer ${authority}`,
                      "content-type": "application/json",
                    },
                    method: "POST",
                    redirect: "manual",
                  },
                  15_000,
                );
                responseBytes = body.bytes;
                result = await classifySendResponse(
                  response,
                  body,
                  destination,
                  identityKey,
                );
              } catch (error) {
                result = {
                  outcome: "ambiguous",
                  reason:
                    error instanceof DOMException && error.name === "AbortError"
                      ? "timed_out"
                      : "connection_lost",
                };
              }
            }
          }
        } catch {
          result =
            sendAttemptCount === 1
              ? { outcome: "ambiguous", reason: "unavailable" }
              : uploadFailure();
        }

        try {
          options.telemetry.emit({
            durationMs: Math.max(0, runtime.now() - startedAt),
            operationClass: "pdf-send",
            outcome: result.outcome,
            responseBytes,
            sendAttemptCount,
            uploadAttemptCount,
            uploadBytes: bytes.byteLength,
          });
        } catch {
          // Telemetry cannot change an already-observed provider outcome.
        }
        return result;
      }),
  };
};

export const makeWasenderPdfSending = (
  options: WasenderPdfSendingOptions,
): PdfSending =>
  makeWasenderPdfSendingWithRuntime(options, productionOutboundSendRuntime);

export const makeWasenderPdfSendingLayer = (
  options: WasenderPdfSendingOptions,
) => Layer.succeed(PdfSendingTag, makeWasenderPdfSending(options));
