import {
  makeConversationId,
  makeMessageId,
} from "@whatsapp-mcp/contracts/handles";
import type { SendTextMessageOutput } from "@whatsapp-mcp/contracts/mcp-schema";
import type {
  AtomicSendRepository,
  SendEncryptionMaterial,
  SendGrantIdentity,
} from "@whatsapp-mcp/db/send";
import {
  makeWasenderRecipientRoute,
  makeWasenderTextSending,
  type RecipientLocator,
  type WasenderIdentityProtectionKey,
  type WasenderRecipientRoute,
} from "@whatsapp-mcp/wasender/session";
import { Effect, Redacted } from "effect";
import { decodeBase64, encodeBase64, encodeBase64Url } from "./base64-url";
import type {
  EnvelopeEncryption,
  VersionedCiphertext,
} from "./encryption/envelope";
import type { SendTextMessageResult, SendTextMessageService } from "./mcp";
import {
  importMessageSearchIndexKey,
  messageSearchIndexesForText,
} from "./message-search-privacy";

const encoder = new TextEncoder();
const envelope = (value: {
  readonly ciphertext: Uint8Array;
  readonly keyVersion: number;
  readonly nonce: Uint8Array;
}): VersionedCiphertext => ({
  ciphertext: encodeBase64(value.ciphertext),
  keyVersion: value.keyVersion,
  nonce: encodeBase64(value.nonce),
  version: 1,
});
const sessionCredential = (authority: string): string => {
  const parsed = JSON.parse(authority) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("sessionCredential" in parsed) ||
    typeof parsed.sessionCredential !== "string" ||
    !/^[\x21-\x7e]{1,4096}$/u.test(parsed.sessionCredential)
  ) {
    throw new Error("invalid Wasender send authority");
  }
  return parsed.sessionCredential;
};
const keys = (material: SendEncryptionMaterial) => ({
  accountKey: {
    ciphertext: encodeBase64(material.accountKey.ciphertext),
    keyVersion: material.accountKey.keyVersion,
    kmsKeyId: material.accountKey.kmsKeyId,
    personalAccountId: material.accountKey.personalAccountId,
    version: 1 as const,
  },
  connectionKey: {
    accountKeyVersion: material.connectionKey.accountKeyVersion,
    ciphertext: encodeBase64(material.connectionKey.ciphertext),
    connectionId: material.connectionKey.connectionId,
    keyVersion: material.connectionKey.keyVersion,
    nonce: encodeBase64(material.connectionKey.nonce),
    personalAccountId: material.connectionKey.personalAccountId,
    version: 1 as const,
  },
});
const fingerprintSubject = (grant: SendGrantIdentity): string =>
  grant.kind === "mcp"
    ? grant.authorization.authorizationId
    : `api:${grant.apiKey.grantId}`;

const fingerprint = async (
  key: CryptoKey,
  input: {
    connectionId: string;
    grant: SendGrantIdentity;
    recipientId: string;
    text: string;
  },
): Promise<string> => {
  const parts = [
    fingerprintSubject(input.grant),
    input.connectionId,
    input.recipientId,
    input.text,
  ].map((value) => encoder.encode(value));
  const size = parts.reduce((sum, value) => sum + 4 + value.byteLength, 0);
  const framed = new Uint8Array(size);
  const view = new DataView(framed.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.byteLength);
    offset += 4;
    framed.set(part, offset);
    offset += part.byteLength;
  }
  const signed = await crypto.subtle.sign("HMAC", key, framed);
  return `sf1_${encodeBase64Url(new Uint8Array(signed))}`;
};
const receipt = (
  value: {
    createdAt: Date;
    publicId: string;
    status: SendTextMessageOutput["status"];
    statusChangedAt: Date;
  },
  replay: boolean,
): SendTextMessageOutput => ({
  send_id: value.publicId as SendTextMessageOutput["send_id"],
  status: value.status,
  created_at:
    value.createdAt.toISOString() as SendTextMessageOutput["created_at"],
  status_changed_at:
    value.statusChangedAt.toISOString() as SendTextMessageOutput["status_changed_at"],
  idempotent_replay: replay,
});

export interface AtomicSendServiceOptions {
  readonly encryption: EnvelopeEncryption;
  readonly fingerprintKey: CryptoKey;
  readonly hourRequestLimit: number;
  readonly minuteRequestLimit: number;
  readonly nextAuditLogId: () => string;
  readonly nextStoredMessage?: () => {
    readonly conversationId: string;
    readonly conversationPublicId: string;
    readonly messageId: string;
    readonly messagePublicId: string;
  };
  readonly nextSend: () => { readonly id: string; readonly publicId: string };
  readonly now: () => Date;
  readonly repository: AtomicSendRepository;
  readonly sendDailyLimit: number;
  readonly sendPerMinuteLimit: number;
  readonly telemetry: (event: unknown) => void;
}

export const makeAtomicSendTextMessageService = (
  options: AtomicSendServiceOptions,
): SendTextMessageService => ({
  send: (input, deferProviderAttempt) =>
    Effect.tryPromise(async (): Promise<SendTextMessageResult> => {
      const observedAt = options.now();
      const send = options.nextSend();
      const grant = input.grant;
      const requestFingerprint = await fingerprint(options.fingerprintKey, {
        connectionId: input.connectionId,
        grant,
        recipientId: input.recipientId,
        text: input.text,
      });
      const committed = await options.repository.commit(
        {
          auditLogId: options.nextAuditLogId(),
          connectionPublicId: input.connectionId,
          fingerprint: requestFingerprint,
          grant,
          hourRequestLimit: options.hourRequestLimit,
          idempotencyKey: input.idempotencyKey,
          minuteRequestLimit: options.minuteRequestLimit,
          observedAt,
          pendingExpiresAt: new Date(observedAt.valueOf() + 7 * 86_400_000),
          recipientPublicId: input.recipientId,
          sendDailyLimit: options.sendDailyLimit,
          sendId: send.id,
          sendPublicId: send.publicId,
          sendPerMinuteLimit: options.sendPerMinuteLimit,
        },
        async (material) => {
          const protectedContent = await Effect.runPromise(
            options.encryption.encrypt({
              ...keys(material),
              context: {
                accountId: material.accountKey.personalAccountId,
                connectionId: material.connectionKey.connectionId,
                entity: "send-operation",
                fieldOrObjectPurpose: "pending-send-content",
                recordId: send.id,
              },
              plaintext: encoder.encode(input.text),
            }),
          );
          return {
            ciphertext: decodeBase64(protectedContent.ciphertext),
            keyVersion: protectedContent.keyVersion,
            nonce: decodeBase64(protectedContent.nonce),
          };
        },
      );
      if (committed.outcome === "replay")
        return {
          outcome: "receipt",
          receipt: receipt(committed.receipt, true),
        };
      if (committed.outcome !== "created") return committed;
      const provider = committed.provider;
      const opened = keys(provider);
      const decryptString = async (
        ciphertext: VersionedCiphertext,
        context: { entity: string; purpose: string; recordId: string },
      ): Promise<string> => {
        const value = await Effect.runPromise(
          options.encryption.decrypt({
            ...opened,
            ciphertext,
            context: {
              accountId: provider.accountKey.personalAccountId,
              connectionId: provider.connectionKey.connectionId,
              entity: context.entity,
              fieldOrObjectPurpose: context.purpose,
              recordId: context.recordId,
            },
          }),
        );
        try {
          return new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: false,
          }).decode(value);
        } finally {
          value.fill(0);
        }
      };
      const completeProviderAttempt =
        async (): Promise<SendTextMessageOutput> => {
          let status:
            | "accepted"
            | "sent"
            | "delivered"
            | "read"
            | "failed"
            | "unknown";
          let messageIdentity: string | undefined;
          try {
            const authority = sessionCredential(
              await decryptString(envelope(provider.authority), {
                entity: "whatsapp-connection",
                purpose: "provider-session-authority",
                recordId: provider.connectionKey.connectionId,
              }),
            );
            const recipient = await decryptString(
              envelope(provider.recipient),
              {
                entity:
                  provider.recipientType === "contact"
                    ? "directory-contact"
                    : "whatsapp-group",
                purpose: "provider-identity",
                recordId: provider.recipientRecordId,
              },
            );
            const contactPhone =
              provider.recipientType === "contact" &&
              provider.contactPhone != null
                ? await decryptString(envelope(provider.contactPhone), {
                    entity: "directory-contact",
                    purpose: "phone-number",
                    recordId: provider.recipientRecordId,
                  })
                : null;
            const identityBytes = await Effect.runPromise(
              options.encryption.decrypt({
                ...opened,
                ciphertext: envelope(provider.identityKey),
                context: {
                  accountId: provider.accountKey.personalAccountId,
                  connectionId: provider.connectionKey.connectionId,
                  entity: "whatsapp-connection",
                  fieldOrObjectPurpose: "webhook-identity-key",
                  recordId: provider.connectionKey.connectionId,
                },
              }),
            );
            try {
              const resolvedRecipient =
                contactPhone === null
                  ? (Redacted.make(recipient) as WasenderRecipientRoute)
                  : await makeWasenderRecipientRoute(
                      Redacted.make(
                        identityBytes,
                      ) as WasenderIdentityProtectionKey,
                      "contact",
                      contactPhone,
                    );
              const locator = "send-recipient" as RecipientLocator;
              const adapter = makeWasenderTextSending({
                authority: Redacted.make(authority) as never,
                identityKey: Redacted.make(
                  identityBytes,
                ) as WasenderIdentityProtectionKey,
                resolveRecipient: (candidate) =>
                  candidate === locator ? resolvedRecipient : null,
                telemetry: { emit: options.telemetry },
              });
              const result = await Effect.runPromise(
                adapter.sendText({ recipient: locator, text: input.text }),
              );
              status =
                result.outcome === "ambiguous"
                  ? "unknown"
                  : result.outcome === "definitive_failure"
                    ? "failed"
                    : result.status;
              if (result.outcome === "identity_evidence") {
                messageIdentity = result.messageIdentity;
              }
            } finally {
              identityBytes.fill(0);
            }
          } catch {
            status = "unknown";
          }
          const updated = await options.repository
            .recordProviderOutcome({
              changedAt: options.now(),
              ...(messageIdentity === undefined ? {} : { messageIdentity }),
              sendId: send.id,
              status,
              ...(messageIdentity !== undefined &&
              (status === "sent" || status === "delivered" || status === "read")
                ? {
                    storedMessage: await (async () => {
                      const identifiers = options.nextStoredMessage?.() ?? {
                        conversationId: crypto.randomUUID(),
                        conversationPublicId: makeConversationId(),
                        messageId: crypto.randomUUID(),
                        messagePublicId: makeMessageId(),
                      };
                      const messageSearchKeyBytes = await Effect.runPromise(
                        options.encryption.decrypt({
                          ...opened,
                          ciphertext: envelope(provider.messageSearchKey),
                          context: {
                            accountId: provider.accountKey.personalAccountId,
                            connectionId: provider.connectionKey.connectionId,
                            entity: "whatsapp-connection",
                            fieldOrObjectPurpose: "message-search-key",
                            recordId: provider.connectionKey.connectionId,
                          },
                        }),
                      );
                      let messageSearchTokens: ReadonlyArray<string>;
                      try {
                        const messageSearchKey = await Effect.runPromise(
                          importMessageSearchIndexKey(messageSearchKeyBytes),
                        );
                        messageSearchTokens = await Effect.runPromise(
                          messageSearchIndexesForText(
                            messageSearchKey,
                            provider.connectionKey.connectionId,
                            input.text,
                          ),
                        );
                      } finally {
                        messageSearchKeyBytes.fill(0);
                      }
                      const plaintext = encoder.encode(
                        JSON.stringify({ mediaSource: null, text: input.text }),
                      );
                      const protectedContent = await Effect.runPromise(
                        Effect.acquireUseRelease(
                          Effect.succeed(plaintext),
                          (bytes) =>
                            options.encryption.encrypt({
                              ...opened,
                              context: {
                                accountId:
                                  provider.accountKey.personalAccountId,
                                connectionId:
                                  provider.connectionKey.connectionId,
                                entity: "stored-message",
                                fieldOrObjectPurpose: "content",
                                recordId: messageIdentity,
                              },
                              plaintext: bytes,
                            }),
                          (bytes) => Effect.sync(() => bytes.fill(0)),
                        ),
                      );
                      return {
                        content: {
                          ciphertext: decodeBase64(protectedContent.ciphertext),
                          keyVersion: protectedContent.keyVersion,
                          nonce: decodeBase64(protectedContent.nonce),
                        },
                        contentType: "text" as const,
                        messageSearch: {
                          indexVersion: 1 as const,
                          tokens: messageSearchTokens,
                        },
                        ...identifiers,
                      };
                    })(),
                  }
                : {}),
            })
            .catch(() => committed.receipt);
          return receipt(updated, false);
        };
      if (deferProviderAttempt !== undefined) {
        const providerAttempt = completeProviderAttempt();
        try {
          deferProviderAttempt(providerAttempt.then(() => undefined));
          return {
            outcome: "receipt",
            receipt: receipt(committed.receipt, false),
          };
        } catch {
          // If the runtime cannot extend the request lifetime, complete the
          // already-committed single attempt before returning.
        }
        return {
          outcome: "receipt",
          receipt: await providerAttempt,
        };
      }
      return {
        outcome: "receipt",
        receipt: await completeProviderAttempt(),
      };
    }).pipe(
      Effect.catchAll(() =>
        Effect.succeed({ outcome: "service_unavailable" as const }),
      ),
    ),
});

export const importSendFingerprintKey = async (
  hex: string,
): Promise<CryptoKey> => {
  if (!/^[a-f0-9]{64}$/iu.test(hex))
    throw new Error(
      "SEND_FINGERPRINT_HMAC_SECRET must be a 32-byte hex secret",
    );
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(hex.match(/../gu) ?? [], (part) =>
      Number.parseInt(part, 16),
    ),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
};
