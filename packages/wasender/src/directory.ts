import { Effect, Redacted } from "effect";
import { encodeBase64Url } from "./base64-url";
import { makeBoundedRetryAfterMs, maximumJsonResponseBytes } from "./common";
import { providerOrigin } from "./provider-origin";
import {
  deriveIdentityRecipientRouteKeys,
  type RecipientRouteKeys,
  sealIdentityRecipientRoute,
} from "./recipient-route";
import type {
  ContactLocator,
  DirectoryContact,
  DirectoryGroup,
  DirectoryObservation,
  DirectorySessionAuthority,
  GroupLocator,
  ProviderNeutralFailure,
  SessionDirectory,
  WasenderIdentityProtectionKey,
} from "./session";

const directoryPageLimit = 100;
const textEncoder = new TextEncoder();

type DirectoryKind = "contacts" | "groups";

type RawDirectoryEntry = {
  readonly jid: string;
  readonly name: string | null;
  readonly notify: string | null;
  readonly verifiedName: string | null;
};

interface ParsedDirectoryPage {
  readonly entries: ReadonlyArray<RawDirectoryEntry>;
  readonly limit: number;
  readonly page: number;
  readonly total: number;
  readonly totalPages: number;
}

interface ResponseBytes {
  readonly bytes: Uint8Array;
  readonly length: number;
}

interface AttemptSuccess extends ResponseBytes {
  readonly outcome: "success";
}

interface AttemptFailure {
  readonly failure: ProviderNeutralFailure;
  readonly outcome: "failure";
}

type AttemptResult = AttemptFailure | AttemptSuccess;

export interface WasenderDirectoryTelemetryEvent {
  readonly attempts: number;
  readonly durationMs: number;
  readonly operation: "safe-read";
  readonly outcome: "complete" | "failed" | "partial";
  readonly responseBytes: number;
}

export interface WasenderSessionDirectoryConfig {
  /** One WhatsApp Connection's session-specific Wasender API key. */
  readonly authority: DirectorySessionAuthority;
  /** The same per-connection identity key used by webhook normalization. */
  readonly identityKey: WasenderIdentityProtectionKey;
  /** Receives only the allowlisted, content-free adapter event above. */
  readonly emitTelemetry?:
    | ((event: WasenderDirectoryTelemetryEvent) => void)
    | undefined;
}

const safeReadFailure = (
  code: ProviderNeutralFailure["code"],
  retryDecision: "do_not_retry" | "retry_within_safe_read_budget",
  retryAfterMs: number | null = null,
): ProviderNeutralFailure => ({
  _tag: "ProviderNeutralFailure",
  code,
  operation: "safe-read",
  retryAfterMs:
    retryAfterMs === null ? null : makeBoundedRetryAfterMs(retryAfterMs),
  retryDecision,
});

const isProviderNeutralFailure = (
  value: unknown,
): value is ProviderNeutralFailure =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "ProviderNeutralFailure";

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const parseRetryAfter = (value: string | null): number | null => {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isSafeInteger(seconds)) {
      return seconds >= 5 ? 5_000 : seconds * 1_000;
    }
  }
  const at = Date.parse(trimmed);
  if (Number.isFinite(at)) {
    return Number(makeBoundedRetryAfterMs(Math.max(0, at - Date.now())));
  }
  return null;
};

const responseFailure = (response: Response): ProviderNeutralFailure => {
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  if (response.status === 401 || response.status === 403) {
    return safeReadFailure("authentication_failed", "do_not_retry");
  }
  if (response.status === 408) {
    return safeReadFailure(
      "timed_out",
      "retry_within_safe_read_budget",
      retryAfterMs,
    );
  }
  if (response.status === 429) {
    return safeReadFailure(
      "throttled",
      "retry_within_safe_read_budget",
      retryAfterMs,
    );
  }
  if (response.status >= 500 && response.status <= 599) {
    return safeReadFailure(
      "unavailable",
      "retry_within_safe_read_budget",
      retryAfterMs,
    );
  }
  if (response.status === 413) {
    return safeReadFailure("response_too_large", "do_not_retry");
  }
  return safeReadFailure("source_rejected", "do_not_retry");
};

const cancelBody = async (body: ReadableStream<Uint8Array> | null) => {
  try {
    await body?.cancel();
  } catch {
    // The classified response outcome remains authoritative if cleanup fails.
  }
};

const readBoundedBody = async (response: Response): Promise<ResponseBytes> => {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      Number.isFinite(parsedLength) &&
      parsedLength > maximumJsonResponseBytes
    ) {
      await cancelBody(response.body);
      throw safeReadFailure("response_too_large", "do_not_retry");
    }
  }

  if (response.body === null) {
    return { bytes: new Uint8Array(), length: 0 };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      length += result.value.byteLength;
      if (length > maximumJsonResponseBytes) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the bounded-size classification if stream cleanup fails.
        }
        throw safeReadFailure("response_too_large", "do_not_retry");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, length };
};

const attemptRequest = async (
  kind: DirectoryKind,
  page: number,
  credential: string,
  timeoutMs: number,
): Promise<AttemptResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(`/api/${kind}`, providerOrigin);
    url.searchParams.set("paginated", "true");
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(directoryPageLimit));
    let response: Response;
    try {
      response = await globalThis.fetch(url, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential}`,
        },
        method: "GET",
        signal: controller.signal,
      });
    } catch {
      return {
        failure: safeReadFailure(
          controller.signal.aborted ? "timed_out" : "unavailable",
          "retry_within_safe_read_budget",
        ),
        outcome: "failure",
      };
    }

    if (!response.ok) {
      const failure = responseFailure(response);
      await cancelBody(response.body);
      return { failure, outcome: "failure" };
    }
    const body = await readBoundedBody(response);
    return { ...body, outcome: "success" };
  } catch (cause) {
    return {
      failure: isProviderNeutralFailure(cause)
        ? cause
        : safeReadFailure(
            controller.signal.aborted ? "timed_out" : "unavailable",
            "retry_within_safe_read_budget",
          ),
      outcome: "failure",
    };
  } finally {
    clearTimeout(timeout);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalidStringField = Symbol("invalidStringField");
const unsupportedDirectoryEntry = Symbol("unsupportedDirectoryEntry");

const optionalNullableString = (
  record: Record<string, unknown>,
  key: string,
): string | null | typeof invalidStringField => {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === "string" ? value : invalidStringField;
};

const parseEntry = (
  value: unknown,
  kind: DirectoryKind,
): RawDirectoryEntry | null | typeof unsupportedDirectoryEntry => {
  if (!isRecord(value)) {
    return null;
  }
  const jidField = value.jid;
  const idField = value.id;
  if (
    (jidField !== undefined && typeof jidField !== "string") ||
    (idField !== undefined && typeof idField !== "string") ||
    (typeof jidField === "string" &&
      typeof idField === "string" &&
      jidField !== idField)
  ) {
    return null;
  }
  const jid = typeof jidField === "string" ? jidField : idField;
  if (typeof jid !== "string" || jid.length < 1 || jid.length > 512) {
    return null;
  }
  const validIdentifier =
    kind === "groups"
      ? /^[1-9]\d{1,31}(?:-[1-9]\d{1,31})?@g\.us$/u.test(jid)
      : /^(?:[1-9]\d{1,14}|[1-9]\d{1,31}(?::\d{1,5})?@(?:s\.whatsapp\.net|lid))$/u.test(
          jid,
        );
  if (!validIdentifier) {
    return /^[^\s@]{1,128}@[^\s@]{1,128}$/u.test(jid)
      ? unsupportedDirectoryEntry
      : null;
  }

  const name = optionalNullableString(value, "name");
  const notify = optionalNullableString(value, "notify");
  const verifiedName = optionalNullableString(value, "verifiedName");
  if (
    name === invalidStringField ||
    notify === invalidStringField ||
    verifiedName === invalidStringField
  ) {
    return null;
  }
  if (
    (name?.length ?? 0) > 4_096 ||
    (notify?.length ?? 0) > 4_096 ||
    (verifiedName?.length ?? 0) > 4_096
  ) {
    return null;
  }
  return {
    jid,
    name: name ?? null,
    notify: notify ?? null,
    verifiedName: verifiedName ?? null,
  };
};

const parsePositiveInteger = (value: unknown): number | null =>
  Number.isSafeInteger(value) && Number(value) >= 1 ? Number(value) : null;

const parseDirectoryPage = (
  bytes: Uint8Array,
  kind: DirectoryKind,
  expectedPage: number,
): ParsedDirectoryPage => {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw safeReadFailure("invalid_response", "do_not_retry");
  }
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) {
    throw safeReadFailure("invalid_response", "do_not_retry");
  }
  const { items, pagination } = value.data;
  if (!Array.isArray(items) || !isRecord(pagination)) {
    throw safeReadFailure("invalid_response", "do_not_retry");
  }
  const page = parsePositiveInteger(pagination.page);
  const limit = parsePositiveInteger(pagination.limit);
  const totalPages = parsePositiveInteger(pagination.totalPages);
  const total = pagination.total;
  const totalCount = Number(total);
  if (
    page !== expectedPage ||
    limit === null ||
    totalPages === null ||
    page > totalPages ||
    !Number.isSafeInteger(total) ||
    totalCount < 0 ||
    totalCount < items.length ||
    items.length > limit ||
    totalPages !== Math.max(1, Math.ceil(totalCount / limit))
  ) {
    throw safeReadFailure("invalid_response", "do_not_retry");
  }
  const parsedEntries = items.map((item) => parseEntry(item, kind));
  const entries = parsedEntries.filter(
    (entry): entry is RawDirectoryEntry =>
      entry !== null && entry !== unsupportedDirectoryEntry,
  );
  if (items.length > 0 && entries.length === 0) {
    throw safeReadFailure("invalid_response", "do_not_retry");
  }
  return {
    entries: entries as ReadonlyArray<RawDirectoryEntry>,
    limit,
    page,
    total: totalCount,
    totalPages,
  };
};

const displayName = (entry: RawDirectoryEntry): string | null => {
  for (const candidate of [entry.name, entry.notify, entry.verifiedName]) {
    if (candidate !== null && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
};

const contactPhoneNumber = (jid: string): string | null => {
  const separator = jid.indexOf("@");
  const local = separator === -1 ? jid : jid.slice(0, separator);
  const domain = separator === -1 ? null : jid.slice(separator + 1);
  if (domain !== null && domain !== "s.whatsapp.net") {
    return null;
  }
  const phone = local.split(":", 1)[0];
  return phone !== undefined && /^[1-9]\d{6,14}$/.test(phone)
    ? `+${phone}`
    : null;
};

interface LocatorKeys extends RecipientRouteKeys {
  readonly identity: CryptoKey;
}

const deriveLocatorKeys = async (
  identityKey: WasenderIdentityProtectionKey,
): Promise<LocatorKeys> => {
  const identityBytes = Redacted.value(identityKey);
  if (identityBytes.byteLength < 32) {
    throw new TypeError("Invalid Directory identity key configuration");
  }
  const identity = await crypto.subtle.importKey(
    "raw",
    identityBytes,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const routeKeys = await deriveIdentityRecipientRouteKeys(identity);
  return {
    ...routeKeys,
    identity,
  };
};

const equalityLocator = async (
  key: CryptoKey,
  kind: "contact" | "group",
  providerIdentifier: string,
): Promise<string> => {
  const value =
    kind === "contact"
      ? (() => {
          const phone = contactPhoneNumber(providerIdentifier);
          return phone === null ? providerIdentifier : `pn:${phone.slice(1)}`;
        })()
      : providerIdentifier;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      textEncoder.encode(`${kind}-recipient\0${JSON.stringify(value)}`),
    ),
  );
  return `wi1_${encodeBase64Url(signature)}`;
};

const outputBytes = (value: unknown): number =>
  textEncoder.encode(JSON.stringify(value)).byteLength;

const emitTelemetry = (
  emit: WasenderSessionDirectoryConfig["emitTelemetry"],
  event: WasenderDirectoryTelemetryEvent,
): void => {
  try {
    emit?.(event);
  } catch {
    // Metrics are deliberately best-effort and never alter a Directory read.
  }
};

const readDirectory = async (
  kind: DirectoryKind,
  credential: string,
  locatorKeys: Promise<LocatorKeys>,
  emit: WasenderSessionDirectoryConfig["emitTelemetry"],
): Promise<DirectoryObservation<DirectoryContact | DirectoryGroup>> => {
  const startedAt = performance.now();
  let attempts = 0;
  let responseBytes = 0;
  let page = 1;
  let validatedPages = 0;
  let observedAt: string | null = null;
  const entries: Array<DirectoryContact | DirectoryGroup> = [];
  const providerIdentifiers = new Set<string>();
  let paginationEvidence: {
    readonly limit: number;
    readonly total: number;
    readonly totalPages: number;
  } | null = null;

  const finish = (
    outcome: "complete" | "partial",
  ): DirectoryObservation<DirectoryContact | DirectoryGroup> => {
    const observation = {
      completeness: outcome === "complete" ? "complete" : "partial",
      entries,
      observedAt: observedAt ?? new Date().toISOString(),
      stale: outcome === "partial",
    } as const;
    emitTelemetry(emit, {
      attempts,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      operation: "safe-read",
      outcome,
      responseBytes,
    });
    return observation;
  };

  try {
    while (attempts < 3) {
      const elapsed = performance.now() - startedAt;
      const remaining = 25_000 - elapsed;
      if (remaining <= 0) {
        if (validatedPages > 0) {
          return finish("partial");
        }
        throw safeReadFailure("timed_out", "retry_within_safe_read_budget");
      }

      attempts += 1;
      const result = await attemptRequest(
        kind,
        page,
        credential,
        Math.max(1, Math.min(10_000, Math.floor(remaining))),
      );
      if (result.outcome === "failure") {
        const canRetry =
          result.failure.retryDecision === "retry_within_safe_read_budget" &&
          attempts < 3;
        if (canRetry) {
          const jitterMs = Math.floor(
            Math.random() * 250 * 2 ** (attempts - 1),
          );
          const retryAfterMs = Number(result.failure.retryAfterMs ?? 0);
          const waitMs = Math.max(jitterMs, retryAfterMs);
          if (performance.now() - startedAt + waitMs < 25_000) {
            await delay(waitMs);
            continue;
          }
        }
        if (
          validatedPages > 0 &&
          result.failure.code !== "authentication_failed" &&
          result.failure.code !== "integrity_failed"
        ) {
          return finish("partial");
        }
        throw result.failure;
      }

      if (responseBytes + result.length > maximumJsonResponseBytes) {
        if (validatedPages > 0) {
          return finish("partial");
        }
        throw safeReadFailure("response_too_large", "do_not_retry");
      }
      responseBytes += result.length;

      let parsed: ParsedDirectoryPage;
      try {
        parsed = parseDirectoryPage(result.bytes, kind, page);
      } catch (cause) {
        if (validatedPages > 0) {
          return finish("partial");
        }
        throw cause;
      }
      const hasDuplicateIdentifier = parsed.entries.some((entry) =>
        providerIdentifiers.has(entry.jid),
      );
      const identifiersInPage = new Set(
        parsed.entries.map((entry) => entry.jid),
      );
      const hasDuplicateWithinPage =
        identifiersInPage.size !== parsed.entries.length;
      if (paginationEvidence === null) {
        paginationEvidence = {
          limit: parsed.limit,
          total: parsed.total,
          totalPages: parsed.totalPages,
        };
      } else if (
        paginationEvidence.limit !== parsed.limit ||
        paginationEvidence.total !== parsed.total ||
        paginationEvidence.totalPages !== parsed.totalPages
      ) {
        return finish("partial");
      }
      if (hasDuplicateIdentifier || hasDuplicateWithinPage) {
        if (validatedPages === 0) {
          throw safeReadFailure("invalid_response", "do_not_retry");
        }
        return finish("partial");
      }
      for (const identifier of identifiersInPage) {
        providerIdentifiers.add(identifier);
      }
      validatedPages += 1;
      observedAt = new Date().toISOString();
      const keys = await locatorKeys;
      for (const entry of parsed.entries) {
        const normalized =
          kind === "contacts"
            ? ({
                active: true,
                displayName: displayName(entry),
                identity: (await equalityLocator(
                  keys.identity,
                  "contact",
                  entry.jid,
                )) as ContactLocator,
                phoneNumber: contactPhoneNumber(entry.jid),
                recipient: (await sealIdentityRecipientRoute(
                  keys,
                  "contact",
                  entry.jid,
                )) as ContactLocator,
              } satisfies DirectoryContact)
            : ({
                displayName: displayName(entry),
                identity: (await equalityLocator(
                  keys.identity,
                  "group",
                  entry.jid,
                )) as GroupLocator,
                joined: true,
                recipient: (await sealIdentityRecipientRoute(
                  keys,
                  "group",
                  entry.jid,
                )) as GroupLocator,
              } satisfies DirectoryGroup);
        const candidate = [...entries, normalized];
        if (
          outputBytes({
            completeness: "partial",
            entries: candidate,
            observedAt,
            stale: true,
          }) > maximumJsonResponseBytes
        ) {
          if (validatedPages > 0) {
            return finish("partial");
          }
          throw safeReadFailure("response_too_large", "do_not_retry");
        }
        entries.push(normalized);
      }

      if (parsed.page >= parsed.totalPages) {
        const completeObservationBytes = outputBytes({
          completeness: "complete",
          entries,
          observedAt,
          stale: false,
        });
        if (completeObservationBytes > maximumJsonResponseBytes) {
          return finish("partial");
        }
        return entries.length === parsed.total
          ? finish("complete")
          : finish("partial");
      }
      page += 1;
    }

    if (validatedPages > 0) {
      return finish("partial");
    }
    throw safeReadFailure("unavailable", "retry_within_safe_read_budget");
  } catch (cause) {
    emitTelemetry(emit, {
      attempts,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      operation: "safe-read",
      outcome: "failed",
      responseBytes,
    });
    throw isProviderNeutralFailure(cause)
      ? cause
      : safeReadFailure("invalid_response", "do_not_retry");
  }
};

const validateCredential = (authority: DirectorySessionAuthority): string => {
  const credential = Redacted.value(authority);
  const hasInvalidHeaderCharacter = Array.from(credential).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 33 || codePoint > 126;
  });
  if (
    credential.trim().length === 0 ||
    credential.trim() !== credential ||
    credential.length > 4_096 ||
    hasInvalidHeaderCharacter
  ) {
    throw new TypeError("Invalid per-session authority configuration");
  }
  return credential;
};

/**
 * Builds the sole production Wasender implementation of SessionDirectory.
 * The fixed provider origin and global Fetch implementation are not runtime
 * selectable, while tests can intercept Fetch at the protocol boundary.
 */
export const makeWasenderSessionDirectory = (
  config: WasenderSessionDirectoryConfig,
): SessionDirectory => {
  const credential = validateCredential(config.authority);
  const locatorKeys = deriveLocatorKeys(config.identityKey);
  return {
    readContacts: () =>
      Effect.tryPromise({
        try: () =>
          readDirectory(
            "contacts",
            credential,
            locatorKeys,
            config.emitTelemetry,
          ) as Promise<DirectoryObservation<DirectoryContact>>,
        catch: (cause) =>
          isProviderNeutralFailure(cause)
            ? cause
            : safeReadFailure("invalid_response", "do_not_retry"),
      }),
    readGroups: () =>
      Effect.tryPromise({
        try: () =>
          readDirectory(
            "groups",
            credential,
            locatorKeys,
            config.emitTelemetry,
          ) as Promise<DirectoryObservation<DirectoryGroup>>,
        catch: (cause) =>
          isProviderNeutralFailure(cause)
            ? cause
            : safeReadFailure("invalid_response", "do_not_retry"),
      }),
  };
};
