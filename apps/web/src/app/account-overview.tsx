import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AccountInsights,
  describeAccountInsights,
} from "./account-insights";

interface OverviewConnection {
  readonly displayName: string;
  readonly id: string;
  readonly state:
    | "connected"
    | "connecting"
    | "degraded"
    | "deleting"
    | "disconnected"
    | "reconnect_required";
}

interface OverviewAuthorization {
  readonly client: { readonly name: string };
  readonly expiryState: "active" | "expired";
  readonly id: string;
  readonly revocationState: "active" | "revoked";
}

const formatChartDay = (value: string): string =>
  new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));

function MessageChart({
  inbound,
  outbound,
  series,
}: {
  readonly inbound: number;
  readonly outbound: number;
  readonly series: AccountInsights["series"];
}) {
  const peak = Math.max(
    1,
    ...series.map((point) => point.inbound + point.outbound),
  );
  const width = 640;
  const height = 196;
  const padding = { bottom: 28, left: 8, right: 8, top: 16 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const barWidth = innerWidth / series.length;
  const gap = Math.max(1, barWidth * 0.28);

  return (
    <figure className="flex flex-col gap-3">
      <svg
        aria-label={`Messages over the last ${series.length} days. ${inbound} arrived and ${outbound} went out.`}
        className="h-48 w-full"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        {series.map((point, index) => {
          const x = padding.left + index * barWidth + gap / 2;
          const inboundHeight = (point.inbound / peak) * innerHeight;
          const outboundHeight = (point.outbound / peak) * innerHeight;
          const inboundY = padding.top + innerHeight - inboundHeight;
          const outboundY = inboundY - outboundHeight;
          const showLabel = index === 0 || index === series.length - 1;
          return (
            <g key={point.date}>
              <rect
                className="fill-primary/80"
                height={Math.max(point.inbound > 0 ? 2 : 0, inboundHeight)}
                rx="2"
                width={barWidth - gap}
                x={x}
                y={inboundY}
              />
              <rect
                className="fill-foreground/70"
                height={Math.max(point.outbound > 0 ? 2 : 0, outboundHeight)}
                rx="2"
                width={barWidth - gap}
                x={x}
                y={outboundY}
              />
              {showLabel ? (
                <text
                  className="fill-muted-foreground"
                  fontSize="11"
                  textAnchor={index === 0 ? "start" : "end"}
                  x={index === 0 ? x : x + barWidth - gap}
                  y={height - 8}
                >
                  {formatChartDay(point.date)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="size-2 rounded-full bg-primary" />
          Arrived
        </span>
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-foreground/70"
          />
          Sent
        </span>
      </figcaption>
    </figure>
  );
}

function StatCard({
  detail,
  label,
  value,
}: {
  readonly detail: string;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl tracking-tight">{value}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm leading-6 text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

export function AccountOverview({
  authorizations,
  authorizationState,
  connections,
  insights,
  insightsState,
}: {
  readonly authorizations: ReadonlyArray<OverviewAuthorization>;
  readonly authorizationState: "idle" | "loading" | "ok" | "unavailable";
  readonly connections: ReadonlyArray<OverviewConnection>;
  readonly insights: AccountInsights | null;
  readonly insightsState: "idle" | "loading" | "ok" | "unavailable";
}) {
  if (insightsState === "idle" || insightsState === "loading") {
    return (
      <section aria-label="Account overview" className="flex flex-col gap-5">
        <span className="sr-only">Loading overview</span>
        <Skeleton className="h-8 w-2/3" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
        <Skeleton className="h-64 w-full" />
      </section>
    );
  }

  if (insightsState === "unavailable" || insights === null) {
    return (
      <section aria-label="Account overview" className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Overview</h2>
        <p aria-live="polite" className="text-sm text-muted-foreground">
          Insights are temporarily unavailable. Your WhatsApp Connections and
          apps still work as usual.
        </p>
      </section>
    );
  }

  const copy = describeAccountInsights(insights);
  const formatNumber = (value: number) =>
    new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);
  const activeApps = authorizations.filter(
    (authorization) =>
      authorization.revocationState === "active" &&
      authorization.expiryState === "active",
  );
  const attentionConnections = connections.filter((connection) =>
    ["disconnected", "reconnect_required", "degraded"].includes(
      connection.state,
    ),
  );

  return (
    <section aria-label="Account overview" className="flex flex-col gap-6">
      <div className="max-w-3xl">
        <p className="text-sm font-medium text-muted-foreground">
          Last {insights.windowDays} days
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-pretty">
          {copy.headline}
        </h2>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          detail={copy.connection}
          label="Connected"
          value={`${formatNumber(insights.connections.connected)}/${formatNumber(insights.connections.total)}`}
        />
        <StatCard
          detail={`Messages that arrived in the last ${insights.windowDays} days.`}
          label="Messages arrived"
          value={formatNumber(insights.messages.inbound)}
        />
        <StatCard
          detail={`Messages you or your apps sent in the last ${insights.windowDays} days.`}
          label="Messages sent"
          value={formatNumber(insights.messages.outbound)}
        />
        <StatCard
          detail={copy.conversation}
          label="Active chats"
          value={formatNumber(insights.conversations.active)}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>How messages moved</CardTitle>
          <CardDescription>
            Arrivals and sends over the last {insights.windowDays} days. Earlier
            WhatsApp history is not imported.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {insights.messages.inbound + insights.messages.outbound === 0 ? (
            <p className="text-sm leading-6 text-muted-foreground">
              A chart will appear here once the first messages arrive.
            </p>
          ) : (
            <MessageChart
              inbound={insights.messages.inbound}
              outbound={insights.messages.outbound}
              series={insights.series}
            />
          )}
          {copy.sendNote ? (
            <p className="mt-4 text-sm text-muted-foreground">
              {copy.sendNote}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>WhatsApp numbers</CardTitle>
            <CardDescription>{copy.connection}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {connections.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Add a WhatsApp Connection to start observing chats.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {connections.map((connection) => (
                  <li
                    className="flex items-center justify-between gap-3 text-sm"
                    key={connection.id}
                  >
                    <span className="truncate font-medium">
                      {connection.displayName}
                    </span>
                    <Badge variant="outline">{connection.state}</Badge>
                  </li>
                ))}
              </ul>
            )}
            {attentionConnections.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                {attentionConnections.length === 1
                  ? "One number needs a reconnect."
                  : `${attentionConnections.length} numbers need a reconnect.`}
              </p>
            ) : null}
            <Link
              className={buttonVariants({
                className: "self-start",
                variant: "outline",
              })}
              href="/dashboard/connections"
            >
              Manage connections
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Apps with access</CardTitle>
            <CardDescription>{copy.apps}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {authorizationState === "unavailable" ? (
              <p aria-live="polite" className="text-sm text-muted-foreground">
                Apps with access are temporarily unavailable.
              </p>
            ) : activeApps.length === 0 ? (
              <p className="text-sm leading-6 text-muted-foreground">
                Connect Claude or ChatGPT so they can read or send on the
                WhatsApp Connections you choose.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {activeApps.map((authorization) => (
                  <li className="text-sm font-medium" key={authorization.id}>
                    {authorization.client.name}
                  </li>
                ))}
              </ul>
            )}
            <Link
              className={buttonVariants({
                className: "self-start",
                variant:
                  authorizationState !== "unavailable" &&
                  activeApps.length === 0
                    ? "default"
                    : "outline",
              })}
              href="/dashboard/authorizations"
            >
              {authorizationState !== "unavailable" && activeApps.length === 0
                ? "Connect an MCP Client"
                : "Review access"}
            </Link>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
