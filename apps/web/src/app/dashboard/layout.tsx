import { connection } from "next/server";
import type { ReactNode } from "react";
import { redirectToCanonicalOrigin } from "../canonical-origin";
import { getPersonalAccountConfiguration } from "../personal-account-configuration";
import { DashboardShell } from "./dashboard-shell";

export default async function DashboardLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  await connection();
  await redirectToCanonicalOrigin("/dashboard");

  return (
    <DashboardShell configuration={getPersonalAccountConfiguration()}>
      {children}
    </DashboardShell>
  );
}
