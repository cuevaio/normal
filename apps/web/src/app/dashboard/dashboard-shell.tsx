"use client";

import { useAuth, useClerk, useUser } from "@clerk/nextjs";
import {
  Activity,
  Cable,
  ChevronsUpDown,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MessageCircleMore,
  Settings,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { getPersonalAccountConfiguration } from "../personal-account-configuration";
import {
  type PersonalAccountView,
  PublicBoundaryJourney,
} from "../public-boundary-journey";
import { ApiKeysPanel } from "./api-keys/api-keys-panel";

type PersonalAccountConfiguration = ReturnType<
  typeof getPersonalAccountConfiguration
>;

const navigation = [
  { href: "/dashboard", icon: LayoutDashboard, label: "Overview" },
  {
    href: "/dashboard/connections",
    icon: MessageCircleMore,
    label: "WhatsApp Connections",
  },
  {
    href: "/dashboard/authorizations",
    icon: Cable,
    label: "MCP Authorizations",
  },
  { href: "/dashboard/api-keys", icon: KeyRound, label: "API Keys" },
  { href: "/dashboard/activity", icon: Activity, label: "Activity Log" },
] as const;

function DashboardSidebar() {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const clerk = useClerk();
  const { user } = useUser();
  const displayName = user?.fullName ?? user?.firstName ?? "Personal Account";
  const email = user?.primaryEmailAddress?.emailAddress ?? "Signed in";
  const initials =
    user?.firstName?.slice(0, 1) ?? user?.fullName?.slice(0, 1) ?? "N";

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link href="/dashboard" />}
              size="lg"
              tooltip="Normal"
            >
              <span className="grid size-8 place-items-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
                N
              </span>
              <span className="font-semibold tracking-tight">Normal.</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Personal Account</SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label="Dashboard navigation">
              <SidebarMenu>
                {navigation.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      isActive={pathname === item.href}
                      onClick={() => setOpenMobile(false)}
                      render={<Link href={item.href} />}
                      tooltip={item.label}
                    >
                      <item.icon aria-hidden="true" />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname === "/dashboard/settings"}
              onClick={() => setOpenMobile(false)}
              render={<Link href="/dashboard/settings" />}
              tooltip="Settings"
            >
              <Settings aria-hidden="true" />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton
                    className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
                    size="lg"
                  />
                }
              >
                <Avatar className="size-8 rounded-lg">
                  <AvatarImage alt={displayName} src={user?.imageUrl} />
                  <AvatarFallback className="rounded-lg">
                    {initials.toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{displayName}</span>
                  <span className="truncate text-xs">{email}</span>
                </span>
                <ChevronsUpDown aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-(--anchor-width)"
                side="top"
                sideOffset={4}
              >
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Profile</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => clerk.signOut({ redirectUrl: "/" })}
                  >
                    <LogOut aria-hidden="true" />
                    Log out
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarGroupLabel>
          <ShieldCheck aria-hidden="true" />
          Private beta
        </SidebarGroupLabel>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

const viewByPathname: Readonly<Record<string, PersonalAccountView>> = {
  "/dashboard": "overview",
  "/dashboard/activity": "activity",
  "/dashboard/authorizations": "authorizations",
  "/dashboard/connections": "connections",
  "/dashboard/settings": "settings",
};

export function DashboardShell({
  children,
  configuration,
}: {
  readonly children: ReactNode;
  readonly configuration: PersonalAccountConfiguration;
}) {
  const { isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();
  const pathname = usePathname();

  if (!isLoaded) {
    return (
      <main className="grid min-h-screen place-items-center bg-muted/30 p-6">
        <p className="text-sm text-muted-foreground">
          Checking sign in status…
        </p>
      </main>
    );
  }

  if (!isSignedIn) {
    return (
      <main className="grid min-h-screen place-items-center bg-muted/30 p-6">
        <section className="w-full max-w-md rounded-2xl bg-background p-8 shadow-sm ring-1 ring-border">
          <Link className="wordmark" href="/">
            Normal<span aria-hidden="true">.</span>
          </Link>
          <h1 className="mt-10 text-3xl font-semibold tracking-tight">
            Sign in to your dashboard
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Your dashboard is only available to authenticated Users.
          </p>
          <Button className="mt-8 w-full" onClick={() => clerk.openSignIn()}>
            Sign in
          </Button>
        </section>
      </main>
    );
  }

  return (
    <TooltipProvider>
      <SidebarProvider className="bg-muted/30">
        <DashboardSidebar />
        <SidebarInset className="bg-muted/30">
          <div className="flex h-14 items-center border-b bg-background px-4 md:hidden">
            <SidebarTrigger aria-label="Open dashboard navigation" />
          </div>
          <div className="dashboard-main">
            {children}
            <section className="dashboard-content">
              {configuration === null ? (
                <p className="text-sm text-muted-foreground">
                  Your Personal Account is temporarily unavailable.
                </p>
              ) : pathname === "/dashboard/api-keys" ? (
                <ApiKeysPanel
                  apiKeysEndpoint={configuration.apiKeysEndpoint}
                  clerkJwtTemplate={configuration.clerkJwtTemplate}
                  connectionsEndpoint={configuration.connectionsEndpoint}
                />
              ) : (
                <PublicBoundaryJourney
                  autoInitialize
                  clerkJwtTemplate={configuration.clerkJwtTemplate}
                  connectionsEndpoint={configuration.connectionsEndpoint}
                  connectionSetupEndpoint={
                    configuration.connectionSetupEndpoint
                  }
                  mcpAuthorizationsEndpoint={
                    configuration.mcpAuthorizationsEndpoint
                  }
                  mcpServerUrl={configuration.mcpServerUrl}
                  onboardingProfileEndpoint={
                    configuration.onboardingProfileEndpoint
                  }
                  personalAccountDeletionEndpoint={
                    configuration.personalAccountDeletionEndpoint
                  }
                  personalAccountEndpoint={
                    configuration.personalAccountEndpoint
                  }
                  toolCallLogsEndpoint={configuration.toolCallLogsEndpoint}
                  view={viewByPathname[pathname] ?? "overview"}
                />
              )}
            </section>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
