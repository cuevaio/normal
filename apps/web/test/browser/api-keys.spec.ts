import { expect, test } from "@playwright/test";
import { installClerkBrowser } from "../support/clerk-browser";

const apiPort = process.env.PLAYWRIGHT_API_PORT ?? "8787";
const webOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_PORT ?? "3000"}`;
const connectionId = "con_123456789012345678901";
const disconnectedId = "con_123456789012345678902";

test("creates, lists, and revokes an API Key across the browser-to-API boundary", async ({
  page,
  request,
}) => {
  let createRequests = 0;
  await page.route("https://api.example.test/**", async (route) => {
    const original = route.request();
    const requestPath = new URL(original.url()).pathname;
    if (
      requestPath === "/v1/whatsapp-connections" &&
      original.method() === "GET"
    ) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          whatsapp_connections: [
            {
              display_name: "Personal WhatsApp",
              id: connectionId,
              number_suffix: "3456",
              state: "connected",
              state_changed_at: "2026-08-14T12:00:00.000Z",
            },
            {
              display_name: "Work WhatsApp",
              id: disconnectedId,
              number_suffix: "7890",
              state: "disconnected",
              state_changed_at: "2026-08-14T12:00:00.000Z",
            },
          ],
        }),
      });
      return;
    }
    if (requestPath === "/v1/api-keys" && original.method() === "POST") {
      createRequests += 1;
    }
    const localUrl = new URL(original.url());
    localUrl.protocol = "http:";
    localUrl.hostname = "127.0.0.1";
    localUrl.port = apiPort;
    const response = await request.fetch(localUrl.toString(), {
      data: original.postDataBuffer(),
      headers: {
        ...original.headers(),
        origin: "http://127.0.0.1:3000",
      },
      method: original.method(),
    });
    await route.fulfill({
      body: await response.body(),
      headers: {
        ...response.headers(),
        "access-control-allow-origin": webOrigin,
      },
      status: response.status(),
    });
  });
  await installClerkBrowser(page, { signedIn: true });
  await page.goto("/dashboard/api-keys");

  const panel = page.getByRole("region", { name: "API Keys" });
  await expect(
    page.getByRole("heading", { level: 1, name: "API Keys" }),
  ).toBeVisible();
  await expect(panel).toBeVisible();
  await expect(panel.getByText("No API Keys yet.")).toBeVisible();
  await expect(
    panel.getByRole("checkbox", {
      name: "Work WhatsApp, ending in 7890",
    }),
  ).toBeVisible();

  await panel.getByLabel("Name").fill("CI");
  await panel.getByRole("checkbox", { name: "Connection metadata" }).check();
  await panel
    .getByRole("checkbox", {
      name: "Personal WhatsApp, ending in 3456",
    })
    .check();
  await panel.getByRole("button", { name: "Create API Key" }).click();

  const reveal = panel.getByLabel("New API Key credential");
  await expect(reveal).toBeVisible();
  await expect(reveal).toContainText("normal_apk_");
  const plaintext = await reveal.locator("p.font-mono").textContent();
  expect(plaintext).toMatch(
    /^normal_apk_[A-Za-z0-9_-]{21}\.[A-Za-z0-9_-]{43}$/u,
  );
  expect(createRequests).toBe(1);

  await page.reload();
  await expect(page.getByRole("region", { name: "API Keys" })).toContainText(
    "CI",
  );
  await expect(
    page.getByRole("region", { name: "API Keys" }),
  ).not.toContainText(plaintext ?? "must-not-redisplay");
  await expect(page.getByLabel("New API Key credential")).toHaveCount(0);

  await page
    .getByRole("region", { name: "API Keys" })
    .getByRole("button", { name: "Revoke CI" })
    .click();
  await expect(page.getByTestId("api-key-state")).toHaveText("Revoked");
  await expect(page.getByRole("button", { name: "Revoke CI" })).toBeDisabled();
});
