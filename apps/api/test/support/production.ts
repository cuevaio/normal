import { TEST_CLERK_JWT_PUBLIC_KEY } from "./clerk";

export const validEnvironment = () => ({
  AWS_ACCESS_KEY_ID: "temporary-access-key",
  AWS_KMS_REGION: "us-east-1",
  AWS_SECRET_ACCESS_KEY: "temporary-secret",
  AWS_SESSION_TOKEN: "temporary-session-token",
  CLERK_API_AUDIENCE: "https://api.example.test",
  CLERK_AUTHORIZED_PARTY: "https://app.example.test",
  CLERK_ISSUER: "https://clerk.example.test",
  CLERK_JWT_KEY: TEST_CLERK_JWT_PUBLIC_KEY,
  CLERK_SECRET_KEY: `sk_test_${"a".repeat(32)}`,
  CLERK_WEBHOOK_SIGNING_SECRET: `whsec_${"b".repeat(32)}`,
  CONNECTION_SETUP_PROVISIONING_QUEUE: {
    send: async () => undefined,
    sendBatch: async () => undefined,
  },
  DELETION_CAPSULES: {
    get: async () => null,
    put: async () => null,
  },
  DELETION_MARKER_HMAC_SECRET:
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  DELETION_MARKERS: {
    get: async () => null,
    list: async () => ({ objects: [], truncated: false }),
    put: async () => null,
  },
  DEPLOYMENT_ENVIRONMENT: "production",
  HYPERDRIVE: {
    connectionString: "postgresql://runtime@hyperdrive.internal/database",
  },
  NEON_BRANCH_ID: "br-production-test",
  INGESTION_QUEUE: {
    send: async () => undefined,
  },
  KMS_CONTENT_ROOT_KEY_ARN:
    "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001",
  KMS_DELETION_COORDINATOR_KEY_ARN:
    "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000002",
  OAUTH_ISSUER: "https://api.example.test",
  OAUTH_KV: {
    delete: async () => undefined,
    get: async () => null,
    put: async () => undefined,
  },
  OAUTH_PROTOCOL_ENCRYPTION_KEY:
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  OAUTH_RESOURCE: "https://api.example.test/mcp",
  MCP_REQUESTS_PER_HOUR: "600",
  MCP_REQUESTS_PER_MINUTE: "60",
  MESSAGE_RETENTION_DAY_OPTIONS: "7,30,90",
  READ_MESSAGE_RECORDS_PER_DAY: "10000",
  RECIPIENT_TRANSITION_HMAC_SECRET:
    "4141414141414141414141414141414141414141414141414141414141414141",
  RECIPIENT_TRANSITIONS: {
    get: async () => null,
    list: async () => ({ objects: [], truncated: false }),
    put: async () => null,
  },
  DECRYPTED_MEDIA_BYTES_PER_DAY: "268435456",
  API_KEY_HMAC_SECRET:
    "4242424242424242424242424242424242424242424242424242424242424242",
  MCP_CURSOR_HMAC_SECRET:
    "3939393939393939393939393939393939393939393939393939393939393939",
  SEND_FINGERPRINT_HMAC_SECRET:
    "3838383838383838383838383838383838383838383838383838383838383838",
  SMOKE_CHECK_SECRET:
    "4747474747474747474747474747474747474747474747474747474747474747",
  SENDS_PER_DAY: "200",
  SENDS_PER_MINUTE: "10",
  WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET:
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
  PROVIDER_CONTROL: {
    connectSession: async () => ({
      error: {
        _tag: "ProviderControlFailure" as const,
        code: "configuration_invalid" as const,
        operation: "boundary" as const,
        retryAfterMs: null,
        retryDecision: "do_not_retry" as const,
      },
      ok: false as const,
    }),
    createSession: async () => ({
      error: {
        _tag: "ProviderControlFailure" as const,
        code: "configuration_invalid" as const,
        operation: "boundary" as const,
        retryAfterMs: null,
        retryDecision: "do_not_retry" as const,
      },
      ok: false as const,
    }),
    deleteSession: async () => ({
      error: {
        _tag: "ProviderControlFailure" as const,
        code: "configuration_invalid" as const,
        operation: "boundary" as const,
        retryAfterMs: null,
        retryDecision: "do_not_retry" as const,
      },
      ok: false as const,
    }),
    disconnectSession: async () => ({
      error: {
        _tag: "ProviderControlFailure" as const,
        code: "configuration_invalid" as const,
        operation: "boundary" as const,
        retryAfterMs: null,
        retryDecision: "do_not_retry" as const,
      },
      ok: false as const,
    }),
    fetch: async () => new Response(null, { status: 204 }),
    getQrCode: async () => ({
      error: {
        _tag: "ProviderControlFailure" as const,
        code: "configuration_invalid" as const,
        operation: "boundary" as const,
        retryAfterMs: null,
        retryDecision: "do_not_retry" as const,
      },
      ok: false as const,
    }),
    listSessions: async () => ({
      error: {
        _tag: "ProviderControlFailure" as const,
        code: "configuration_invalid" as const,
        operation: "boundary" as const,
        retryAfterMs: null,
        retryDecision: "do_not_retry" as const,
      },
      ok: false as const,
    }),
    reconcileSession: async () => ({
      error: {
        _tag: "ProviderControlFailure" as const,
        code: "configuration_invalid" as const,
        operation: "boundary" as const,
        retryAfterMs: null,
        retryDecision: "do_not_retry" as const,
      },
      ok: false as const,
    }),
    repairSessionConfiguration: async () => ({
      error: {
        _tag: "ProviderControlFailure" as const,
        code: "configuration_invalid" as const,
        operation: "boundary" as const,
        retryAfterMs: null,
        retryDecision: "do_not_retry" as const,
      },
      ok: false as const,
    }),
  },
  STORED_MEDIA: {
    createMultipartUpload: async () => ({
      abort: async () => undefined,
      complete: async () => ({}),
      uploadPart: async (partNumber: number) => ({
        etag: "test-etag",
        partNumber,
      }),
    }),
    delete: async () => undefined,
    get: async () => null,
    put: async () => null,
  },
  WEBHOOK_INGRESS: {
    delete: async () => undefined,
    get: async () => null,
    list: async () => ({ objects: [], truncated: false }),
    put: async () => null,
  },
  WEBHOOK_HYPERDRIVE: {
    connectionString:
      "postgresql://webhook-runtime@hyperdrive.internal/database",
  },
});
