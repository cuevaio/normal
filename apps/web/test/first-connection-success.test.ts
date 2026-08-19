import { describe, expect, test } from "bun:test";
import {
  getFirstConnectionSuccessModel,
  type IntendedMcpClient,
} from "../src/app/first-connection-onboarding";

const activeConnection = {
  displayName: "Verified WhatsApp",
  numberSuffix: "7890",
  retentionDays: 30,
  state: "connected" as const,
};

describe("first-connection success model", () => {
  test("does not report a missing connection as success", () => {
    expect(getFirstConnectionSuccessModel(null, "claude")).toBeNull();
  });

  test.each([
    ["connecting", "connecting"],
    ["degraded", "degraded"],
    ["deleting", "deleting"],
    ["disconnected", "disconnected"],
    ["reconnect_required", "reconnect_required"],
  ] as const)("does not report %s connection data as success", (_, state) => {
    expect(
      getFirstConnectionSuccessModel({ ...activeConnection, state }, "claude"),
    ).toBeNull();
  });

  test("uses the confirmed active connection identity and success copy", () => {
    const model = getFirstConnectionSuccessModel(activeConnection, "claude");

    expect(model?.connection).toEqual(activeConnection);
    expect(model?.authorizationCopy).toBe(
      "Claude still needs its own MCP Authorization for this WhatsApp Connection.",
    );
    expect(model?.nextStepCopy).toBe(
      "Create the MCP Authorization in Claude next so it can access only the WhatsApp Connections and permissions you choose.",
    );
  });

  test.each([
    ["claude", "Claude", "https://claude.ai/settings/connectors"],
    ["chatgpt", "ChatGPT", "https://chatgpt.com/plugins"],
    ["other", "your MCP Client", null],
    ["not_sure", "your MCP Client", null],
  ] satisfies ReadonlyArray<
    readonly [IntendedMcpClient, string, string | null]
  >)("selects the correct next action for %s", (client, name, href) => {
    const model = getFirstConnectionSuccessModel(activeConnection, client);

    expect(model?.clientName).toBe(name);
    expect(model?.nextActionHref).toBe(href);
    expect(model?.authorizationCopy).toStartWith(
      `${name} still needs its own MCP Authorization`,
    );
  });
});
