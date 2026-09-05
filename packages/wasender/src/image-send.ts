import { Effect, Layer, Redacted } from "effect";
import {
  providerDestination,
  publicUrlFrom,
  requestWithTimeout,
  uploadFailure,
} from "./pdf-send";
import { providerOrigin } from "./provider-origin";
import {
  deriveIdentityRecipientRouteKeys,
  deriveRecipientRouteKeys,
  openIdentityRecipientRoute,
  openRecipientRoute,
} from "./recipient-route";
import type {
  ImageSending,
  ImageSendResult,
  WasenderImageSendingOptions,
} from "./session";
import { ImageSending as ImageSendingTag } from "./session";
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

/** Internal transport seam used only by focused adapter tests. */
export const makeWasenderImageSendingWithRuntime = (
  options: WasenderImageSendingOptions,
  runtime: OutboundSendRuntime,
): ImageSending => {
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
    sendImage: ({ bytes, caption, recipient }) =>
      Effect.promise(async () => {
        const startedAt = runtime.now();
        let uploadAttemptCount: 0 | 1 = 0;
        let sendAttemptCount: 0 | 1 = 0;
        let responseBytes: number | null = null;
        let result: ImageSendResult = uploadFailure();

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
                      "content-type": bytes.mimeType,
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
            const imageUrl = uploadResponse.ok
              ? publicUrlFrom(uploadBody.text)
              : null;

            if (imageUrl === null) {
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
                      imageUrl,
                      ...(caption === undefined ? {} : { text: caption }),
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
            operationClass: "image-send",
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

export const makeWasenderImageSending = (
  options: WasenderImageSendingOptions,
): ImageSending =>
  makeWasenderImageSendingWithRuntime(options, productionOutboundSendRuntime);

export const makeWasenderImageSendingLayer = (
  options: WasenderImageSendingOptions,
) => Layer.succeed(ImageSendingTag, makeWasenderImageSending(options));
