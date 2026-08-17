import { Data, Effect, Either, Encoding, Schema } from "effect";
import { ConnectionId } from "./handles";

const CursorNumber = Schema.Number.pipe(Schema.finite());

const CursorScalar = Schema.Union(
  Schema.String,
  CursorNumber,
  Schema.Boolean,
  Schema.Null,
);

const CursorFilterValue = Schema.Union(
  CursorScalar,
  Schema.Array(CursorScalar),
);

const CursorContextSchema = Schema.Struct({
  authorizationId: Schema.String.pipe(Schema.minLength(1)),
  tool: Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9_]*$/)),
  connectionId: ConnectionId,
  filters: Schema.Record({
    key: Schema.String,
    value: CursorFilterValue,
  }),
  pageSize: Schema.Number.pipe(Schema.int(), Schema.between(1, 50)),
  sortVersion: Schema.String.pipe(Schema.minLength(1)),
});

export type CursorContext = typeof CursorContextSchema.Type;

const RestCursorContextSchema = Schema.Struct({
  grantId: Schema.String.pipe(Schema.minLength(1)),
  operationId: Schema.String.pipe(Schema.pattern(/^[a-z][A-Za-z0-9]*$/)),
  connectionId: ConnectionId,
  filters: Schema.Record({
    key: Schema.String,
    value: CursorFilterValue,
  }),
  pageSize: Schema.Number.pipe(Schema.int(), Schema.between(1, 50)),
  sortVersion: Schema.String.pipe(Schema.minLength(1)),
});

export type RestCursorContext = typeof RestCursorContextSchema.Type;

const CursorPayloadSchema = Schema.Struct({
  version: Schema.Literal(1),
  boundary: Schema.Array(CursorScalar).pipe(Schema.minItems(1)),
  expiresAtEpochSeconds: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});
type CursorPayload = typeof CursorPayloadSchema.Type;

const CursorClaimsSchema = Schema.Struct({
  context: CursorContextSchema,
  boundary: Schema.Array(CursorScalar).pipe(Schema.minItems(1)),
  expiresAtEpochSeconds: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});

export type CursorClaims = typeof CursorClaimsSchema.Type;
export type CursorBoundary = CursorClaims["boundary"];

export class CursorSigningError extends Data.TaggedError("CursorSigningError")<{
  readonly cause: unknown;
}> {}

export class InvalidCursorError extends Data.TaggedError(
  "InvalidCursorError",
) {}

const textEncoder = new TextEncoder();
const maxCursorLength = 4_096;

const decodeClaims = Schema.decodeUnknownSync(CursorClaimsSchema, {
  onExcessProperty: "error",
});
const decodeContext = Schema.decodeUnknownSync(CursorContextSchema, {
  onExcessProperty: "error",
});
const decodeRestContext = Schema.decodeUnknownSync(RestCursorContextSchema, {
  onExcessProperty: "error",
});
const decodePayload = Schema.decodeUnknownSync(CursorPayloadSchema, {
  onExcessProperty: "error",
});
const decodeRestClaims = Schema.decodeUnknownSync(
  Schema.Struct({
    context: RestCursorContextSchema,
    boundary: Schema.Array(CursorScalar).pipe(Schema.minItems(1)),
    expiresAtEpochSeconds: Schema.Number.pipe(
      Schema.int(),
      Schema.nonNegative(),
    ),
  }),
  { onExcessProperty: "error" },
);

const canonicalFilters = (
  filters: CursorContext["filters"],
): CursorContext["filters"] =>
  Object.fromEntries(
    Object.entries(filters).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );

const serializePayload = (payload: CursorPayload): string =>
  JSON.stringify({
    version: payload.version,
    boundary: payload.boundary,
    expiresAtEpochSeconds: payload.expiresAtEpochSeconds,
  });

const serializeSigningDocument = (
  context: CursorContext,
  payload: CursorPayload,
): string =>
  JSON.stringify({
    version: payload.version,
    authorizationId: context.authorizationId,
    tool: context.tool,
    connectionId: context.connectionId,
    filters: canonicalFilters(context.filters),
    pageSize: context.pageSize,
    sortVersion: context.sortVersion,
    boundary: payload.boundary,
    expiresAtEpochSeconds: payload.expiresAtEpochSeconds,
  });

const serializeRestSigningDocument = (
  context: RestCursorContext,
  payload: CursorPayload,
): string =>
  JSON.stringify({
    version: payload.version,
    channel: "rest",
    grantId: context.grantId,
    operationId: context.operationId,
    connectionId: context.connectionId,
    filters: canonicalFilters(context.filters),
    pageSize: context.pageSize,
    sortVersion: context.sortVersion,
    boundary: payload.boundary,
    expiresAtEpochSeconds: payload.expiresAtEpochSeconds,
  });

export const importCursorSigningKey = (
  secret: Uint8Array,
): Effect.Effect<CryptoKey, CursorSigningError> => {
  if (secret.byteLength < 32) {
    return Effect.fail(
      new CursorSigningError({
        cause: new Error("Cursor signing keys must contain at least 32 bytes"),
      }),
    );
  }

  return Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        "raw",
        secret,
        {
          name: "HMAC",
          hash: "SHA-256",
        },
        false,
        ["sign", "verify"],
      ),
    catch: (cause) => new CursorSigningError({ cause }),
  });
};

export const signCursor = (
  key: CryptoKey,
  input: unknown,
): Effect.Effect<string, CursorSigningError> =>
  Effect.try({
    try: () => decodeClaims(input),
    catch: (cause) => new CursorSigningError({ cause }),
  }).pipe(
    Effect.flatMap((claims) => {
      const payload: CursorPayload = {
        version: 1,
        boundary: claims.boundary,
        expiresAtEpochSeconds: claims.expiresAtEpochSeconds,
      };
      const serializedPayload = serializePayload(payload);

      return Effect.tryPromise({
        try: () =>
          crypto.subtle.sign(
            "HMAC",
            key,
            textEncoder.encode(
              serializeSigningDocument(claims.context, payload),
            ),
          ),
        catch: (cause) => new CursorSigningError({ cause }),
      }).pipe(
        Effect.map(
          (signature) =>
            `${Encoding.encodeBase64Url(serializedPayload)}.${Encoding.encodeBase64Url(
              new Uint8Array(signature),
            )}`,
        ),
      );
    }),
  );

const parseCursor = (
  cursor: string,
): {
  readonly payload: CursorPayload;
  readonly signature: Uint8Array;
} => {
  if (cursor.length > maxCursorLength) {
    throw new InvalidCursorError();
  }

  const parts = cursor.split(".");
  if (parts.length !== 2) {
    throw new InvalidCursorError();
  }

  const [encodedPayload, encodedSignature] = parts;
  if (!encodedPayload || !encodedSignature) {
    throw new InvalidCursorError();
  }

  const serializedPayload = Either.getOrThrow(
    Encoding.decodeBase64UrlString(encodedPayload),
  );
  const payload = decodePayload(JSON.parse(serializedPayload));
  const signature = Either.getOrThrow(
    Encoding.decodeBase64Url(encodedSignature),
  );

  if (
    Encoding.encodeBase64Url(serializePayload(payload)) !== encodedPayload ||
    Encoding.encodeBase64Url(signature) !== encodedSignature
  ) {
    throw new InvalidCursorError();
  }

  return {
    payload,
    signature,
  };
};

export const verifyCursor = (
  key: CryptoKey,
  cursor: string,
  contextInput: unknown,
  nowEpochSeconds: number,
): Effect.Effect<CursorBoundary, InvalidCursorError> =>
  Effect.try({
    try: () => {
      const context = decodeContext(contextInput);
      const parsed = parseCursor(cursor);

      return {
        context,
        ...parsed,
      };
    },
    catch: () => new InvalidCursorError(),
  }).pipe(
    Effect.flatMap(({ context, payload, signature }) =>
      Effect.tryPromise({
        try: () =>
          crypto.subtle.verify(
            "HMAC",
            key,
            signature,
            textEncoder.encode(serializeSigningDocument(context, payload)),
          ),
        catch: () => new InvalidCursorError(),
      }).pipe(
        Effect.filterOrFail(
          (valid) =>
            valid &&
            Number.isInteger(nowEpochSeconds) &&
            nowEpochSeconds >= 0 &&
            nowEpochSeconds < payload.expiresAtEpochSeconds,
          () => new InvalidCursorError(),
        ),
        Effect.map(() => payload.boundary),
      ),
    ),
  );

export const signRestCursor = (
  key: CryptoKey,
  input: unknown,
): Effect.Effect<string, CursorSigningError> =>
  Effect.try({
    try: () => decodeRestClaims(input),
    catch: (cause) => new CursorSigningError({ cause }),
  }).pipe(
    Effect.flatMap((claims) => {
      const payload: CursorPayload = {
        version: 1,
        boundary: claims.boundary,
        expiresAtEpochSeconds: claims.expiresAtEpochSeconds,
      };
      const serializedPayload = serializePayload(payload);

      return Effect.tryPromise({
        try: () =>
          crypto.subtle.sign(
            "HMAC",
            key,
            textEncoder.encode(
              serializeRestSigningDocument(claims.context, payload),
            ),
          ),
        catch: (cause) => new CursorSigningError({ cause }),
      }).pipe(
        Effect.map(
          (signature) =>
            `${Encoding.encodeBase64Url(serializedPayload)}.${Encoding.encodeBase64Url(
              new Uint8Array(signature),
            )}`,
        ),
      );
    }),
  );

export const verifyRestCursor = (
  key: CryptoKey,
  cursor: string,
  contextInput: unknown,
  nowEpochSeconds: number,
): Effect.Effect<CursorBoundary, InvalidCursorError> =>
  Effect.try({
    try: () => {
      const context = decodeRestContext(contextInput);
      const parsed = parseCursor(cursor);

      return {
        context,
        ...parsed,
      };
    },
    catch: () => new InvalidCursorError(),
  }).pipe(
    Effect.flatMap(({ context, payload, signature }) =>
      Effect.tryPromise({
        try: () =>
          crypto.subtle.verify(
            "HMAC",
            key,
            signature,
            textEncoder.encode(serializeRestSigningDocument(context, payload)),
          ),
        catch: () => new InvalidCursorError(),
      }).pipe(
        Effect.filterOrFail(
          (valid) =>
            valid &&
            Number.isInteger(nowEpochSeconds) &&
            nowEpochSeconds >= 0 &&
            nowEpochSeconds < payload.expiresAtEpochSeconds,
          () => new InvalidCursorError(),
        ),
        Effect.map(() => payload.boundary),
      ),
    ),
  );
