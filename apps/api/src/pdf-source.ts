import { isPublicIpAddress } from "@whatsapp-mcp/whatsapp-provider/media";
import {
  makeVerifiedPdfBytes,
  type VerifiedPdfBytes,
} from "@whatsapp-mcp/whatsapp-provider/session";
import { decodeBase64 } from "./base64-url";

export const MAX_PDF_BYTES = 16_777_216;
const MAX_DNS_BYTES = 65_536;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;
export type OutboundFileFetch = (
  input: string | URL,
  init: RequestInit,
) => Promise<Response>;

const unsafeHostSuffix =
  /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|example|onion|example\.(?:com|net|org))$/iu;

const readBounded = async (
  response: Response,
  maximum: number,
): Promise<Uint8Array> => {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > maximum)
  ) {
    throw new Error("response exceeded byte limit");
  }
  if (response.body === null) throw new Error("response body unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response exceeded byte limit");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const resolveHostname = async (
  hostname: string,
  signal: AbortSignal,
  fetcher: OutboundFileFetch,
): Promise<ReadonlyArray<string>> => {
  const query = async (type: "A" | "AAAA") => {
    const url = new URL("https://cloudflare-dns.com/dns-query");
    url.searchParams.set("name", hostname);
    url.searchParams.set("type", type);
    const response = await fetcher(url, {
      headers: { accept: "application/dns-json" },
      redirect: "manual",
      signal,
    });
    if (!response.ok) throw new Error("DNS resolution unavailable");
    const bytes = await readBounded(response, MAX_DNS_BYTES);
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
      readonly Answer?: ReadonlyArray<{
        readonly data?: unknown;
        readonly type?: unknown;
      }>;
    };
    return (payload.Answer ?? [])
      .filter((answer) => answer.type === (type === "A" ? 1 : 28))
      .map((answer) => answer.data)
      .filter((address): address is string => typeof address === "string");
  };
  const [ipv4, ipv6] = await Promise.all([query("A"), query("AAAA")]);
  return [...ipv4, ...ipv6];
};

const validateUrl = async (
  value: string,
  signal: AbortSignal,
  fetcher: OutboundFileFetch,
): Promise<URL> => {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    unsafeHostSuffix.test(url.hostname)
  ) {
    throw new Error("PDF source rejected");
  }
  const literal = url.hostname.replace(/^\[|\]$/gu, "");
  const isIpLiteral =
    /^\d+(?:\.\d+){3}$/u.test(literal) || literal.includes(":");
  if (isIpLiteral) {
    throw new Error("PDF source rejected");
  }
  const addresses = await resolveHostname(url.hostname, signal, fetcher);
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isPublicIpAddress(address))
  ) {
    throw new Error("PDF source rejected");
  }
  return url;
};

export const decodePdfBase64 = (value: string): VerifiedPdfBytes => {
  if (
    value.length > 22_369_624 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    throw new Error("invalid PDF base64");
  }
  return makeVerifiedPdfBytes(decodeBase64(value));
};

export const downloadVerifiedFile = async <Bytes extends Uint8Array>(
  value: string,
  options: {
    readonly accept: string;
    readonly maximumBytes: number;
    readonly verify: (bytes: Uint8Array) => Bytes;
  },
  fetcher: OutboundFileFetch = globalThis.fetch,
): Promise<Bytes> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let url = await validateUrl(value, controller.signal, fetcher);
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetcher(url, {
        headers: { accept: options.accept },
        redirect: "manual",
        signal: controller.signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error("PDF download failed");
        }
        return options.verify(
          await readBounded(response, options.maximumBytes),
        );
      }
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (location === null || redirects >= MAX_REDIRECTS) {
        throw new Error("PDF redirect rejected");
      }
      url = await validateUrl(
        new URL(location, url).href,
        controller.signal,
        fetcher,
      );
    }
  } finally {
    clearTimeout(timer);
  }
};

export const downloadPdf = async (
  value: string,
  fetcher: OutboundFileFetch = globalThis.fetch,
): Promise<VerifiedPdfBytes> =>
  downloadVerifiedFile(
    value,
    {
      accept: "application/pdf",
      maximumBytes: MAX_PDF_BYTES,
      verify: makeVerifiedPdfBytes,
    },
    fetcher,
  );
