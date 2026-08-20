import type { OperationsFetch } from "./cloudflare";

const statusUrl = "https://wasenderapi.com/status";
const windowMilliseconds = 7 * 86_400_000;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;

const externalTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  timestamp.test(value) &&
  Number.isFinite(Date.parse(value));

const decodeAttribute = (value: string) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

const boundedText = async (response: Response) => {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > 1_048_576)
    throw new Error("Wasender status response is invalid");
  const text = await response.text();
  if (text.length > 1_048_576)
    throw new Error("Wasender status response is invalid");
  return text;
};

const percentage = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 100;

export const queryDependencyAvailability = async (
  asOf: string,
  fetcher: OperationsFetch = fetch,
) => {
  const response = await fetcher(statusUrl, {
    headers: { accept: "text/html" },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Wasender status is unavailable");
  const match = /data-page="([^"]+)"/u.exec(await boundedText(response));
  if (!match?.[1]) throw new Error("Wasender status response is invalid");
  const page = JSON.parse(decodeAttribute(match[1])) as {
    readonly props?: {
      readonly currentStatus?: {
        readonly last_checked?: unknown;
        readonly services?: { readonly whatsapp_servers?: unknown };
        readonly status?: unknown;
      };
      readonly scheduledOutages?: unknown;
      readonly uptime?: { readonly "7d"?: unknown };
    };
  };
  const current = page.props?.currentStatus;
  const wasenderPercent = page.props?.uptime?.["7d"];
  const checkedAt =
    current && externalTimestamp(current.last_checked)
      ? Date.parse(current.last_checked)
      : Number.NaN;
  const now = Date.now();
  if (
    !current ||
    !Number.isFinite(checkedAt) ||
    !percentage(wasenderPercent) ||
    (current.status !== "up" && current.status !== "down") ||
    (current.services?.whatsapp_servers !== "up" &&
      current.services?.whatsapp_servers !== "down") ||
    checkedAt < now - 15 * 60_000 ||
    checkedAt > now + 5 * 60_000
  )
    throw new Error("Wasender status response is invalid");

  const completed = Date.parse(asOf);
  const started = completed - windowMilliseconds;
  const outages = page.props?.scheduledOutages;
  if (!Array.isArray(outages))
    throw new Error("Wasender status response is invalid");
  let unavailableMilliseconds = 0;
  for (const outage of outages) {
    if (typeof outage !== "object" || outage === null || Array.isArray(outage))
      throw new Error("Wasender status response is invalid");
    const candidate = outage as {
      readonly affected_services?: unknown;
      readonly ends_at?: unknown;
      readonly starts_at?: unknown;
      readonly status?: unknown;
    };
    if (
      !Array.isArray(candidate.affected_services) ||
      !candidate.affected_services.every(
        (service) => typeof service === "string",
      ) ||
      !externalTimestamp(candidate.starts_at) ||
      !externalTimestamp(candidate.ends_at) ||
      Date.parse(candidate.ends_at) < Date.parse(candidate.starts_at) ||
      candidate.status !== "completed"
    )
      throw new Error("Wasender status response is invalid");
    if (!candidate.affected_services.includes("WhatsApp Server")) continue;
    const outageStart = Math.max(started, Date.parse(candidate.starts_at));
    const outageEnd = Math.min(completed, Date.parse(candidate.ends_at));
    unavailableMilliseconds += Math.max(0, outageEnd - outageStart);
  }
  const scheduledWhatsAppPercent =
    Math.round(
      (100 - (unavailableMilliseconds / windowMilliseconds) * 100) * 1_000_000,
    ) / 1_000_000;
  return {
    wasenderPercent,
    whatsappPercent:
      current.services.whatsapp_servers === "up"
        ? Math.min(wasenderPercent, scheduledWhatsAppPercent)
        : 0,
  } as const;
};
