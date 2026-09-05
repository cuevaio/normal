import { createHash } from "node:crypto";
import type {
  FinalizeStoredMediaOutcome,
  StoredMediaCiphertext,
  StoredMediaType,
} from "@whatsapp-mcp/db/stored-media";
import type {
  MediaRetrieval,
  MediaSource,
  ProviderNeutralFailure,
} from "@whatsapp-mcp/whatsapp-provider/session";
import { makeMediaDownloadByteLimit } from "@whatsapp-mcp/whatsapp-provider/session";
import { Effect, Stream } from "effect";
import type {
  ConnectionKeyEnvelope,
  EnvelopeEncryption,
  PersonalAccountKeyEnvelope,
} from "./encryption/envelope";
import type { StoredMediaContainer } from "./encryption/stored-media-container";

export const STORED_MEDIA_LIMITS: Readonly<Record<StoredMediaType, number>> = {
  audio: 16_000_000,
  document: 100_000_000,
  image: 5_000_000,
  sticker: 100_000,
  video: 50_000_000,
};

export interface StoredMediaProcessingInput {
  readonly accountKey: PersonalAccountKeyEnvelope;
  readonly connectionKey: ConnectionKeyEnvelope;
  readonly id: string;
  readonly mediaType: StoredMediaType;
  readonly objectKey: string;
  readonly personalAccountId: string;
  readonly source: MediaSource;
  readonly whatsappConnectionId: string;
}

export interface StoredMediaProcessingPersistence {
  readonly fail: (input: {
    readonly code: "policy_rejected" | "processing_failed";
    readonly id: string;
    readonly personalAccountId: string;
  }) => Promise<boolean>;
  readonly finalize: (input: {
    readonly id: string;
    readonly metadata: StoredMediaCiphertext;
    readonly objectKey: string;
    readonly personalAccountId: string;
    readonly plaintextSizeBytes: number;
    readonly sha256: string;
  }) => Promise<FinalizeStoredMediaOutcome>;
}

const normalizeMimeType = (value: string | null): string => {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(
    normalized,
  )
    ? normalized
    : "application/octet-stream";
};

const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) {}
  } finally {
    reader.releaseLock();
  }
};

const policyFailure = (error: unknown): boolean => {
  const code = (error as Partial<ProviderNeutralFailure> | null)?.code;
  return code === "source_rejected" || code === "response_too_large";
};

export const processStoredMedia = async (options: {
  readonly container: StoredMediaContainer;
  readonly deleteObject: (objectKey: string) => Promise<void>;
  readonly encryption: EnvelopeEncryption;
  readonly input: StoredMediaProcessingInput;
  readonly persistence: StoredMediaProcessingPersistence;
  readonly retrieval: MediaRetrieval;
}): Promise<
  "failed" | "quota_exceeded" | "ready" | "rejected" | "suppressed"
> => {
  const { input } = options;
  const context = {
    connectionId: input.whatsappConnectionId,
    mediaObjectId: input.id,
    personalAccountId: input.personalAccountId,
  };
  let objectWritten = false;
  try {
    const metadata = await Effect.runPromise(
      options.retrieval.getMetadata({ source: input.source }),
    );
    const maximumBytes = STORED_MEDIA_LIMITS[input.mediaType];
    if (
      metadata.expectedSizeBytes !== null &&
      metadata.expectedSizeBytes > maximumBytes
    )
      throw { _tag: "ProviderNeutralFailure", code: "response_too_large" };
    const download = await Effect.runPromise(
      options.retrieval.download({
        maxBytes: makeMediaDownloadByteLimit(maximumBytes),
        source: metadata.source,
      }),
    );
    const hash = createHash("sha256");
    const hashing = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        hash.update(chunk);
        controller.enqueue(chunk);
      },
    });
    objectWritten = true;
    const result = await Effect.runPromise(
      options.container.write({
        accountKey: input.accountKey,
        connectionKey: input.connectionKey,
        context,
        objectKey: input.objectKey,
        plaintext: Stream.toReadableStream(download.stream).pipeThrough(
          hashing,
        ),
      }),
    );
    if (
      metadata.expectedSizeBytes !== null &&
      metadata.expectedSizeBytes !== result.plaintextBytes
    )
      throw new Error("provider size did not match actual Stored Media bytes");
    await drain(
      await Effect.runPromise(
        options.container.read({
          accountKey: input.accountKey,
          connectionKey: input.connectionKey,
          context,
          objectKey: input.objectKey,
        }),
      ),
    );
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        fileName: metadata.fileName,
        mimeType: normalizeMimeType(metadata.mimeType),
      }),
    );
    const protectedMetadata = await Effect.runPromise(
      options.encryption
        .encrypt({
          accountKey: input.accountKey,
          connectionKey: input.connectionKey,
          context: {
            accountId: input.personalAccountId,
            connectionId: input.whatsappConnectionId,
            entity: "stored-media",
            fieldOrObjectPurpose: "metadata",
            recordId: input.id,
          },
          plaintext,
        })
        .pipe(Effect.ensuring(Effect.sync(() => plaintext.fill(0)))),
    );
    const outcome = await options.persistence.finalize({
      id: input.id,
      metadata: protectedMetadata,
      objectKey: input.objectKey,
      personalAccountId: input.personalAccountId,
      plaintextSizeBytes: result.plaintextBytes,
      sha256: hash.digest("hex"),
    });
    if (outcome !== "ready") {
      // A losing upload is removed from object storage, including one that a
      // WhatsApp Recipient Exclusion overtook while it was being processed.
      await options.deleteObject(input.objectKey);
      return outcome === "quota_exceeded"
        ? "quota_exceeded"
        : outcome === "recipient_excluded"
          ? "suppressed"
          : "failed";
    }
    return "ready";
  } catch (error) {
    if (objectWritten)
      await options.deleteObject(input.objectKey).catch(() => undefined);
    const rejected = policyFailure(error);
    await options.persistence.fail({
      code: rejected ? "policy_rejected" : "processing_failed",
      id: input.id,
      personalAccountId: input.personalAccountId,
    });
    return rejected ? "rejected" : "failed";
  }
};
