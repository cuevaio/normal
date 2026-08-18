import { Schema } from "effect";
import { ApiKeyId, ConnectionId } from "./handles";
import { makePublicObjectContract, UtcTimestamp } from "./mcp-schema";

const nanoIdSecretPattern = "[A-Za-z0-9_-]{43}(?![\\s\\S])";

export const API_KEY_PERMISSIONS = [
  "connections:read",
  "directory:read",
  "messages:read",
  "messages:send",
] as const;

export type ApiKeyPermission = (typeof API_KEY_PERMISSIONS)[number];

export const ApiKeyPermission = Schema.Literal(...API_KEY_PERMISSIONS);

export const ApiKeyCredential = Schema.String.pipe(
  Schema.pattern(
    new RegExp(`^normal_apk_[A-Za-z0-9_-]{21}\\.${nanoIdSecretPattern}$`),
  ),
  Schema.brand("ApiKeyCredential"),
);
export type ApiKeyCredential = typeof ApiKeyCredential.Type;

export const ApiKeyName = Schema.transform(
  Schema.String,
  Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  {
    decode: (value) => value.trim(),
    encode: (value) => value,
    strict: true,
  },
);

export const CreateApiKeyRequest = Schema.Struct({
  connection_ids: Schema.Array(ConnectionId).pipe(
    Schema.minItems(1),
    Schema.maxItems(50),
  ),
  expires_at: Schema.optional(Schema.NullOr(UtcTimestamp)),
  name: ApiKeyName,
  permissions: Schema.Array(ApiKeyPermission).pipe(
    Schema.minItems(1),
    Schema.maxItems(API_KEY_PERMISSIONS.length),
  ),
});
export type CreateApiKeyRequest = typeof CreateApiKeyRequest.Type;

export const ApiKeySummary = Schema.Struct({
  connection_ids: Schema.Array(ConnectionId),
  created_at: UtcTimestamp,
  credential_hint: Schema.String,
  expires_at: Schema.NullOr(UtcTimestamp),
  id: ApiKeyId,
  last_used_at: Schema.NullOr(UtcTimestamp),
  name: ApiKeyName,
  permissions: Schema.Array(ApiKeyPermission),
  revoked_at: Schema.NullOr(UtcTimestamp),
  state: Schema.Literal("active", "expired", "revoked"),
});
export type ApiKeySummary = typeof ApiKeySummary.Type;

export const CreatedApiKey = Schema.Struct({
  ...ApiKeySummary.fields,
  credential: ApiKeyCredential,
});
export type CreatedApiKey = typeof CreatedApiKey.Type;

export const CreateApiKeyRequestContract = makePublicObjectContract(
  CreateApiKeyRequest.fields,
);
export type CreateApiKeyRequestBody =
  typeof CreateApiKeyRequestContract.schema.Type;

export const ApiKeySummaryContract = makePublicObjectContract(
  ApiKeySummary.fields,
);
export type ApiKeySummaryRecord = typeof ApiKeySummaryContract.schema.Type;

export const CreatedApiKeyContract = makePublicObjectContract(
  CreatedApiKey.fields,
);
export type CreatedApiKeyRecord = typeof CreatedApiKeyContract.schema.Type;

export const ApiKeyListContract = makePublicObjectContract({
  api_keys: Schema.Array(ApiKeySummary),
});
export type ApiKeyList = typeof ApiKeyListContract.schema.Type;

export const ApiKeyRevokeResponseContract = makePublicObjectContract({
  api_key: Schema.Struct({
    id: ApiKeyId,
    revoked_at: UtcTimestamp,
    state: Schema.Literal("revoked"),
  }),
});
export type ApiKeyRevokeResponse =
  typeof ApiKeyRevokeResponseContract.schema.Type;

export const decodeCreateApiKeyRequest = Schema.decodeUnknownSync(
  CreateApiKeyRequest,
  { onExcessProperty: "error" },
);

export const decodeCreatedApiKey = Schema.decodeUnknownSync(
  CreatedApiKeyContract.schema,
  { onExcessProperty: "error" },
);

export const decodeApiKeyList = Schema.decodeUnknownSync(
  ApiKeyListContract.schema,
  { onExcessProperty: "error" },
);

export const decodeApiKeyRevokeResponse = Schema.decodeUnknownSync(
  ApiKeyRevokeResponseContract.schema,
  { onExcessProperty: "error" },
);

export const parseApiKeyCredential = (
  value: string,
): {
  readonly credential: ApiKeyCredential;
  readonly publicId: ApiKeyId;
} | null => {
  try {
    const credential = Schema.decodeUnknownSync(ApiKeyCredential)(value);
    const publicId = Schema.decodeUnknownSync(ApiKeyId)(
      value.slice("normal_".length, "normal_".length + "apk_".length + 21),
    );
    return { credential, publicId };
  } catch {
    return null;
  }
};

export const apiKeyCredentialHint = (credential: ApiKeyCredential): string => {
  const secret = credential.slice(credential.lastIndexOf(".") + 1);
  const publicId = credential.slice(
    "normal_".length,
    credential.lastIndexOf("."),
  );
  return `normal_${publicId}.…${secret.slice(-4)}`;
};
