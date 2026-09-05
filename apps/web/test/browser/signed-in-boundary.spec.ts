import { expect, test } from "@playwright/test";
import { installClerkBrowser } from "../support/clerk-browser";
import { expectSuccessToast } from "../support/toasts";

const apiPort = process.env.PLAYWRIGHT_API_PORT ?? "8787";
const webOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_PORT ?? "3000"}`;

// A failed journey must not retain the ephemeral QR response in a trace.
test.use({ trace: "off" });

test("drives the signed-in browser-to-API boundary over real HTTP", async ({
  page,
  request,
}) => {
  let requestedTokenOptions: unknown;
  let bootstrapMethod: string | undefined;
  let bootstrapRequests = 0;
  const analyticsEvents: Array<Record<string, unknown>> = [];
  const setupBodies: Array<{
    readonly idempotency_key: string;
    readonly name: string;
    readonly whatsapp_number: string;
  }> = [];
  let releaseFirstSetup: (() => void) | undefined;
  const firstSetupCanContinue = new Promise<void>((resolve) => {
    releaseFirstSetup = resolve;
  });
  let releaseFirstQr: (() => void) | undefined;
  const firstQrCanContinue = new Promise<void>((resolve) => {
    releaseFirstQr = resolve;
  });
  let reconnectRequests = 0;
  let renameRequests = 0;
  let retentionUpdateRequests = 0;
  let resumeReconnectPolling = false;
  let releaseReconnectPoll: (() => void) | undefined;
  const reconnectPollCanContinue = new Promise<void>((resolve) => {
    releaseReconnectPoll = resolve;
  });
  await page.route("https://analytics.example.test/**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      analyticsEvents.push(request.postDataJSON() as Record<string, unknown>);
    }
    await route.fulfill({
      body: "{}",
      headers: {
        "access-control-allow-headers": "content-type",
        "access-control-allow-origin": webOrigin,
      },
      status: 200,
    });
  });
  await page.route("https://api.example.test/**", async (route) => {
    const original = route.request();
    const requestPath = new URL(original.url()).pathname;
    if (requestPath === "/v1/personal-account/bootstrap") {
      bootstrapMethod = original.method();
      bootstrapRequests += 1;
    }
    if (
      requestPath === "/v1/connection-setups" &&
      original.method() === "POST"
    ) {
      setupBodies.push(original.postDataJSON());
      if (setupBodies.length === 1) {
        await firstSetupCanContinue;
      }
    }
    if (
      /^\/v1\/connection-setups\/cst_[A-Za-z0-9_-]{21}\/qr$/u.test(
        requestPath,
      ) &&
      original.method() === "GET"
    ) {
      await firstQrCanContinue;
    }
    if (
      /\/v1\/whatsapp-connections\/con_[A-Za-z0-9_-]{21}\/name$/u.test(
        requestPath,
      ) &&
      original.method() === "PUT"
    ) {
      renameRequests += 1;
    }
    if (
      /\/v1\/whatsapp-connections\/con_[A-Za-z0-9_-]{21}\/retention-policy$/u.test(
        requestPath,
      ) &&
      original.method() === "PUT"
    ) {
      retentionUpdateRequests += 1;
    }
    if (
      /^\/v1\/whatsapp-connections\/con_[A-Za-z0-9_-]{21}\/reconnect$/u.test(
        requestPath,
      ) &&
      original.method() === "POST"
    ) {
      reconnectRequests += 1;
      if (reconnectRequests > 1 && !resumeReconnectPolling) {
        await reconnectPollCanContinue;
      }
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
    onTokenRequest: (options) => {
      requestedTokenOptions = options;
    },
    signedIn: true,
  });
  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      name: "Your WhatsApp, inside ChatGPT and Claude.",
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Ask questions about your chats, find forgotten details, summarize busy groups, and draft replies without copying messages back and forth.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Log in" })).toHaveAttribute(
    "href",
    "/dashboard",
  );
  await expect(
    page.getByRole("region", { name: "Signed-in API boundary" }),
  ).toHaveCount(0);

  await page.goto("/dashboard");
  await expect(
    page.getByRole("navigation", { name: "Dashboard navigation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Preparing your Personal Account…")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Continue to Personal Account" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "MCP Authorizations" }),
  ).toHaveCount(0);

  await page.goto("/dashboard/authorizations");
  await expect(
    page.getByRole("navigation", { name: "Dashboard navigation" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard\/authorizations$/u);
  await expect(
    page.getByRole("heading", {
      name: "Connect Normal to Claude or ChatGPT",
    }),
  ).toBeVisible();
  const authorizations = page.getByRole("region", {
    name: "MCP Authorizations",
  });
  await expect(authorizations).toContainText("Approved MCP Client");
  await expect(authorizations).toContainText("con_123456789012345678901");
  await expect(authorizations).toContainText("Connection metadata");
  await expect(authorizations).toContainText("Send messages");
  await expect(authorizations).toContainText("Created");
  await expect(authorizations).toContainText("Expires");
  const authorizationState = authorizations.getByTestId(
    "mcp-authorization-state",
  );
  if ((await authorizationState.textContent()) === "Active") {
    await authorizations
      .getByRole("button", { name: "Revoke Approved MCP Client" })
      .click();
  }
  await expect(authorizationState).toHaveText("Revoked");
  await expect(
    authorizations.getByRole("button", {
      name: "Revoke Approved MCP Client",
    }),
  ).toBeDisabled();
  expect(requestedTokenOptions).toEqual({ template: "whatsapp-api" });
  expect(bootstrapMethod).toBe("POST");
  const bootstrapsAfterAuthorizations = bootstrapRequests;
  expect(bootstrapsAfterAuthorizations).toBeGreaterThanOrEqual(1);

  await page.getByRole("link", { name: "Activity Log" }).click();
  await expect(page).toHaveURL(/\/dashboard\/activity$/u);
  const activityLogs = page.getByRole("region", { name: "Activity Log" });
  const mcpLogs = activityLogs.getByTestId("activity-log").filter({
    hasText: "Approved MCP Client",
  });
  await expect(mcpLogs).toContainText("list connections");
  await expect(activityLogs).toContainText("Approved MCP Client");
  await expect(activityLogs).toContainText("success");
  await expect(activityLogs).toContainText("1");
  await expect(activityLogs).toContainText("120 ms");
  await expect(activityLogs).toContainText("mca_123456789012345678901");
  await expect(mcpLogs).not.toContainText(/message text|phone|provider/iu);
  await activityLogs.getByRole("button", { name: "Next page" }).click();
  await expect(mcpLogs).toHaveCount(2);
  await expect(activityLogs).toContainText("read messages");
  await expect(activityLogs).toContainText("Page 1 of 1");
  await activityLogs.getByRole("button", { name: "Sort by results" }).click();
  await expect(mcpLogs.first()).toContainText("list connections");
  await activityLogs.getByRole("button", { name: "Sort by results" }).click();
  await expect(mcpLogs.first()).toContainText("read messages");
  await activityLogs.getByLabel("Search Activity Log").fill("list connections");
  await expect(mcpLogs).toHaveCount(1);
  await expect(mcpLogs).toContainText("list connections");
  await activityLogs.getByLabel("Search Activity Log").fill("");
  await expect(mcpLogs).toHaveCount(2);

  await page
    .getByRole("button", { name: /Personal Account Signed in/u })
    .click();
  await expect(page.getByRole("menuitem", { name: "Log out" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/dashboard\/settings$/u);
  await expect(
    page.getByRole("region", { name: "Personal Account Deletion" }),
  ).toBeVisible();
  expect(bootstrapRequests).toBe(bootstrapsAfterAuthorizations);

  await page.getByRole("link", { name: "WhatsApp Connections" }).click();
  await expect(page).toHaveURL(/\/dashboard\/connections$/u);
  await expect(
    page.getByRole("button", { name: "Add WhatsApp number" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add WhatsApp number" }).click();
  const setup = page.getByRole("dialog", { name: "New WhatsApp Connection" });
  await expect(setup).toBeVisible();
  await setup.getByLabel("Name", { exact: true }).fill("Personal WhatsApp");
  const whatsappNumber = setup.getByLabel("WhatsApp number");
  const startConnectionSetup = setup.getByRole("button", {
    name: "Continue",
    exact: true,
  });
  await whatsappNumber.fill("+1 (555) 012-3456");
  await startConnectionSetup.click();
  await expect(setup.getByTestId("connection-setup-panel")).toBeVisible();
  await expect(page.getByTestId("connection-setup-status")).toHaveText(
    "Starting Connection Setup.",
  );
  await expect(whatsappNumber).toBeDisabled();
  await expect(startConnectionSetup).toBeDisabled();
  releaseFirstSetup?.();
  await expect(page.getByTestId("connection-setup-status")).toHaveText(
    "Connection Setup started. Preparing your QR code.",
  );
  await expect(startConnectionSetup).toBeDisabled();
  await expect(setup).toContainText("Preparing your QR code");
  await expect(
    page.getByRole("img", { name: "Scan this WhatsApp QR code" }),
  ).toHaveCount(0);
  await expect(setup).toBeVisible();
  releaseFirstQr?.();
  await expect(page.getByTestId("connection-setup-status")).toHaveText(
    "WhatsApp Connection active.",
    { timeout: 15_000 },
  );
  await expect
    .poll(() =>
      analyticsEvents.filter((capture) => {
        return capture.event === "connection_setup_started";
      }),
    )
    .toHaveLength(1);
  await expect
    .poll(() =>
      analyticsEvents.filter(
        (capture) =>
          capture.event === "connection_setup_completed" &&
          (capture.properties as Record<string, unknown> | undefined)
            ?.outcome === "success",
      ),
    )
    .toHaveLength(1);
  await expect
    .poll(() =>
      analyticsEvents.filter(
        (capture) =>
          capture.event === "feature_used" &&
          (capture.properties as Record<string, unknown> | undefined)
            ?.feature === "connection_setup_opened",
      ),
    )
    .toHaveLength(1);
  await expect(
    page.getByRole("img", { name: "Scan this WhatsApp QR code" }),
  ).toHaveCount(0);
  await setup.getByRole("button", { name: "Close" }).click();
  await expect(
    page.getByRole("navigation", { name: "Dashboard navigation" }),
  ).toBeVisible();
  await expect(
    page.getByText("1 currently connected or retained.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByTestId("whatsapp-connection")).toContainText(
    "Number ending 3456",
  );
  await expect(page.getByTestId("whatsapp-connection")).toContainText(
    "connected",
  );
  await expect(page.getByTestId("whatsapp-connection")).toContainText(
    "Personal WhatsApp",
  );
  await page.reload();
  await page.getByRole("link", { name: "Overview" }).click();
  const overview = page.getByRole("region", { name: "Account overview" });
  await expect(overview).toBeVisible();
  await expect(overview).toContainText(
    "In the last 30 days, 12 messages arrived and 3 messages went out.",
  );
  await expect(overview).toContainText("Messages arrived");
  await expect(overview).toContainText("Messages sent");
  await expect(overview.getByText("12", { exact: true }).first()).toBeVisible();
  await expect(overview.getByText("3", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Connect Normal to Claude or ChatGPT",
    }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "WhatsApp Connections" }).click();
  await page
    .getByRole("button", { name: "Add another WhatsApp number" })
    .click();
  await expect(page.getByLabel("Name", { exact: true })).toBeEnabled();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("WhatsApp number")).toBeEnabled();
  await expect(page.getByLabel("WhatsApp number")).toHaveValue("");
  await page.getByRole("button", { name: "Close" }).click();
  const connection = page.getByTestId("whatsapp-connection");
  await connection
    .getByRole("button", {
      name: "Options for WhatsApp Connection ending 3456",
    })
    .click();
  await page.getByRole("menuitem", { name: "Configure" }).click();
  const configuration = page.getByRole("dialog", {
    name: "Configure WhatsApp Connection",
  });
  const retentionPolicy = configuration.getByRole("combobox", {
    name: "Keep message history for",
  });
  const saveConfiguration = configuration.getByRole("button", {
    name: "Save changes",
  });
  await expect(saveConfiguration).toBeDisabled();
  await configuration.getByLabel("Name", { exact: true }).fill("Work WhatsApp");
  await expect(saveConfiguration).toBeEnabled();
  await saveConfiguration.click();
  await expect(configuration).toContainText("Name saved.");
  await expectSuccessToast(page, "Name saved.");
  expect(renameRequests).toBe(1);
  expect(retentionUpdateRequests).toBe(0);
  await expect(connection).toContainText("Work WhatsApp");
  await expect(retentionPolicy).toContainText("30 days");
  await retentionPolicy.click();
  await page.getByRole("option", { name: "7 days" }).click();
  await saveConfiguration.click();
  await expect(configuration).toContainText("Current policy: 7 days");
  await expectSuccessToast(page, "Message Retention Policy saved");
  expect(renameRequests).toBe(1);
  expect(retentionUpdateRequests).toBe(1);
  await retentionPolicy.click();
  await page
    .getByRole("option", { name: "Retain until Connection Deletion" })
    .click();
  await expect(saveConfiguration).toBeDisabled();
  await configuration
    .getByRole("checkbox", {
      name: "I explicitly choose to retain message content for longer.",
    })
    .check();
  await saveConfiguration.click();
  await expect(configuration).toContainText("retain until Connection Deletion");
  await expectSuccessToast(page, "Message Retention Policy saved");
  await expect(page.getByTestId("whatsapp-connection")).not.toContainText(
    "session-authority",
  );
  await configuration.getByRole("button", { name: "Close" }).click();
  await connection
    .getByRole("button", {
      name: "Options for WhatsApp Connection ending 3456",
    })
    .click();
  await page.getByRole("menuitem", { name: "Disconnect" }).click();
  await expect(connection).toContainText("disconnected");
  await connection
    .getByRole("button", {
      name: "Options for WhatsApp Connection ending 3456",
    })
    .click();
  await page.getByRole("menuitem", { name: "Reconnect" }).click();
  const reconnect = page.getByRole("dialog", {
    name: "Reconnect WhatsApp Connection",
  });
  await expect(reconnect).toContainText(
    "Retained history remains available under its Message Retention Policy.",
  );
  await reconnect
    .getByRole("button", {
      name: "Reconnect WhatsApp Connection ending 3456",
    })
    .click();
  await expect(
    reconnect.getByRole("img", {
      name: "Reconnect this WhatsApp Connection QR code",
    }),
  ).toBeVisible();
  await page.reload();
  const resumedConnection = page.getByTestId("whatsapp-connection");
  await expect(resumedConnection).toContainText("connecting");
  await resumedConnection
    .getByRole("button", {
      name: "Options for WhatsApp Connection ending 3456",
    })
    .click();
  await page.getByRole("menuitem", { name: "Reconnect" }).click();
  const resumedReconnect = page.getByRole("dialog", {
    name: "Reconnect WhatsApp Connection",
  });
  resumeReconnectPolling = true;
  releaseReconnectPoll?.();
  await resumedReconnect
    .getByRole("button", {
      name: "Reconnect WhatsApp Connection ending 3456",
    })
    .click();
  await expect(resumedConnection).toContainText("connected");
  await expect(
    resumedReconnect.getByRole("img", {
      name: "Reconnect this WhatsApp Connection QR code",
    }),
  ).toHaveCount(0);
  await expect(resumedConnection).toContainText("Number ending 3456");
  await resumedReconnect.getByRole("button", { name: "Close" }).click();
  expect(setupBodies).toHaveLength(1);
  expect(setupBodies[0]?.whatsapp_number).toBe("+1 (555) 012-3456");
  expect(setupBodies[0]?.name).toBe("Personal WhatsApp");
  expect(setupBodies[0]?.idempotency_key).toMatch(/^[A-Za-z0-9_-]{21}$/);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/dashboard\/settings$/u);
  await expect(
    page.getByRole("region", { name: "Personal Account Deletion" }),
  ).toBeVisible();

  const exclusions = page.getByRole("region", {
    name: "WhatsApp Recipient Exclusions",
  });
  await expect(exclusions).toBeVisible();
  const excludeAda = exclusions.getByRole("button", {
    name: "Stop tracking Ada Lovelace",
  });
  await excludeAda.click();
  await expect(page.getByTestId("recipient-exclusion-status")).toContainText(
    "Normal no longer tracks Ada Lovelace.",
  );
  await expectSuccessToast(page, "Normal no longer tracks Ada Lovelace.");
  await expect(
    exclusions.getByRole("button", { name: "Track again Ada Lovelace" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Track again Ada Lovelace" }),
  ).toBeVisible();
  await page.getByLabel("Search by name").fill("grace");
  await expect(
    page.getByRole("button", { name: "Stop tracking Grace Hopper" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Track again Ada Lovelace" }),
  ).toHaveCount(0);
  // A scoped recipient outage must not disable unrelated account controls.
  await expect(
    page.getByRole("button", { name: "Delete Personal Account" }),
  ).toBeEnabled();
  const providerObservations = await request.get(
    `http://127.0.0.1:${apiPort}/test/provider-observations`,
  );
  expect(await providerObservations.json()).toEqual([
    "reconcileSession",
    "connectSession",
    "reconcileSession",
    "getQrCode",
    "reconcileSession",
    "verifySessionNumber",
    "reconcileSession",
    "disconnectSession",
    "reconcileSession",
    "connectSession",
    "getQrCode",
    "reconcileSession",
  ]);
});

test.describe("Connection Setup loading UI", () => {
  test.use({ viewport: { height: 844, width: 390 } });

  test("keeps a stable QR placeholder on mobile while the QR response is delayed", async ({
    page,
    request,
  }) => {
    const delayedSetupNumber = "+1 (555) 012-3476";
    let releaseSetup: (() => void) | undefined;
    const setupCanContinue = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    let releaseFirstQr: (() => void) | undefined;
    const firstQrCanContinue = new Promise<void>((resolve) => {
      releaseFirstQr = resolve;
    });
    let releaseQrPoll: (() => void) | undefined;
    const qrPollCanContinue = new Promise<void>((resolve) => {
      releaseQrPoll = resolve;
    });
    let qrRequests = 0;
    let firstQrResponseStatus: number | null = null;

    await page.route("https://api.example.test/**", async (route) => {
      const original = route.request();
      const localUrl = new URL(original.url());
      if (
        localUrl.pathname === "/v1/connection-setups" &&
        original.method() === "POST"
      ) {
        await setupCanContinue;
      }
      if (
        original.method() === "GET" &&
        /^\/v1\/connection-setups\/cst_[A-Za-z0-9_-]{21}\/qr$/u.test(
          localUrl.pathname,
        )
      ) {
        qrRequests += 1;
        if (qrRequests === 1) {
          await firstQrCanContinue;
        } else {
          await qrPollCanContinue;
        }
      }
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
      const responseBody = await response.body();
      if (qrRequests === 1 && localUrl.pathname.endsWith("/qr")) {
        firstQrResponseStatus = response.status();
      }
      await route.fulfill({
        body: responseBody,
        headers: {
          ...response.headers(),
          "access-control-allow-origin": webOrigin,
        },
        status: response.status(),
      });
    });

    await installClerkBrowser(page, {
      signedIn: true,
      token: "signed-second-test-user",
    });
    await page.goto("/dashboard/connections");
    await page.getByRole("button", { name: "Add WhatsApp number" }).click();
    const setup = page.getByRole("dialog", {
      name: "New WhatsApp Connection",
    });
    await expect(setup).toBeVisible();
    await setup.getByLabel("Name", { exact: true }).fill("Personal WhatsApp");
    await setup.getByLabel("WhatsApp number").fill(delayedSetupNumber);
    await setup.getByRole("button", { name: "Continue", exact: true }).click();

    const panel = setup.getByTestId("connection-setup-panel");
    const placeholder = panel.getByTestId(
      "connection-setup-loading-placeholder",
    );
    const loadingProgress = panel.getByTestId(
      "connection-setup-loading-progress",
    );
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("connection-setup-status")).toHaveText(
      "Starting Connection Setup.",
    );
    await expect(setup).toContainText("Starting Connection Setup");
    await expect(placeholder).toBeVisible();
    await expect(loadingProgress).toContainText("Provisioning setup");
    await expect(
      page.getByRole("img", { name: "Scan this WhatsApp QR code" }),
    ).toHaveCount(0);

    releaseSetup?.();

    await expect(page.getByTestId("connection-setup-status")).toHaveText(
      "Connection Setup started. Preparing your QR code.",
    );
    await expect(setup).toContainText("Preparing your QR code");
    await expect(panel).toBeVisible();
    await expect(placeholder).toBeVisible();
    await expect(loadingProgress).toContainText("Waiting for QR code");
    await expect(
      page.getByRole("img", { name: "Scan this WhatsApp QR code" }),
    ).toHaveCount(0);

    const placeholderBox = await placeholder.boundingBox();
    expect(placeholderBox).not.toBeNull();
    releaseFirstQr?.();
    await expect.poll(() => firstQrResponseStatus).toBe(202);
    await expect(placeholder).toBeVisible();
    releaseQrPoll?.();

    const qrImage = page.getByRole("img", {
      name: "Scan this WhatsApp QR code",
    });
    await expect(qrImage).toBeVisible();
    await expect(page.getByTestId("connection-setup-status")).toHaveText(
      "Scan this QR code with WhatsApp.",
    );
    const qrBox = await qrImage.boundingBox();
    expect(qrBox).not.toBeNull();
    expect(
      Math.abs((qrBox?.height ?? 0) - (placeholderBox?.height ?? 0)),
    ).toBeLessThanOrEqual(24);

    await setup.getByRole("button", { name: "Cancel setup" }).click();
    await expect(page.getByTestId("connection-setup-status")).toHaveText(
      /Connection Setup cancelled\./u,
    );
    await expect(placeholder).toHaveCount(0);
    await expect(loadingProgress).toHaveCount(0);
    await expect(
      setup.getByRole("button", { name: "Start again" }),
    ).toBeVisible();
  });
});

test("shows a terminal provisioning failure during Connection Setup", async ({
  page,
  request,
}) => {
  const failedSetupNumber = "+1 (555) 012-3486";
  await page.route("https://api.example.test/**", async (route) => {
    const original = route.request();
    const localUrl = new URL(original.url());
    if (
      original.method() === "GET" &&
      /^\/v1\/connection-setups\/cst_[A-Za-z0-9_-]{21}\/qr$/u.test(
        localUrl.pathname,
      )
    ) {
      await route.fulfill({
        body: JSON.stringify({ error: "provisioning_failed" }),
        contentType: "application/json",
        headers: { "access-control-allow-origin": webOrigin },
        status: 503,
      });
      return;
    }
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
    signedIn: true,
    token: "signed-second-test-user",
  });
  await page.goto("/dashboard/connections");
  await page.getByRole("button", { name: "Add WhatsApp number" }).click();
  const setup = page.getByRole("dialog", {
    name: "New WhatsApp Connection",
  });
  await expect(setup).toBeVisible();
  await setup.getByLabel("Name", { exact: true }).fill("Personal WhatsApp");
  await setup.getByLabel("WhatsApp number").fill(failedSetupNumber);
  await setup.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(setup.getByTestId("connection-setup-panel")).toBeVisible();
  await expect(page.getByTestId("connection-setup-status")).toHaveText(
    "Connection Setup could not be prepared.",
  );
  await expect(setup).toContainText(
    "Normal could not finish preparing this Connection Setup before the QR step.",
  );
  await expect(setup).toContainText(
    "Cancel setup below, then start again to request a fresh QR code.",
  );
  await expect(
    page.getByRole("img", { name: "Scan this WhatsApp QR code" }),
  ).toHaveCount(0);
  await expect(
    setup.getByTestId("connection-setup-loading-placeholder"),
  ).toHaveCount(0);
  await expect(
    setup.getByTestId("connection-setup-loading-progress"),
  ).toHaveCount(0);
});

test("starts irreversible Connection Deletion and keeps direct setup available after refresh", async ({
  page,
  request,
}) => {
  await page.route("https://api.example.test/**", async (route) => {
    const original = route.request();
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
  await page.goto("/dashboard/connections");
  const connection = page.getByTestId("whatsapp-connection");
  const emptyState = page.getByText("No WhatsApp Connections yet.");
  await expect(connection.or(emptyState)).toBeVisible();
  if (!(await connection.isVisible())) {
    await page.getByRole("button", { name: "Add WhatsApp number" }).click();
    const setup = page.getByRole("dialog", {
      name: "New WhatsApp Connection",
    });
    await expect(setup).toBeVisible();
    await setup.getByLabel("Name", { exact: true }).fill("Personal WhatsApp");
    await setup.getByLabel("WhatsApp number").fill("+1 (555) 012-3456");
    await setup.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByTestId("connection-setup-status")).toHaveText(
      "WhatsApp Connection active.",
      { timeout: 15_000 },
    );
    await setup.getByRole("button", { name: "Close" }).click();
    await expect(connection).toBeVisible();
  }

  let confirmationMessage = "";
  const confirmation = page.waitForEvent("dialog").then(async (dialog) => {
    confirmationMessage = dialog.message();
    expect(dialog.type()).toBe("confirm");
    await dialog.accept();
  });
  await connection
    .getByRole("button", {
      name: "Options for WhatsApp Connection ending 3456",
    })
    .click();
  await page.getByRole("menuitem", { name: "Delete Connection" }).click();
  await confirmation;

  expect(confirmationMessage).toContain("irreversible Connection Deletion");
  await expect(
    page.getByText(
      "Connection Deletion started for the WhatsApp Connection ending 3456. Access stops immediately while provider cleanup continues.",
    ),
  ).toBeVisible();
  await expect(page.getByTestId("whatsapp-connection")).toHaveCount(0);
  await expect(page.getByText("No WhatsApp Connections yet.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add WhatsApp number" }),
  ).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/dashboard\/connections$/u);
  await expect(page.getByTestId("whatsapp-connection")).toHaveCount(0);
  await expect(page.getByText("No WhatsApp Connections yet.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add WhatsApp number" }),
  ).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("shows safe same-account retry guidance when QR number confirmation fails", async ({
  page,
  request,
}) => {
  await page.route("https://api.example.test/**", async (route) => {
    const original = route.request();
    const localUrl = new URL(original.url());
    if (
      original.method() === "GET" &&
      /^\/v1\/connection-setups\/cst_[A-Za-z0-9_-]{21}\/qr$/u.test(
        localUrl.pathname,
      )
    ) {
      await route.fulfill({
        body: JSON.stringify({
          error: "number_confirmation_failed",
          message: "Retry by scanning the same WhatsApp account you entered.",
        }),
        contentType: "application/json",
        headers: { "access-control-allow-origin": webOrigin },
        status: 409,
      });
      return;
    }
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
    signedIn: true,
    token: "signed-second-test-user",
  });
  await page.goto("/dashboard/connections");
  await page.getByRole("button", { name: "Add WhatsApp number" }).click();
  const setup = page.getByRole("dialog", {
    name: "New WhatsApp Connection",
  });
  await expect(setup).toBeVisible();
  await setup.getByLabel("Name", { exact: true }).fill("Personal WhatsApp");
  await setup.getByLabel("WhatsApp number").fill("+1 (555) 012-3456");
  await setup.getByRole("button", { name: "Continue", exact: true }).click();

  const status = page.getByTestId("connection-setup-status");
  await expect(status).toHaveText(
    "We couldn't confirm that this QR code was scanned by the WhatsApp account you entered. Start again and scan with that same account.",
  );
  await expect(
    setup.getByRole("button", { name: "Start again" }),
  ).toBeVisible();
  await expect(status).not.toContainText("+1 (555) 012-3456");
  await expect(status).not.toContainText("Wasender");
});

test("keeps the Personal Account usable when MCP Authorization listing is unavailable", async ({
  page,
  request,
}) => {
  await page.route("https://api.example.test/**", async (route) => {
    const original = route.request();
    if (
      new URL(original.url()).pathname === "/v1/mcp-authorizations" &&
      original.method() === "GET"
    ) {
      await route.fulfill({
        body: "temporarily unavailable",
        contentType: "text/plain",
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
  await installClerkBrowser(page, { signedIn: true });
  await page.goto("/dashboard/authorizations");

  await expect(
    page.getByText("MCP Authorizations are temporarily unavailable."),
  ).toBeVisible();
});

test("recovers when the external identity token lookup fails", async ({
  page,
}) => {
  await installClerkBrowser(page, {
    signedIn: true,
    tokenError: "identity unavailable",
  });
  await page.goto("/dashboard");

  await expect(
    page.getByText(
      "Your Personal Account is temporarily unavailable. Please try again.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue to Personal Account" }),
  ).toHaveCount(0);
});

test("keeps the dashboard behind Clerk sign in when no browser session exists", async ({
  page,
}) => {
  await installClerkBrowser(page);
  await page.goto("/dashboard");

  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue to Personal Account" }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Sign in" }).click();

  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            readonly __openedClerkSignIn?: boolean;
          }
        ).__openedClerkSignIn,
    ),
  ).toBe(true);
});

test("opens the Personal Account automatically after Clerk signs in", async ({
  page,
}) => {
  await installClerkBrowser(page, {
    signInToken: "signed-test-user",
  });
  await page.goto("/dashboard");

  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(
    page.getByRole("button", { name: "Continue to Personal Account" }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      "Signed in. Continue to create or open your Personal Account.",
    ),
  ).toHaveCount(0);
});

test("adds first and later WhatsApp numbers before showing the three-number limit", async ({
  page,
  request,
}) => {
  await page.route("https://api.example.test/**", async (route) => {
    const original = route.request();
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
  await page.goto("/dashboard/connections");

  const connectionsHeading = page.getByRole("heading", {
    name: "Your WhatsApp Connections",
  });
  await expect(connectionsHeading).toBeVisible();

  await expect(
    page
      .getByTestId("whatsapp-connection")
      .first()
      .or(page.getByText("No WhatsApp Connections yet.")),
  ).toBeVisible();

  const addNumber = async (name: string, number: string, suffix: string) => {
    const existing = page
      .getByTestId("whatsapp-connection")
      .filter({ hasText: `ending ${suffix}` });
    if ((await existing.count()) > 0) return;

    await page
      .getByRole("button", {
        name: /^Add (?:another )?WhatsApp number$/u,
      })
      .click();
    const setup = page.getByRole("dialog", {
      name: "New WhatsApp Connection",
    });
    await setup.getByLabel("Name", { exact: true }).fill(name);
    await setup.getByLabel("WhatsApp number").fill(number);
    await setup.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByTestId("connection-setup-status")).toHaveText(
      "WhatsApp Connection active.",
      { timeout: 15_000 },
    );
    await expect(existing).toBeVisible();
    await setup.getByRole("button", { name: "Close" }).click();
  };

  await addNumber("Personal WhatsApp", "+1 (555) 012-3456", "3456");
  await addNumber("Family WhatsApp", "+1 (555) 012-3457", "3457");
  await addNumber("Work WhatsApp", "+1 (555) 012-3458", "3458");

  await expect(page.getByTestId("whatsapp-connection")).toHaveCount(3);
  await expect(
    page.getByText("3 currently connected or retained.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "3-number limit reached" }),
  ).toBeDisabled();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
