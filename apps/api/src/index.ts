import type { ProviderControlService } from "@whatsapp-mcp/contracts/provider-control";
import { withPgRequestConnectionScope } from "@whatsapp-mcp/db/request-connection";
import {
  createProductionHandler,
  createProductionQueueHandler,
  createProductionScheduledHandler,
} from "./production";
import { createWorker } from "./worker";

export interface Env {
  readonly DECRYPTED_MEDIA_BYTES_PER_DAY: string;
  readonly AWS_ACCESS_KEY_ID: string;
  readonly AWS_KMS_REGION: string;
  readonly AWS_SECRET_ACCESS_KEY: string;
  readonly AWS_SESSION_TOKEN: string;
  readonly CLERK_API_AUDIENCE: string;
  readonly CLERK_AUTHORIZED_PARTY: string;
  readonly CLERK_ISSUER: string;
  readonly CLERK_JWT_KEY: string;
  readonly CLERK_SECRET_KEY: string;
  readonly CLERK_WEBHOOK_SIGNING_SECRET: string;
  readonly CONNECTION_SETUP_PROVISIONING_QUEUE: Queue;
  readonly DELETION_CAPSULES: R2Bucket;
  readonly DELETION_MARKER_HMAC_SECRET: string;
  readonly DELETION_MARKERS: R2Bucket;
  readonly DEPLOYMENT_ENVIRONMENT: string;
  readonly HYPERDRIVE: Hyperdrive;
  readonly INGESTION_QUEUE: Queue;
  readonly KMS_CONTENT_ROOT_KEY_ARN: string;
  readonly KMS_DELETION_COORDINATOR_KEY_ARN: string;
  readonly MCP_REQUESTS_PER_HOUR: string;
  readonly MCP_REQUESTS_PER_MINUTE: string;
  readonly MESSAGE_RETENTION_DAY_OPTIONS: string;
  readonly NEON_BRANCH_ID: string;
  readonly READ_MESSAGE_RECORDS_PER_DAY: string;
  readonly API_KEY_HMAC_SECRET: string;
  readonly MCP_CURSOR_HMAC_SECRET: string;
  readonly SEND_FINGERPRINT_HMAC_SECRET: string;
  readonly SENDS_PER_DAY: string;
  readonly SENDS_PER_MINUTE: string;
  readonly SMOKE_CHECK_SECRET: string;
  readonly OAUTH_ISSUER: string;
  readonly OAUTH_KV: KVNamespace;
  readonly OAUTH_PROTOCOL_ENCRYPTION_KEY: string;
  readonly OAUTH_RESOURCE: string;
  readonly PROVIDER_CONTROL: Fetcher & ProviderControlService;
  readonly STORED_MEDIA: R2Bucket;
  readonly WEBHOOK_INGRESS: R2Bucket;
  readonly WEBHOOK_HYPERDRIVE: Hyperdrive;
  readonly WHATSAPP_NUMBER_RESERVATION_HMAC_SECRET: string;
}

export default createWorker<Env>({
  fetch: (request, env, context) => {
    const handle = () => createProductionHandler(env)(request, context);
    return new URL(request.url).pathname === "/mcp"
      ? withPgRequestConnectionScope(handle)
      : handle();
  },
  queue: (batch, env) => createProductionQueueHandler(env)(batch),
  scheduled: (controller, env) =>
    createProductionScheduledHandler(env)(controller),
});
