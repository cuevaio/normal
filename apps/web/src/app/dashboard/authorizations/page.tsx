import type { Metadata } from "next";
import { DashboardRoute } from "../dashboard-route";

export const metadata: Metadata = { title: "MCP Authorizations | Normal" };

export default function AuthorizationsPage() {
  return (
    <DashboardRoute
      description="Connect Claude or ChatGPT, then review and revoke access."
      title="MCP Authorizations"
    />
  );
}
