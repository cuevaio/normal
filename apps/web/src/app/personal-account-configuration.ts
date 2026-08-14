import { isDeploymentEnvironment, parseApiOrigin } from "../effect/api-origin";
import {
  CLERK_JWT_TEMPLATE,
  isClerkPublishableKey,
} from "../effect/clerk-config";

export function getPersonalAccountConfiguration() {
  const apiOrigin = parseApiOrigin(process.env.NEXT_PUBLIC_API_ORIGIN);

  if (
    apiOrigin === null ||
    !isDeploymentEnvironment(process.env.DEPLOYMENT_ENVIRONMENT) ||
    !isClerkPublishableKey(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)
  ) {
    return null;
  }

  return {
    clerkJwtTemplate: CLERK_JWT_TEMPLATE,
    apiKeysEndpoint: new URL("/v1/api-keys", apiOrigin).toString(),
    mcpAuthorizationsEndpoint: new URL(
      "/v1/mcp-authorizations",
      apiOrigin,
    ).toString(),
    mcpServerUrl: new URL("/mcp", apiOrigin).toString(),
    toolCallLogsEndpoint: new URL("/v1/tool-call-logs", apiOrigin).toString(),
    connectionsEndpoint: new URL(
      "/v1/whatsapp-connections",
      apiOrigin,
    ).toString(),
    connectionSetupEndpoint: new URL(
      "/v1/connection-setups",
      apiOrigin,
    ).toString(),
    personalAccountEndpoint: new URL(
      "/v1/personal-account/bootstrap",
      apiOrigin,
    ).toString(),
    onboardingProfileEndpoint: new URL(
      "/v1/personal-account/onboarding-profile",
      apiOrigin,
    ).toString(),
    personalAccountDeletionEndpoint: new URL(
      "/v1/personal-account",
      apiOrigin,
    ).toString(),
  };
}
