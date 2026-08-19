import { defineConfig } from "@playwright/test";

const port = (name: string, fallback: string): string => {
  const value = process.env[name] ?? fallback;
  if (!/^[1-9][0-9]{0,4}$/u.test(value) || Number(value) > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
};

const webPort = port("PLAYWRIGHT_WEB_PORT", "3000");
const apiPort = port("PLAYWRIGHT_API_PORT", "8787");
const webOrigin = `http://127.0.0.1:${webPort}`;
const apiOrigin = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  reporter: process.env.CI ? "github" : "list",
  retries: process.env.CI ? 2 : 0,
  testDir: "./test/browser",
  use: {
    baseURL: webOrigin,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `bun x wrangler dev --config test/wrangler.browser.jsonc --ip 127.0.0.1 --port ${apiPort}`,
      cwd: "../api",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      url: `${apiOrigin}/test/ready`,
    },
    {
      command: `bun run build && bun run start --hostname 127.0.0.1 --port ${webPort}`,
      env: {
        ...process.env,
        DEPLOYMENT_ENVIRONMENT: "development",
        NEXT_PUBLIC_API_ORIGIN: "https://api.example.test",
        NEXT_PUBLIC_CLERK_JS_URL: `${webOrigin}/clerk-test.js`,
        NEXT_PUBLIC_CLERK_UI_URL: `${webOrigin}/clerk-ui-test.js`,
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA",
        NEXT_PUBLIC_POSTHOG_HOST: "https://analytics.example.test",
        NEXT_PUBLIC_POSTHOG_KEY: "phc_browser_test",
      },
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      url: webOrigin,
    },
  ],
});
