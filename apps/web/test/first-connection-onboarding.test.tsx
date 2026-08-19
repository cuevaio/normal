import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildVerificationPromptCopy,
  FirstConnectionOnboarding,
  type OnboardingProfile,
} from "../src/app/first-connection-onboarding";

const completedProfile: OnboardingProfile = {
  completedAt: "2026-08-18T12:00:00.000Z",
  createdAt: "2026-08-18T12:00:00.000Z",
  intendedMcpClient: "chatgpt",
  primaryUseCase: "conversation_search",
  researchCallInterest: "yes",
  role: "engineer",
  updatedAt: "2026-08-18T12:00:00.000Z",
  whatsappUsageContext: "personal",
};

describe("first-connection onboarding verification prompt", () => {
  test("builds client-specific read-only prompt copy without a full number", () => {
    const connection = {
      displayName: "Personal WhatsApp",
      numberSuffix: "3456",
      retentionDays: 30,
    } as const;

    const claude = buildVerificationPromptCopy("claude", connection);
    expect(claude.spanishPrompt).toContain("Usa Normal");
    expect(claude.spanishPrompt).toContain("solo en modo de lectura");
    expect(claude.spanishPrompt).toContain("Personal WhatsApp");
    expect(claude.spanishPrompt).toContain("terminada en 3456");
    expect(claude.spanishPrompt).not.toContain("@normal");
    expect(claude.spanishPrompt).not.toContain("555");

    const chatgpt = buildVerificationPromptCopy("chatgpt", connection);
    expect(chatgpt.spanishPrompt).toContain("Usa el conector Normal");
    expect(chatgpt.spanishPrompt).toContain("autorización de ChatGPT");
    expect(chatgpt.englishPrompt).toContain("read-only check");
    expect(chatgpt.englishPrompt).toContain("number suffix only");
    expect(chatgpt.englishPrompt).not.toContain("+1 (555) 012-3456");
  });

  test("distinguishes authorization selection from lifecycle reconnection", () => {
    const copy = buildVerificationPromptCopy("chatgpt", {
      displayName: "Personal WhatsApp",
      numberSuffix: "3456",
      retentionDays: 30,
    });

    expect(copy.missingConnectionHelp).toContain(
      "revise the existing MCP Authorization or create a new one",
    );
    expect(copy.missingConnectionHelp).toContain("explicitly selects");
    expect(copy.missingConnectionHelp).not.toContain("Reconnect");
    expect(copy.unavailableConnectionHelp).toContain(
      "Reconnect in Normal only",
    );
    expect(copy.unavailableConnectionHelp).toContain(
      "lifecycle state is unavailable",
    );
    expect(copy.englishPrompt).toContain(
      "active connection is missing from the results",
    );
    expect(copy.englishPrompt).toContain(
      "Recommend reconnecting it in Normal only if it is listed as unavailable",
    );
  });

  test("renders the selected client prompt for Claude and ChatGPT with suffix-only expectations", () => {
    for (const intendedMcpClient of ["claude", "chatgpt"] as const) {
      const html = renderToStaticMarkup(
        <FirstConnectionOnboarding
          connectedConnection={{
            displayName: "Personal WhatsApp",
            numberSuffix: "3456",
            retentionDays: 30,
            state: "connected",
          }}
          getToken={async () => null}
          initialProfile={{
            ...completedProfile,
            intendedMcpClient,
          }}
          mcpServerUrl="https://api.example.test/mcp"
          onboardingProfileEndpoint="https://api.example.test/v1/personal-account/onboarding-profile"
          onComplete={() => undefined}
          onProfileSaved={() => undefined}
          setupForm={{
            connectionName: "",
            onCancelSetup: () => undefined,
            onConnectionNameChange: () => undefined,
            onResetSetup: () => undefined,
            onStartSetup: () => undefined,
            onWhatsappNumberChange: () => undefined,
            qrImageUrl: null,
            setupCleanupState: null,
            setupId: null,
            setupState: "connected",
            whatsappNumber: "",
          }}
        />,
      );

      expect(html).toContain(
        `Verify ${intendedMcpClient === "claude" ? "Claude" : "ChatGPT"} can see this WhatsApp Connection`,
      );
      expect(html).toContain("Spanish prompt");
      expect(html).toContain("English equivalent");
      expect(html).toContain("Personal WhatsApp, número terminado en 3456.");
      expect(html).toContain("Personal WhatsApp, number ending in 3456.");
      expect(html).toContain("never the full WhatsApp Number");
      expect(html).toContain(
        "revise the existing MCP Authorization or create a new one",
      );
      expect(html).toContain("Reconnect in Normal only when");
      expect(html).toContain("/dashboard/authorizations");
      expect(html).toContain("/dashboard/connections");
      expect(html).not.toContain("+1 (555) 012-3456");
    }
  });
});
