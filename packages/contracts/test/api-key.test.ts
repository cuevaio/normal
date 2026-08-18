import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  ApiKeyCredential,
  ApiKeySummary,
  apiKeyCredentialHint,
  CreatedApiKey,
  decodeApiKeyList,
  decodeApiKeyRevokeResponse,
  decodeCreateApiKeyRequest,
  decodeCreatedApiKey,
  parseApiKeyCredential,
} from "../src/api-key";
import { ApiKeyId, ConnectionId, McpAuthorizationId } from "../src/handles";

const publicId = "apk_123456789012345678901";
const secret = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const credential = `normal_${publicId}.${secret}`;
const connectionId = "con_123456789012345678901";

const validCreate = {
  connection_ids: [connectionId],
  name: "CI",
  permissions: ["connections:read"],
} as const;

describe("API Key contract", () => {
  test("accepts the split credential grammar and rejects near-misses", () => {
    expect(String(Schema.decodeUnknownSync(ApiKeyCredential)(credential))).toBe(
      credential,
    );

    for (const invalid of [
      `normal_mca_123456789012345678901.${secret}`,
      `normal_${publicId}.${secret.slice(0, -1)}`,
      `normal_${publicId}.${secret}a`,
      `normal_${publicId}.${secret}=`,
      `normal_${publicId}.${secret}+`,
      `normal_${publicId}.${secret}/`,
      `apk_${publicId.slice(4)}.${secret}`,
      `${credential}\n`,
      ` ${credential}`,
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(ApiKeyCredential)(invalid),
      ).toThrow();
    }
  });

  test("parses the management handle and rejects cross-type prefixes", () => {
    expect(parseApiKeyCredential(credential)).toEqual({
      credential: ApiKeyCredential.make(credential),
      publicId: ApiKeyId.make(publicId),
    });
    expect(
      parseApiKeyCredential(`normal_mca_123456789012345678901.${secret}`),
    ).toBeNull();
    expect(() =>
      Schema.decodeUnknownSync(ApiKeyId)("mca_123456789012345678901"),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(McpAuthorizationId)(publicId),
    ).toThrow();
  });

  test("builds a safe hint without exposing the secret", () => {
    expect(apiKeyCredentialHint(ApiKeyCredential.make(credential))).toBe(
      `normal_${publicId}.…DEFG`,
    );
    expect(
      apiKeyCredentialHint(ApiKeyCredential.make(credential)),
    ).not.toContain(secret);
  });

  test("rejects excess create properties and cross-type connection handles", () => {
    expect(decodeCreateApiKeyRequest(validCreate)).toMatchObject({
      name: "CI",
      permissions: ["connections:read"],
    });
    expect(() =>
      decodeCreateApiKeyRequest({
        ...validCreate,
        credential: credential,
      }),
    ).toThrow();
    expect(() =>
      decodeCreateApiKeyRequest({
        ...validCreate,
        connection_ids: ["mca_123456789012345678901"],
      }),
    ).toThrow();
    expect(() =>
      decodeCreateApiKeyRequest({
        ...validCreate,
        permissions: ["messages:send", "messages:send"],
      }),
    ).not.toThrow();
  });

  test("keeps summaries closed and free of plaintext credentials", () => {
    const summary = {
      connection_ids: [ConnectionId.make(connectionId)],
      created_at: "2026-08-14T12:00:00.000Z",
      credential_hint: `normal_${publicId}.…DEFG`,
      expires_at: null,
      id: ApiKeyId.make(publicId),
      last_used_at: null,
      name: "CI",
      permissions: ["connections:read"],
      revoked_at: null,
      state: "active",
    } as const;
    expect(Schema.decodeUnknownSync(ApiKeySummary)(summary)).toMatchObject({
      id: publicId,
      state: "active",
    });
    expect(() =>
      Schema.decodeUnknownSync(ApiKeySummary, { onExcessProperty: "error" })({
        ...summary,
        credential,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CreatedApiKey, { onExcessProperty: "error" })(
        summary,
      ),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(CreatedApiKey)({
        ...summary,
        credential,
      }),
    ).toMatchObject({ credential });
    expect(
      decodeCreatedApiKey({
        ...summary,
        credential,
      }),
    ).toMatchObject({ credential });
    expect(decodeApiKeyList({ api_keys: [summary] })).toMatchObject({
      api_keys: [summary],
    });
    expect(() =>
      decodeApiKeyList({
        api_keys: [{ ...summary, credential }],
      }),
    ).toThrow();
    expect(
      decodeApiKeyRevokeResponse({
        api_key: {
          id: publicId,
          revoked_at: "2026-08-14T13:00:00.000Z",
          state: "revoked",
        },
      }),
    ).toMatchObject({
      api_key: { id: publicId, state: "revoked" },
    });
  });
});
