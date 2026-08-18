import { defineConfig } from "@playwright/test";

const port = process.env.PLAYWRIGHT_DOCS_PORT ?? "4321";
if (!/^[1-9][0-9]{0,4}$/u.test(port) || Number(port) > 65_535) {
  throw new Error("PLAYWRIGHT_DOCS_PORT must be a valid TCP port");
}

const docsOrigin = `http://127.0.0.1:${port}`;

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  reporter: process.env.CI ? "github" : "list",
  retries: process.env.CI ? 2 : 0,
  testDir: "./test/browser",
  use: {
    baseURL: docsOrigin,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `bun scripts/serve-static.ts`,
    env: {
      ...process.env,
      DOCS_PORT: port,
    },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    url: docsOrigin,
  },
});
