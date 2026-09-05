import type { WebhookEventProcessingMaterial } from "@whatsapp-mcp/db/webhook-event";
import type { NormalizedWebhookDelivery } from "@whatsapp-mcp/whatsapp-provider/webhook";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import {
  EncryptionError,
  EnvelopeEncryptionService,
} from "../src/encryption/envelope";
import { SafeTelemetry, type SafeTelemetryEvent } from "../src/services";
import {
  handleWebhookDeadLetterBatch,
  handleWebhookEventBatch,
  jitteredWebhookRetryDelaySeconds,
  WebhookEventClock,
  WebhookEventIdentifiers,
  WebhookEventNormalization,
  WebhookEventNormalizationError,
  WebhookEventObjectStore,
  WebhookEventObjectStoreError,
  WebhookEventPersistence,
  WebhookEventPersistenceError,
  type WebhookEventQueueMessage,
  WebhookEventRetrySchedule,
} from "../src/webhook-event";

const encoder = new TextEncoder();
const message: WebhookEventQueueMessage = {
  ciphertext_sha256:
    "9b209e3192476f6747c3239d13de46ee2951bb8fc09468f7d2bb9cf0d82d1de0",
  object_id: "40000000-0000-4000-8000-000000000033",
  payload_bytes: 128,
  personal_account_id: "10000000-0000-4000-8000-000000000033",
  received_at: "2026-07-31T12:10:00.000Z",
  version: 1,
  whatsapp_connection_id: "20000000-0000-4000-8000-000000000033",
};
const storedCiphertext = encoder.encode(
  JSON.stringify({
    ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY",
    key_version: 1,
    nonce: "AQIDBAUGBwgJCgsM",
    version: 1,
  }),
);
const identityKey = new Uint8Array(32).fill(33);
const messageSearchKey = new Uint8Array(32).fill(41);
const incidentReference = "50000000-0000-4000-8000-000000000033";

const material: WebhookEventProcessingMaterial = {
  accountKey: {
    ciphertext: "AQI=",
    keyVersion: 1,
    kmsKeyId: "kms-content-root",
    personalAccountId: message.personal_account_id,
    version: 1,
  },
  connectionKey: {
    accountKeyVersion: 1,
    ciphertext: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=",
    connectionId: message.whatsapp_connection_id,
    keyVersion: 1,
    nonce: "AwMDAwMDAwMDAwMD",
    personalAccountId: message.personal_account_id,
    version: 1,
  },
  identityKey: {
    ciphertext: "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=",
    keyVersion: 1,
    nonce: "BgYGBgYGBgYGBgYG",
    version: 1,
  },
  messageSearchKey: {
    ciphertext: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    keyVersion: 1,
    nonce: "CAgICAgICAgICAgI",
    version: 1,
  },
};

const delivery: NormalizedWebhookDelivery = {
  items: [
    {
      classification: "invalid_item_shape",
      itemIndex: 0,
      kind: "malformed",
    },
    {
      evidence: {
        occurredAt: "2026-07-31T12:09:00.000Z",
        version: "wv1.test.signature" as never,
      },
      itemIdentity: `wi1_${"connection_state".padEnd(43, "0")}` as never,
      itemIndex: 1,
      kind: "connection_state",
      state: "connected",
    },
    {
      contact: {
        active: true,
        displayName: "Ada",
        identity: `wi1_${"i".repeat(43)}` as never,
        phoneNumber: "+15550199",
        recipient: `wi1_${"r".repeat(43)}` as never,
      },
      evidence: {
        occurredAt: "2026-07-31T12:09:30.000Z",
        version: "wv1.test.signature" as never,
      },
      itemIdentity: `wi1_${"directory_contact".padEnd(43, "0")}` as never,
      itemIndex: 2,
      kind: "directory_contact",
    },
    {
      classification: "unsupported_item_kind",
      itemIndex: 3,
      kind: "unsupported",
    },
  ],
};

interface HarnessOptions {
  readonly deadLetterUnavailable?: boolean;
  readonly decryptionUnavailable?: boolean;
  readonly normalizationUnavailable?: boolean;
  readonly permanentlyInvalidSource?: boolean;
  readonly objectStoreUnavailable?: boolean;
  readonly persistenceUnavailable?: boolean;
  readonly delivery?: NormalizedWebhookDelivery;
}

const makeHarness = (options: HarnessOptions = {}) => {
  const calls: string[] = [];
  const telemetry: SafeTelemetryEvent[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(WebhookEventObjectStore, {
      load: () =>
        options.objectStoreUnavailable
          ? Effect.fail(new WebhookEventObjectStoreError())
          : Effect.succeed({
              body: storedCiphertext,
              customMetadata: {
                ciphertextSha256: options.permanentlyInvalidSource
                  ? "f".repeat(64)
                  : message.ciphertext_sha256,
                payloadBytes: String(message.payload_bytes),
                personalAccountId: message.personal_account_id,
                receivedAt: message.received_at,
                version: "1",
                whatsappConnectionId: message.whatsapp_connection_id,
              },
            }),
    }),
    Layer.succeed(WebhookEventPersistence, {
      complete: () =>
        Effect.sync(() => {
          calls.push("complete");
        }),
      deadLetter: () =>
        options.deadLetterUnavailable
          ? Effect.fail(new WebhookEventPersistenceError())
          : Effect.sync(() => {
              calls.push("dead-letter");
              return {
                incidentReference,
                outcome: "gap_recorded" as const,
              };
            }),
      prepare: () =>
        options.persistenceUnavailable
          ? Effect.fail(new WebhookEventPersistenceError())
          : Effect.sync(() => {
              calls.push("prepare");
              return material;
            }),
      projectConnectionState: (_input, compareVersions) =>
        Effect.promise(async () => {
          calls.push("project");
          expect(
            await compareVersions("wv1.test.signature", "wv1.test.signature"),
          ).toBe("equal");
          return "applied" as const;
        }),
      projectGroup: (input, protect) =>
        Effect.promise(async () => {
          expect(input.namePrefixIndexes).toHaveLength(4);
          expect(JSON.stringify(input.namePrefixIndexes)).not.toContain("fam");
          const protectedFields = await protect(
            "60000000-0000-4000-8000-000000000039",
          );
          expect(
            protectedFields.displayName?.ciphertext.byteLength,
          ).toBeGreaterThan(0);
          calls.push(`project-group:${input.displayName ?? "null"}`);
          return "applied" as const;
        }),
      projectDirectoryContact: (input, compareVersions) =>
        Effect.promise(async () => {
          calls.push("project-contact");
          expect(input.publicId).toBe("ctc_123456789012345678901");
          expect(input.displayNameCiphertext).not.toBeNull();
          expect(input.phoneCiphertext).not.toBeNull();
          expect(input.providerIdentityCiphertext.ciphertext).not.toContain(
            input.providerIdentityIndex,
          );
          if (input.insertOnly !== true) {
            expect(
              await compareVersions("wv1.test.signature", "wv1.test.signature"),
            ).toBe("equal");
          }
          return "applied" as const;
        }),
      projectStoredMessage: (input) =>
        Effect.sync(() => {
          calls.push(`project-message:${input.media?.publicId ?? "none"}`);
          expect(input.media?.source.ciphertext).not.toContain(
            "provider-media-key",
          );
          expect(input.messageSearch.tokens).toEqual([
            expect.stringMatching(/^msi1_[A-Za-z0-9_-]{43}$/u),
          ]);
          expect(JSON.stringify(input.messageSearch)).not.toContain("hello");
          return "applied" as const;
        }),
      projectStoredMessageEdit: (input, compareVersions) =>
        Effect.promise(async () => {
          calls.push("project-message-edit");
          expect(input.editedAt).toBe("2026-07-31T12:09:30.000Z");
          expect(input.content.ciphertext).not.toContain("edited text");
          expect(input.messageSearch.tokens).toHaveLength(2);
          expect(input.messageSearch.tokens).toEqual(
            expect.arrayContaining([
              expect.stringMatching(/^msi1_[A-Za-z0-9_-]{43}$/u),
            ]),
          );
          expect(
            await compareVersions("wv1.test.signature", "wv1.test.signature"),
          ).toBe("equal");
          return "applied" as const;
        }),
      projectStoredMessageDeletion: (input) =>
        Effect.sync(() => {
          calls.push("project-message-deletion");
          expect(input).toMatchObject({
            deletedAt: "2026-07-31T12:09:45.000Z",
            direction: "inbound",
            recipientKind: "group",
            sentAt: "2026-07-31T12:09:00.000Z",
          });
          return "applied" as const;
        }),
      projectSendEvidence: (input, materialize) =>
        Effect.promise(async () => {
          calls.push(`send-evidence:${input.status}:${input.messageIdentity}`);
          if (input.status === "sent" && materialize !== undefined) {
            const stored = await materialize({
              ciphertext: new TextEncoder().encode("pending"),
              keyVersion: 1,
              nonce: new Uint8Array(12),
              sendId: "60000000-0000-4000-8000-000000000051",
            });
            expect(stored.content.ciphertext).not.toContain("sent text");
            expect(stored.messagePublicId).toMatch(/^msg_/u);
          }
          return "applied" as const;
        }),
      quarantine: (input) =>
        Effect.sync(() => {
          calls.push(`quarantine:${input.classification}`);
        }),
    }),
    Layer.succeed(WebhookEventClock, {
      now: Effect.succeed("2026-07-31T12:10:01.000Z"),
    }),
    Layer.succeed(WebhookEventIdentifiers, {
      nextContactId: Effect.succeed("ctc_123456789012345678901"),
      nextConversationId: Effect.succeed("cvs_123456789012345678901"),
      nextMessageId: Effect.succeed("msg_123456789012345678901"),
      nextMediaId: Effect.succeed("med_123456789012345678901"),
    }),
    Layer.succeed(WebhookEventRetrySchedule, {
      delaySeconds: (attempt) =>
        Effect.sync(() => {
          expect(attempt).toBe(1);
          return 10_123;
        }),
    }),
    Layer.succeed(WebhookEventNormalization, {
      make: (key) =>
        options.normalizationUnavailable
          ? Effect.fail(new WebhookEventNormalizationError())
          : Effect.sync(() => {
              expect(key).toEqual(identityKey);
              return {
                compareVersions: () => Effect.succeed("equal" as const),
                normalize: () => Effect.succeed(options.delivery ?? delivery),
              };
            }),
    }),
    Layer.succeed(EnvelopeEncryptionService, {
      createConnectionKey: () => Effect.die("not used"),
      createPersonalAccountKey: () => Effect.die("not used"),
      decrypt: ({ context }) =>
        options.decryptionUnavailable
          ? Effect.fail(new EncryptionError({ operation: "decrypt" }))
          : context.fieldOrObjectPurpose === "webhook-identity-key"
            ? Effect.succeed(identityKey.slice())
            : context.fieldOrObjectPurpose === "message-search-key"
              ? Effect.succeed(messageSearchKey.slice())
              : Effect.succeed(new Uint8Array(message.payload_bytes)),
      decryptMany: () => Effect.die("not used"),
      encrypt: ({ plaintext }) =>
        Effect.succeed({
          ciphertext: btoa(
            String.fromCharCode(...plaintext, ...new Uint8Array(17).fill(9)),
          ),
          keyVersion: 1,
          nonce: btoa(String.fromCharCode(...new Uint8Array(12).fill(8))),
          version: 1,
        }),
    }),
    Layer.succeed(SafeTelemetry, {
      emit: (event) =>
        Effect.sync(() => {
          telemetry.push(event);
        }),
    }),
  );
  return { calls, layer, telemetry };
};

const queueMessage = (body: unknown) => {
  const acknowledgements: string[] = [];
  const retries: number[] = [];
  return {
    acknowledgements,
    message: {
      ack: () => acknowledgements.push("ack"),
      attempts: 1,
      body,
      id: "webhook-event-message",
      retry: (options?: { readonly delaySeconds?: number }) =>
        retries.push(options?.delaySeconds ?? 0),
      timestamp: new Date(message.received_at),
    } as unknown as Message,
    retries,
  };
};

describe("Webhook Event processing", () => {
  test("projects media-bearing messages with a separately encrypted pending source", async () => {
    const identity = `wi1_${"media-message".padEnd(43, "0")}` as never;
    const recipient = `wi1_${"contact".padEnd(43, "0")}` as never;
    const harness = makeHarness({
      delivery: {
        items: [
          {
            content: {
              mediaSource: Redacted.make("provider-media-key") as never,
              text: "caption",
              type: "image",
            },
            direction: "inbound",
            evidence: { occurredAt: "2026-07-31T12:09:00.000Z", version: null },
            itemIdentity: identity,
            itemIndex: 0,
            kind: "message_upsert",
            messageIdentity: identity,
            recipient,
            recipientKind: "direct",
            sender: null,
            senderContact: {
              displayName: Redacted.make("Ada Lovelace"),
              identity: `wi1_${"sender-contact".padEnd(43, "0")}` as never,
              itemIdentity: `wi1_${"sender-item".padEnd(43, "0")}` as never,
              phoneNumber: Redacted.make("+15550199"),
              recipient,
            },
            sentAt: "2026-07-31T12:09:00.000Z" as never,
          },
        ],
      },
    });
    const queued = queueMessage(message);

    await handleWebhookEventBatch(
      {
        messages: [queued.message],
        queue: "whatsapp-mcp-ingestion",
      } as unknown as MessageBatch,
      harness.layer,
    );

    expect(harness.calls).toContain(
      "project-message:med_123456789012345678901",
    );
    expect(harness.calls).toContain("project-contact");
    expect(queued.acknowledgements).toEqual(["ack"]);
  });

  test("independently quarantines permanent siblings and projects connection state", async () => {
    const harness = makeHarness();
    const queued = queueMessage(message);

    await handleWebhookEventBatch(
      {
        messages: [queued.message],
        queue: "whatsapp-mcp-ingestion",
      } as unknown as MessageBatch,
      harness.layer,
    );

    expect(harness.calls).toEqual([
      "prepare",
      "quarantine:invalid_item_shape",
      "project",
      "project-contact",
      "quarantine:unsupported_item_kind",
      "complete",
    ]);
    expect(queued.acknowledgements).toEqual(["ack"]);
    expect(queued.retries).toEqual([]);
    expect(harness.telemetry).toContainEqual({
      appliedCount: 2,
      duplicateCount: 0,
      event: "webhook_event.processing.completed",
      outcome: "completed",
      quarantinedCount: 2,
      service: "api",
      supersededCount: 0,
      suppressedCount: 0,
    });
  });

  test("encrypts and projects authenticated group items", async () => {
    const recipient = `wi1_${"group".padEnd(43, "0")}` as never;
    const harness = makeHarness({
      delivery: {
        items: [
          {
            evidence: {
              occurredAt: "2026-07-31T12:09:00.000Z",
              version: "wv1.test.signature" as never,
            },
            group: {
              displayName: "Family",
              identity: recipient,
              joined: true,
              recipient,
            },
            itemIdentity: `wi1_${"group-item".padEnd(43, "0")}` as never,
            itemIndex: 0,
            kind: "directory_group",
          },
        ],
      },
    });
    const queued = queueMessage(message);

    await handleWebhookEventBatch(
      {
        messages: [queued.message],
        queue: "whatsapp-mcp-ingestion",
      } as unknown as MessageBatch,
      harness.layer,
    );

    expect(harness.calls).toEqual([
      "prepare",
      "project-group:Family",
      "complete",
    ]);
    expect(queued.acknowledgements).toEqual(["ack"]);
  });

  test("projects authenticated edits and delete-before-upsert tombstones", async () => {
    const messageIdentity = `wi1_${"message".padEnd(43, "0")}` as never;
    const recipient = `wi1_${"group".padEnd(43, "0")}` as never;
    const harness = makeHarness({
      delivery: {
        items: [
          {
            content: {
              mediaSource: null,
              text: "edited text",
              type: "text",
            },
            editedAt: "2026-07-31T12:09:30.000Z" as never,
            evidence: {
              occurredAt: "2026-07-31T12:09:30.000Z",
              version: "wv1.test.signature" as never,
            },
            itemIdentity: `wi1_${"edit-item".padEnd(43, "0")}` as never,
            itemIndex: 0,
            kind: "message_edit",
            messageIdentity,
          },
          {
            deletedAt: "2026-07-31T12:09:45.000Z" as never,
            direction: "inbound",
            evidence: {
              occurredAt: "2026-07-31T12:09:45.000Z",
              version: "wv1.test.signature" as never,
            },
            itemIdentity: `wi1_${"delete-item".padEnd(43, "0")}` as never,
            itemIndex: 1,
            kind: "message_delete",
            messageIdentity,
            recipient,
            recipientKind: "group",
            sentAt: "2026-07-31T12:09:00.000Z" as never,
          },
        ],
      },
    });
    const queued = queueMessage(message);

    await handleWebhookEventBatch(
      {
        messages: [queued.message],
        queue: "whatsapp-mcp-ingestion",
      } as unknown as MessageBatch,
      harness.layer,
    );

    expect(harness.calls).toEqual([
      "prepare",
      "project-message-edit",
      "project-message-deletion",
      "complete",
    ]);
    expect(queued.acknowledgements).toEqual(["ack"]);
  });

  test("retries transient processing failures without acknowledging", async () => {
    const harness = makeHarness({ persistenceUnavailable: true });
    const queued = queueMessage(message);

    await handleWebhookEventBatch(
      {
        messages: [queued.message],
        queue: "whatsapp-mcp-ingestion",
      } as unknown as MessageBatch,
      harness.layer,
    );

    expect(queued.acknowledgements).toEqual([]);
    expect(queued.retries).toEqual([10_123]);
    expect(harness.telemetry).toContainEqual({
      appliedCount: 0,
      duplicateCount: 0,
      event: "webhook_event.processing.completed",
      outcome: "retry",
      quarantinedCount: 0,
      service: "api",
      supersededCount: 0,
      suppressedCount: 0,
    });
  });

  test.each([
    ["R2", { objectStoreUnavailable: true }],
    ["KMS", { decryptionUnavailable: true }],
    ["Neon", { persistenceUnavailable: true }],
    ["Worker", { normalizationUnavailable: true }],
  ] as const)(
    "retries a transient %s failure with jitter and without acknowledging",
    async (_boundary, options) => {
      const harness = makeHarness(options);
      const queued = queueMessage(message);

      await handleWebhookEventBatch(
        {
          messages: [queued.message],
          queue: "whatsapp-mcp-ingestion",
        } as unknown as MessageBatch,
        harness.layer,
      );

      expect(queued.acknowledgements).toEqual([]);
      expect(queued.retries).toEqual([10_123]);
    },
  );

  test("records a processing Ingestion Gap and alerts before acknowledging DLQ work", async () => {
    const harness = makeHarness();
    const queued = queueMessage(message);

    await handleWebhookDeadLetterBatch(
      {
        messages: [queued.message],
        queue: "whatsapp-mcp-ingestion-dlq",
      } as unknown as MessageBatch,
      harness.layer,
    );

    expect(harness.calls).toEqual(["dead-letter"]);
    expect(queued.acknowledgements).toEqual(["ack"]);
    expect(queued.retries).toEqual([]);
    expect(harness.telemetry).toContainEqual({
      event: "webhook_event.dead_letter.completed",
      incidentReference,
      outcome: "gap_recorded",
      service: "api",
    });
  });

  test("records and acknowledges permanent source validation failure without transient retry", async () => {
    const harness = makeHarness({ permanentlyInvalidSource: true });
    const queued = queueMessage(message);

    await handleWebhookEventBatch(
      {
        messages: [queued.message],
        queue: "whatsapp-mcp-ingestion",
      } as unknown as MessageBatch,
      harness.layer,
    );

    expect(harness.calls).toEqual(["dead-letter"]);
    expect(queued.acknowledgements).toEqual(["ack"]);
    expect(queued.retries).toEqual([]);
    expect(harness.telemetry).toContainEqual({
      event: "webhook_event.dead_letter.completed",
      incidentReference,
      outcome: "gap_recorded",
      service: "api",
    });
  });

  test("retries DLQ work without acknowledgement when the gap transaction fails", async () => {
    const harness = makeHarness({ deadLetterUnavailable: true });
    const queued = queueMessage(message);

    await handleWebhookDeadLetterBatch(
      {
        messages: [queued.message],
        queue: "whatsapp-mcp-ingestion-dlq",
      } as unknown as MessageBatch,
      harness.layer,
    );

    expect(queued.acknowledgements).toEqual([]);
    expect(queued.retries).toEqual([300]);
    expect(harness.telemetry).not.toContainEqual(
      expect.objectContaining({
        event: "webhook_event.dead_letter.completed",
      }),
    );
  });

  test("bounds jitter around three hours for the seven-retry Queue policy", () => {
    expect(jitteredWebhookRetryDelaySeconds(0)).toBe(9_900);
    expect(jitteredWebhookRetryDelaySeconds(0.5)).toBe(10_800);
    expect(jitteredWebhookRetryDelaySeconds(1)).toBe(11_700);
  });

  test("projects normalized Send Status evidence instead of quarantining it", async () => {
    const harness = makeHarness({
      delivery: {
        items: [
          {
            direction: "outbound",
            evidence: { occurredAt: "2026-07-31T12:09:45.000Z", version: null },
            itemIdentity: `wi1_${"send_evidence".padEnd(43, "0")}` as never,
            itemIndex: 0,
            kind: "send_evidence",
            messageIdentity: `wi1_${"message".padEnd(43, "0")}` as never,
            status: "delivered",
          },
        ],
      },
    });
    const queued = queueMessage(message);
    await handleWebhookEventBatch(
      {
        messages: [queued.message],
        queue: "whatsapp-mcp-ingestion",
      } as unknown as MessageBatch,
      harness.layer,
    );
    expect(harness.calls).toContain(
      `send-evidence:delivered:wi1_${"message".padEnd(43, "0")}`,
    );
  });

  test("acknowledges a permanently invalid Queue envelope without touching data", async () => {
    const harness = makeHarness();
    const queued = queueMessage({ object_id: "not-an-event" });

    await handleWebhookEventBatch(
      {
        messages: [queued.message],
        queue: "whatsapp-mcp-ingestion",
      } as unknown as MessageBatch,
      harness.layer,
    );

    expect(harness.calls).toEqual([]);
    expect(queued.acknowledgements).toEqual(["ack"]);
    expect(queued.retries).toEqual([]);
    expect(harness.telemetry).toContainEqual({
      appliedCount: 0,
      duplicateCount: 0,
      event: "webhook_event.processing.completed",
      outcome: "invalid_message",
      quarantinedCount: 0,
      service: "api",
      supersededCount: 0,
      suppressedCount: 0,
    });
  });
});
