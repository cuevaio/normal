import { Effect, Layer, Redacted } from "effect";
import { encodeBase64Url } from "./base64-url";
import {
  makeBoundedRetryAfterMs,
  maximumJsonResponseBytes,
  maximumRetryAfterMs,
} from "./common";
import { providerOrigin } from "./provider-origin";
import {
  deriveIdentityRecipientRouteKeys,
  deriveRecipientRouteKeys,
  openIdentityRecipientRoute,
  openRecipientRoute,
  sealIdentityRecipientRoute,
} from "./recipient-route";
import {
  type IdentityBearingSendStatus,
  type StableMessageIdentity,
  TextSending,
  type TextSendResult,
  type WasenderIdentityProtectionKey,
  type WasenderRecipientRoute,
  type WasenderTextSendingOptions,
} from "./session";

const sendMessageUrl = `${providerOrigin}/api/send-message`;
const textEncoder = new TextEncoder();

const contactIdentifier =
  /^(?:\+[1-9]\d{1,14}|[1-9]\d{6,14}|[1-9]\d{6,14}(?::\d{1,5})?@s\.whatsapp\.net|[1-9]\d{1,31}(?::\d{1,5})?@lid|@[A-Za-z0-9._-]{1,64})$/u;
const groupIdentifier = /^[1-9]\d{1,31}(?:-[1-9]\d{1,31})?@g\.us$/u;
const usernameIdentifier = /^@[A-Za-z0-9._-]{1,64}$/u;

const providerDestination = (
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

const canonicalRecipient = (value: string): string | null => {
  const phone =
    /^\+([1-9]\d{1,14})$/u.exec(value)?.[1] ??
    /^([1-9]\d{6,14})$/u.exec(value)?.[1] ??
    /^([1-9]\d{6,14})(?::\d{1,5})?@s\.whatsapp\.net$/u.exec(value)?.[1];
  if (phone !== undefined) return `pn:${phone}`;
  if (/^[1-9]\d{1,31}(?::\d{1,5})?@lid$/u.test(value)) return `lid:${value}`;
  if (usernameIdentifier.test(value)) return `username:${value}`;
  return groupIdentifier.test(value) ? `group:${value}` : null;
};

const sameRecipient = (left: unknown, right: string): boolean =>
  typeof left === "string" &&
  canonicalRecipient(left) !== null &&
  canonicalRecipient(left) === canonicalRecipient(right);

const isUsernameRecipient = (value: string): boolean =>
  usernameIdentifier.test(value);

const isResolvedUsernameRecipient = (value: unknown): boolean =>
  typeof value === "string" &&
  /^(?:\+[1-9]\d{1,14}|[1-9]\d{6,14}|[1-9]\d{6,14}(?::\d{1,5})?@s\.whatsapp\.net|[1-9]\d{1,31}(?::\d{1,5})?@lid)$/u.test(
    value,
  );

export interface OutboundSendRuntime {
  readonly clearTimeout: (handle: unknown) => void;
  readonly fetch: (
    input: Request | string | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
}

export interface BoundedBody {
  readonly bytes: number;
  readonly text: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isProtectedString = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 4_096 &&
  !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });

export const readBoundedBody = async (
  response: Response,
): Promise<BoundedBody> => {
  if (response.body === null) {
    return { bytes: 0, text: "" };
  }

  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let bytes = 0;

  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    if (bytes + next.value.byteLength > maximumJsonResponseBytes) {
      try {
        await reader.cancel();
      } catch {
        // The response is already classified as oversized.
      }
      return { bytes: maximumJsonResponseBytes, text: null };
    }
    chunks.push(next.value);
    bytes += next.value.byteLength;
  }

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return {
      bytes,
      text: new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      }).decode(body),
    };
  } catch {
    return { bytes, text: null };
  }
};

const parseJsonRecord = (
  text: string | null,
): Record<string, unknown> | null => {
  if (text === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

const boundedRetryAfter = (
  response: Response,
  body: Record<string, unknown> | null,
) => {
  const bodySeconds = body?.retry_after;
  const headerSeconds = response.headers.get("retry-after");
  const seconds =
    typeof bodySeconds === "number" &&
    Number.isSafeInteger(bodySeconds) &&
    bodySeconds >= 0
      ? bodySeconds
      : headerSeconds !== null && /^\d+$/u.test(headerSeconds)
        ? Number(headerSeconds)
        : null;

  if (seconds === null || !Number.isSafeInteger(seconds)) {
    return null;
  }
  return makeBoundedRetryAfterMs(
    Math.min(seconds * 1_000, maximumRetryAfterMs),
  );
};

const mapIdentityStatus = (
  value: unknown,
): IdentityBearingSendStatus | null => {
  if (value === 1 || value === "accepted" || value === "in_progress") {
    return "accepted";
  }
  if (value === 2 || value === "sent") {
    return "sent";
  }
  if (value === 3 || value === "delivered") {
    return "delivered";
  }
  if (value === 4 || value === "read") {
    return "read";
  }
  return null;
};

const protectMessageIdentity = async (
  keyBytes: Uint8Array,
  providerIdentity: string,
): Promise<StableMessageIdentity> => {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(`message-identity\0${JSON.stringify(providerIdentity)}`),
  );
  return `wi1_${encodeBase64Url(new Uint8Array(signature))}` as StableMessageIdentity;
};

const definitiveFailure = (
  reason: "authentication_failed" | "provider_rejected" | "recipient_rejected",
): TextSendResult => ({
  outcome: "definitive_failure",
  reason,
  retryAfterMs: null,
});

export const classifySendResponse = async (
  response: Response,
  body: BoundedBody,
  providerRecipient: string,
  identityKey: Uint8Array,
): Promise<TextSendResult> => {
  const parsed = parseJsonRecord(body.text);

  if (response.status >= 300 && response.status < 400) {
    return definitiveFailure("provider_rejected");
  }
  if (response.status === 401 || response.status === 403) {
    return definitiveFailure("authentication_failed");
  }
  if (response.status === 408) {
    return { outcome: "ambiguous", reason: "timed_out" };
  }
  if (response.status === 429) {
    return {
      outcome: "definitive_failure",
      reason: "throttled",
      retryAfterMs: boundedRetryAfter(response, parsed),
    };
  }
  if (response.status === 422) {
    const errors =
      parsed !== null && isRecord(parsed.errors) ? parsed.errors : null;
    return definitiveFailure(
      errors !== null && Object.hasOwn(errors, "to")
        ? "recipient_rejected"
        : "provider_rejected",
    );
  }
  if (response.status >= 400 && response.status < 500) {
    return definitiveFailure("provider_rejected");
  }
  if (response.status >= 500) {
    return { outcome: "ambiguous", reason: "unavailable" };
  }
  if (!response.ok || parsed === null) {
    return { outcome: "ambiguous", reason: "invalid_response" };
  }
  if (parsed.success === false) {
    return definitiveFailure("provider_rejected");
  }
  if (parsed.success !== true) {
    return { outcome: "ambiguous", reason: "invalid_response" };
  }

  const data = isRecord(parsed.data) ? parsed.data : null;
  if (data !== null && Object.hasOwn(data, "key")) {
    const key = isRecord(data.key) ? data.key : null;
    const status = mapIdentityStatus(data?.status);
    if (
      key === null ||
      key.fromMe !== true ||
      typeof key.id !== "string" ||
      !isProtectedString(key.id) ||
      status === null
    ) {
      return { outcome: "ambiguous", reason: "invalid_response" };
    }
    if (!sameRecipient(key.remoteJid, providerRecipient)) {
      return isUsernameRecipient(providerRecipient) &&
        isResolvedUsernameRecipient(key.remoteJid)
        ? { outcome: "provider_acknowledgement", status: "accepted" }
        : { outcome: "ambiguous", reason: "invalid_response" };
    }
    return {
      messageIdentity: await protectMessageIdentity(identityKey, key.id),
      outcome: "identity_evidence",
      status,
    };
  }

  const documentedDataAcknowledgement =
    data !== null &&
    typeof data.msgId === "number" &&
    Number.isSafeInteger(data.msgId) &&
    data.msgId > 0 &&
    (sameRecipient(data.jid, providerRecipient) ||
      (isUsernameRecipient(providerRecipient) &&
        isResolvedUsernameRecipient(data.jid))) &&
    data.status === "in_progress";

  return documentedDataAcknowledgement
    ? { outcome: "provider_acknowledgement", status: "accepted" }
    : { outcome: "ambiguous", reason: "invalid_response" };
};

export const productionOutboundSendRuntime: OutboundSendRuntime = {
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) =>
    globalThis.setTimeout(callback, milliseconds),
};

export const makeWasenderRecipientRoute = async (
  identityKey: WasenderIdentityProtectionKey,
  kind: "contact" | "group",
  providerIdentifier: string,
): Promise<WasenderRecipientRoute> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(Redacted.value(identityKey)),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return Redacted.make(
    await sealIdentityRecipientRoute(
      await deriveIdentityRecipientRouteKeys(key),
      kind,
      providerIdentifier,
    ),
  ) as WasenderRecipientRoute;
};

/**
 * Internal test seam. Package consumers can construct only the production
 * adapter below, whose host, transport, timeout, and attempt count are fixed.
 */
export const makeWasenderTextSendingWithRuntime = (
  options: WasenderTextSendingOptions,
  runtime: OutboundSendRuntime,
): TextSending => {
  const authority = Redacted.value(options.authority);
  const identityKey = new Uint8Array(Redacted.value(options.identityKey));
  if (!isProtectedString(authority)) {
    throw new Error("Wasender session authority is invalid");
  }
  if (identityKey.byteLength !== 32) {
    throw new Error("Wasender identity protection key must contain 32 bytes");
  }
  const recipientRouteKeys = deriveRecipientRouteKeys(authority);
  const identityRecipientRouteKeys = crypto.subtle
    .importKey("raw", identityKey, { hash: "SHA-256", name: "HMAC" }, false, [
      "sign",
    ])
    .then(deriveIdentityRecipientRouteKeys);

  return {
    sendText: ({ recipient, text }) =>
      Effect.promise(async () => {
        const startedAt = runtime.now();
        let attemptCount: 0 | 1 = 0;
        let responseBytes: number | null = null;
        let result: TextSendResult;

        try {
          const resolved = options.resolveRecipient(recipient);
          if (resolved === null) {
            result = definitiveFailure("recipient_rejected");
          } else {
            const route = Redacted.value(resolved);
            const opened = isProtectedString(route)
              ? ((await openIdentityRecipientRoute(
                  await identityRecipientRouteKeys,
                  route,
                )) ??
                (await openRecipientRoute(await recipientRouteKeys, route)))
              : null;
            const providerRecipient =
              opened === null
                ? null
                : providerDestination(opened.kind, opened.identifier);
            if (providerRecipient === null) {
              result = definitiveFailure("recipient_rejected");
            } else {
              const controller = new AbortController();
              let timedOut = false;
              const timeout = runtime.setTimeout(() => {
                timedOut = true;
                controller.abort();
              }, 15_000);

              try {
                attemptCount = 1;
                const response = await runtime.fetch(sendMessageUrl, {
                  body: JSON.stringify({ to: providerRecipient, text }),
                  headers: {
                    authorization: `Bearer ${authority}`,
                    "content-type": "application/json",
                  },
                  method: "POST",
                  redirect: "manual",
                  signal: controller.signal,
                });
                const body = await readBoundedBody(response);
                responseBytes = body.bytes;
                result = await classifySendResponse(
                  response,
                  body,
                  providerRecipient,
                  identityKey,
                );
              } catch {
                result = timedOut
                  ? { outcome: "ambiguous", reason: "timed_out" }
                  : { outcome: "ambiguous", reason: "connection_lost" };
              } finally {
                runtime.clearTimeout(timeout);
              }
            }
          }
        } catch {
          result =
            attemptCount === 0
              ? definitiveFailure("recipient_rejected")
              : { outcome: "ambiguous", reason: "unavailable" };
        }

        try {
          options.telemetry.emit({
            attemptCount,
            durationMs: Math.max(0, runtime.now() - startedAt),
            operationClass: "text-send",
            outcome: result.outcome,
            responseBytes,
          });
        } catch {
          // Telemetry cannot change an already-observed provider outcome.
        }
        return result;
      }),
  };
};

export const makeWasenderTextSending = (
  options: WasenderTextSendingOptions,
): TextSending =>
  makeWasenderTextSendingWithRuntime(options, productionOutboundSendRuntime);

export const makeWasenderTextSendingLayer = (
  options: WasenderTextSendingOptions,
) => Layer.succeed(TextSending, makeWasenderTextSending(options));
