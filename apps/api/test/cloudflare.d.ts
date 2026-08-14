declare namespace Cloudflare {
  interface Env {
    readonly CONNECTION_SETUP_PROVISIONING_QUEUE: Queue;
    readonly INGESTION_QUEUE: Queue;
    readonly MCP_REQUESTS_PER_HOUR: string;
    readonly MCP_REQUESTS_PER_MINUTE: string;
    readonly API_KEY_HMAC_SECRET: string;
    readonly MCP_CURSOR_HMAC_SECRET: string;
    readonly SEND_FINGERPRINT_HMAC_SECRET: string;
    readonly SMOKE_CHECK_SECRET: string;
    readonly SENDS_PER_DAY: string;
    readonly SENDS_PER_MINUTE: string;
    readonly WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET: string;
    readonly OAUTH_KV: KVNamespace;
    readonly PROVIDER_CONTROL: Fetcher;
    readonly STORED_MEDIA: R2Bucket;
    readonly WEBHOOK_INGRESS: R2Bucket;
    readonly WEBHOOK_HYPERDRIVE: Hyperdrive;
  }

  interface GlobalProps {
    mainModule:
      | typeof import("../src/index")
      | typeof import("./support/public-boundary-worker");
  }
}
