import { expect, type Page, test } from "@playwright/test";
import { installClerkBrowser } from "../support/clerk-browser";

const choose = async (page: Page, label: string, option: string) => {
  const onboarding = page.getByTestId("first-connection-onboarding");
  await onboarding.getByLabel(label, { exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
};

const reachActiveConnection = async (page: Page, client: string) => {
  const onboarding = page.getByTestId("first-connection-onboarding");
  await expect(onboarding).toBeVisible();
  await onboarding.getByRole("button", { name: "Continue" }).click();
  await choose(page, "Primary use case", "Search WhatsApp Conversations");
  await choose(page, "WhatsApp usage context", "Personal");
  await choose(page, "Role", "Engineer");
  await choose(page, "Intended MCP Client", client);
  await choose(page, "Interested in a short research call?", "No");
  await onboarding.getByRole("button", { name: "Save and continue" }).click();
  await onboarding
    .getByRole("button", { name: "Continue to Connection Setup" })
    .click();
  await onboarding.getByLabel("Name", { exact: true }).fill("Setup draft name");
  await onboarding.getByLabel("WhatsApp number").fill("+1 (555) 012-3456");
  await onboarding
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "WhatsApp Connection active" }),
  ).toBeVisible({ timeout: 15_000 });

  return onboarding;
};

test.beforeEach(async ({ page }) => {
  let connectionActive = false;
  await page.route("https://api.example.test/**", async (route) => {
    const original = route.request();
    const path = new URL(original.url()).pathname;
    if (path === "/v1/personal-account/bootstrap") {
      await route.fulfill({
        json: {
          personal_account: {
            message_retention_days: 30,
            state: "active",
            stored_media_limit_bytes: 5_368_709_120,
            whatsapp_connection_limit: 3,
          },
        },
      });
      return;
    }
    if (path === "/v1/whatsapp-connections") {
      await route.fulfill({
        json: {
          whatsapp_connections: connectionActive
            ? [
                {
                  display_name: "Verified WhatsApp",
                  id: "con_123456789012345678901",
                  number_suffix: "3456",
                  state: "connected",
                  state_changed_at: "2026-08-18T20:00:00.000Z",
                },
              ]
            : [],
        },
      });
      return;
    }
    if (path.endsWith("/retention-policy")) {
      await route.fulfill({
        json: { allowed_days: [7, 30, 90], policy: { days: 30 } },
      });
      return;
    }
    if (
      path === "/v1/personal-account/onboarding-profile" &&
      original.method() === "GET"
    ) {
      await route.fulfill({ json: { profile: null } });
      return;
    }
    if (
      path === "/v1/personal-account/onboarding-profile" &&
      original.method() === "PUT"
    ) {
      await route.fulfill({
        json: {
          profile: {
            ...original.postDataJSON(),
            completed_at: "2026-08-18T20:00:00.000Z",
            created_at: "2026-08-18T20:00:00.000Z",
            updated_at: "2026-08-18T20:00:00.000Z",
          },
        },
      });
      return;
    }
    if (path === "/v1/connection-setups" && original.method() === "POST") {
      connectionActive = true;
      await route.fulfill({
        json: {
          connection_setup: {
            expires_at: "2026-08-18T20:15:00.000Z",
            id: "cst_123456789012345678901",
            idempotent_replay: false,
            state: "activated",
          },
        },
      });
      return;
    }
    await route.fulfill({
      json: { error: "not_available_in_focused_test" },
      status: 503,
    });
  });
  await installClerkBrowser(page, { signedIn: true });
});

const clientCases = [
  {
    client: "ChatGPT",
    clientName: "ChatGPT",
    href: "https://chatgpt.com/plugins",
  },
  { client: "Another MCP Client", clientName: "your MCP Client", href: null },
  { client: "Not sure yet", clientName: "your MCP Client", href: null },
] as const;

for (const { client, clientName, href } of clientCases) {
  test(`shows the active identity and correct ${client} next action`, async ({
    page,
  }) => {
    await page.goto("/dashboard/connections");
    const onboarding = await reachActiveConnection(page, client);

    await expect(onboarding).toContainText(
      "Your WhatsApp Connection is active.",
    );
    await expect(onboarding).toContainText(
      `${clientName} still needs its own MCP Authorization for this WhatsApp Connection.`,
    );
    await expect(onboarding).toContainText("NameVerified WhatsApp");
    await expect(onboarding).toContainText("Active WhatsApp Numberending 3456");
    await expect(onboarding).toContainText(
      "Normal observes supported WhatsApp Conversations from activation forward. Earlier WhatsApp history is not imported.",
    );
    await expect(onboarding).toContainText(
      `Create the MCP Authorization in ${clientName} next so it can access only the WhatsApp Connections and permissions you choose.`,
    );

    if (href !== null) {
      await expect(
        onboarding.getByRole("link", { name: `Open ${clientName}` }).first(),
      ).toHaveAttribute("href", href);
      await expect(
        onboarding.getByRole("heading", {
          name: `Connect Normal to ${clientName}`,
        }),
      ).toBeVisible();
    } else {
      await expect(
        onboarding.getByRole("link", { name: /^Open /u }),
      ).toHaveCount(0);
      await expect(
        onboarding.getByRole("button", { name: "Copy MCP server URL" }),
      ).toHaveCount(2);
    }
  });
}
