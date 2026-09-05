import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          WASENDER_API_CREDENTIAL: "pat_0123456789abcdef0123456789abcdef",
          WASENDER_REFERENCE_SECRET:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
      },
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
    }),
  ],
  test: {
    testTimeout: 60_000,
  },
});
