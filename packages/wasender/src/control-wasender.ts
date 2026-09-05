import { Effect, Layer, Redacted } from "effect";
import { renderSVG } from "uqr";
import { encodeBase64Url } from "./base64-url";
import {
  type AdapterFailureCode,
  makeBoundedRetryAfterMs,
  maximumJsonResponseBytes,
  type ProviderNeutralFailure,
} from "./common";
import {
  type LifecycleConnectionState,
  type LifecycleSession,
  type LifecycleSessionLocator,
  type QrCodeObservation,
  type SessionAuthority,
  type SessionDeletionObservation,
  SessionLifecycle,
  type SessionLifecycle as SessionLifecycleService,
  type SessionNumberVerification,
  type SessionReconciliation,
  type SetupMarker,
} from "./control";
import { providerOrigin } from "./provider-origin";
import {
  WebshareProxySelectionError,
  type WebshareProxySelector,
} from "./webshare";

const safeReadAttemptTimeoutMs = 10_000;
const safeReadMaximumAttempts = 3;
const safeReadTotalTimeoutMs = 25_000;
const lifecycleWriteTimeoutMs = 15_000;
const referenceDomain = "whatsapp-mcp:wasender:lifecycle-session:v1:";
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
] as const;

type Fetch = (request: Request) => Promise<Response>;

export interface WasenderLifecycleConfig {
  readonly credential: Redacted.Redacted<string>;
  /** A stable, independently rotatable 32-byte hex HMAC key. */
  readonly referenceSecret: Redacted.Redacted<string>;
}

export interface WasenderLifecycleTelemetryEvent {
  readonly attempt: number;
  readonly durationMs: number;
  readonly operation: "lifecycle-write" | "safe-read";
  readonly outcome: "success" | AdapterFailureCode;
  readonly responseBytes: number;
}

export interface WasenderProxyAllocationCoordinator {
  readonly release: (setupMarker: SetupMarker) => Promise<void>;
  readonly reserve: (setupMarker: SetupMarker) => Promise<void>;
}

export interface WasenderLifecycleDependencies {
  readonly fetch?: Fetch;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly renderQr?: (payload: string) => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly telemetry?: (event: WasenderLifecycleTelemetryEvent) => void;
  readonly proxyAllocationCoordinator?: WasenderProxyAllocationCoordinator;
  readonly proxySelector?: WebshareProxySelector;
}

interface ProviderSession {
  readonly apiKey: string | null;
  readonly id: number;
  readonly ignoreGroups: boolean | null;
  readonly logMessages: boolean | null;
  readonly name: string;
  readonly proxyUrl: string | null;
  readonly readIncomingMessages: boolean | null;
  readonly status: string;
  readonly webhookEnabled: boolean | null;
  readonly webhookEvents: ReadonlyArray<string> | null;
  readonly webhookSecret: string | null;
  readonly webhookUrl: string | null;
}

interface SessionUserInfo {
  readonly id: string;
}

interface BoundedBody {
  readonly bytes: Uint8Array;
  readonly jsonValid: boolean;
  readonly value: unknown;
}

const safeFailure = (
  code: AdapterFailureCode,
  retryAfterMs: number | null = null,
): Extract<ProviderNeutralFailure, { readonly operation: "safe-read" }> => ({
  _tag: "ProviderNeutralFailure",
  code,
  operation: "safe-read",
  retryAfterMs:
    retryAfterMs === null ? null : makeBoundedRetryAfterMs(retryAfterMs),
  retryDecision: "do_not_retry",
});

const writeFailure = (
  code: AdapterFailureCode,
  ambiguous: boolean,
): Extract<
  ProviderNeutralFailure,
  { readonly operation: "lifecycle-write" }
> => ({
  _tag: "ProviderNeutralFailure",
  code,
  operation: "lifecycle-write",
  retryAfterMs: null,
  retryDecision: ambiguous ? "reconcile_before_repeat" : "do_not_retry",
});

const isProviderFailure = (value: unknown): value is ProviderNeutralFailure =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "ProviderNeutralFailure";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseProviderSession = (
  value: unknown,
  requireAuthority: boolean,
): ProviderSession | null => {
  if (!isRecord(value)) return null;
  const {
    api_key: apiKey,
    id,
    ignore_groups: ignoreGroups,
    log_messages: logMessages,
    name,
    proxy_url: proxyUrl,
    read_incoming_messages: readIncomingMessages,
    status,
    webhook_enabled: webhookEnabled,
    webhook_events: webhookEvents,
    webhook_secret: webhookSecret,
    webhook_url: webhookUrl,
  } = value;
  if (
    !Number.isSafeInteger(id) ||
    (id as number) <= 0 ||
    typeof name !== "string" ||
    name.length === 0 ||
    typeof status !== "string" ||
    status.length === 0 ||
    (proxyUrl !== undefined &&
      proxyUrl !== null &&
      typeof proxyUrl !== "string") ||
    (apiKey !== undefined && typeof apiKey !== "string") ||
    (webhookSecret !== undefined &&
      webhookSecret !== null &&
      typeof webhookSecret !== "string") ||
    (logMessages !== undefined &&
      logMessages !== null &&
      typeof logMessages !== "boolean") ||
    (ignoreGroups !== undefined &&
      ignoreGroups !== null &&
      typeof ignoreGroups !== "boolean") ||
    (readIncomingMessages !== undefined &&
      readIncomingMessages !== null &&
      typeof readIncomingMessages !== "boolean") ||
    (webhookEnabled !== undefined &&
      webhookEnabled !== null &&
      typeof webhookEnabled !== "boolean") ||
    (webhookEvents !== undefined &&
      webhookEvents !== null &&
      (!Array.isArray(webhookEvents) ||
        webhookEvents.some((event) => typeof event !== "string"))) ||
    (webhookUrl !== undefined &&
      webhookUrl !== null &&
      typeof webhookUrl !== "string") ||
    (requireAuthority && (typeof apiKey !== "string" || apiKey.length === 0))
  ) {
    return null;
  }
  return {
    apiKey: typeof apiKey === "string" && apiKey.length > 0 ? apiKey : null,
    id: id as number,
    ignoreGroups: typeof ignoreGroups === "boolean" ? ignoreGroups : null,
    logMessages: typeof logMessages === "boolean" ? logMessages : null,
    name,
    proxyUrl: typeof proxyUrl === "string" ? proxyUrl : null,
    readIncomingMessages:
      typeof readIncomingMessages === "boolean" ? readIncomingMessages : null,
    status,
    webhookEnabled: typeof webhookEnabled === "boolean" ? webhookEnabled : null,
    webhookEvents: Array.isArray(webhookEvents)
      ? (webhookEvents as ReadonlyArray<string>)
      : null,
    webhookSecret:
      typeof webhookSecret === "string" && webhookSecret.length > 0
        ? webhookSecret
        : null,
    webhookUrl: typeof webhookUrl === "string" ? webhookUrl : null,
  };
};

const parseData = (value: unknown): unknown =>
  isRecord(value) && value.success === true && "data" in value
    ? value.data
    : undefined;

const parseSessionUserInfo = (value: unknown): SessionUserInfo => {
  const data = parseData(value);
  if (!isRecord(data) || typeof data.id !== "string" || data.id.length === 0) {
    throw safeFailure("invalid_response");
  }
  return { id: data.id };
};

const parseSessionList = (value: unknown): ReadonlyArray<ProviderSession> => {
  const data = parseData(value);
  if (!Array.isArray(data)) throw safeFailure("invalid_response");
  const sessions = data.map((entry) => parseProviderSession(entry, false));
  if (sessions.includes(null)) {
    throw safeFailure("invalid_response");
  }
  return sessions as ReadonlyArray<ProviderSession>;
};

const parseSessionDetail = (value: unknown): ProviderSession => {
  const session = parseProviderSession(parseData(value), true);
  if (!session) throw safeFailure("invalid_response");
  return session;
};

const normalizeConnectionState = (
  providerStatus: string,
): LifecycleConnectionState => {
  switch (providerStatus.trim().toLowerCase()) {
    case "connected":
      return "connected";
    case "connecting":
    case "need_scan":
    case "qr":
    case "scan_qr_code":
      return "connecting";
    case "disconnected":
      return "disconnected";
    case "expired":
    case "logged_out":
    case "reconnect_required":
      return "reconnect_required";
    default:
      return "degraded";
  }
};

const decodeHex = (value: string): Uint8Array => {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const isProviderApiCredential = (value: string) =>
  /^[\x21-\x7e]{1,4096}$/u.test(value) &&
  !/replace|example|placeholder/iu.test(value);

const validateConfig = (config: WasenderLifecycleConfig) => {
  const credential = Redacted.value(config.credential);
  const referenceSecret = Redacted.value(config.referenceSecret);
  if (!isProviderApiCredential(credential)) {
    throw new RangeError("Provider API Credential is invalid");
  }
  if (!/^[0-9a-f]{64}$/iu.test(referenceSecret)) {
    throw new RangeError("Wasender reference secret must be 32-byte hex");
  }
  return { credential, referenceSecret };
};

const retryAfterMilliseconds = (
  response: Response,
  body: unknown,
  now: number,
): number | null => {
  const header = response.headers.get("retry-after")?.trim();
  let milliseconds: number | null = null;
  if (header && /^\d+$/u.test(header)) {
    milliseconds = Number(header) * 1_000;
  } else if (header) {
    const date = Date.parse(header);
    if (Number.isFinite(date)) milliseconds = Math.max(0, date - now);
  }
  if (
    milliseconds === null &&
    isRecord(body) &&
    typeof body.retry_after === "number" &&
    Number.isFinite(body.retry_after) &&
    body.retry_after >= 0
  ) {
    milliseconds = Math.floor(body.retry_after * 1_000);
  }
  return milliseconds === null ? null : Math.min(milliseconds, 5_000);
};

const classifyStatus = (status: number): AdapterFailureCode => {
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 429) return "throttled";
  if (status === 408) return "timed_out";
  if (status >= 500) return "unavailable";
  return "invalid_response";
};

const isAbort = (cause: unknown): boolean =>
  (cause instanceof DOMException && cause.name === "AbortError") ||
  (isRecord(cause) && cause.name === "AbortError");

const readBoundedJson = async (response: Response): Promise<BoundedBody> => {
  if (!response.body) {
    return { bytes: new Uint8Array(), jsonValid: true, value: undefined };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maximumJsonResponseBytes) {
      await reader.cancel();
      throw safeFailure("response_too_large");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.byteLength === 0) {
    return { bytes, jsonValid: true, value: undefined };
  }
  try {
    return {
      bytes,
      jsonValid: true,
      value: JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      ),
    };
  } catch {
    return { bytes, jsonValid: false, value: undefined };
  }
};

export const makeWasenderSessionLifecycle = (
  config: WasenderLifecycleConfig,
  dependencies: WasenderLifecycleDependencies = {},
): SessionLifecycleService => {
  const validated = validateConfig(config);
  const fetchRequest = dependencies.fetch ?? ((request) => fetch(request));
  const now = dependencies.now ?? Date.now;
  const random = dependencies.random ?? Math.random;
  const renderQr =
    dependencies.renderQr ??
    ((payload: string) => renderSVG(payload, { border: 4, ecc: "M" }));
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const telemetry = dependencies.telemetry ?? (() => undefined);
  const proxyAllocationCoordinator = dependencies.proxyAllocationCoordinator;
  const proxySelector = dependencies.proxySelector;
  const keyPromise = crypto.subtle.importKey(
    "raw",
    decodeHex(validated.referenceSecret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );

  const emit = (event: WasenderLifecycleTelemetryEvent) => {
    try {
      telemetry(event);
    } catch {
      // Telemetry is deliberately non-authoritative for provider behavior.
    }
  };

  const request = async (
    path: string,
    operation: "lifecycle-write" | "safe-read",
    attempt: number,
    timeoutMs: number,
    init?: { readonly body?: unknown; readonly method?: string },
    requestCredential = validated.credential,
  ): Promise<{ readonly body: BoundedBody; readonly response: Response }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = now();
    let responseBytes = 0;
    try {
      const headers = new Headers({
        accept: "application/json",
        authorization: `Bearer ${requestCredential}`,
      });
      const body =
        init?.body === undefined ? undefined : JSON.stringify(init.body);
      if (body !== undefined) headers.set("content-type", "application/json");
      const requestInit: RequestInit = {
        headers,
        method: init?.method ?? "GET",
        signal: controller.signal,
        ...(body === undefined ? {} : { body }),
      };
      const response = await fetchRequest(
        new Request(`${providerOrigin}${path}`, requestInit),
      );
      const boundedBody = await readBoundedJson(response);
      responseBytes = boundedBody.bytes.byteLength;
      return { body: boundedBody, response };
    } catch (cause) {
      const code = isProviderFailure(cause)
        ? cause.code
        : isAbort(cause)
          ? "timed_out"
          : "unavailable";
      emit({
        attempt,
        durationMs: Math.max(0, now() - startedAt),
        operation,
        outcome: code,
        responseBytes,
      });
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  };

  const safeJson = async (
    path: string,
    requestCredential = validated.credential,
  ): Promise<BoundedBody> => {
    const startedAt = now();
    for (let attempt = 1; attempt <= safeReadMaximumAttempts; attempt += 1) {
      const remaining = safeReadTotalTimeoutMs - (now() - startedAt);
      if (remaining <= 0) throw safeFailure("timed_out");
      const attemptStartedAt = now();
      try {
        const { body, response } = await request(
          path,
          "safe-read",
          attempt,
          Math.min(safeReadAttemptTimeoutMs, remaining),
          undefined,
          requestCredential,
        );
        if (response.ok) {
          if (!body.jsonValid) {
            emit({
              attempt,
              durationMs: Math.max(0, now() - attemptStartedAt),
              operation: "safe-read",
              outcome: "invalid_response",
              responseBytes: body.bytes.byteLength,
            });
            throw safeFailure("invalid_response");
          }
          emit({
            attempt,
            durationMs: Math.max(0, now() - attemptStartedAt),
            operation: "safe-read",
            outcome: "success",
            responseBytes: body.bytes.byteLength,
          });
          return body;
        }
        const code = classifyStatus(response.status);
        const retryAfter = retryAfterMilliseconds(response, body.value, now());
        emit({
          attempt,
          durationMs: Math.max(0, now() - attemptStartedAt),
          operation: "safe-read",
          outcome: code,
          responseBytes: body.bytes.byteLength,
        });
        const eligible =
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500;
        if (eligible && attempt < safeReadMaximumAttempts) {
          const jitteredBackoff = Math.floor(
            250 * 2 ** (attempt - 1) * (0.5 + random()),
          );
          const delay = retryAfter ?? jitteredBackoff;
          if (now() - startedAt + delay < safeReadTotalTimeoutMs) {
            await sleep(delay);
            continue;
          }
        }
        throw safeFailure(code, retryAfter);
      } catch (cause) {
        if (isProviderFailure(cause)) throw cause;
        const code = isAbort(cause) ? "timed_out" : "unavailable";
        if (attempt < safeReadMaximumAttempts) {
          const delay = Math.floor(250 * 2 ** (attempt - 1) * (0.5 + random()));
          if (now() - startedAt + delay < safeReadTotalTimeoutMs) {
            await sleep(delay);
            continue;
          }
        }
        throw safeFailure(code);
      }
    }
    throw safeFailure("unavailable");
  };

  const writeJson = async (
    path: string,
    init: {
      readonly body?: unknown;
      readonly method: "DELETE" | "POST" | "PUT";
    },
  ): Promise<BoundedBody> => {
    const startedAt = now();
    try {
      const { body, response } = await request(
        path,
        "lifecycle-write",
        1,
        lifecycleWriteTimeoutMs,
        init,
      );
      if (!response.ok) {
        const code = classifyStatus(response.status);
        emit({
          attempt: 1,
          durationMs: Math.max(0, now() - startedAt),
          operation: "lifecycle-write",
          outcome: code,
          responseBytes: body.bytes.byteLength,
        });
        throw writeFailure(
          code,
          response.status === 408 ||
            response.status === 429 ||
            response.status >= 500,
        );
      }
      if (!body.jsonValid) {
        emit({
          attempt: 1,
          durationMs: Math.max(0, now() - startedAt),
          operation: "lifecycle-write",
          outcome: "invalid_response",
          responseBytes: body.bytes.byteLength,
        });
        throw writeFailure("invalid_response", true);
      }
      emit({
        attempt: 1,
        durationMs: Math.max(0, now() - startedAt),
        operation: "lifecycle-write",
        outcome: "success",
        responseBytes: body.bytes.byteLength,
      });
      return body;
    } catch (cause) {
      if (isProviderFailure(cause) && cause.operation === "lifecycle-write") {
        throw cause;
      }
      if (isProviderFailure(cause)) {
        throw writeFailure(cause.code, true);
      }
      throw writeFailure(isAbort(cause) ? "timed_out" : "unavailable", true);
    }
  };

  const completeLifecycleWrite = async <Value>(
    task: () => Promise<Value>,
  ): Promise<Value> => {
    try {
      return await task();
    } catch (cause) {
      if (isProviderFailure(cause)) {
        if (cause.operation === "lifecycle-write") throw cause;
        throw writeFailure(cause.code, true);
      }
      throw writeFailure(isAbort(cause) ? "timed_out" : "unavailable", true);
    }
  };

  const locatorFor = async (id: number): Promise<LifecycleSessionLocator> => {
    const signature = await crypto.subtle.sign(
      "HMAC",
      await keyPromise,
      new TextEncoder().encode(`${referenceDomain}${id}`),
    );
    return `wsl_${encodeBase64Url(new Uint8Array(signature))}` as LifecycleSessionLocator;
  };

  const loadProviderSessions = async (): Promise<
    ReadonlyArray<ProviderSession>
  > => parseSessionList((await safeJson("/api/whatsapp-sessions")).value);

  const resolveProviderSession = async (
    locator: LifecycleSessionLocator,
  ): Promise<ProviderSession | null> => {
    const sessions = await loadProviderSessions();
    for (const session of sessions) {
      if ((await locatorFor(session.id)) === locator) return session;
    }
    return null;
  };

  const loadDetail = async (id: number): Promise<ProviderSession> => {
    const detail = parseSessionDetail(
      (await safeJson(`/api/whatsapp-sessions/${id}`)).value,
    );
    if (detail.id !== id) throw safeFailure("invalid_response");
    return detail;
  };

  const normalizedPhoneFromUserId = (value: string): string | null => {
    const trimmed = value.trim().toLowerCase();
    const match = /^([1-9]\d{7,14})(?::\d{1,5})?@s\.whatsapp\.net$/u.exec(
      trimmed,
    );
    return match?.[1] ? `+${match[1]}` : null;
  };

  const toLifecycleSession = async (
    providerSession: ProviderSession,
  ): Promise<LifecycleSession> => {
    if (
      !providerSession.apiKey ||
      !providerSession.webhookSecret ||
      !/^[\x21-\x7e]{1,4096}$/u.test(providerSession.webhookSecret)
    ) {
      throw safeFailure("invalid_response");
    }
    const authority = Redacted.make(
      JSON.stringify({
        sessionCredential: providerSession.apiKey,
        webhookVerificationSecret: providerSession.webhookSecret,
      }),
    ) as SessionAuthority;
    return {
      authority,
      connectionState: normalizeConnectionState(providerSession.status),
      session: await locatorFor(providerSession.id),
    };
  };

  const loadSessionsForMarker = async (
    setupMarker: SetupMarker,
  ): Promise<ReadonlyArray<ProviderSession>> => {
    const marker = String(setupMarker);
    if (marker.length === 0 || marker.length > 128) {
      throw safeFailure("invalid_response");
    }
    const matching = (await loadProviderSessions()).filter(
      (session) => session.name === marker,
    );
    const result: ProviderSession[] = [];
    for (const summary of matching) {
      const detail = await loadDetail(summary.id);
      if (detail.name !== marker) throw safeFailure("invalid_response");
      result.push(detail);
    }
    return result;
  };

  const listSessions = async (
    setupMarker: SetupMarker,
  ): Promise<ReadonlyArray<LifecycleSession>> => {
    const sessions = await loadSessionsForMarker(setupMarker);
    const result: LifecycleSession[] = [];
    for (const session of sessions) {
      result.push(await toLifecycleSession(session));
    }
    return result;
  };

  const hasWebhookConfiguration = (
    session: ProviderSession,
    webhookUrl: string,
  ): boolean =>
    session.logMessages === false &&
    session.ignoreGroups === false &&
    session.readIncomingMessages === false &&
    session.webhookEnabled === true &&
    session.webhookUrl === webhookUrl &&
    session.webhookEvents !== null &&
    session.webhookEvents.length === webhookEvents.length &&
    webhookEvents.every((event) => session.webhookEvents?.includes(event));

  const hasProxyConfiguration = (session: ProviderSession): boolean => {
    if (proxySelector === undefined) return true;
    if (session.proxyUrl === null) return false;
    try {
      const url = new URL(session.proxyUrl);
      return (
        url.protocol === "socks5:" &&
        url.hostname === "p.webshare.io" &&
        url.username.length > 0 &&
        url.password.length > 0 &&
        Number(url.port) >= 9_999 &&
        Number(url.port) <= 19_999 &&
        url.pathname === "" &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  };

  const hasSessionConfiguration = (
    session: ProviderSession,
    webhookUrl: string,
  ): boolean =>
    hasWebhookConfiguration(session, webhookUrl) &&
    hasProxyConfiguration(session);

  const selectProxyUrl = async (
    setupMarker: SetupMarker,
    session?: ProviderSession,
    operation: "lifecycle-write" | "safe-read" = "lifecycle-write",
  ): Promise<string | undefined> => {
    if (proxySelector === undefined) return undefined;
    try {
      const providerSessions = await loadProviderSessions();
      const occupiedProxyUrls: Redacted.Redacted<string>[] = [];
      for (const candidate of providerSessions) {
        if (candidate.id === session?.id) continue;
        const detail = await loadDetail(candidate.id);
        if (detail.proxyUrl !== null) {
          occupiedProxyUrls.push(Redacted.make(detail.proxyUrl));
        }
      }
      const selected = await proxySelector.select({
        ...(session?.proxyUrl === null || session?.proxyUrl === undefined
          ? {}
          : { currentProxyUrl: Redacted.make(session.proxyUrl) }),
        occupiedProxyUrls,
        setupMarker,
      });
      return Redacted.value(selected);
    } catch (cause) {
      if (isProviderFailure(cause)) {
        if (operation === "safe-read") throw cause;
        const transient =
          cause.code === "throttled" ||
          cause.code === "timed_out" ||
          cause.code === "unavailable";
        throw writeFailure(cause.code, transient);
      }
      if (operation === "safe-read") {
        throw safeFailure(
          cause instanceof WebshareProxySelectionError &&
            !cause.retryable &&
            !cause.capacityUnavailable
            ? "integrity_failed"
            : "unavailable",
        );
      }
      if (
        cause instanceof WebshareProxySelectionError &&
        cause.capacityUnavailable
      ) {
        throw writeFailure("source_rejected", false);
      }
      if (cause instanceof WebshareProxySelectionError && !cause.retryable) {
        throw writeFailure("integrity_failed", false);
      }
      throw writeFailure("unavailable", true);
    }
  };

  const withProxyAllocationReservation = async <Value>(
    setupMarker: SetupMarker,
    required: boolean,
    task: () => Promise<Value>,
  ): Promise<Value> => {
    if (!required || proxyAllocationCoordinator === undefined) return task();
    try {
      await proxyAllocationCoordinator.reserve(setupMarker);
    } catch {
      throw writeFailure("unavailable", true);
    }
    try {
      const value = await task();
      try {
        await proxyAllocationCoordinator.release(setupMarker);
      } catch {
        throw writeFailure("unavailable", true);
      }
      return value;
    } catch (cause) {
      if (!isProviderFailure(cause)) {
        throw writeFailure("unavailable", true);
      }
      if (
        cause.operation === "lifecycle-write" &&
        cause.retryDecision === "reconcile_before_repeat"
      ) {
        throw cause;
      }
      try {
        await proxyAllocationCoordinator.release(setupMarker);
      } catch {
        throw writeFailure("unavailable", true);
      }
      throw cause;
    }
  };

  const effect = <Value>(task: () => Promise<Value>) =>
    Effect.tryPromise({
      try: task,
      catch: (cause): ProviderNeutralFailure =>
        isProviderFailure(cause) ? cause : safeFailure("unavailable"),
    });

  const changeSessionState = async (
    session: LifecycleSessionLocator,
    action: "connect" | "disconnect",
  ): Promise<LifecycleSession> => {
    const summary = await resolveProviderSession(session);
    if (!summary) throw writeFailure("invalid_response", false);
    const detail = await loadDetail(summary.id);
    if (action === "connect") {
      const selectedProxyUrl = await selectProxyUrl(
        summary.name as SetupMarker,
        detail,
      );
      if (
        selectedProxyUrl !== undefined &&
        detail.proxyUrl !== selectedProxyUrl
      ) {
        throw writeFailure("integrity_failed", false);
      }
    }
    const body = await writeJson(
      `/api/whatsapp-sessions/${summary.id}/${action}`,
      action === "connect"
        ? { body: { linkMethod: "qr" }, method: "POST" }
        : { method: "POST" },
    );
    return completeLifecycleWrite(async () => {
      const data = parseData(body.value);
      if (!isRecord(data) || typeof data.status !== "string") {
        throw writeFailure("invalid_response", true);
      }
      return toLifecycleSession({ ...detail, status: data.status });
    });
  };

  return {
    connectSession: ({ session }) =>
      effect(() => changeSessionState(session, "connect")),
    disconnectSession: ({ session }) =>
      effect(() => changeSessionState(session, "disconnect")),
    createSession: ({ phoneNumber, setupMarker, webhookEndpoint }) =>
      effect(async () => {
        const number = Redacted.value(phoneNumber);
        const marker = String(setupMarker);
        const webhookUrl = Redacted.value(webhookEndpoint);
        let validWebhookUrl = false;
        try {
          const parsed = new URL(webhookUrl);
          validWebhookUrl =
            parsed.protocol === "https:" &&
            parsed.username === "" &&
            parsed.password === "" &&
            /^\/webhooks\/wasender\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              parsed.pathname,
            ) &&
            parsed.search === "" &&
            parsed.hash === "";
        } catch {
          validWebhookUrl = false;
        }
        if (
          !/^\+[1-9]\d{7,14}$/u.test(number) ||
          marker.length === 0 ||
          marker.length > 128 ||
          !validWebhookUrl
        ) {
          throw writeFailure("invalid_response", false);
        }
        const existing = await loadSessionsForMarker(setupMarker);
        if (existing.length === 1) {
          const adopted = existing[0];
          if (!adopted || !hasSessionConfiguration(adopted, webhookUrl)) {
            throw writeFailure("integrity_failed", false);
          }
          const selectedProxyUrl = await selectProxyUrl(setupMarker, adopted);
          if (
            selectedProxyUrl !== undefined &&
            adopted.proxyUrl !== selectedProxyUrl
          ) {
            throw writeFailure("integrity_failed", false);
          }
          return toLifecycleSession(adopted);
        }
        if (existing.length > 1) {
          throw writeFailure("integrity_failed", false);
        }
        const proxyUrl = await selectProxyUrl(setupMarker);
        return withProxyAllocationReservation(
          setupMarker,
          proxyUrl !== undefined,
          async () => {
            const body = await writeJson("/api/whatsapp-sessions", {
              body: {
                account_protection: true,
                ignore_groups: false,
                log_messages: false,
                name: marker,
                phone_number: number,
                ...(proxyUrl === undefined ? {} : { proxy_url: proxyUrl }),
                read_incoming_messages: false,
                webhook_enabled: true,
                webhook_events: webhookEvents,
                webhook_url: webhookUrl,
              },
              method: "POST",
            });
            return completeLifecycleWrite(async () => {
              const created = parseProviderSession(parseData(body.value), true);
              if (
                !created ||
                created.name !== marker ||
                !hasSessionConfiguration(created, webhookUrl) ||
                (proxyUrl !== undefined && created.proxyUrl !== proxyUrl)
              ) {
                throw writeFailure("invalid_response", true);
              }
              return toLifecycleSession(created);
            });
          },
        );
      }),
    deleteSession: ({ session }) =>
      effect(async (): Promise<SessionDeletionObservation> => {
        const before = await resolveProviderSession(session);
        if (!before) return { state: "absent" };
        await writeJson(`/api/whatsapp-sessions/${before.id}`, {
          method: "DELETE",
        });
        return completeLifecycleWrite(async () => {
          const after = await resolveProviderSession(session);
          return { state: after ? "present" : "absent" };
        });
      }),
    getQrCode: ({ session }) =>
      effect(async (): Promise<QrCodeObservation> => {
        const providerSession = await resolveProviderSession(session);
        if (!providerSession) throw safeFailure("invalid_response");
        const data = parseData(
          (
            await safeJson(
              `/api/whatsapp-sessions/${providerSession.id}/qrcode`,
            )
          ).value,
        );
        if (!isRecord(data)) throw safeFailure("invalid_response");
        if (data.qrCode === null || data.qrCode === undefined) {
          return { state: "not_available" };
        }
        if (typeof data.qrCode !== "string" || data.qrCode.length === 0) {
          throw safeFailure("invalid_response");
        }
        try {
          const image = new TextEncoder().encode(renderQr(data.qrCode));
          if (image.byteLength > maximumJsonResponseBytes) {
            throw safeFailure("response_too_large");
          }
          return { expiresAt: null, image, state: "available" };
        } catch (cause) {
          if (isProviderFailure(cause)) throw cause;
          throw safeFailure("invalid_response");
        }
      }),
    verifySessionNumber: ({ phoneNumber, session }) =>
      effect(async (): Promise<SessionNumberVerification> => {
        const expectedNumber = Redacted.value(phoneNumber);
        const providerSession = await resolveProviderSession(session);
        if (providerSession === null) throw safeFailure("invalid_response");
        const detail = await loadDetail(providerSession.id);
        if (!detail.apiKey) throw safeFailure("invalid_response");
        const user = parseSessionUserInfo(
          (await safeJson("/api/user", detail.apiKey)).value,
        );
        const actualNumber = normalizedPhoneFromUserId(user.id);
        if (actualNumber === null) {
          return { outcome: "unverified" };
        }
        return {
          outcome: actualNumber === expectedNumber ? "match" : "mismatch",
        };
      }),
    listSessions: ({ setupMarker }) => effect(() => listSessions(setupMarker)),
    reconcileSession: ({ requireConnectReady, setupMarker, webhookEndpoint }) =>
      effect(async (): Promise<SessionReconciliation> => {
        const providerSessions = await loadSessionsForMarker(setupMarker);
        if (providerSessions.length === 0) return { outcome: "absent" };
        if (providerSessions.length === 1) {
          const providerSession = providerSessions[0];
          if (!providerSession) throw safeFailure("invalid_response");
          const validateProxy =
            requireConnectReady === true || webhookEndpoint !== undefined;
          const selectedProxyUrl = validateProxy
            ? await selectProxyUrl(setupMarker, providerSession, "safe-read")
            : undefined;
          if (
            (webhookEndpoint !== undefined &&
              !hasSessionConfiguration(
                providerSession,
                Redacted.value(webhookEndpoint),
              )) ||
            (validateProxy &&
              (!hasProxyConfiguration(providerSession) ||
                (selectedProxyUrl !== undefined &&
                  providerSession.proxyUrl !== selectedProxyUrl)))
          ) {
            throw safeFailure("integrity_failed");
          }
          return {
            outcome: "present",
            session: await toLifecycleSession(providerSession),
          };
        }
        const sessions: LifecycleSession[] = [];
        for (const providerSession of providerSessions) {
          sessions.push(await toLifecycleSession(providerSession));
        }
        return {
          outcome: "duplicates",
          sessions: sessions as [
            LifecycleSession,
            LifecycleSession,
            ...LifecycleSession[],
          ],
        };
      }),
    repairSessionConfiguration: ({ setupMarker, webhookEndpoint }) =>
      effect(async () => {
        const webhookUrl = Redacted.value(webhookEndpoint);
        const providerSessions = await loadSessionsForMarker(setupMarker);
        if (providerSessions.length !== 1) {
          throw writeFailure("integrity_failed", false);
        }
        const providerSession = providerSessions[0];
        if (!providerSession) throw writeFailure("integrity_failed", false);
        const proxyUrl = await selectProxyUrl(setupMarker, providerSession);
        return withProxyAllocationReservation(
          setupMarker,
          proxyUrl !== undefined && providerSession.proxyUrl !== proxyUrl,
          async () => {
            await writeJson(`/api/whatsapp-sessions/${providerSession.id}`, {
              body: {
                account_protection: true,
                ignore_groups: false,
                log_messages: false,
                ...(proxyUrl === undefined ? {} : { proxy_url: proxyUrl }),
                read_incoming_messages: false,
                webhook_enabled: true,
                webhook_events: webhookEvents,
                webhook_url: webhookUrl,
              },
              method: "PUT",
            });
            return completeLifecycleWrite(async () => {
              const repaired = await loadDetail(providerSession.id);
              if (
                !hasSessionConfiguration(repaired, webhookUrl) ||
                (proxyUrl !== undefined && repaired.proxyUrl !== proxyUrl)
              ) {
                throw writeFailure("integrity_failed", true);
              }
              return toLifecycleSession(repaired);
            });
          },
        );
      }),
  };
};

export const makeWasenderSessionLifecycleLayer = (
  config: WasenderLifecycleConfig,
  dependencies: WasenderLifecycleDependencies = {},
) =>
  Layer.succeed(
    SessionLifecycle,
    makeWasenderSessionLifecycle(config, dependencies),
  );
