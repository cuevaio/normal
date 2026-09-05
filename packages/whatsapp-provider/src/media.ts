import { Effect, Layer, Redacted, Stream } from "effect";
import {
  maximumJsonResponseBytes,
  type ProviderNeutralFailure,
} from "./common";
import type { SessionAuthority } from "./control";
import {
  makeDownloadMediaSource,
  parseDownloadMediaSource,
  parseEncryptedMediaSource,
} from "./media-source";
import { providerMediaHostname, providerOrigin } from "./provider-origin";
import {
  type GuardedMediaDownload,
  guardedMediaDownloadPolicy,
  MediaRetrieval,
  type MediaRetrieval as MediaRetrievalService,
  mediaDecryptMetadataPolicy,
} from "./session";

/**
 * The host a download may come from, and the metadata endpoint.
 *
 * `validateDownloadUrl` pins the hostname and re-pins it on every redirect hop, so this must
 * track the origin the adapter actually calls. Deriving both from one constant is what keeps
 * that true: a build whose call target and validated host disagree fails mid-download, at a
 * boundary, instead of anywhere a reader would look for it.
 */
export const wasenderMediaHostname = providerMediaHostname;
export const wasenderMediaDecryptEndpoint = `${providerOrigin}/api/decrypt-media`;

const dnsOverHttpsEndpoint = "https://cloudflare-dns.com/dns-query";
const maximumDnsResponseBytes = 65_536;
const maximumRedirects = 3;
const internalFailure = Symbol("WasenderMediaInternalFailure");

export interface WasenderMediaTelemetryEvent {
  readonly attemptCount: 1;
  readonly byteCount: number;
  readonly durationMs: number;
  readonly operationClass: "media-download" | "media-metadata";
  readonly outcome:
    | "authentication_failed"
    | "cancelled"
    | "integrity_failed"
    | "invalid_response"
    | "response_too_large"
    | "source_rejected"
    | "succeeded"
    | "throttled"
    | "timed_out"
    | "unavailable";
}

export interface WasenderMediaTelemetry {
  readonly emit: (event: WasenderMediaTelemetryEvent) => void;
}

export interface WasenderMediaAdapterDependencies {
  readonly clearTimer: (timer: unknown) => void;
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  readonly now: () => number;
  readonly resolveHostname: (
    hostname: string,
    signal: AbortSignal,
  ) => Promise<ReadonlyArray<string>>;
  readonly scheduleTimer: (callback: () => void, delayMs: number) => unknown;
  readonly telemetry: WasenderMediaTelemetry;
}

export interface MakeWasenderMediaRetrievalOptions {
  readonly dependencies: WasenderMediaAdapterDependencies;
  readonly sessionAuthority: SessionAuthority;
}

export class WasenderMediaConfigurationError extends Error {
  readonly _tag = "WasenderMediaConfigurationError";
}

const markFailure = <Failure extends ProviderNeutralFailure>(
  failure: Failure,
): Failure => {
  Object.defineProperty(failure, internalFailure, { value: true });
  return failure;
};

const metadataFailure = (
  code: ProviderNeutralFailure["code"],
): Extract<ProviderNeutralFailure, { readonly operation: "media-metadata" }> =>
  markFailure({
    _tag: "ProviderNeutralFailure",
    code,
    operation: "media-metadata",
    retryAfterMs: null,
    retryDecision: "do_not_retry",
  });

const downloadFailure = (
  code: ProviderNeutralFailure["code"],
  retryDecision:
    | "do_not_retry"
    | "restart_media_from_byte_zero" = "do_not_retry",
): Extract<ProviderNeutralFailure, { readonly operation: "media-download" }> =>
  markFailure({
    _tag: "ProviderNeutralFailure",
    code,
    operation: "media-download",
    retryAfterMs: null,
    retryDecision,
  });

const isProviderNeutralFailure = (
  value: unknown,
): value is ProviderNeutralFailure =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly [internalFailure]?: unknown })[internalFailure] === true;

const mapProviderStatus = (
  status: number,
  operation: "media-download" | "media-metadata",
): ProviderNeutralFailure => {
  const code =
    status === 401 || status === 403
      ? "authentication_failed"
      : status === 429
        ? "throttled"
        : status === 408 || status >= 500
          ? "unavailable"
          : "invalid_response";
  return operation === "media-metadata"
    ? metadataFailure(code)
    : downloadFailure(
        code,
        status === 408 || status >= 500
          ? "restart_media_from_byte_zero"
          : "do_not_retry",
      );
};

const parseIpv4 = (address: string): ReadonlyArray<number> | null => {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const bytes = parts.map((part) =>
    /^(0|[1-9][0-9]{0,2})$/.test(part) ? Number(part) : Number.NaN,
  );
  return bytes.every((byte) => Number.isInteger(byte) && byte <= 255)
    ? bytes
    : null;
};

const isPublicIpv4 = (address: string): boolean => {
  const bytes = parseIpv4(address);
  if (bytes === null) {
    return false;
  }
  const [first = 0, second = 0, third = 0] = bytes;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
};

const parseIpv6 = (address: string): ReadonlyArray<number> | null => {
  if (address.includes("%")) {
    return null;
  }
  const withoutZone = address.split("%", 1)[0] ?? "";
  if (withoutZone.length === 0 || (withoutZone.match(/::/g)?.length ?? 0) > 1) {
    return null;
  }
  let normalized = withoutZone;
  const ipv4Tail = /(?:^|:)([0-9]+(?:\.[0-9]+){3})$/.exec(normalized);
  if (ipv4Tail?.[1] !== undefined) {
    const ipv4 = parseIpv4(ipv4Tail[1]);
    if (ipv4 === null) {
      return null;
    }
    const high = ((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0);
    const low = ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0);
    normalized = `${normalized.slice(0, -ipv4Tail[1].length)}${high.toString(16)}:${low.toString(16)}`;
  }
  const [leftText, rightText] = normalized.split("::");
  const left = leftText === "" ? [] : (leftText?.split(":") ?? []);
  const right =
    rightText === undefined || rightText === "" ? [] : rightText.split(":");
  if (
    [...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/i.test(part)) ||
    (rightText === undefined && left.length !== 8) ||
    (rightText !== undefined && left.length + right.length >= 8)
  ) {
    return null;
  }
  const groups = [
    ...left,
    ...Array.from(
      { length: rightText === undefined ? 0 : 8 - left.length - right.length },
      () => "0",
    ),
    ...right,
  ].map((part) => Number.parseInt(part, 16));
  if (groups.length !== 8) {
    return null;
  }
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
};

const isPublicIpv6 = (address: string): boolean => {
  const bytes = parseIpv6(address);
  if (bytes === null) {
    return false;
  }
  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (mapped) {
    return isPublicIpv4(bytes.slice(12).join("."));
  }
  const globalUnicast = ((bytes[0] ?? 0) & 0xe0) === 0x20;
  const documentation =
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8;
  const transition =
    (bytes[0] === 0x20 &&
      bytes[1] === 0x01 &&
      bytes[2] === 0x00 &&
      bytes[3] === 0x00) ||
    (bytes[0] === 0x20 && bytes[1] === 0x02);
  const benchmarking =
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x02;
  const orchid =
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x00 &&
    (((bytes[3] ?? 0) & 0xf0) === 0x10 || ((bytes[3] ?? 0) & 0xf0) === 0x20);
  const documentation2 = bytes[0] === 0x3f && ((bytes[1] ?? 0) & 0xf0) === 0xf0;
  return (
    globalUnicast &&
    !documentation &&
    !transition &&
    !benchmarking &&
    !orchid &&
    !documentation2
  );
};

export const isPublicIpAddress = (address: string): boolean =>
  address.includes(":") ? isPublicIpv6(address) : isPublicIpv4(address);

const validateDownloadUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw downloadFailure("source_rejected");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== wasenderMediaHostname ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw downloadFailure("source_rejected");
  }
  return url;
};

const validateResolvedHost = async (
  url: URL,
  signal: AbortSignal,
  dependencies: WasenderMediaAdapterDependencies,
  operation: "media-download" | "media-metadata",
): Promise<void> => {
  const addresses = await dependencies.resolveHostname(url.hostname, signal);
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isPublicIpAddress(address))
  ) {
    throw operation === "media-metadata"
      ? metadataFailure("source_rejected")
      : downloadFailure("source_rejected");
  }
};

const isRedirect = (status: number): boolean =>
  status === 301 ||
  status === 302 ||
  status === 303 ||
  status === 307 ||
  status === 308;

const cancelBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best effort after the response has already been rejected.
  }
};

const fetchWithValidatedRedirects = async (options: {
  readonly controller: AbortController;
  readonly dependencies: WasenderMediaAdapterDependencies;
  readonly headers?: Headers | Readonly<Record<string, string>>;
  readonly method: "GET" | "POST";
  readonly operation: "media-download" | "media-metadata";
  readonly requestBody?: string;
  readonly url: URL;
}): Promise<Response> => {
  let url = options.url;
  for (let redirectCount = 0; ; redirectCount += 1) {
    await validateResolvedHost(
      url,
      options.controller.signal,
      options.dependencies,
      options.operation,
    );
    const response = await options.dependencies.fetch(url.href, {
      ...(options.requestBody === undefined
        ? {}
        : { body: options.requestBody }),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      method: options.method,
      redirect: "manual",
      signal: options.controller.signal,
    });
    if (!isRedirect(response.status)) {
      return response;
    }
    const location = response.headers.get("location");
    await cancelBody(response);
    if (location === null || redirectCount >= maximumRedirects) {
      throw options.operation === "media-metadata"
        ? metadataFailure("source_rejected")
        : downloadFailure("source_rejected");
    }
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, url);
    } catch {
      throw options.operation === "media-metadata"
        ? metadataFailure("source_rejected")
        : downloadFailure("source_rejected");
    }
    try {
      url = validateDownloadUrl(nextUrl.href);
    } catch {
      throw options.operation === "media-metadata"
        ? metadataFailure("source_rejected")
        : downloadFailure("source_rejected");
    }
  }
};

const readBoundedBytes = async (
  response: Response,
  maximumBytes: number,
  overflowFailure: unknown,
  missingBodyFailure: unknown = overflowFailure,
): Promise<Uint8Array> => {
  if (response.body === null) {
    throw missingBodyFailure;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the bounded-response failure if cancellation also fails.
        }
        throw overflowFailure;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const parseMetadataResponse = async (
  response: Response,
): Promise<{ readonly byteCount: number; readonly publicUrl: string }> => {
  const bytes = await readBoundedBytes(
    response,
    maximumJsonResponseBytes,
    metadataFailure("response_too_large"),
    metadataFailure("invalid_response"),
  );
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw metadataFailure("invalid_response");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { readonly success?: unknown }).success !== true ||
    typeof (value as { readonly publicUrl?: unknown }).publicUrl !== "string"
  ) {
    throw metadataFailure("invalid_response");
  }
  return {
    byteCount: bytes.byteLength,
    publicUrl: (value as { readonly publicUrl: string }).publicUrl,
  };
};

const emitTelemetry = (
  telemetry: WasenderMediaTelemetry,
  event: WasenderMediaTelemetryEvent,
): void => {
  try {
    telemetry.emit(event);
  } catch {
    // Telemetry cannot change provider operation outcomes.
  }
};

const normalizeMetadataFailure = (
  error: unknown,
  timedOut: boolean,
): ProviderNeutralFailure =>
  isProviderNeutralFailure(error)
    ? error
    : metadataFailure(timedOut ? "timed_out" : "unavailable");

const normalizeDownloadFailure = (
  error: unknown,
  timedOut: boolean,
): ProviderNeutralFailure =>
  isProviderNeutralFailure(error)
    ? error
    : downloadFailure(
        timedOut ? "timed_out" : "unavailable",
        "restart_media_from_byte_zero",
      );

export const makeWasenderMediaRetrieval = ({
  dependencies,
  sessionAuthority,
}: MakeWasenderMediaRetrievalOptions): MediaRetrievalService => {
  const credential = Redacted.value(sessionAuthority);
  if (
    !/^[\x21-\x7e]+$/.test(credential) ||
    credential.length > 4_096 ||
    credential.trim().length === 0
  ) {
    throw new WasenderMediaConfigurationError(
      "Wasender session authority is invalid",
    );
  }

  const getMetadata: MediaRetrievalService["getMetadata"] = ({ source }) => {
    const parsedSource = parseEncryptedMediaSource(source);
    if (parsedSource === null) {
      return Effect.fail(metadataFailure("source_rejected"));
    }
    return Effect.tryPromise({
      try: async () => {
        const startedAt = dependencies.now();
        const controller = new AbortController();
        let timedOut = false;
        let outcome: WasenderMediaTelemetryEvent["outcome"] = "unavailable";
        let byteCount = 0;
        const timer = dependencies.scheduleTimer(() => {
          timedOut = true;
          controller.abort();
        }, mediaDecryptMetadataPolicy.attemptTimeoutMs);
        try {
          const response = await fetchWithValidatedRedirects({
            controller,
            dependencies,
            headers: {
              authorization: `Bearer ${credential}`,
              "content-type": "application/json",
            },
            method: "POST",
            operation: "media-metadata",
            requestBody: JSON.stringify(parsedSource.requestBody),
            url: new URL(wasenderMediaDecryptEndpoint),
          });
          if (response.status !== 200) {
            await cancelBody(response);
            throw mapProviderStatus(response.status, "media-metadata");
          }
          const metadataResponse = await parseMetadataResponse(response);
          byteCount = metadataResponse.byteCount;
          try {
            validateDownloadUrl(metadataResponse.publicUrl);
          } catch {
            throw metadataFailure("source_rejected");
          }
          outcome = "succeeded";
          return {
            expectedSizeBytes: parsedSource.expectedSizeBytes,
            fileName: parsedSource.fileName,
            mimeType: parsedSource.mimeType,
            source: makeDownloadMediaSource(metadataResponse.publicUrl),
          };
        } catch (error) {
          const failure = normalizeMetadataFailure(error, timedOut);
          outcome = failure.code;
          throw failure;
        } finally {
          dependencies.clearTimer(timer);
          emitTelemetry(dependencies.telemetry, {
            attemptCount: 1,
            byteCount,
            durationMs: Math.max(0, dependencies.now() - startedAt),
            operationClass: "media-metadata",
            outcome,
          });
        }
      },
      catch: (error) => normalizeMetadataFailure(error, false),
    });
  };

  const download: MediaRetrievalService["download"] = ({
    maxBytes,
    source,
  }) => {
    const encodedUrl = parseDownloadMediaSource(source);
    if (encodedUrl === null) {
      return Effect.fail(downloadFailure("source_rejected"));
    }
    let url: URL;
    try {
      url = validateDownloadUrl(encodedUrl);
    } catch (error) {
      return Effect.fail(normalizeDownloadFailure(error, false));
    }

    const bytes = async function* (): AsyncGenerator<Uint8Array> {
      const startedAt = dependencies.now();
      const controller = new AbortController();
      let timedOut = false;
      let outcome: WasenderMediaTelemetryEvent["outcome"] = "cancelled";
      let byteCount = 0;
      const timer = dependencies.scheduleTimer(() => {
        timedOut = true;
        controller.abort();
      }, guardedMediaDownloadPolicy.attemptTimeoutMs);
      let reader: { readonly releaseLock: () => void } | null = null;
      try {
        const response = await fetchWithValidatedRedirects({
          controller,
          dependencies,
          method: "GET",
          operation: "media-download",
          url,
        });
        if (response.status !== 200) {
          await cancelBody(response);
          throw mapProviderStatus(response.status, "media-download");
        }
        if (response.body === null) {
          throw downloadFailure("invalid_response");
        }
        const activeReader = response.body.getReader();
        reader = activeReader;
        for (;;) {
          const result = await activeReader.read();
          if (result.done) {
            outcome = "succeeded";
            break;
          }
          const nextByteCount = byteCount + result.value.byteLength;
          if (nextByteCount > maxBytes) {
            try {
              await activeReader.cancel();
            } catch {
              // Preserve the hard-limit failure if cancellation also fails.
            }
            throw downloadFailure(
              "response_too_large",
              "restart_media_from_byte_zero",
            );
          }
          byteCount = nextByteCount;
          yield result.value;
        }
      } catch (error) {
        const failure = normalizeDownloadFailure(error, timedOut);
        outcome = failure.code;
        throw failure;
      } finally {
        dependencies.clearTimer(timer);
        controller.abort();
        try {
          reader?.releaseLock();
        } catch {
          // A cancelled body may already have released its reader lock.
        }
        emitTelemetry(dependencies.telemetry, {
          attemptCount: 1,
          byteCount,
          durationMs: Math.max(0, dependencies.now() - startedAt),
          operationClass: "media-download",
          outcome,
        });
      }
    };

    return Effect.succeed({
      maxBytes,
      stream: Stream.unwrap(
        Effect.sync(() =>
          Stream.fromAsyncIterable(bytes(), (error) =>
            normalizeDownloadFailure(error, false),
          ),
        ),
      ),
    } satisfies GuardedMediaDownload);
  };

  return { download, getMetadata };
};

const readDnsJson = async (
  response: Response,
): Promise<{
  readonly Answer?: ReadonlyArray<{
    readonly data?: unknown;
    readonly type?: unknown;
  }>;
}> => {
  if (!response.ok) {
    throw new Error("DNS resolution unavailable");
  }
  const bytes = await readBoundedBytes(
    response,
    maximumDnsResponseBytes,
    new Error("DNS response exceeded its byte limit"),
    new Error("DNS response was empty"),
  );
  return JSON.parse(new TextDecoder().decode(bytes));
};

const resolveWithDnsOverHttps = async (
  hostname: string,
  signal: AbortSignal,
): Promise<ReadonlyArray<string>> => {
  const query = async (type: "A" | "AAAA") => {
    const url = new URL(dnsOverHttpsEndpoint);
    url.searchParams.set("name", hostname);
    url.searchParams.set("type", type);
    const response = await globalThis.fetch(url, {
      headers: { accept: "application/dns-json" },
      redirect: "manual",
      signal,
    });
    const payload = await readDnsJson(response);
    return (payload.Answer ?? [])
      .filter((answer) => answer.type === (type === "A" ? 1 : 28))
      .map((answer) => answer.data)
      .filter((address): address is string => typeof address === "string");
  };
  const [ipv4, ipv6] = await Promise.all([query("A"), query("AAAA")]);
  return [...ipv4, ...ipv6];
};

const productionTelemetry: WasenderMediaTelemetry = {
  emit: (event) => console.info(JSON.stringify(event)),
};

const productionDependencies = (): WasenderMediaAdapterDependencies => ({
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => Date.now(),
  resolveHostname: resolveWithDnsOverHttps,
  scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  telemetry: productionTelemetry,
});

export const makeWasenderMediaRetrievalLayer = (options: {
  readonly sessionAuthority: SessionAuthority;
  readonly telemetry?: WasenderMediaTelemetry;
}) =>
  Layer.effect(
    MediaRetrieval,
    Effect.try({
      try: () =>
        makeWasenderMediaRetrieval({
          dependencies: {
            ...productionDependencies(),
            ...(options.telemetry === undefined
              ? {}
              : { telemetry: options.telemetry }),
          },
          sessionAuthority: options.sessionAuthority,
        }),
      catch: () =>
        new WasenderMediaConfigurationError(
          "Wasender media adapter configuration is invalid",
        ),
    }),
  );
