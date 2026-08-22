export const queryKeys = {
  accountInsights: () => ["account-insights"] as const,
  activityLogs: () => ["activity-logs"] as const,
  apiKeys: () => ["api-keys"] as const,
  authorizations: () => ["mcp-authorizations"] as const,
  connections: () => ["whatsapp-connections"] as const,
  connectionWorkspace: () => ["whatsapp-connections", "workspace"] as const,
  oauthInspection: (request: string) => ["oauth-inspection", request] as const,
  onboardingProfile: () => ["onboarding-profile"] as const,
  recipients: (
    connectionId: string,
    kind: "contact" | "group",
    search: string,
  ) => ["recipients", connectionId, kind, search] as const,
};
