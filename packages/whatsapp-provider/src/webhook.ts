import { Context, Effect, Redacted } from "effect";
import type { AdapterEffect, AdapterReference, UtcTimestamp } from "./common";
import type { LifecycleConnectionState } from "./control";
import type {
  ContactLocator,
  DirectoryContact,
  DirectoryGroup,
  IdentityBearingSendStatus,
  MediaSource,
  RecipientLocator,
  StableMessageIdentity,
} from "./session";

export type {
  AdapterFailureCode,
  OperationClass,
  ProviderNeutralFailure,
  RetryDecision,
} from "./common";

export type WebhookItemIdentity = AdapterReference<"WebhookItemIdentity">;
export type ConvergenceVersion = AdapterReference<"ConvergenceVersion">;

export type ConvergenceVersionComparison =
  | "after"
  | "before"
  | "equal"
  | "incomparable";

export interface ConvergenceEvidence {
  readonly occurredAt: UtcTimestamp | null;
  /**
   * An adapter-private equality token, never a raw provider version.
   */
  readonly version: ConvergenceVersion | null;
}

export type NormalizedContentType =
  | "audio"
  | "document"
  | "image"
  | "sticker"
  | "text"
  | "unknown"
  | "video";

export interface NormalizedMessageContent {
  readonly mediaSource: MediaSource | null;
  readonly text: string | null;
  readonly type: NormalizedContentType;
}

interface NormalizedItemBase {
  readonly evidence: ConvergenceEvidence;
  /**
   * A stable-identity token when the provider supplies one, otherwise the
   * semantic fallback required by ADR 0016. Raw provider identities never
   * become the runtime value.
   */
  readonly itemIdentity: WebhookItemIdentity;
  readonly itemIndex: number;
}

export interface NormalizedMessageUpsert extends NormalizedItemBase {
  readonly content: NormalizedMessageContent;
  readonly direction: "inbound" | "outbound";
  readonly kind: "message_upsert";
  readonly messageIdentity: StableMessageIdentity;
  readonly recipient: RecipientLocator;
  readonly recipientKind?: "direct" | "group";
  readonly sender: ContactLocator | null;
  readonly senderContact: {
    readonly displayName: Redacted.Redacted<string> | null;
    readonly identity: ContactLocator;
    readonly itemIdentity: WebhookItemIdentity;
    readonly phoneNumber: Redacted.Redacted<string> | null;
    readonly recipient: ContactLocator;
  } | null;
  readonly sentAt: UtcTimestamp;
}

export interface NormalizedMessageEdit extends NormalizedItemBase {
  readonly content: NormalizedMessageContent;
  readonly editedAt: UtcTimestamp;
  readonly kind: "message_edit";
  readonly messageIdentity: StableMessageIdentity;
}

export interface NormalizedMessageDeletion extends NormalizedItemBase {
  readonly deletedAt: UtcTimestamp;
  readonly direction?: "inbound" | "outbound";
  readonly kind: "message_delete";
  readonly messageIdentity: StableMessageIdentity;
  readonly recipient?: RecipientLocator;
  readonly recipientKind?: "direct" | "group";
  readonly sentAt?: UtcTimestamp;
}

export interface NormalizedSendEvidence extends NormalizedItemBase {
  readonly direction: "outbound";
  readonly kind: "send_evidence";
  readonly messageIdentity: StableMessageIdentity;
  readonly status: IdentityBearingSendStatus | "failed";
}

export interface NormalizedDirectoryContact extends NormalizedItemBase {
  readonly contact: DirectoryContact;
  readonly kind: "directory_contact";
}

export interface NormalizedDirectoryGroup extends NormalizedItemBase {
  readonly group: DirectoryGroup;
  readonly kind: "directory_group";
}

export interface NormalizedConnectionState extends NormalizedItemBase {
  readonly kind: "connection_state";
  readonly state: LifecycleConnectionState;
}

export interface UnsupportedWebhookItem {
  readonly classification: "unsupported_item_kind";
  readonly itemIndex: number;
  readonly kind: "unsupported";
}

export interface MalformedWebhookItem {
  readonly classification:
    | "invalid_item_shape"
    | "invalid_top_level_shape"
    | "missing_required_identity";
  readonly itemIndex: number | null;
  readonly kind: "malformed";
}

export type NormalizedWebhookItem =
  | MalformedWebhookItem
  | NormalizedConnectionState
  | NormalizedDirectoryContact
  | NormalizedDirectoryGroup
  | NormalizedMessageDeletion
  | NormalizedMessageEdit
  | NormalizedMessageUpsert
  | NormalizedSendEvidence
  | UnsupportedWebhookItem;

export interface NormalizedWebhookDelivery {
  readonly items: ReadonlyArray<NormalizedWebhookItem>;
}

/**
 * Raw bytes enter only here. Unsupported and malformed logical items are
 * returned as safe classifications so valid siblings remain processable.
 */
export interface WebhookNormalization {
  /**
   * Compares opaque versions without exposing provider version syntax or
   * ordering rules to the ingestion domain.
   */
  readonly compareVersions: (request: {
    readonly left: ConvergenceVersion;
    readonly right: ConvergenceVersion;
  }) => AdapterEffect<ConvergenceVersionComparison>;
  readonly normalize: (request: {
    readonly payload: Uint8Array;
    readonly receivedAt: UtcTimestamp;
  }) => AdapterEffect<NormalizedWebhookDelivery>;
}

export const WebhookNormalization = Context.GenericTag<WebhookNormalization>(
  "@whatsapp-mcp/whatsapp-provider/WebhookNormalization",
);

export const webhookNormalizationPolicy = {
  maximumPayloadBytes: 1_048_576,
  operationClass: "webhook-normalization",
} as const;

export type WasenderWebhookAuthenticationResult =
  | "authenticated"
  | "authentication_failed"
  | "invalid_authority"
  | "invalid_payload"
  | "session_mismatch";

interface WasenderWebhookAuthority {
  readonly sessionCredential: string;
  readonly webhookVerificationSecret: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const protectedValue = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[\x21-\x7e]{1,4096}$/u.test(value) &&
  value.trim() === value;

const parseWebhookAuthority = (
  authority: Redacted.Redacted<string>,
): WasenderWebhookAuthority | null => {
  try {
    const value = JSON.parse(Redacted.value(authority)) as unknown;
    if (
      !isRecord(value) ||
      !protectedValue(value.sessionCredential) ||
      !protectedValue(value.webhookVerificationSecret)
    ) {
      return null;
    }
    return {
      sessionCredential: value.sessionCredential,
      webhookVerificationSecret: value.webhookVerificationSecret,
    };
  } catch {
    return null;
  }
};

const sha256 = (value: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((digest) => new Uint8Array(digest));

const constantTimeEqual = async (
  left: string,
  right: string,
): Promise<boolean> => {
  const [leftDigest, rightDigest] = await Promise.all([
    sha256(left),
    sha256(right),
  ]);
  let difference = 0;
  for (let index = 0; index < leftDigest.byteLength; index += 1) {
    difference |= (leftDigest[index] ?? 0) ^ (rightDigest[index] ?? 0);
  }
  return difference === 0;
};

const payloadSessionIdentities = (
  value: Record<string, unknown>,
): ReadonlyArray<unknown> => {
  const identities: unknown[] = [];
  for (const container of [
    value,
    isRecord(value.data) ? value.data : undefined,
  ]) {
    if (container === undefined) continue;
    for (const field of ["sessionId", "session_id"] as const) {
      if (Object.hasOwn(container, field)) identities.push(container[field]);
    }
  }
  return identities;
};

/**
 * Keeps Wasender credential and payload field names inside the adapter seam.
 * Callers receive only a safe classification and must never log either input.
 */
export const authenticateWasenderWebhook = (input: {
  readonly authority: Redacted.Redacted<string>;
  readonly payload: Uint8Array;
  readonly signature: string;
}): Effect.Effect<WasenderWebhookAuthenticationResult> =>
  Effect.promise(async () => {
    const authority = parseWebhookAuthority(input.authority);
    if (authority === null) return "invalid_authority";

    if (
      !protectedValue(input.signature) ||
      !(await constantTimeEqual(
        authority.webhookVerificationSecret,
        input.signature,
      ))
    ) {
      return "authentication_failed";
    }

    let payloadValue: unknown;
    try {
      payloadValue = JSON.parse(
        new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: false,
        }).decode(input.payload),
      ) as unknown;
    } catch {
      return "invalid_payload";
    }
    if (!isRecord(payloadValue)) return "invalid_payload";

    const identities = payloadSessionIdentities(payloadValue);
    for (const identity of identities) {
      if (!protectedValue(identity)) return "invalid_payload";
      if (!(await constantTimeEqual(identity, authority.sessionCredential))) {
        return "session_mismatch";
      }
    }
    return "authenticated";
  });

export {
  importWebhookIdentityKey,
  makeWasenderWebhookNormalization,
  makeWasenderWebhookNormalizationLayer,
  WebhookIdentityKeyError,
} from "./wasender-webhook-normalization";
