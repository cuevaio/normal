import { describe, expect, test, vi } from "vitest";
import {
  createProductionHandler,
  createProductionRpc,
} from "../src/production";

describe("provider-control production root", () => {
  test("accepts valid production configuration", async () => {
    const response = await createProductionHandler({
      DEPLOYMENT_ENVIRONMENT: "production",
      WASENDER_API_CREDENTIAL: "12|opaque+provider/credential=value",
      WASENDER_REFERENCE_SECRET:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      WEBSHARE_API_KEY: "webshare_api_key_fixture",
    })(new Request("https://provider-control.internal/health"));

    expect(response.status).toBe(200);
  });

  test("fails closed without the Provider API Credential", async () => {
    const response = await createProductionHandler({
      DEPLOYMENT_ENVIRONMENT: "production",
      WASENDER_REFERENCE_SECRET:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      WEBSHARE_API_KEY: "webshare_api_key_fixture",
    })(new Request("https://provider-control.internal/health"));

    expect(response.status).toBe(503);
  });

  test("fails closed for placeholder provider authority", async () => {
    const response = await createProductionHandler({
      DEPLOYMENT_ENVIRONMENT: "production",
      WASENDER_API_CREDENTIAL: "replace-with-wasender-credential-value",
      WASENDER_REFERENCE_SECRET:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      WEBSHARE_API_KEY: "webshare_api_key_fixture",
    })(new Request("https://provider-control.internal/health"));

    expect(response.status).toBe(503);
  });

  test("fails closed without the Webshare API key", async () => {
    const response = await createProductionHandler({
      DEPLOYMENT_ENVIRONMENT: "production",
      WASENDER_API_CREDENTIAL: "12|opaque+provider/credential=value",
      WASENDER_REFERENCE_SECRET:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    })(new Request("https://provider-control.internal/health"));

    expect(response.status).toBe(503);
  });

  test("fails closed when deployment configuration is absent", async () => {
    const response = await createProductionHandler({})(
      new Request("https://provider-control.internal/health"),
    );

    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      service: "provider-control",
      status: "unavailable",
    });
  });

  test("fails RPC closed before provider access for an invalid deployment environment", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const rpc = createProductionRpc({
      DEPLOYMENT_ENVIRONMENT: "bogus",
      WASENDER_API_CREDENTIAL: "12|opaque+provider/credential=value",
      WASENDER_REFERENCE_SECRET:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      WEBSHARE_API_KEY: "webshare_api_key_fixture",
    });

    const result = await rpc.reconcileSession({
      setupMarker: "cst_0123456789abcdefghijk",
    });

    expect(result).toEqual({
      error: {
        _tag: "ProviderControlFailure",
        code: "configuration_invalid",
        operation: "boundary",
        retryAfterMs: null,
        retryDecision: "do_not_retry",
      },
      ok: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
