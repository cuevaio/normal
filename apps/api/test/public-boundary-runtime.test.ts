import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { connectionSetupProvisioningMessage } from "../src/connection-setup-provisioning";
import worker from "./support/public-boundary-worker";

describe("public-boundary Worker harness", () => {
  test("keeps the production Worker entrypoint under the runtime harness", async () => {
    const response = await exports.default.fetch(
      "https://api.example.test/health",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: "api",
      status: "ok",
    });
  });

  test("runs deterministic external identity and provider Layers through HTTP", async () => {
    const response = await exports.default.fetch(
      new Request("https://api.example.test/v1/personal-account", {
        headers: {
          authorization: "Bearer signed-test-user",
          origin: "http://127.0.0.1:3000",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:3000",
    );
    expect(await response.json()).toEqual({
      connection_id: "con_0123456789abcdefghijk",
      observed_at: "2026-01-02T03:04:05.000Z",
      provider_state: "connected",
      user_id: "user_test_public_boundary",
    });
  });

  test("bootstraps a Personal Account through the public browser/API seam", async () => {
    const response = await exports.default.fetch(
      new Request("https://api.example.test/v1/personal-account/bootstrap", {
        headers: {
          authorization: "Bearer signed-test-user",
          origin: "http://127.0.0.1:3000",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:3000",
    );
    expect(await response.json()).toEqual({
      personal_account: {
        message_retention_days: 30,
        state: "active",
        stored_media_limit_bytes: 5_368_709_120,
        whatsapp_connection_limit: 3,
      },
    });
  });

  test("starts and replays a Connection Setup through the signed-in HTTP boundary", async () => {
    const profile = await exports.default.fetch(
      new Request(
        "https://api.example.test/v1/personal-account/onboarding-profile",
        {
          body: JSON.stringify({
            intended_mcp_client: "not_sure",
            primary_use_case: "exploration",
            research_call_interest: "not_sure",
            role: "not_sure",
            whatsapp_usage_context: "personal",
          }),
          headers: {
            authorization: "Bearer signed-test-user",
            "content-type": "application/json",
            origin: "http://127.0.0.1:3000",
          },
          method: "PUT",
        },
      ),
    );
    expect(profile.status).toBe(200);

    const request = () =>
      new Request("https://api.example.test/v1/connection-setups", {
        body: JSON.stringify({
          idempotency_key: "123456789012345678901",
          name: "Personal WhatsApp",
          whatsapp_number: "+1 (555) 012-3456",
        }),
        headers: {
          authorization: "Bearer signed-test-user",
          "content-type": "application/json",
          origin: "http://127.0.0.1:3000",
        },
        method: "POST",
      });

    const first = await exports.default.fetch(request());
    const replay = await exports.default.fetch(request());
    const firstBody = (await first.json()) as {
      readonly connection_setup: Record<string, unknown>;
    };
    const replayBody = (await replay.json()) as {
      readonly connection_setup: Record<string, unknown>;
    };

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(firstBody.connection_setup).toMatchObject({
      expires_at: "2026-01-02T03:19:05.000Z",
      idempotent_replay: false,
      state: "pending",
    });
    expect(replayBody.connection_setup).toEqual({
      ...firstBody.connection_setup,
      idempotent_replay: true,
    });

    const cancelRequest = () =>
      new Request(
        `https://api.example.test/v1/connection-setups/${String(
          firstBody.connection_setup.id,
        )}`,
        {
          headers: {
            authorization: "Bearer signed-test-user",
            origin: "http://127.0.0.1:3000",
          },
          method: "DELETE",
        },
      );
    const cancelled = await exports.default.fetch(cancelRequest());
    const cancelReplay = await exports.default.fetch(cancelRequest());

    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({
      connection_setup: {
        cleanup_state: "pending",
        id: firstBody.connection_setup.id,
        idempotent_replay: false,
        state: "cancelled",
      },
    });
    expect(await cancelReplay.json()).toEqual({
      connection_setup: {
        cleanup_state: "pending",
        id: firstBody.connection_setup.id,
        idempotent_replay: true,
        state: "cancelled",
      },
    });
  });

  test("provisions a Connection Setup through the actual Queue boundary", async () => {
    const response = await exports.default.fetch(
      new Request("https://api.example.test/v1/connection-setups", {
        body: JSON.stringify({
          idempotency_key: "223456789012345678901",
          name: "Work WhatsApp",
          whatsapp_number: "+1 (555) 012-3457",
        }),
        headers: {
          authorization: "Bearer signed-test-user",
          "content-type": "application/json",
          origin: "http://127.0.0.1:3000",
        },
        method: "POST",
      }),
    );
    const body = (await response.json()) as {
      readonly connection_setup: { readonly id: string };
    };
    const batch = createMessageBatch(
      "whatsapp-mcp-connection-setup-provisioning",
      [
        {
          attempts: 1,
          body: connectionSetupProvisioningMessage(body.connection_setup.id),
          id: "connection-setup-provisioning-1",
          timestamp: new Date("2026-01-02T03:05:00.000Z"),
        },
      ],
    );
    const context = createExecutionContext();

    await worker.queue?.(batch, env, context);
    const result = await getQueueResult(batch, context);

    expect(response.status).toBe(201);
    expect(result).toMatchObject({
      ackAll: false,
      explicitAcks: ["connection-setup-provisioning-1"],
      outcome: "ok",
    });
  });

  test("streams QR data, observes provider connection, and lists the activated Connection over HTTP", async () => {
    const started = await exports.default.fetch(
      new Request("https://api.example.test/v1/connection-setups", {
        body: JSON.stringify({
          idempotency_key: "323456789012345678901",
          name: "Personal WhatsApp",
          whatsapp_number: "+1 (555) 012-3456",
        }),
        headers: {
          authorization: "Bearer signed-test-user",
          "content-type": "application/json",
          origin: "http://127.0.0.1:3000",
        },
        method: "POST",
      }),
    );
    const body = (await started.json()) as {
      readonly connection_setup: { readonly id: string };
    };
    const qrRequest = () =>
      new Request(
        `https://api.example.test/v1/connection-setups/${body.connection_setup.id}/qr`,
        {
          headers: {
            authorization: "Bearer signed-test-user",
            origin: "http://127.0.0.1:3000",
          },
        },
      );

    const qr = await exports.default.fetch(qrRequest());
    const connected = await exports.default.fetch(qrRequest());
    const listed = await exports.default.fetch(
      new Request("https://api.example.test/v1/whatsapp-connections", {
        headers: {
          authorization: "Bearer signed-test-user",
          origin: "http://127.0.0.1:3000",
        },
      }),
    );
    const connectionId = "con_000000000000000000018";
    const lifecycleRequest = (action: "disconnect" | "reconnect") =>
      new Request(
        `https://api.example.test/v1/whatsapp-connections/${connectionId}/${action}`,
        {
          headers: {
            authorization: "Bearer signed-test-user",
            origin: "http://127.0.0.1:3000",
          },
          method: "POST",
        },
      );
    const disconnected = await exports.default.fetch(
      lifecycleRequest("disconnect"),
    );
    const disconnectReplay = await exports.default.fetch(
      lifecycleRequest("disconnect"),
    );
    const reconnectQr = await exports.default.fetch(
      lifecycleRequest("reconnect"),
    );
    const reconnected = await exports.default.fetch(
      lifecycleRequest("reconnect"),
    );
    const listedAgain = await exports.default.fetch(
      new Request("https://api.example.test/v1/whatsapp-connections", {
        headers: {
          authorization: "Bearer signed-test-user",
          origin: "http://127.0.0.1:3000",
        },
      }),
    );

    expect(qr.status).toBe(200);
    expect(qr.headers.get("content-type")).toBe("image/svg+xml");
    expect((await qr.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(connected.status).toBe(204);
    expect(await listed.json()).toEqual({
      whatsapp_connections: [
        {
          display_name: "Personal WhatsApp",
          id: "con_000000000000000000018",
          number_suffix: "3456",
          state: "connected",
          state_changed_at: "2026-01-02T03:06:00.000Z",
        },
      ],
    });
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toMatchObject({
      lifecycle: { action: "disconnect", outcome: "complete" },
      whatsapp_connection: {
        id: connectionId,
        state: "disconnected",
      },
    });
    expect(disconnectReplay.status).toBe(200);
    expect(reconnectQr.status).toBe(200);
    expect(reconnectQr.headers.get("content-type")).toBe("image/svg+xml");
    expect(reconnectQr.headers.get("x-whatsapp-connection-state")).toBe(
      "connecting",
    );
    expect(reconnected.status).toBe(200);
    expect(await reconnected.json()).toMatchObject({
      lifecycle: { action: "reconnect", outcome: "complete" },
      whatsapp_connection: {
        id: connectionId,
        state: "connected",
      },
    });
    expect(await listedAgain.json()).toMatchObject({
      whatsapp_connections: [
        {
          id: connectionId,
          number_suffix: "3456",
          state: "connected",
        },
      ],
    });
  });

  test("bootstraps another Clerk-authenticated User without a provider reservation", async () => {
    const response = await exports.default.fetch(
      new Request("https://api.example.test/v1/personal-account/bootstrap", {
        headers: {
          authorization: "Bearer signed-second-test-user",
          origin: "http://127.0.0.1:3000",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      personal_account: { state: "active", whatsapp_connection_limit: 3 },
    });
  });

  test("lists and revokes an MCP Authorization through the signed-in product boundary", async () => {
    const list = await exports.default.fetch(
      new Request("https://api.example.test/v1/mcp-authorizations", {
        headers: {
          authorization: "Bearer signed-test-user",
          origin: "http://127.0.0.1:3000",
        },
      }),
    );
    const body = (await list.json()) as {
      readonly mcp_authorizations: ReadonlyArray<{
        readonly id: string;
      }>;
    };
    const authorizationId = body.mcp_authorizations[0]?.id;
    if (authorizationId === undefined) {
      throw new Error("test authorization was not listed");
    }
    const revoked = await exports.default.fetch(
      new Request(
        `https://api.example.test/v1/mcp-authorizations/${authorizationId}`,
        {
          headers: {
            authorization: "Bearer signed-test-user",
            origin: "http://127.0.0.1:3000",
          },
          method: "DELETE",
        },
      ),
    );

    expect(list.status).toBe(200);
    expect(body.mcp_authorizations[0]).toMatchObject({
      client: {
        id: "approved-client",
        name: "Approved MCP Client",
      },
      connection_ids: ["con_123456789012345678901"],
      expiry_state: "active",
      revocation_state: "active",
      scopes: ["connections:read", "messages:send"],
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({
      mcp_authorization: {
        id: authorizationId,
        revocation_state: "revoked",
        revoked_at: "2026-01-02T03:05:00.000Z",
      },
    });
  });

  test("lists safe Tool Call Logs through the signed-in product boundary", async () => {
    const response = await exports.default.fetch(
      new Request("https://api.example.test/v1/tool-call-logs", {
        headers: {
          authorization: "Bearer signed-test-user",
          origin: "http://127.0.0.1:3000",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      next_cursor: "tcl_123456789012345678901",
      tool_call_logs: [
        {
          capability: "list_connections",
          channel: "mcp",
          client: { id: "approved-client", name: "Approved MCP Client" },
          completed_at: "2026-01-02T03:04:05.120Z",
          counts: { media_bytes: 0, results: 1 },
          error_code: null,
          latency_ms: 120,
          outcome: "success",
          references: {
            api_key_id: null,
            mcp_authorization_id: "mca_123456789012345678901",
            send_id: null,
            whatsapp_connection_id: "con_123456789012345678901",
          },
          started_at: "2026-01-02T03:04:05.000Z",
        },
      ],
    });
  });

  test("lists selected Connections with an API Key and records Activity Log", async () => {
    const created = await exports.default.fetch(
      new Request("https://api.example.test/v1/api-keys", {
        body: JSON.stringify({
          connection_ids: ["con_123456789012345678901"],
          name: "CI",
          permissions: ["connections:read"],
        }),
        headers: {
          authorization: "Bearer signed-test-user",
          "content-type": "application/json",
          origin: "http://127.0.0.1:3000",
        },
        method: "POST",
      }),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      readonly credential: string;
    };
    expect(created.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:3000",
    );

    const listed = await exports.default.fetch(
      new Request("https://api.example.test/v1/connections", {
        headers: {
          authorization: `Bearer ${createdBody.credential}`,
        },
      }),
    );
    expect(listed.status).toBe(200);
    expect(listed.headers.get("access-control-allow-origin")).toBeNull();
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(await listed.json()).toEqual({
      data: [
        {
          connection_id: "con_123456789012345678901",
          display_name: "Personal WhatsApp",
          number_last_four: "3456",
          state: "connected",
          state_changed_at: "2026-08-14T12:00:00.000Z",
        },
      ],
      pagination: { has_more: false, next_cursor: null },
    });

    const logs = await exports.default.fetch(
      new Request("https://api.example.test/v1/tool-call-logs", {
        headers: {
          authorization: "Bearer signed-test-user",
          origin: "http://127.0.0.1:3000",
        },
      }),
    );
    const logBody = (await logs.json()) as {
      readonly tool_call_logs: ReadonlyArray<{
        readonly channel: string;
        readonly client: { readonly name: string };
        readonly capability: string;
      }>;
    };
    expect(logBody.tool_call_logs[0]).toMatchObject({
      capability: "list_connections",
      channel: "api",
      client: { name: "CI" },
    });
    expect(JSON.stringify(logBody)).not.toContain(createdBody.credential);
  });

  test("injects deterministic external failures only in the test root", async () => {
    const response = await exports.default.fetch(
      new Request("https://api.example.test/v1/personal-account", {
        headers: {
          authorization: "Bearer signed-test-user",
          origin: "http://127.0.0.1:3000",
          "x-test-failure": "provider",
        },
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "controlled_external_failure",
    });
  });

  test("drives OAuth authorization over signed-in HTTP without following the client redirect", async () => {
    const response = await exports.default.fetch(
      new Request(
        "https://api.example.test/oauth/authorize?redirect_uri=https%3A%2F%2Fclient.example.test%2Fcallback&state=state_123",
        {
          headers: {
            authorization: "Bearer signed-test-user",
          },
          redirect: "manual",
        },
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe(
      "https://client.example.test/callback?code=oauth_test_code&state=state_123",
    );
  });

  test("drives MCP discovery through HTTP JSON-RPC", async () => {
    const response = await exports.default.fetch(
      new Request("https://api.example.test/mcp", {
        body: JSON.stringify({
          id: "request-1",
          jsonrpc: "2.0",
          method: "tools/list",
        }),
        headers: {
          authorization: "Bearer signed-test-user",
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "request-1",
      jsonrpc: "2.0",
      result: { tools: [] },
    });
  });

  test("reads a protected resource through the authenticated HTTP boundary", async () => {
    const response = await exports.default.fetch(
      new Request("https://api.example.test/mcp/resources/protected", {
        headers: {
          authorization: "Bearer signed-test-user",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
      "protected boundary",
    );
  });

  test("uses real KV, R2, Queue, and service bindings from an actual fetch handler", async () => {
    const response = await exports.default.fetch(
      "https://api.example.test/test/bindings",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kv: "stored",
      provider_control: "ok",
      queue: "published",
      r2: "stored",
    });
    expect(await env.OAUTH_KV.get("public-boundary:kv")).toBe("stored");
    expect(
      await (await env.WEBHOOK_INGRESS.get("public-boundary/r2"))?.text(),
    ).toBe("stored");
  });

  test("acknowledges authenticated webhooks only after real R2 and Queue boundaries succeed", async () => {
    const ingress =
      "https://api.example.test/webhooks/wasender/30000000-0000-4000-8000-000000000018";
    const payload = (sessionId = "test-session-credential") =>
      JSON.stringify({
        data: { messages: [] },
        event: "messages.upsert",
        sessionId,
      });
    const deliver = (
      url: string,
      options: {
        readonly body?: BodyInit;
        readonly failure?: string;
        readonly signature?: string;
      } = {},
    ) =>
      exports.default.fetch(
        new Request(url, {
          body: options.body ?? payload(),
          headers: {
            "content-type": "application/json",
            "x-test-failure": options.failure ?? "",
            "x-webhook-signature": options.signature ?? "test-webhook-secret",
          },
          method: "POST",
        }),
      );
    const objectsBefore = await env.WEBHOOK_INGRESS.list({
      prefix: "webhook-events/",
    });
    const queueBefore = (await (
      await exports.default.fetch("https://api.example.test/test/webhook-queue")
    ).json()) as ReadonlyArray<unknown>;

    const unknown = await deliver(
      "https://api.example.test/webhooks/wasender/30000000-0000-4000-8000-000000000099",
    );
    const wrongSecret = await deliver(ingress, { signature: "wrong-secret" });
    const wrongSession = await deliver(ingress, {
      body: payload("another-session"),
    });
    const oversized = await deliver(ingress, {
      body: new Uint8Array(1_048_577).fill(32),
    });
    const databaseFailure = await deliver(ingress, {
      failure: "webhook-database",
    });
    const r2Failure = await deliver(ingress, { failure: "webhook-r2" });
    const queueFailure = await deliver(ingress, {
      failure: "webhook-queue",
    });
    const accepted = await deliver(ingress);

    expect([
      unknown.status,
      wrongSecret.status,
      wrongSession.status,
      oversized.status,
      databaseFailure.status,
      r2Failure.status,
      queueFailure.status,
      accepted.status,
    ]).toEqual([404, 404, 404, 413, 503, 503, 503, 200]);
    expect(await accepted.json()).toEqual({ accepted: true });

    const objectsAfter = await env.WEBHOOK_INGRESS.list({
      prefix: "webhook-events/",
    });
    const newObjects = objectsAfter.objects.filter(
      ({ key }) => !objectsBefore.objects.some((before) => before.key === key),
    );
    expect(newObjects).toHaveLength(2);
    for (const object of newObjects) {
      const stored = await env.WEBHOOK_INGRESS.get(object.key);
      expect(stored).not.toBeNull();
      expect(await stored?.json()).toEqual({
        ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
        key_version: 1,
        nonce: "AQIDBAUGBwgJCgsM",
        version: 1,
      });
      expect(stored?.customMetadata).toEqual({
        ciphertextSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        payloadBytes: String(new TextEncoder().encode(payload()).byteLength),
        personalAccountId: "10000000-0000-4000-8000-000000000018",
        receivedAt: "2026-01-02T03:07:00.000Z",
        version: "1",
        whatsappConnectionId: "20000000-0000-4000-8000-000000000018",
      });
    }

    const queueAfter = (await (
      await exports.default.fetch("https://api.example.test/test/webhook-queue")
    ).json()) as ReadonlyArray<Record<string, unknown>>;
    expect(queueAfter).toHaveLength(queueBefore.length + 1);
    const published = queueAfter.at(-1);
    expect(Object.keys(published ?? {}).sort()).toEqual([
      "ciphertext_sha256",
      "object_id",
      "payload_bytes",
      "personal_account_id",
      "received_at",
      "version",
      "whatsapp_connection_id",
    ]);
    expect(published).toMatchObject({
      payload_bytes: new TextEncoder().encode(payload()).byteLength,
      personal_account_id: "10000000-0000-4000-8000-000000000018",
      received_at: "2026-01-02T03:07:00.000Z",
      version: 1,
      whatsapp_connection_id: "20000000-0000-4000-8000-000000000018",
    });
  });

  test("projects authenticated connection-state items into the signed-in inventory", async () => {
    const endpoint =
      "https://api.example.test/webhooks/wasender/30000000-0000-4000-8000-000000000018";
    const deliver = (status: string, timestamp: number) =>
      exports.default.fetch(
        new Request(endpoint, {
          body: JSON.stringify({
            data: { status },
            event: "session.status",
            sessionId: "test-session-credential",
            timestamp,
          }),
          headers: {
            "content-type": "application/json",
            "x-webhook-signature": "test-webhook-secret",
          },
          method: "POST",
        }),
      );
    const published = async () =>
      (await (
        await exports.default.fetch(
          "https://api.example.test/test/webhook-queue",
        )
      ).json()) as ReadonlyArray<Record<string, unknown>>;
    const consume = async (body: Record<string, unknown>, id: string) => {
      const batch = createMessageBatch("whatsapp-mcp-ingestion", [
        {
          attempts: 1,
          body,
          id,
          timestamp: new Date("2026-01-02T03:08:01.000Z"),
        },
      ]);
      const context = createExecutionContext();
      await worker.queue?.(batch, env, context);
      return getQueueResult(batch, context);
    };

    const connectedEvidence = await deliver("degraded", 1_767_323_280_000);
    const firstMessage = (await published()).at(-1);
    if (firstMessage === undefined) {
      throw new Error("connection-state Queue message was not published");
    }
    const firstResult = await consume(firstMessage, "connection-state-1");

    const olderEvidence = await deliver("connecting", 1_767_323_250_000);
    const olderMessage = (await published()).at(-1);
    if (olderMessage === undefined) {
      throw new Error("older connection-state Queue message was not published");
    }
    const olderResult = await consume(olderMessage, "connection-state-2");
    const duplicateResult = await consume(firstMessage, "connection-state-3");
    const listed = await exports.default.fetch(
      new Request("https://api.example.test/v1/whatsapp-connections", {
        headers: {
          authorization: "Bearer signed-test-user",
          origin: "http://127.0.0.1:3000",
        },
      }),
    );

    expect(connectedEvidence.status).toBe(200);
    expect(olderEvidence.status).toBe(200);
    expect(firstResult).toMatchObject({
      explicitAcks: ["connection-state-1"],
      outcome: "ok",
    });
    expect(olderResult).toMatchObject({
      explicitAcks: ["connection-state-2"],
      outcome: "ok",
    });
    expect(duplicateResult).toMatchObject({
      explicitAcks: ["connection-state-3"],
      outcome: "ok",
    });
    expect(await listed.json()).toMatchObject({
      whatsapp_connections: [
        {
          id: "con_000000000000000000018",
          state: "degraded",
          state_changed_at: "2026-01-02T03:08:00.000Z",
        },
      ],
    });
  });

  test("sweeps an orphaned ingress object and converges later provider redelivery", async () => {
    const endpoint =
      "https://api.example.test/webhooks/wasender/30000000-0000-4000-8000-000000000018";
    const payload = JSON.stringify({
      data: { status: "connected" },
      event: "session.status",
      sessionId: "test-session-credential",
      timestamp: 1_767_323_400_000,
    });
    const deliver = (failure?: string) =>
      exports.default.fetch(
        new Request(endpoint, {
          body: payload,
          headers: {
            "content-type": "application/json",
            "x-test-failure": failure ?? "",
            "x-webhook-signature": "test-webhook-secret",
          },
          method: "POST",
        }),
      );
    const published = async () =>
      (await (
        await exports.default.fetch(
          "https://api.example.test/test/webhook-queue",
        )
      ).json()) as ReadonlyArray<Record<string, unknown>>;
    const consume = async (
      body: Record<string, unknown>,
      id: string,
      queue = "whatsapp-mcp-ingestion",
    ) => {
      const batch = createMessageBatch(queue, [
        {
          attempts: 1,
          body,
          id,
          timestamp: new Date("2026-01-02T03:10:00.000Z"),
        },
      ]);
      const context = createExecutionContext();
      await worker.queue?.(batch, env, context);
      return getQueueResult(batch, context);
    };
    const objectsBefore = await env.WEBHOOK_INGRESS.list({
      prefix: "webhook-events/",
    });

    const failedPublication = await deliver("webhook-queue");
    const objectsAfter = await env.WEBHOOK_INGRESS.list({
      prefix: "webhook-events/",
    });
    const orphan = objectsAfter.objects.find(
      ({ key }) => !objectsBefore.objects.some((before) => before.key === key),
    );
    if (orphan === undefined) throw new Error("missing orphaned ingress");
    const orphanId = orphan.key.slice("webhook-events/".length);

    const controller = createScheduledController({
      cron: "* * * * *",
      scheduledTime: orphan.uploaded.valueOf() + 60_000,
    });
    const context = createExecutionContext();
    await worker.scheduled?.(controller, env, context);
    await waitOnExecutionContext(context);
    const recovered = (await published()).find(
      (message) => message.object_id === orphanId,
    );
    if (recovered === undefined) throw new Error("orphan was not recovered");
    const recoveredResult = await consume(recovered, "recovered-ingress");

    const redelivery = await deliver();
    const redeliveredMessage = (await published()).at(-1);
    if (redeliveredMessage === undefined) {
      throw new Error("redelivery was not published");
    }
    const redeliveryResult = await consume(
      redeliveredMessage,
      "provider-redelivery",
    );

    expect(failedPublication.status).toBe(503);
    expect(redelivery.status).toBe(200);
    expect(recoveredResult).toMatchObject({
      explicitAcks: ["recovered-ingress"],
      outcome: "ok",
    });
    expect(redeliveryResult).toMatchObject({
      explicitAcks: ["provider-redelivery"],
      outcome: "ok",
    });
  });

  test("actively records and acknowledges exhausted ingestion work from DLQ", async () => {
    const ingress = await exports.default.fetch(
      new Request(
        "https://api.example.test/webhooks/wasender/30000000-0000-4000-8000-000000000018",
        {
          body: JSON.stringify({
            data: { status: "degraded" },
            event: "session.status",
            sessionId: "test-session-credential",
            timestamp: 1_767_323_460_000,
          }),
          headers: {
            "content-type": "application/json",
            "x-webhook-signature": "test-webhook-secret",
          },
          method: "POST",
        },
      ),
    );
    const messages = (await (
      await exports.default.fetch("https://api.example.test/test/webhook-queue")
    ).json()) as ReadonlyArray<Record<string, unknown>>;
    const message = messages.at(-1);
    if (message === undefined) throw new Error("missing Webhook Event fixture");
    const batch = createMessageBatch("whatsapp-mcp-ingestion-dlq", [
      {
        attempts: 1,
        body: message,
        id: "dead-letter-ingress",
        timestamp: new Date("2026-01-03T00:00:00.000Z"),
      },
    ]);
    const context = createExecutionContext();

    await worker.queue?.(batch, env, context);
    const result = await getQueueResult(batch, context);
    const recorded = (await (
      await exports.default.fetch(
        "https://api.example.test/test/webhook-dead-letters",
      )
    ).json()) as ReadonlyArray<string>;

    expect(ingress.status).toBe(200);
    expect(result).toMatchObject({
      explicitAcks: ["dead-letter-ingress"],
      outcome: "ok",
    });
    expect(recorded).toContain(message.object_id);
  });

  test("audits an opaque immutable replay and routes its canonical source through normal ingestion", async () => {
    const ingress = await exports.default.fetch(
      new Request(
        "https://api.example.test/webhooks/wasender/30000000-0000-4000-8000-000000000018",
        {
          body: JSON.stringify({
            data: { status: "connected" },
            event: "session.status",
            sessionId: "test-session-credential",
            timestamp: 1_767_323_460_000,
          }),
          headers: {
            "content-type": "application/json",
            "x-webhook-signature": "test-webhook-secret",
          },
          method: "POST",
        },
      ),
    );
    const beforeReplay = (await (
      await exports.default.fetch("https://api.example.test/test/webhook-queue")
    ).json()) as ReadonlyArray<Record<string, unknown>>;
    const canonical = beforeReplay.at(-1);
    if (canonical === undefined) throw new Error("missing replay source");
    const deadLetter = createMessageBatch("whatsapp-mcp-ingestion-dlq", [
      {
        attempts: 8,
        body: canonical,
        id: "dead-letter-replay-source",
        timestamp: new Date("2026-01-03T00:00:00.000Z"),
      },
    ]);
    const deadLetterContext = createExecutionContext();
    await worker.queue?.(deadLetter, env, deadLetterContext);
    await getQueueResult(deadLetter, deadLetterContext);

    const requestId = "60000000-0000-4000-8000-000000000018";
    const replay = createMessageBatch("whatsapp-mcp-ingestion-replay", [
      {
        attempts: 1,
        body: {
          incident_reference: "50000000-0000-4000-8000-000000000018",
          operator_reference: "b".repeat(64),
          reason_code: "dependency_recovered",
          request_id: requestId,
          requested_at: "2026-01-03T00:00:00.000Z",
          version: 1,
        },
        id: "immutable-replay-request",
        timestamp: new Date("2026-01-03T00:00:00.000Z"),
      },
    ]);
    const replayContext = createExecutionContext();
    await worker.queue?.(replay, env, replayContext);
    const replayResult = await getQueueResult(replay, replayContext);
    const afterReplay = (await (
      await exports.default.fetch("https://api.example.test/test/webhook-queue")
    ).json()) as ReadonlyArray<Record<string, unknown>>;
    const attempts = (await (
      await exports.default.fetch(
        "https://api.example.test/test/webhook-replay-attempts",
      )
    ).json()) as ReadonlyArray<Record<string, unknown>>;

    expect(ingress.status).toBe(200);
    expect(replayResult).toMatchObject({
      explicitAcks: ["immutable-replay-request"],
      outcome: "ok",
    });
    expect(afterReplay.at(-1)).toEqual(canonical);
    expect(attempts).toContainEqual({
      requestId,
      status: "dispatched",
    });

    const normal = createMessageBatch("whatsapp-mcp-ingestion", [
      {
        attempts: 1,
        body: afterReplay.at(-1),
        id: "normal-replay-ingestion",
        timestamp: new Date("2026-01-03T00:00:01.000Z"),
      },
    ]);
    const normalContext = createExecutionContext();
    await worker.queue?.(normal, env, normalContext);
    expect(await getQueueResult(normal, normalContext)).toMatchObject({
      explicitAcks: ["normal-replay-ingestion"],
      outcome: "ok",
    });
  });

  test("removes an expired dead-letter source through the hourly Worker boundary", async () => {
    const ingress = await exports.default.fetch(
      new Request(
        "https://api.example.test/webhooks/wasender/30000000-0000-4000-8000-000000000018",
        {
          body: JSON.stringify({
            data: { status: "connected" },
            event: "session.status",
            sessionId: "test-session-credential",
            timestamp: 1_767_323_520_000,
          }),
          headers: {
            "content-type": "application/json",
            "x-webhook-signature": "test-webhook-secret",
          },
          method: "POST",
        },
      ),
    );
    const published = (await (
      await exports.default.fetch("https://api.example.test/test/webhook-queue")
    ).json()) as ReadonlyArray<Record<string, unknown>>;
    const canonical = published.at(-1);
    if (
      canonical === undefined ||
      typeof canonical.object_id !== "string" ||
      typeof canonical.received_at !== "string"
    ) {
      throw new Error("missing retention source");
    }
    const objectKey = `webhook-events/${canonical.object_id}`;
    const deadLetter = createMessageBatch("whatsapp-mcp-ingestion-dlq", [
      {
        attempts: 8,
        body: canonical,
        id: "dead-letter-retention-source",
        timestamp: new Date(canonical.received_at),
      },
    ]);
    const deadLetterContext = createExecutionContext();
    await worker.queue?.(deadLetter, env, deadLetterContext);
    await getQueueResult(deadLetter, deadLetterContext);

    expect(ingress.status).toBe(200);
    expect(await env.WEBHOOK_INGRESS.get(objectKey)).not.toBeNull();

    const controller = createScheduledController({
      cron: "0 * * * *",
      scheduledTime:
        Date.parse(canonical.received_at) + 7 * 24 * 60 * 60 * 1_000,
    });
    const retentionContext = createExecutionContext();
    await worker.scheduled?.(controller, env, retentionContext);
    await waitOnExecutionContext(retentionContext);

    expect(await env.WEBHOOK_INGRESS.get(objectKey)).toBeNull();
  });

  test("routes an invalid ingestion message through the Webhook Event consumer", async () => {
    const batch = createMessageBatch("whatsapp-mcp-ingestion", [
      {
        attempts: 1,
        body: { object_id: "evt_public_boundary" },
        id: "queue-message-1",
        timestamp: new Date("2026-01-02T03:04:05.000Z"),
      },
    ]);
    const context = createExecutionContext();

    await worker.queue?.(batch, env, context);
    const result = await getQueueResult(batch, context);

    expect(result).toMatchObject({
      ackAll: false,
      explicitAcks: ["queue-message-1"],
      outcome: "ok",
    });
    expect(await env.OAUTH_KV.get("queue:queue-message-1")).toBeNull();
  });

  test("runs scheduled handlers against real KV and service bindings", async () => {
    const controller = createScheduledController({
      cron: "*/5 * * * *",
      scheduledTime: new Date("2026-01-02T03:05:00.000Z").valueOf(),
    });
    const context = createExecutionContext();

    await worker.scheduled?.(controller, env, context);
    await waitOnExecutionContext(context);

    expect(await env.OAUTH_KV.get("scheduled:last")).toBe(
      "2026-01-02T03:05:00.000Z",
    );
    expect(await env.OAUTH_KV.get("scheduled:provider-control")).toBe("ok");
  });
});
