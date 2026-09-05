import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import { parseEncryptedMediaSource } from "../src/media-source";
import {
  importWebhookIdentityKey,
  makeWasenderWebhookNormalization,
  makeWasenderWebhookNormalizationLayer,
  type NormalizedWebhookDelivery,
  WebhookNormalization,
} from "../src/webhook";
import {
  connectionFixtures,
  contactsFixture,
  deletionFixture,
  editFixture,
  groupsFixture,
  messageBatchFixture,
  receiptFixture,
  sentFixtures,
  statusFixture,
} from "./fixtures/webhook";

const encoder = new TextEncoder();
const receivedAt = "2026-07-30T12:00:00.000Z";
const identityKeyBytes = encoder.encode("0123456789abcdef0123456789abcdef");

const encode = (value: unknown): Uint8Array =>
  encoder.encode(JSON.stringify(value));

const makeNormalizer = async (): Promise<WebhookNormalization> => {
  const key = await Effect.runPromise(
    importWebhookIdentityKey(identityKeyBytes),
  );
  return makeWasenderWebhookNormalization(key);
};

const normalize = async (
  normalizer: WebhookNormalization,
  value: unknown,
  observedAt = receivedAt,
): Promise<NormalizedWebhookDelivery> =>
  Effect.runPromise(
    normalizer.normalize({
      payload: encode(value),
      receivedAt: observedAt,
    }),
  );

describe("Wasender webhook normalization", () => {
  test("provides the production capability as an Effect Layer", async () => {
    const key = await Effect.runPromise(
      importWebhookIdentityKey(identityKeyBytes),
    );
    const delivery = await Effect.runPromise(
      Effect.gen(function* () {
        const normalizer = yield* WebhookNormalization;
        return yield* normalizer.normalize({
          payload: encode(groupsFixture),
          receivedAt,
        });
      }).pipe(Effect.provide(makeWasenderWebhookNormalizationLayer(key))),
    );

    expect(delivery.items).toMatchObject([{ kind: "directory_group" }]);
  });

  test("normalizes every valid message in a batch around malformed siblings", async () => {
    const normalizer = await makeNormalizer();
    const delivery = await normalize(normalizer, messageBatchFixture);

    expect(delivery.items.map((item) => item.kind)).toEqual([
      "message_upsert",
      "message_upsert",
      "malformed",
      "message_upsert",
      "message_upsert",
      "unsupported",
    ]);
    expect(delivery.items[2]).toEqual({
      classification: "missing_required_identity",
      itemIndex: 2,
      kind: "malformed",
    });
    expect(delivery.items[0]).toMatchObject({
      content: { mediaSource: null, text: "hello", type: "text" },
      direction: "inbound",
      itemIndex: 0,
      kind: "message_upsert",
      sentAt: "2025-07-28T10:59:50.000Z",
      senderContact: {
        identity: expect.stringMatching(/^wi1_/u),
        itemIdentity: expect.stringMatching(/^wi1_/u),
        recipient: expect.stringMatching(/^loc_v2_c_/u),
      },
    });
    const first = delivery.items[0];
    if (
      first?.kind !== "message_upsert" ||
      first.sender === null ||
      first.senderContact?.displayName === null ||
      first.senderContact?.displayName === undefined ||
      first.senderContact.phoneNumber === null
    )
      throw new Error("expected protected sender contact");
    expect(Redacted.value(first.senderContact.displayName)).toBe(
      "Ada Lovelace",
    );
    expect(Redacted.value(first.senderContact.phoneNumber)).toBe("+15550101");
    expect(first.senderContact.recipient).not.toBe(
      first.senderContact.identity,
    );
    expect(first.recipient).toBe(first.sender);
    expect(delivery.items[1]).toMatchObject({
      content: { text: "photo", type: "image" },
      itemIndex: 1,
      kind: "message_upsert",
    });
    expect(delivery.items[3]).toMatchObject({
      content: {
        mediaSource: null,
        text: "optional fields absent",
        type: "text",
      },
      itemIndex: 3,
      kind: "message_upsert",
      sentAt: "2025-07-28T11:00:00.000Z",
    });
    expect(delivery.items[4]).toMatchObject({
      kind: "message_upsert",
      sender: null,
    });
    expect(delivery.items[5]).toEqual({
      classification: "unsupported_item_kind",
      itemIndex: 5,
      kind: "unsupported",
    });

    const serialized = JSON.stringify(delivery);
    expect(serialized).not.toContain("inbound-text-1");
    expect(serialized).not.toContain("15550101");
    expect(serialized).not.toContain("provider-media-key");
    expect(serialized).not.toContain("provider-object");
    const image = delivery.items[1];
    expect(image?.kind).toBe("message_upsert");
    if (image?.kind === "message_upsert") {
      const mediaSource = image.content.mediaSource;
      if (mediaSource === null) {
        throw new Error("expected a protected media source");
      }
      expect(Redacted.value(mediaSource)).toContain("provider-media-key");
    }
  });

  test("preserves a retrievable provider source for media messages", async () => {
    const normalizer = await makeNormalizer();
    const delivery = await normalize(normalizer, messageBatchFixture);
    const image = delivery.items[1];

    expect(image?.kind).toBe("message_upsert");
    if (image?.kind !== "message_upsert") {
      throw new Error("expected normalized image message");
    }
    expect(image.content.mediaSource).not.toBeNull();
    if (image.content.mediaSource === null) {
      throw new Error("expected protected media source");
    }

    expect(parseEncryptedMediaSource(image.content.mediaSource)).toMatchObject({
      expectedSizeBytes: null,
      fileName: null,
      mimeType: "image/jpeg",
      requestBody: {
        data: {
          messages: {
            key: {
              id: "inbound-image-1",
              remoteJid: "120363000000@g.us",
            },
            message: {
              imageMessage: {
                caption: "photo",
                mediaKey: "provider-media-key",
                mimetype: "image/jpeg",
                url: "https://mmg.whatsapp.net/provider-object",
              },
            },
          },
        },
      },
    });
  });

  test("isolates malformed media metadata from valid batch siblings", async () => {
    const normalizer = await makeNormalizer();
    const payload =
      '{"event":"messages.upsert","data":{"messages":[' +
      '{"key":{"id":"valid","fromMe":false,"remoteJid":"15550101@s.whatsapp.net"},' +
      '"message":{"conversation":"hello"}},' +
      '{"key":{"id":"invalid-media","fromMe":false,"remoteJid":"15550102@s.whatsapp.net"},' +
      '"message":{"imageMessage":{"fileLength":1e400}}}' +
      "]}}";
    const delivery = await Effect.runPromise(
      normalizer.normalize({
        payload: encoder.encode(payload),
        receivedAt,
      }),
    );

    expect(delivery.items).toMatchObject([
      { itemIndex: 0, kind: "message_upsert" },
      {
        classification: "invalid_item_shape",
        itemIndex: 1,
        kind: "malformed",
      },
    ]);
  });

  test("fails closed on missing direction and unsupported conversations", async () => {
    const normalizer = await makeNormalizer();
    const delivery = await normalize(normalizer, {
      event: "messages.upsert",
      data: {
        messages: [
          {
            key: {
              id: "missing-direction",
              remoteJid: "15550101@s.whatsapp.net",
            },
            message: { conversation: "direction is required" },
          },
          {
            key: {
              id: "invalid-conversation",
              fromMe: false,
              remoteJid: "not a provider address",
            },
            message: { conversation: "unsupported address" },
          },
        ],
      },
    });

    expect(delivery.items).toEqual([
      {
        classification: "invalid_item_shape",
        itemIndex: 0,
        kind: "malformed",
      },
      {
        classification: "unsupported_item_kind",
        itemIndex: 1,
        kind: "unsupported",
      },
    ]);
  });

  test("does not turn content-free provider items into Stored Messages", async () => {
    const normalizer = await makeNormalizer();
    const delivery = await normalize(normalizer, {
      event: "messages.upsert",
      data: {
        messages: [
          {
            key: {
              id: "missing-content",
              fromMe: false,
              remoteJid: "15550101@s.whatsapp.net",
            },
          },
          {
            key: {
              id: "provider-control-item",
              fromMe: false,
              remoteJid: "120363000000@g.us",
            },
            message: {
              senderKeyDistributionMessage: {
                groupId: "provider-control-group",
              },
            },
          },
        ],
      },
    });

    expect(delivery.items).toEqual([
      {
        classification: "unsupported_item_kind",
        itemIndex: 0,
        kind: "unsupported",
      },
      {
        classification: "unsupported_item_kind",
        itemIndex: 1,
        kind: "unsupported",
      },
    ]);
  });

  test("normalizes edits, deletions, and receipt or send evidence", async () => {
    const normalizer = await makeNormalizer();
    const deliveries = await Promise.all(
      [
        editFixture,
        deletionFixture,
        statusFixture,
        receiptFixture,
        ...sentFixtures,
      ].map((fixture) => normalize(normalizer, fixture)),
    );

    expect(
      deliveries.map(({ items }) => items.map((item) => item.kind)),
    ).toEqual([
      ["message_edit"],
      ["message_delete", "malformed"],
      ["send_evidence", "send_evidence"],
      ["send_evidence"],
      ["message_upsert"],
      ["send_evidence"],
    ]);
    expect(deliveries[0]?.items[0]).toMatchObject({
      content: { mediaSource: null, text: "hello, edited", type: "text" },
      editedAt: "2025-07-28T11:00:50.000Z",
      kind: "message_edit",
    });
    expect(deliveries[1]?.items[1]).toEqual({
      classification: "missing_required_identity",
      itemIndex: 1,
      kind: "malformed",
    });
    expect(deliveries[2]?.items).toMatchObject([
      { kind: "send_evidence", status: "read" },
      { kind: "send_evidence", status: "failed" },
    ]);
    expect(deliveries[3]?.items[0]).toMatchObject({
      kind: "send_evidence",
      status: "read",
    });
    expect(deliveries[4]?.items[0]).toMatchObject({
      content: { mediaSource: null, text: "sent text", type: "text" },
      direction: "outbound",
      kind: "message_upsert",
    });
    expect(deliveries[5]?.items[0]).toMatchObject({
      kind: "send_evidence",
      status: "failed",
    });
  });

  test("correlates message evidence by exact provider message identity", async () => {
    const normalizer = await makeNormalizer();
    const providerMessageId = "shared-provider-message";
    const [upsert, status, deletion] = await Promise.all([
      normalize(normalizer, {
        event: "messages.upsert",
        data: {
          messages: {
            key: {
              id: providerMessageId,
              fromMe: true,
              remoteJid: "15550110@s.whatsapp.net",
            },
            message: { conversation: "sent text" },
          },
        },
      }),
      normalize(normalizer, {
        event: "messages.update",
        data: {
          key: {
            id: providerMessageId,
            fromMe: true,
            remoteJid: "+15550110",
          },
          update: { status: 2 },
        },
      }),
      normalize(normalizer, {
        event: "messages.delete",
        data: { keys: [{ id: providerMessageId }] },
      }),
    ]);
    const upsertItem = upsert.items[0];
    const statusItem = status.items[0];
    const deletionItem = deletion.items[0];
    if (
      upsertItem?.kind !== "message_upsert" ||
      statusItem?.kind !== "send_evidence" ||
      deletionItem?.kind !== "message_delete"
    ) {
      throw new Error("expected identity-bearing message evidence");
    }

    expect(
      new Set([
        upsertItem.messageIdentity,
        statusItem.messageIdentity,
        deletionItem.messageIdentity,
      ]).size,
    ).toBe(1);
  });

  test("does not turn inbound status changes into outbound send evidence", async () => {
    const normalizer = await makeNormalizer();
    const delivery = await normalize(normalizer, {
      event: "messages.update",
      data: {
        key: {
          id: "inbound-status",
          fromMe: false,
          remoteJid: "15550110@s.whatsapp.net",
        },
        update: { status: 3 },
      },
    });

    expect(delivery.items).toEqual([
      {
        classification: "unsupported_item_kind",
        itemIndex: 0,
        kind: "unsupported",
      },
    ]);
  });

  test("falls back to receipt time for deletion and rejects content-free edits", async () => {
    const normalizer = await makeNormalizer();
    const deletionWithoutTimestamp = {
      event: "messages.delete",
      data: {
        keys: [deletionFixture.data.keys[0]],
      },
    };
    const editWithoutContent = {
      ...editFixture,
      data: {
        messages: {
          ...editFixture.data.messages,
          message: {
            protocolMessage: {
              ...editFixture.data.messages.message.protocolMessage,
              editedMessage: undefined,
            },
          },
        },
      },
    };

    const deletion = await normalize(normalizer, deletionWithoutTimestamp);
    const repeatedDeletion = await normalize(
      normalizer,
      deletionWithoutTimestamp,
    );
    const edit = await normalize(normalizer, editWithoutContent);

    expect(deletion.items[0]).toMatchObject({
      deletedAt: receivedAt,
      kind: "message_delete",
    });
    expect(repeatedDeletion).toEqual(deletion);
    expect(edit.items).toEqual([
      {
        classification: "invalid_item_shape",
        itemIndex: 0,
        kind: "malformed",
      },
    ]);
  });

  test("keeps edit identity stable across provider retries without occurrence time", async () => {
    const normalizer = await makeNormalizer();
    const editWithoutTimestamp = {
      ...editFixture,
      timestamp: undefined,
      data: {
        messages: {
          ...editFixture.data.messages,
          message: {
            protocolMessage: {
              ...editFixture.data.messages.message.protocolMessage,
              timestampMs: undefined,
            },
          },
        },
      },
    };

    const first = await normalize(
      normalizer,
      editWithoutTimestamp,
      "2026-07-30T12:00:00.000Z",
    );
    const retry = await normalize(
      normalizer,
      editWithoutTimestamp,
      "2026-07-30T12:01:00.000Z",
    );
    const firstItem = first.items[0];
    const retryItem = retry.items[0];
    if (
      firstItem?.kind !== "message_edit" ||
      retryItem?.kind !== "message_edit"
    ) {
      throw new Error("expected normalized message edits");
    }

    expect(firstItem.editedAt).not.toBe(retryItem.editedAt);
    expect(firstItem.itemIdentity).toBe(retryItem.itemIdentity);
  });

  test("normalizes Directory and connection-state changes with missing optional fields", async () => {
    const normalizer = await makeNormalizer();
    const contacts = await normalize(normalizer, contactsFixture);
    const groups = await normalize(normalizer, groupsFixture);
    const states = await Promise.all(
      connectionFixtures.map((fixture) => normalize(normalizer, fixture)),
    );

    expect(contacts.items).toMatchObject([
      {
        contact: {
          active: true,
          displayName: "Ada",
          phoneNumber: "+15550108",
        },
        kind: "directory_contact",
      },
      {
        contact: {
          active: true,
          displayName: null,
          phoneNumber: "+15550109",
        },
        kind: "directory_contact",
      },
      {
        contact: {
          active: true,
          displayName: "Linked identity",
          phoneNumber: null,
        },
        kind: "directory_contact",
      },
      {
        classification: "missing_required_identity",
        kind: "malformed",
      },
    ]);
    expect(groups.items).toMatchObject([
      {
        group: { displayName: "Family", joined: true },
        kind: "directory_group",
      },
    ]);
    expect(states.map(({ items }) => items[0])).toMatchObject([
      { kind: "connection_state", state: "connected" },
      { kind: "connection_state", state: "connecting" },
      { kind: "connection_state", state: "reconnect_required" },
    ]);
  });

  test("changes a Directory item identity when its normalized phone changes", async () => {
    const normalizer = await makeNormalizer();
    const contact = contactsFixture.data[0];
    const first = await normalize(normalizer, {
      ...contactsFixture,
      data: [{ ...contact, phoneNumber: "+15550111" }],
    });
    const second = await normalize(normalizer, {
      ...contactsFixture,
      data: [{ ...contact, phoneNumber: "+15550112" }],
    });
    const firstItem = first.items[0];
    const secondItem = second.items[0];
    if (
      firstItem?.kind !== "directory_contact" ||
      secondItem?.kind !== "directory_contact"
    ) {
      throw new Error("expected Directory contact items");
    }

    expect(firstItem.contact.phoneNumber).toBe("+15550111");
    expect(secondItem.contact.phoneNumber).toBe("+15550112");
    expect(firstItem.itemIdentity).not.toBe(secondItem.itemIdentity);
  });

  test("canonicalizes phone identities without guessing numbers from text", async () => {
    const normalizer = await makeNormalizer();
    const contacts = await normalize(normalizer, {
      event: "contacts.upsert",
      data: [
        { jid: "15550108" },
        {
          jid: "123456789@lid",
          phoneNumber: "call 15550112 now",
        },
      ],
    });
    const message = await normalize(normalizer, {
      event: "messages.upsert",
      data: {
        messages: {
          key: {
            id: "canonical-phone-message",
            fromMe: false,
            remoteJid: "15550108@s.whatsapp.net",
          },
          message: { conversation: "hello" },
        },
      },
    });
    const contact = contacts.items[0];
    const lidContact = contacts.items[1];
    const messageItem = message.items[0];
    if (
      contact?.kind !== "directory_contact" ||
      lidContact?.kind !== "directory_contact" ||
      messageItem?.kind !== "message_upsert"
    ) {
      throw new Error("expected contact and message items");
    }

    expect(messageItem.recipient).toBe(contact.contact.recipient);
    expect(lidContact.contact.phoneNumber).toBeNull();
  });

  test("does not erase Directory fields from unrelated partial updates", async () => {
    const normalizer = await makeNormalizer();
    const contacts = await normalize(normalizer, {
      event: "contacts.update",
      timestamp: contactsFixture.timestamp,
      data: [
        { jid: "15550108@s.whatsapp.net", status: "available" },
        { jid: "15550109@s.whatsapp.net", name: "Grace" },
      ],
    });
    const groups = await normalize(normalizer, {
      event: "groups.update",
      timestamp: groupsFixture.timestamp,
      data: [
        { jid: "120363000001@g.us", announce: true, restrict: false },
        { jid: "120363000002@g.us", subject: "Friends" },
      ],
    });

    expect(contacts.items).toMatchObject([
      { kind: "unsupported" },
      { contact: { displayName: "Grace" }, kind: "directory_contact" },
    ]);
    expect(groups.items).toMatchObject([
      { kind: "unsupported" },
      { group: { displayName: "Friends" }, kind: "directory_group" },
    ]);
  });

  test("distinguishes later repeated mutable states from exact retries", async () => {
    const normalizer = await makeNormalizer();
    const contactAtFirstOccurrence = {
      ...contactsFixture,
      data: [contactsFixture.data[0]],
    };
    const contactAtLaterOccurrence = {
      ...contactAtFirstOccurrence,
      timestamp: contactsFixture.timestamp + 60,
    };
    const statusAtLaterOccurrence = {
      ...statusFixture,
      timestamp: statusFixture.timestamp + 60_000,
    };

    const [contactFirst, contactRetry, contactLater, statusFirst, statusLater] =
      await Promise.all([
        normalize(normalizer, contactAtFirstOccurrence),
        normalize(normalizer, contactAtFirstOccurrence),
        normalize(normalizer, contactAtLaterOccurrence),
        normalize(normalizer, statusFixture),
        normalize(normalizer, statusAtLaterOccurrence),
      ]);
    const identities = [
      contactFirst.items[0],
      contactRetry.items[0],
      contactLater.items[0],
      statusFirst.items[0],
      statusLater.items[0],
    ].map((item) =>
      item !== undefined &&
      item.kind !== "malformed" &&
      item.kind !== "unsupported"
        ? item.itemIdentity
        : null,
    );

    expect(identities[0]).toBe(identities[1]);
    expect(identities[0]).not.toBe(identities[2]);
    expect(identities[3]).not.toBe(identities[4]);
  });

  test("deduplicates regrouped logical items while retaining duplicate batch positions", async () => {
    const normalizer = await makeNormalizer();
    const firstMessage = messageBatchFixture.data.messages[0];
    const regrouped = {
      ...messageBatchFixture,
      data: {
        messages: [firstMessage, messageBatchFixture.data.messages[1]],
      },
    };
    const repeated = {
      ...messageBatchFixture,
      data: {
        messages: [firstMessage, firstMessage],
      },
    };
    const original = await normalize(normalizer, messageBatchFixture);
    const repeatedDelivery = await normalize(normalizer, messageBatchFixture);
    const regroupedResult = await normalize(normalizer, regrouped);
    const repeatedResult = await normalize(normalizer, repeated);

    expect(repeatedDelivery).toEqual(original);

    expect(regroupedResult.items[0]).toMatchObject({
      itemIdentity:
        original.items[0]?.kind === "message_upsert"
          ? original.items[0].itemIdentity
          : "unexpected",
    });
    expect(regroupedResult.items[1]).toMatchObject({
      itemIdentity:
        original.items[1]?.kind === "message_upsert"
          ? original.items[1].itemIdentity
          : "unexpected",
    });
    expect(repeatedResult.items).toHaveLength(2);
    expect(repeatedResult.items[0]).toMatchObject({ itemIndex: 0 });
    expect(repeatedResult.items[1]).toMatchObject({ itemIndex: 1 });
    if (
      repeatedResult.items[0]?.kind === "message_upsert" &&
      repeatedResult.items[1]?.kind === "message_upsert"
    ) {
      expect(repeatedResult.items[0].itemIdentity).toBe(
        repeatedResult.items[1].itemIdentity,
      );
    }
  });

  test("compares authenticated occurrence evidence independently of delivery order", async () => {
    const normalizer = await makeNormalizer();
    const results = await Promise.all(
      connectionFixtures.map((fixture) => normalize(normalizer, fixture)),
    );
    const versions = results.map(({ items }) => {
      const item = items[0];
      if (item?.kind !== "connection_state" || item.evidence.version === null) {
        throw new Error("expected connection-state convergence evidence");
      }
      return item.evidence.version;
    });
    const [connectedVersion, connectingVersion, reconnectVersion] = versions;
    if (
      connectedVersion === undefined ||
      connectingVersion === undefined ||
      reconnectVersion === undefined
    ) {
      throw new Error("expected three convergence versions");
    }

    expect(
      await Effect.runPromise(
        normalizer.compareVersions({
          left: connectingVersion,
          right: connectedVersion,
        }),
      ),
    ).toBe("before");
    expect(
      await Effect.runPromise(
        normalizer.compareVersions({
          left: reconnectVersion,
          right: connectingVersion,
        }),
      ),
    ).toBe("before");

    const otherKey = await Effect.runPromise(
      importWebhookIdentityKey(
        encoder.encode("abcdef0123456789abcdef0123456789"),
      ),
    );
    const otherConnection = makeWasenderWebhookNormalization(otherKey);
    expect(
      await Effect.runPromise(
        otherConnection.compareVersions({
          left: connectedVersion,
          right: connectingVersion,
        }),
      ),
    ).toBe("incomparable");
  });

  test("classifies unsupported and malformed top-level deliveries", async () => {
    const normalizer = await makeNormalizer();

    expect(
      await normalize(normalizer, { event: "messages.reaction", data: [] }),
    ).toEqual({
      items: [
        {
          classification: "unsupported_item_kind",
          itemIndex: 0,
          kind: "unsupported",
        },
      ],
    });
    expect(await normalize(normalizer, ["not", "an", "envelope"])).toEqual({
      items: [
        {
          classification: "invalid_top_level_shape",
          itemIndex: null,
          kind: "malformed",
        },
      ],
    });
    expect(
      await Effect.runPromise(
        normalizer.normalize({
          payload: encoder.encode("not json"),
          receivedAt,
        }),
      ),
    ).toEqual({
      items: [
        {
          classification: "invalid_top_level_shape",
          itemIndex: null,
          kind: "malformed",
        },
      ],
    });
  });

  test("rejects weak identity keys and oversized payloads", async () => {
    const keyError = await Effect.runPromise(
      Effect.flip(importWebhookIdentityKey(encoder.encode("too short"))),
    );
    expect(keyError).toMatchObject({ _tag: "WebhookIdentityKeyError" });

    const normalizer = await makeNormalizer();
    const payloadError = await Effect.runPromise(
      Effect.flip(
        normalizer.normalize({
          payload: new Uint8Array(1_048_577),
          receivedAt,
        }),
      ),
    );
    expect(payloadError).toMatchObject({
      code: "response_too_large",
      operation: "webhook-normalization",
      retryDecision: "do_not_retry",
    });
  });
});
