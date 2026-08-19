import { describe, expect, test } from "vitest";
import {
  SafeTelemetryViolation,
  serializeSafeTelemetry,
} from "../src/safe-telemetry";

const sensitive = {
  messageText: "private message text",
  mediaBytes: new Uint8Array([115, 101, 99, 114, 101, 116]),
  phoneNumber: "+15550199999",
  contact: { name: "Private Person", email: "private@example.test" },
  credential: "provider-api-credential-value",
  oauthToken: "oauth-token-value",
  providerPayload: { remoteJid: "15550199999@s.whatsapp.net" },
  providerIdentifier: "provider-session-123",
};

describe("safe telemetry serialization", () => {
  test.each(["success", "execution_error", "service_unavailable"] as const)(
    "emits only the event allowlist on the %s path",
    (outcome) => {
      const serialized = serializeSafeTelemetry({
        event: "mcp.tool_call.completed",
        outcome,
        resultCount: 1,
        service: "api",
        tool: "read_messages",
        ...sensitive,
      });

      expect(JSON.parse(serialized)).toEqual({
        event: "mcp.tool_call.completed",
        outcome,
        resultCount: 1,
        service: "api",
        tool: "read_messages",
      });
      for (const value of [
        sensitive.messageText,
        sensitive.phoneNumber,
        sensitive.credential,
        sensitive.oauthToken,
        sensitive.providerIdentifier,
        sensitive.providerPayload.remoteJid,
      ]) {
        expect(serialized).not.toContain(value);
      }
    },
  );

  test("rejects malformed and unknown event kinds without echoing input", () => {
    for (const event of [null, {}, { event: sensitive.credential }]) {
      let caught: unknown;
      try {
        serializeSafeTelemetry(event);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SafeTelemetryViolation);
      expect(String(caught)).toBe("SafeTelemetryViolation: telemetry.event");
      expect(String(caught)).not.toContain(sensitive.credential);
    }
  });

  test("allows a stage-only MCP failure diagnostic", () => {
    expect(
      JSON.parse(
        serializeSafeTelemetry({
          event: "mcp.tool_call.completed",
          failureStage: "decryption",
          outcome: "service_unavailable",
          service: "api",
          tool: "list_chats",
        }),
      ),
    ).toEqual({
      event: "mcp.tool_call.completed",
      failureStage: "decryption",
      outcome: "service_unavailable",
      service: "api",
      tool: "list_chats",
    });
  });

  test("keeps connection setup timing fields on the allowlist", () => {
    expect(
      JSON.parse(
        serializeSafeTelemetry({
          event: "connection_setup.provision.claimed",
          queueDelayMs: 42,
          service: "api",
        }),
      ),
    ).toEqual({
      event: "connection_setup.provision.claimed",
      queueDelayMs: 42,
      service: "api",
    });
    expect(
      JSON.parse(
        serializeSafeTelemetry({
          durationMs: 84,
          event: "connection_setup.provision.completed",
          outcome: "provisioned",
          service: "api",
        }),
      ),
    ).toEqual({
      durationMs: 84,
      event: "connection_setup.provision.completed",
      outcome: "provisioned",
      service: "api",
    });
  });

  test("drops credential material added to timeout and break-glass-shaped events", () => {
    const serialized = serializeSafeTelemetry({
      event: "provider.text_send.completed",
      attemptCount: 1,
      durationMs: 30_000,
      operationClass: "text-send",
      outcome: "ambiguous",
      responseBytes: null,
      service: "api",
      authorization: `Bearer ${sensitive.oauthToken}`,
      encryptionKey: sensitive.credential,
      webhookBody: sensitive.providerPayload,
      mediaUrl: "https://provider.example/private-media",
      qrData: "private-qr-data",
    });
    expect(JSON.parse(serialized)).toEqual({
      event: "provider.text_send.completed",
      attemptCount: 1,
      durationMs: 30_000,
      operationClass: "text-send",
      outcome: "ambiguous",
      responseBytes: null,
      service: "api",
    });
  });

  test("rejects non-scalar values in allowlisted fields without serializing them", () => {
    let serialized = false;
    const maliciousOutcome = {
      toJSON: () => {
        serialized = true;
        return sensitive;
      },
    };

    let caught: unknown;
    try {
      serializeSafeTelemetry({
        event: "mcp.tool_call.completed",
        outcome: maliciousOutcome,
        service: "api",
        tool: "read_messages",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SafeTelemetryViolation);
    expect(String(caught)).toBe("SafeTelemetryViolation: telemetry.outcome");
    expect(String(caught)).not.toContain(sensitive.credential);
    expect(serialized).toBe(false);
  });
});
