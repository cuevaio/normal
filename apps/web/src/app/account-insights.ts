export const ACCOUNT_INSIGHTS_WINDOW_DAYS = 30;

export interface AccountInsightsSeriesPoint {
  readonly date: string;
  readonly inbound: number;
  readonly outbound: number;
}

export interface AccountInsights {
  readonly authorizations: {
    readonly active: number;
  };
  readonly connections: {
    readonly connected: number;
    readonly needsAttention: number;
    readonly total: number;
  };
  readonly conversations: {
    readonly active: number;
    readonly direct: number;
    readonly group: number;
    readonly total: number;
  };
  readonly generatedAt: string;
  readonly messages: {
    readonly inbound: number;
    readonly outbound: number;
  };
  readonly sends: {
    readonly confirmed: number;
    readonly failed: number;
    readonly unknown: number;
  };
  readonly series: ReadonlyArray<AccountInsightsSeriesPoint>;
  readonly windowDays: typeof ACCOUNT_INSIGHTS_WINDOW_DAYS;
}

export interface AccountInsightsCopy {
  readonly apps: string;
  readonly connection: string;
  readonly conversation: string;
  readonly headline: string;
  readonly sendNote: string | null;
}

const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const isCalendarDate = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const decodeObjectCounts = (
  value: unknown,
  expectedKeys: ReadonlyArray<string>,
): Record<string, unknown> | null => {
  const record = asRecord(value);
  if (record === null || Object.keys(record).length !== expectedKeys.length) {
    return null;
  }
  for (const key of expectedKeys) {
    if (!isCount(record[key])) return null;
  }
  return record;
};

export const decodeAccountInsights = (
  value: unknown,
): AccountInsights | null => {
  const record = asRecord(value);
  if (record === null || record.window_days !== ACCOUNT_INSIGHTS_WINDOW_DAYS) {
    return null;
  }
  if (!isIsoDate(record.generated_at) || !Array.isArray(record.series)) {
    return null;
  }
  if (record.series.length !== ACCOUNT_INSIGHTS_WINDOW_DAYS) return null;
  const connections = decodeObjectCounts(record.connections, [
    "connected",
    "needs_attention",
    "total",
  ]);
  const messages = decodeObjectCounts(record.messages, ["inbound", "outbound"]);
  const conversations = decodeObjectCounts(record.conversations, [
    "active",
    "direct",
    "group",
    "total",
  ]);
  const sends = decodeObjectCounts(record.sends, [
    "confirmed",
    "failed",
    "unknown",
  ]);
  const authorizations = decodeObjectCounts(record.authorizations, ["active"]);
  if (
    connections === null ||
    messages === null ||
    conversations === null ||
    sends === null ||
    authorizations === null ||
    !isCount(connections.connected) ||
    !isCount(connections.needs_attention) ||
    !isCount(connections.total) ||
    !isCount(messages.inbound) ||
    !isCount(messages.outbound) ||
    !isCount(conversations.active) ||
    !isCount(conversations.direct) ||
    !isCount(conversations.group) ||
    !isCount(conversations.total) ||
    !isCount(sends.confirmed) ||
    !isCount(sends.failed) ||
    !isCount(sends.unknown) ||
    !isCount(authorizations.active)
  ) {
    return null;
  }
  const series: AccountInsightsSeriesPoint[] = [];
  for (const candidate of record.series) {
    const point = asRecord(candidate);
    if (
      point === null ||
      !isCalendarDate(point.date) ||
      !isCount(point.inbound) ||
      !isCount(point.outbound)
    ) {
      return null;
    }
    series.push({
      date: point.date,
      inbound: point.inbound,
      outbound: point.outbound,
    });
  }
  return {
    authorizations: { active: authorizations.active },
    connections: {
      connected: connections.connected,
      needsAttention: connections.needs_attention,
      total: connections.total,
    },
    conversations: {
      active: conversations.active,
      direct: conversations.direct,
      group: conversations.group,
      total: conversations.total,
    },
    generatedAt: record.generated_at,
    messages: {
      inbound: messages.inbound,
      outbound: messages.outbound,
    },
    sends: {
      confirmed: sends.confirmed,
      failed: sends.failed,
      unknown: sends.unknown,
    },
    series,
    windowDays: ACCOUNT_INSIGHTS_WINDOW_DAYS,
  };
};

const formatCount = (value: number): string =>
  new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);

const plural = (count: number, singular: string, pluralForm: string): string =>
  `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;

export const describeAccountInsights = (
  insights: AccountInsights,
): AccountInsightsCopy => {
  const { inbound, outbound } = insights.messages;
  const headline =
    insights.connections.total === 0
      ? "Connect a WhatsApp number to start a living picture of your chats."
      : inbound + outbound === 0
        ? insights.connections.connected === 0
          ? "WhatsApp is not connected right now. Reconnect to see new chats here."
          : "Your WhatsApp is connected. New chats will show up here as they arrive."
        : `In the last ${insights.windowDays} days, ${plural(inbound, "message", "messages")} arrived and ${plural(outbound, "message", "messages")} went out.`;

  const connection =
    insights.connections.total === 0
      ? "No WhatsApp numbers yet"
      : insights.connections.connected === insights.connections.total
        ? plural(
            insights.connections.connected,
            "WhatsApp number connected",
            "WhatsApp numbers connected",
          )
        : `${formatCount(insights.connections.connected)} of ${formatCount(insights.connections.total)} WhatsApp numbers connected`;

  const conversation =
    insights.conversations.total === 0
      ? "No chats observed yet"
      : insights.conversations.active === 0
        ? `${plural(insights.conversations.total, "chat", "chats")} in history, none active this week`
        : `${plural(insights.conversations.active, "chat was", "chats were")} active this week`;

  const apps =
    insights.authorizations.active === 0
      ? "No apps have access yet"
      : plural(
          insights.authorizations.active,
          "app can use WhatsApp",
          "apps can use WhatsApp",
        );

  const sendNote =
    insights.sends.unknown > 0
      ? `${plural(insights.sends.unknown, "send is", "sends are")} still unconfirmed.`
      : insights.sends.failed > 0
        ? `${plural(insights.sends.failed, "send did", "sends did")} not go through.`
        : null;

  return {
    apps,
    connection,
    conversation,
    headline,
    sendNote,
  };
};
