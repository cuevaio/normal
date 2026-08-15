import type { Metadata } from "next";
import { DashboardRoute } from "../dashboard-route";

export const metadata: Metadata = { title: "Activity Log | Normal" };

export default function ActivityPage() {
  return (
    <DashboardRoute
      description="Review how MCP Clients and API Keys used your WhatsApp access."
      title="Activity Log"
    />
  );
}
