import { expect, test } from "@playwright/test";
import { installClerkBrowser } from "../support/clerk-browser";

const apiPort = process.env.PLAYWRIGHT_API_PORT ?? "8787";
const webOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_PORT ?? "3000"}`;
const connectionId = "con_123456789012345678901";
const disconnectedId = "con_123456789012345678902";

test("creates, lists, and revokes an API Key across the browser-to-API boundary", async ({
  context,
  page,
  request,
}) => {
  let createRequests = 0;
  let failKeysListAfterCreate = true;
  const tokenRequests: Array<unknown> = [];
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
    if (
      /^\/v1\/whatsapp-connections\/con_[A-Za-z0-9_-]{21}\/retention-policy$/u.test(
        requestPath,
      ) &&
      original.method() === "GET"
    ) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          allowed_days: [7, 30, 90],
          policy: { days: 30 },
        }),
      });
      return;
    }
    if (requestPath === "/v1/api-keys" && original.method() === "POST") {
      createRequests += 1;
    }
    if (
      requestPath === "/v1/api-keys" &&
      original.method() === "GET" &&
      createRequests > 0 &&
      failKeysListAfterCreate
    ) {
      failKeysListAfterCreate = false;
      await route.fulfill({
        body: JSON.stringify({ error: "unavailable" }),
        contentType: "application/json",
        status: 503,
      });
      return;
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
  await installClerkBrowser(page, {
    onTokenRequest: (options) => tokenRequests.push(options),
    signedIn: true,
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: webOrigin,
  });
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
  await panel.getByRole("checkbox", { name: "Send messages" }).check();
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
  expect(tokenRequests).toContainEqual({ skipCache: true });
  await expect(panel).not.toContainText("temporarily unavailable");
  await expect(panel.getByRole("heading", { name: "CI" })).toBeVisible();
  await expect(panel.getByTestId("api-key-state")).toHaveText("Active");

  const curlCommand = reveal.getByLabel("Send message curl command");
  await reveal.getByLabel("Recipient phone").fill("+12025550199");
  await expect(curlCommand).toContainText(
    `/v1/connections/${connectionId}/send-operations`,
  );
  await expect(curlCommand).toContainText("Bearer $NORMAL_API_KEY");
  await expect(curlCommand).toContainText('"text": "Hello from Normal API"');
  await reveal
    .getByRole("checkbox", { name: "Include API Key in command" })
    .check();
  await expect(curlCommand).toContainText(`Bearer ${plaintext}`);
  await reveal.getByRole("button", { name: "Copy cURL" }).click();
  await expect(
    reveal.getByRole("button", { name: "Copied cURL" }),
  ).toBeVisible();

  const listed = await request.get(
    `http://127.0.0.1:${apiPort}/v1/connections`,
    {
      headers: {
        authorization: `Bearer ${plaintext}`,
      },
    },
  );
  expect(listed.status()).toBe(200);
  expect(listed.headers()["access-control-allow-origin"]).toBeUndefined();
  expect(await listed.json()).toEqual({
    data: [
      {
        connection_id: connectionId,
        display_name: "Personal WhatsApp",
        number_last_four: "3456",
        state: "connected",
        state_changed_at: "2026-08-14T12:00:00.000Z",
      },
    ],
    pagination: { has_more: false, next_cursor: null },
  });

  await page.getByRole("link", { name: "Activity Log" }).click();
  await expect(page).toHaveURL(/\/dashboard\/activity$/u);
  await expect(
    page.getByRole("region", { name: "Activity Log" }),
  ).toContainText("API Key · CI");
  await expect(page.getByTestId("activity-log").first()).toContainText(
    "list connections",
  );

  await page.goto("/dashboard/api-keys");
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

test("renders expired and revoked API Key dashboard states without recovery", async ({
  page,
}) => {
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
          ],
        }),
      });
      return;
    }
    if (requestPath === "/v1/api-keys" && original.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          api_keys: [
            {
              connection_ids: [connectionId],
              created_at: "2026-08-14T12:00:00.000Z",
              credential_hint: "normal_apk_123456789012345678901.…wxyz",
              expires_at: "2026-08-14T13:00:00.000Z",
              id: "apk_123456789012345678901",
              last_used_at: "2026-08-14T12:30:00.000Z",
              name: "Temporary",
              permissions: ["connections:read"],
              revoked_at: null,
              state: "expired",
            },
            {
              connection_ids: [connectionId],
              created_at: "2026-08-14T11:00:00.000Z",
              credential_hint: "normal_apk_123456789012345678902.…abcd",
              expires_at: null,
              id: "apk_123456789012345678902",
              last_used_at: null,
              name: "Retired",
              permissions: ["messages:send"],
              revoked_at: "2026-08-14T12:05:00.000Z",
              state: "revoked",
            },
          ],
        }),
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({ error: "not_found" }),
      contentType: "application/json",
      status: 404,
    });
  });
  await installClerkBrowser(page, { signedIn: true });
  await page.goto("/dashboard/api-keys");

  const panel = page.getByRole("region", { name: "API Keys" });
  await expect(panel.getByRole("heading", { name: "Temporary" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Retired" })).toBeVisible();
  await expect(panel.getByTestId("api-key-state")).toHaveText([
    "Expired",
    "Revoked",
  ]);
  await expect(
    panel.getByRole("button", { name: "Revoke Temporary" }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "Revoke Retired" }),
  ).toBeDisabled();
  await expect(panel.getByLabel("New API Key credential")).toHaveCount(0);
  await expect(panel).toContainText("normal_apk_123456789012345678901.…wxyz");
  await expect(panel).not.toContainText(
    "normal_apk_123456789012345678901.abcdefghijklmnopqrstuvwxyz0123456789ABC",
  );
});
