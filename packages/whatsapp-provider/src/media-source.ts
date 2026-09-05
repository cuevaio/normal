import { Redacted } from "effect";
import { maximumJsonResponseBytes } from "./common";
import type { MediaSource } from "./session";

const sourceVersion = 1;

interface EncryptedMediaSourceEnvelope {
  readonly kind: "encrypted-media";
  readonly messages: unknown;
  readonly version: typeof sourceVersion;
}

interface DownloadMediaSourceEnvelope {
  readonly kind: "decrypted-download";
  readonly url: string;
  readonly version: typeof sourceVersion;
}

export interface ParsedEncryptedMediaSource {
  readonly expectedSizeBytes: number | null;
  readonly fileName: string | null;
  readonly mimeType: string | null;
  readonly requestBody: {
    readonly data: {
      readonly messages: unknown;
    };
  };
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const encodeSource = (value: unknown): MediaSource =>
  Redacted.make(JSON.stringify(value)) as MediaSource;

export const makeEncryptedMediaSource = (messages: unknown): MediaSource =>
  encodeSource({
    kind: "encrypted-media",
    messages,
    version: sourceVersion,
  } satisfies EncryptedMediaSourceEnvelope);

export const makeDownloadMediaSource = (url: string): MediaSource =>
  encodeSource({
    kind: "decrypted-download",
    url,
    version: sourceVersion,
  } satisfies DownloadMediaSourceEnvelope);

const decodeSource = (source: MediaSource): Record<string, unknown> | null => {
  try {
    const encoded = Redacted.value(source);
    if (
      new TextEncoder().encode(encoded).byteLength > maximumJsonResponseBytes
    ) {
      return null;
    }
    return asRecord(JSON.parse(encoded));
  } catch {
    return null;
  }
};

const mediaKeys = [
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
] as const;

const optionalString = (
  value: unknown,
): { readonly valid: boolean; readonly value: string | null } =>
  value === undefined
    ? { valid: true, value: null }
    : typeof value === "string"
      ? { valid: true, value }
      : { valid: false, value: null };

const expectedSize = (
  value: unknown,
): { readonly valid: boolean; readonly value: number | null } => {
  if (value === undefined) {
    return { valid: true, value: null };
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? { valid: true, value: parsed }
    : { valid: false, value: null };
};

export const parseEncryptedMediaSource = (
  source: MediaSource,
): ParsedEncryptedMediaSource | null => {
  const envelope = decodeSource(source);
  if (
    envelope?.version !== sourceVersion ||
    envelope.kind !== "encrypted-media"
  ) {
    return null;
  }
  const messages = asRecord(envelope.messages);
  const key = asRecord(messages?.key);
  const message = asRecord(messages?.message);
  if (typeof key?.id !== "string" || key.id.length === 0 || message === null) {
    return null;
  }
  const presentMedia = mediaKeys.filter((name) => message[name] !== undefined);
  if (presentMedia.length !== 1) {
    return null;
  }
  const media = asRecord(
    message[presentMedia[0] as (typeof mediaKeys)[number]],
  );
  if (
    media === null ||
    typeof media.url !== "string" ||
    media.url.length === 0 ||
    typeof media.mediaKey !== "string" ||
    media.mediaKey.length === 0
  ) {
    return null;
  }
  const size = expectedSize(media.fileLength);
  const fileName = optionalString(media.fileName);
  const mimeType = optionalString(media.mimetype);
  if (!size.valid || !fileName.valid || !mimeType.valid) {
    return null;
  }
  return {
    expectedSizeBytes: size.value,
    fileName: fileName.value,
    mimeType: mimeType.value,
    requestBody: { data: { messages } },
  };
};

export const parseDownloadMediaSource = (
  source: MediaSource,
): string | null => {
  const envelope = decodeSource(source);
  return envelope?.version === sourceVersion &&
    envelope.kind === "decrypted-download" &&
    typeof envelope.url === "string"
    ? envelope.url
    : null;
};
