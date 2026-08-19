import type { Metadata } from "next";
import { DashboardRoute } from "../dashboard-route";

export const metadata: Metadata = { title: "API Keys | Normal" };

export default function ApiKeysPage() {
  return (
    <DashboardRoute
      description="Create and revoke API Keys for REST automations and compatible MCP Clients."
      title="API Keys"
    />
  );
}
