import { Data, Effect, Encoding } from "effect";
import { encodeBase64 } from "./base64-url";

export class MessageSearchPrivacyError extends Data.TaggedError(
  "MessageSearchPrivacyError",
) {}

export const MESSAGE_SEARCH_INDEX_VERSION = "v1" as const;
export const MESSAGE_SEARCH_QUERY_MAX_SCALARS = 256;
export const MESSAGE_SEARCH_QUERY_MAX_TERMS = 8;

const encoder = new TextEncoder();
const connectionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const wordPattern = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu;
const hmacDomain = encoder.encode("normal.message-search.index\0");

export interface ValidatedMessageSearchQuery {
  readonly indexVersion: typeof MESSAGE_SEARCH_INDEX_VERSION;
  readonly terms: ReadonlyArray<string>;
}

const compareUtf8 = (left: string, right: string): number => {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const comparedLength = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < comparedLength; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
};

const hasOnlyUnicodeScalars = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0xd800 || codeUnit > 0xdfff) continue;
    if (
      codeUnit > 0xdbff ||
      index + 1 >= value.length ||
      value.charCodeAt(index + 1) < 0xdc00 ||
      value.charCodeAt(index + 1) > 0xdfff
    ) {
      return false;
    }
    index += 1;
  }
  return true;
};

export const tokenizeMessageSearchText = (
  value: string,
): ReadonlyArray<string> => {
  if (!hasOnlyUnicodeScalars(value)) {
    throw new MessageSearchPrivacyError();
  }
  const normalized = value.normalize("NFKC").toLowerCase().normalize("NFKC");
  return Array.from(new Set(normalized.match(wordPattern) ?? [])).sort(
    compareUtf8,
  );
};

export const validateMessageSearchQuery = (
  query: string,
): ValidatedMessageSearchQuery => {
  if (
    !hasOnlyUnicodeScalars(query) ||
    Array.from(query).length < 1 ||
    Array.from(query).length > MESSAGE_SEARCH_QUERY_MAX_SCALARS
  ) {
    throw new MessageSearchPrivacyError();
  }
  const terms = tokenizeMessageSearchText(query);
  if (terms.length < 1 || terms.length > MESSAGE_SEARCH_QUERY_MAX_TERMS) {
    throw new MessageSearchPrivacyError();
  }
  return { indexVersion: MESSAGE_SEARCH_INDEX_VERSION, terms };
};

const hasCanonicalQueryTerms = (
  query: ValidatedMessageSearchQuery,
): boolean => {
  if (
    query.indexVersion !== MESSAGE_SEARCH_INDEX_VERSION ||
    query.terms.length < 1 ||
    query.terms.length > MESSAGE_SEARCH_QUERY_MAX_TERMS ||
    new Set(query.terms).size !== query.terms.length
  ) {
    return false;
  }
  try {
    const sorted = [...query.terms].sort(compareUtf8);
    return query.terms.every((term, index) => {
      const tokenized = tokenizeMessageSearchText(term);
      return (
        sorted[index] === term &&
        tokenized.length === 1 &&
        tokenized[0] === term
      );
    });
  } catch {
    return false;
  }
};

export const importMessageSearchIndexKey = (
  secret: Uint8Array,
): Effect.Effect<CryptoKey, MessageSearchPrivacyError> =>
  secret.byteLength !== 32
    ? Effect.fail(new MessageSearchPrivacyError())
    : Effect.tryPromise({
        try: () =>
          crypto.subtle.importKey(
            "raw",
            secret,
            { hash: "SHA-256", name: "HMAC" },
            false,
            ["sign"],
          ),
        catch: () => new MessageSearchPrivacyError(),
      });

const appendLengthPrefixed = (
  target: Uint8Array,
  offset: number,
  value: Uint8Array,
): number => {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(
    offset,
    value.byteLength,
    false,
  );
  target.set(value, offset + 4);
  return offset + 4 + value.byteLength;
};

const indexFrame = (connectionId: string, term: string): Uint8Array => {
  const connection = encoder.encode(connectionId);
  const normalizedTerm = encoder.encode(term);
  const frame = new Uint8Array(
    hmacDomain.byteLength +
      1 +
      4 +
      connection.byteLength +
      4 +
      normalizedTerm.byteLength,
  );
  frame.set(hmacDomain);
  let offset = hmacDomain.byteLength;
  frame[offset] = 1;
  offset = appendLengthPrefixed(frame, offset + 1, connection);
  appendLengthPrefixed(frame, offset, normalizedTerm);
  return frame;
};

export const messageSearchIndexesForTerms = (
  key: CryptoKey,
  connectionId: string,
  terms: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, MessageSearchPrivacyError> => {
  if (!connectionIdPattern.test(connectionId)) {
    return Effect.fail(new MessageSearchPrivacyError());
  }
  let canonicalTerms: ReadonlyArray<string>;
  try {
    canonicalTerms = Array.from(new Set(terms)).sort(compareUtf8);
    if (
      canonicalTerms.some((term) => {
        const tokenized = tokenizeMessageSearchText(term);
        return tokenized.length !== 1 || tokenized[0] !== term;
      })
    ) {
      return Effect.fail(new MessageSearchPrivacyError());
    }
  } catch {
    return Effect.fail(new MessageSearchPrivacyError());
  }
  return Effect.tryPromise({
    try: () =>
      Promise.all(
        canonicalTerms.map(async (term) => {
          const signature = await crypto.subtle.sign(
            "HMAC",
            key,
            indexFrame(connectionId, term),
          );
          return `msi1_${Encoding.encodeBase64Url(new Uint8Array(signature))}`;
        }),
      ),
    catch: () => new MessageSearchPrivacyError(),
  });
};

export const messageSearchIndexesForText = (
  key: CryptoKey,
  connectionId: string,
  plaintext: string,
): Effect.Effect<ReadonlyArray<string>, MessageSearchPrivacyError> => {
  try {
    return messageSearchIndexesForTerms(
      key,
      connectionId,
      tokenizeMessageSearchText(plaintext),
    );
  } catch {
    return Effect.fail(new MessageSearchPrivacyError());
  }
};

export const messageSearchIndexesForQuery = (
  key: CryptoKey,
  connectionId: string,
  query: ValidatedMessageSearchQuery,
): Effect.Effect<ReadonlyArray<string>, MessageSearchPrivacyError> =>
  hasCanonicalQueryTerms(query)
    ? messageSearchIndexesForTerms(key, connectionId, query.terms)
    : Effect.fail(new MessageSearchPrivacyError());

export const messageSearchQueryDigest = (
  key: CryptoKey,
  terms: ReadonlyArray<string>,
): Effect.Effect<string, MessageSearchPrivacyError> =>
  Effect.tryPromise({
    try: async () => {
      const document = encoder.encode(
        `normal.message-search.cursor\0v1\0${JSON.stringify(terms)}`,
      );
      return encodeBase64(
        new Uint8Array(await crypto.subtle.sign("HMAC", key, document)),
      );
    },
    catch: () => new MessageSearchPrivacyError(),
  });

export const verifyMessageSearchCandidate = (
  plaintext: string,
  query: ValidatedMessageSearchQuery,
): boolean => {
  try {
    if (!hasCanonicalQueryTerms(query)) return false;
    const plaintextTerms = new Set(tokenizeMessageSearchText(plaintext));
    return query.terms.every((term) => plaintextTerms.has(term));
  } catch {
    return false;
  }
};
