import type { Metadata } from "next";
import { connection } from "next/server";
import { DashboardRoute } from "./dashboard-route";

export const metadata: Metadata = {
  title: "Dashboard | Normal",
  description: "Manage your Personal Account and WhatsApp Connections.",
  robots: { follow: false, index: false },
};

export default async function DashboardPage() {
  await connection();
  return (
    <DashboardRoute
      description="See how your WhatsApp is being used, without opening a chat."
      title="Overview"
    />
  );
}
