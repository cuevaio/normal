import { checkDatabaseReadiness } from "@whatsapp-mcp/db/connectivity";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createProductionHandler,
  createProductionQueueHandler,
} from "../src/production";
import { validEnvironment } from "./support/production";

describe("API production root", () => {
  beforeEach(() => {
    vi.mocked(checkDatabaseReadiness).mockResolvedValue(undefined);
  });

  test("accepts valid production configuration", async () => {
    const response = await createProductionHandler(validEnvironment())(
      new Request("https://api.example.test/health"),
    );

    expect(response.status).toBe(200);
  });

  test("fails public traffic closed until replay approves the configured branch", async () => {
    vi.mocked(checkDatabaseReadiness).mockRejectedValueOnce(
      new Error("database restore replay is not complete"),
    );
    const environment = validEnvironment();
    const response = await createProductionHandler(environment)(
      new Request(
        "https://api.example.test/.well-known/oauth-authorization-server",
      ),
    );

    expect(response.status).toBe(503);
    expect(checkDatabaseReadiness).toHaveBeenCalledWith(
      environment.HYPERDRIVE.connectionString,
      environment.NEON_BRANCH_ID,
      false,
    );
  });

  test.each([
    "CONNECTION_SETUP_PROVISIONING_QUEUE",
    "DELETION_CAPSULES",
    "DELETION_MARKERS",
    "INGESTION_QUEUE",
    "OAUTH_KV",
    "STORED_MEDIA",
    "WEBHOOK_INGRESS",
  ] as const)("fails closed when the %s binding is absent", async (binding) => {
    const { [binding]: _missing, ...environment } = validEnvironment();
    const response = await createProductionHandler(environment)(
      new Request("https://api.example.test/health"),
    );

    expect(response.status).toBe(503);
  });

  test("fails closed when the provider-control binding is absent", async () => {
    const { PROVIDER_CONTROL: _missing, ...environment } = validEnvironment();
    const response = await createProductionHandler(environment)(
      new Request("https://api.example.test/health"),
    );

    expect(response.status).toBe(503);
  });

  test("fails closed when the provider-control binding lacks RPC lifecycle authority", async () => {
    const response = await createProductionHandler({
      ...validEnvironment(),
      PROVIDER_CONTROL: {
        fetch: async () => new Response(null, { status: 204 }),
      },
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });

  test("fails closed when the provider-control binding cannot disconnect", async () => {
    const environment = validEnvironment();
    const { disconnectSession: _missing, ...providerControlWithoutDisconnect } =
      environment.PROVIDER_CONTROL;
    const response = await createProductionHandler({
      ...environment,
      PROVIDER_CONTROL: providerControlWithoutDisconnect,
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });

  test("fails closed when the provider-control binding cannot verify a number", async () => {
    const environment = validEnvironment();
    const {
      verifySessionNumber: _missing,
      ...providerControlWithoutVerification
    } = environment.PROVIDER_CONTROL;
    const response = await createProductionHandler({
      ...environment,
      PROVIDER_CONTROL: providerControlWithoutVerification,
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });

  test("fails closed when Stored Media cannot start multipart uploads", async () => {
    const environment = validEnvironment();
    const { createMultipartUpload: _missing, ...storedMediaWithoutMultipart } =
      environment.STORED_MEDIA;

    const response = await createProductionHandler({
      ...environment,
      STORED_MEDIA: storedMediaWithoutMultipart,
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });

  test("fails closed when Webhook ingress cannot list orphan candidates", async () => {
    const environment = validEnvironment();
    const { list: _missing, ...webhookIngressWithoutList } =
      environment.WEBHOOK_INGRESS;

    const response = await createProductionHandler({
      ...environment,
      WEBHOOK_INGRESS: webhookIngressWithoutList,
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });

  test.each(["development", "preview"] as const)(
    "routes the %s ingestion DLQ through active dead-letter handling",
    async (deploymentEnvironment) => {
      let acknowledgements = 0;
      let retries = 0;

      await createProductionQueueHandler({
        ...validEnvironment(),
        DEPLOYMENT_ENVIRONMENT: deploymentEnvironment,
      })({
        ackAll: () => undefined,
        messages: [
          {
            ack: () => {
              acknowledgements += 1;
            },
            attempts: 1,
            body: { invalid: "envelope" },
            id: "invalid-dead-letter",
            retry: () => {
              retries += 1;
            },
            timestamp: new Date("2026-07-31T12:15:00.000Z"),
          },
        ],
        metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
        queue: `whatsapp-mcp-ingestion-dlq-${deploymentEnvironment}`,
        retryAll: () => undefined,
      } as MessageBatch);

      expect(acknowledgements).toBe(1);
      expect(retries).toBe(0);
    },
  );

  test("fails closed before data-plane traffic when Hyperdrive is absent", async () => {
    const { HYPERDRIVE: _missing, ...environment } = validEnvironment();
    const response = await createProductionHandler(environment)(
      new Request("https://api.example.test/ready"),
    );

    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      service: "api",
      status: "unavailable",
    });
  });

  test("fails closed before webhook traffic when Webhook Hyperdrive is absent", async () => {
    const { WEBHOOK_HYPERDRIVE: _missing, ...environment } = validEnvironment();
    const response = await createProductionHandler(environment)(
      new Request("https://api.example.test/health"),
    );

    expect(response.status).toBe(503);
  });

  test("fails closed when deployment configuration is invalid", async () => {
    const response = await createProductionHandler({
      ...validEnvironment(),
      DEPLOYMENT_ENVIRONMENT: "test",
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      service: "api",
      status: "unavailable",
    });
  });

  test("fails closed without temporary KMS role credentials", async () => {
    const { AWS_SESSION_TOKEN: _missing, ...environment } = validEnvironment();
    const response = await createProductionHandler(environment)(
      new Request("https://api.example.test/health"),
    );

    expect(response.status).toBe(503);
  });

  test.each([
    "CLERK_API_AUDIENCE",
    "CLERK_AUTHORIZED_PARTY",
    "CLERK_ISSUER",
    "CLERK_JWT_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_WEBHOOK_SIGNING_SECRET",
    "OAUTH_ISSUER",
    "OAUTH_PROTOCOL_ENCRYPTION_KEY",
    "OAUTH_RESOURCE",
    "MCP_REQUESTS_PER_HOUR",
    "MCP_REQUESTS_PER_MINUTE",
    "READ_MESSAGE_RECORDS_PER_DAY",
    "API_KEY_HMAC_SECRET",
    "MCP_CURSOR_HMAC_SECRET",
    "SMOKE_CHECK_SECRET",
    "WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET",
  ] as const)("fails closed when %s is absent", async (configuration) => {
    const { [configuration]: _missing, ...environment } = validEnvironment();
    const response = await createProductionHandler(environment)(
      new Request("https://api.example.test/health"),
    );

    expect(response.status).toBe(503);
  });

  test("fails closed when the WhatsApp Number reservation secret is malformed", async () => {
    const response = await createProductionHandler({
      ...validEnvironment(),
      WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET: "not-a-32-byte-key",
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });

  test("fails closed when the MCP cursor secret is malformed", async () => {
    const response = await createProductionHandler({
      ...validEnvironment(),
      MCP_CURSOR_HMAC_SECRET: "not-a-32-byte-key",
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });

  test("fails closed when the API Key HMAC secret is malformed", async () => {
    const response = await createProductionHandler({
      ...validEnvironment(),
      API_KEY_HMAC_SECRET: "too-short",
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });

  test.each([
    ["MCP_REQUESTS_PER_MINUTE", "0"],
    ["MCP_REQUESTS_PER_MINUTE", "1.5"],
    ["MCP_REQUESTS_PER_HOUR", "0"],
    ["MCP_REQUESTS_PER_HOUR", "59"],
    ["READ_MESSAGE_RECORDS_PER_DAY", "0"],
  ] as const)("fails closed when %s is %s", async (name, value) => {
    const response = await createProductionHandler({
      ...validEnvironment(),
      [name]: value,
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });

  test.each([
    ["CLERK_API_AUDIENCE", "http://api.example.test"],
    ["CLERK_AUTHORIZED_PARTY", "https://app.example.test/path"],
    ["CLERK_ISSUER", "https://user@clerk.example.test"],
    ["CLERK_JWT_KEY", "not-a-public-key"],
    [
      "CLERK_JWT_KEY",
      "-----BEGIN PUBLIC KEY-----\ncHJvZHVjdGlvbi1wdWJsaWMta2V5\n-----END PUBLIC KEY-----",
    ],
    ["OAUTH_ISSUER", "http://api.example.test"],
    ["OAUTH_ISSUER", "https://other-api.example.test"],
    ["OAUTH_RESOURCE", "https://api.example.test/other"],
    ["OAUTH_PROTOCOL_ENCRYPTION_KEY", "not-a-32-byte-key"],
    ["SMOKE_CHECK_SECRET", "not-a-32-byte-key"],
  ] as const)(
    "fails closed when %s is invalid",
    async (configuration, value) => {
      const response = await createProductionHandler({
        ...validEnvironment(),
        [configuration]: value,
      })(new Request("https://api.example.test/health"));

      expect(response.status).toBe(503);
    },
  );

  test("fails closed for a KMS root outside us-east-1", async () => {
    const response = await createProductionHandler({
      ...validEnvironment(),
      KMS_CONTENT_ROOT_KEY_ARN:
        "arn:aws:kms:us-west-2:111122223333:key/00000000-0000-0000-0000-000000000001",
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });

  test("fails closed without the dedicated marker HMAC secret", async () => {
    const { DELETION_MARKER_HMAC_SECRET: _missing, ...environment } =
      validEnvironment();

    const response = await createProductionHandler(environment)(
      new Request("https://api.example.test/health"),
    );

    expect(response.status).toBe(503);
  });

  test("fails closed when the Deletion Capsule key is not a separate us-east-1 key", async () => {
    const environment = validEnvironment();
    const response = await createProductionHandler({
      ...environment,
      KMS_DELETION_COORDINATOR_KEY_ARN: environment.KMS_CONTENT_ROOT_KEY_ARN,
    })(new Request("https://api.example.test/health"));

    expect(response.status).toBe(503);
  });
});
