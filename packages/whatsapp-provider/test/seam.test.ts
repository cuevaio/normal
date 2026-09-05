import { describe, expect, test } from "bun:test";
import { Effect, Layer, Redacted, Stream } from "effect";
import {
  type LifecycleSession,
  type LifecycleSessionLocator,
  type SessionAuthority,
  SessionLifecycle,
  type SetupMarker,
  type WebhookEndpoint,
  type WhatsAppNumber,
} from "../src/control";
import {
  type ContactLocator,
  type DirectoryContact,
  type DirectoryGroup,
  type DirectoryObservation,
  type GroupLocator,
  MediaRetrieval,
  type MediaSource,
  makeBoundedRetryAfterMs,
  makeMediaDownloadByteLimit,
  type ProviderNeutralFailure,
  SessionDirectory,
  type StableMessageIdentity,
  TextSending,
} from "../src/session";
import {
  type ConvergenceVersion,
  type NormalizedWebhookDelivery,
  type NormalizedWebhookItem,
  type WebhookItemIdentity,
  WebhookNormalization,
} from "../src/webhook";

const setupMarker = "setup-marker" as SetupMarker;
const phoneNumber = Redacted.make("+15550123456") as WhatsAppNumber;
const webhookEndpoint = Redacted.make(
  "https://api.example.test/webhooks/wasender/30000000-0000-4000-8000-000000000041",
) as WebhookEndpoint;
const session = "sealed-session" as LifecycleSessionLocator;
const sessionAuthority = Redacted.make("session-authority") as SessionAuthority;
const contact = "sealed-contact" as ContactLocator;
const group = "sealed-group" as GroupLocator;
const messageIdentity = "keyed-message-identity" as StableMessageIdentity;
const mediaSource = Redacted.make("media-source") as MediaSource;
const webhookItemIdentity =
  "keyed-webhook-item-identity" as WebhookItemIdentity;
const earlierVersion = "sealed-earlier-version" as ConvergenceVersion;
const laterVersion = "sealed-later-version" as ConvergenceVersion;

const lifecycleSession: LifecycleSession = {
  authority: sessionAuthority,
  connectionState: "connecting",
  session,
};

const contactEntry: DirectoryContact = {
  active: true,
  displayName: "Ada",
  identity: contact,
  phoneNumber: "+15550199",
  recipient: contact,
};

const contacts: DirectoryObservation<DirectoryContact> = {
  completeness: "complete",
  entries: [contactEntry],
  observedAt: "2026-07-30T12:00:00Z",
  stale: false,
};

const webhookDelivery: NormalizedWebhookDelivery = {
  items: [
    {
      direction: "outbound",
      evidence: {
        occurredAt: "2026-07-30T12:00:00Z",
        version: null,
      },
      itemIdentity: webhookItemIdentity,
      itemIndex: 0,
      kind: "send_evidence",
      messageIdentity,
      status: "delivered",
    },
    {
      classification: "unsupported_item_kind",
      itemIndex: 1,
      kind: "unsupported",
    },
  ],
};

const evidence = {
  occurredAt: "2026-07-30T12:00:00Z",
  version: null,
} as const;

const normalizedItemKinds = [
  {
    content: {
      mediaSource: null,
      text: "hello",
      type: "text",
    },
    direction: "inbound",
    evidence,
    itemIdentity: webhookItemIdentity,
    itemIndex: 0,
    kind: "message_upsert",
    messageIdentity,
    recipient: contact,
    sender: contact,
    senderContact: null,
    sentAt: "2026-07-30T12:00:00Z",
  },
  {
    content: {
      mediaSource: null,
      text: "edited",
      type: "text",
    },
    editedAt: "2026-07-30T12:01:00Z",
    evidence,
    itemIdentity: webhookItemIdentity,
    itemIndex: 1,
    kind: "message_edit",
    messageIdentity,
  },
  {
    deletedAt: "2026-07-30T12:02:00Z",
    evidence,
    itemIdentity: webhookItemIdentity,
    itemIndex: 2,
    kind: "message_delete",
    messageIdentity,
  },
  {
    direction: "outbound",
    evidence,
    itemIdentity: webhookItemIdentity,
    itemIndex: 3,
    kind: "send_evidence",
    messageIdentity,
    status: "delivered",
  },
  {
    contact: contactEntry,
    evidence,
    itemIdentity: webhookItemIdentity,
    itemIndex: 4,
    kind: "directory_contact",
  },
  {
    evidence,
    group: {
      displayName: "Family",
      identity: group,
      joined: true,
      recipient: group,
    } satisfies DirectoryGroup,
    itemIdentity: webhookItemIdentity,
    itemIndex: 5,
    kind: "directory_group",
  },
  {
    evidence,
    itemIdentity: webhookItemIdentity,
    itemIndex: 6,
    kind: "connection_state",
    state: "connected",
  },
  {
    classification: "unsupported_item_kind",
    itemIndex: 7,
    kind: "unsupported",
  },
  {
    classification: "invalid_item_shape",
    itemIndex: 8,
    kind: "malformed",
  },
] satisfies ReadonlyArray<NormalizedWebhookItem>;

describe("provider-neutral capability seam", () => {
  test("keeps lifecycle authority separate and reconcile-before-write", async () => {
    let reconciliations = 0;
    let creates = 0;

    const layer = Layer.succeed(SessionLifecycle, {
      connectSession: () => Effect.succeed(lifecycleSession),
      createSession: () => {
        creates += 1;
        return Effect.succeed(lifecycleSession);
      },
      deleteSession: () => Effect.succeed({ state: "present" }),
      disconnectSession: () =>
        Effect.succeed({
          ...lifecycleSession,
          connectionState: "disconnected",
        }),
      getQrCode: () => Effect.succeed({ state: "not_available" }),
      listSessions: () => Effect.succeed([]),
      reconcileSession: () => {
        reconciliations += 1;
        return Effect.succeed({ outcome: "absent" });
      },
      repairSessionConfiguration: () => Effect.succeed(lifecycleSession),
      verifySessionNumber: () => Effect.succeed({ outcome: "match" }),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* SessionLifecycle;
        const reconciliation = yield* lifecycle.reconcileSession({
          setupMarker,
        });
        if (reconciliation.outcome === "absent") {
          return yield* lifecycle.createSession({
            phoneNumber,
            setupMarker,
            webhookEndpoint,
          });
        }
        return null;
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toEqual(lifecycleSession);
    expect(JSON.stringify(result)).not.toContain("session-authority");
    expect({ creates, reconciliations }).toEqual({
      creates: 1,
      reconciliations: 1,
    });
  });

  test("uses independent per-session Directory, send, and media capabilities", async () => {
    const byteLimit = makeMediaDownloadByteLimit(5_000_000);
    const layer = Layer.mergeAll(
      Layer.succeed(SessionDirectory, {
        readContacts: () => Effect.succeed(contacts),
        readGroups: () =>
          Effect.succeed({
            completeness: "complete",
            entries: [],
            observedAt: "2026-07-30T12:00:00Z",
            stale: false,
          }),
      }),
      Layer.succeed(TextSending, {
        sendText: ({ text }) =>
          Effect.succeed({
            messageIdentity,
            outcome: "identity_evidence",
            status: text === "hello" ? "sent" : "accepted",
          }),
      }),
      Layer.succeed(MediaRetrieval, {
        download: ({ maxBytes }) =>
          Effect.succeed({
            maxBytes,
            stream: Stream.empty,
          }),
        getMetadata: () =>
          Effect.succeed({
            expectedSizeBytes: 4,
            fileName: "photo.jpg",
            mimeType: "image/jpeg",
            source: mediaSource,
          }),
      }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const directory = yield* SessionDirectory;
        const sending = yield* TextSending;
        const media = yield* MediaRetrieval;
        const directoryResult = yield* directory.readContacts();
        const sendResult = yield* sending.sendText({
          recipient: contact,
          text: "hello",
        });
        const metadata = yield* media.getMetadata({
          source: mediaSource,
        });
        const download = yield* media.download({
          maxBytes: byteLimit,
          source: metadata.source,
        });
        return { directoryResult, download, metadata, sendResult };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.directoryResult).toEqual(contacts);
    expect(result.sendResult).toEqual({
      messageIdentity,
      outcome: "identity_evidence",
      status: "sent",
    });
    expect(Number(result.download.maxBytes)).toBe(5_000_000);
    expect(JSON.stringify(result.metadata)).not.toContain("media-source");
  });

  test("normalizes every webhook item independently", async () => {
    const layer = Layer.succeed(WebhookNormalization, {
      compareVersions: ({ left, right }) =>
        Effect.succeed(
          left === right
            ? "equal"
            : left === earlierVersion
              ? "before"
              : "after",
        ),
      normalize: () => Effect.succeed(webhookDelivery),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const normalizer = yield* WebhookNormalization;
        const delivery = yield* normalizer.normalize({
          payload: new Uint8Array([123, 125]),
          receivedAt: "2026-07-30T12:00:01Z",
        });
        const versionComparison = yield* normalizer.compareVersions({
          left: earlierVersion,
          right: laterVersion,
        });
        return { delivery, versionComparison };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.delivery.items).toHaveLength(2);
    expect(result.delivery.items.map((item) => item.kind)).toEqual([
      "send_evidence",
      "unsupported",
    ]);
    expect(result.delivery.items[0]).toHaveProperty(
      "itemIdentity",
      webhookItemIdentity,
    );
    expect(result.versionComparison).toBe("before");
    expect(JSON.stringify(result.delivery)).not.toContain("wasender");
  });

  test("fixes the supported provider-neutral webhook item kinds", () => {
    expect(normalizedItemKinds.map((item) => item.kind)).toEqual([
      "message_upsert",
      "message_edit",
      "message_delete",
      "send_evidence",
      "directory_contact",
      "directory_group",
      "connection_state",
      "unsupported",
      "malformed",
    ]);
  });

  test("rejects unbounded media download limits", () => {
    expect(() => makeMediaDownloadByteLimit(0)).toThrow(RangeError);
    expect(() => makeMediaDownloadByteLimit(100_000_001)).toThrow(RangeError);
    expect(() => makeMediaDownloadByteLimit(1.5)).toThrow(RangeError);
  });

  test("caps Retry-After within the safe-read policy", () => {
    expect(Number(makeBoundedRetryAfterMs(250))).toBe(250);
    expect(Number(makeBoundedRetryAfterMs(25_000))).toBe(5_000);
    expect(() => makeBoundedRetryAfterMs(-1)).toThrow(RangeError);
  });
});

type Exact<Actual, Expected> = (<Value>() => Value extends Actual
  ? 1
  : 2) extends <Value>() => Value extends Expected ? 1 : 2
  ? true
  : false;
type Assert<Condition extends true> = Condition;
type LifecycleFailure = Extract<
  ProviderNeutralFailure,
  { readonly operation: "lifecycle-write" }
>;
type TextSendFailure = Extract<
  ProviderNeutralFailure,
  { readonly operation: "text-send" }
>;

export type LifecycleRetryDecisionContract = Assert<
  Exact<
    LifecycleFailure["retryDecision"],
    "do_not_retry" | "reconcile_before_repeat"
  >
>;
export type LifecycleRetryDelayContract = Assert<
  Exact<LifecycleFailure["retryAfterMs"], null>
>;
export type TextSendFailureContract = Assert<Exact<TextSendFailure, never>>;
