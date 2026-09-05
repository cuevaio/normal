/**
 * Reviewed against Wasender's webhook documentation on 2026-07-30:
 * https://wasenderapi.com/api-docs/webhooks/webhook-message-upsert
 * https://wasenderapi.com/api-docs/webhooks/webhook-message-received
 * https://wasenderapi.com/api-docs/webhooks/webhook-personal-message-received
 * https://wasenderapi.com/api-docs/webhooks/webhook-group-message-received
 * https://wasenderapi.com/api-docs/webhooks/webhook-message-sent
 * https://wasenderapi.com/api-docs/webhooks/webhook-message-update
 * https://wasenderapi.com/api-docs/webhooks/webhook-message-deleted
 * https://wasenderapi.com/api-docs/webhooks/webhook-message-receipt-update
 * https://wasenderapi.com/api-docs/webhooks/webhook-contact-upsert
 * https://wasenderapi.com/api-docs/webhooks/webhook-contact-update
 * https://wasenderapi.com/api-docs/webhooks/webhook-group-upsert
 * https://wasenderapi.com/api-docs/webhooks/webhook-group-update
 * https://wasenderapi.com/api-docs/webhooks/webhook-session-status
 * https://wasenderapi.com/api-docs/messages/edit-a-message
 */

export const messageBatchFixture = {
  event: "messages.upsert",
  timestamp: 1_753_700_400_000,
  data: {
    messages: [
      {
        pushName: "Ada Lovelace",
        key: {
          id: "inbound-text-1",
          fromMe: false,
          remoteJid: "987654321@lid",
          senderPn: "987654321@lid",
          cleanedSenderPn: "15550101",
        },
        messageBody: "hello",
        message: {
          conversation: "hello",
        },
        messageTimestamp: 1_753_700_390,
      },
      {
        key: {
          id: "inbound-image-1",
          fromMe: false,
          remoteJid: "120363000000@g.us",
          cleanedParticipantPn: "15550102",
        },
        message: {
          imageMessage: {
            caption: "photo",
            mediaKey: "provider-media-key",
            mimetype: "image/jpeg",
            url: "https://mmg.whatsapp.net/provider-object",
          },
        },
        messageTimestamp: "1753700395",
      },
      {
        key: {
          fromMe: false,
          remoteJid: "15550103@s.whatsapp.net",
        },
        messageBody: "missing identity",
        message: {
          conversation: "missing identity",
        },
      },
      {
        key: {
          id: "inbound-text-2",
          fromMe: false,
          remoteJid: "15550104@s.whatsapp.net",
        },
        message: {
          extendedTextMessage: {
            text: "optional fields absent",
          },
        },
      },
      {
        key: {
          id: "group-without-participant",
          fromMe: false,
          remoteJid: "120363000000@g.us",
        },
        messageBody: "sender omitted",
        message: {
          conversation: "sender omitted",
        },
      },
      {
        key: {
          id: "newsletter-message",
          fromMe: false,
          remoteJid: "120363000000@newsletter",
        },
        messageBody: "not in the Message Store",
        message: {
          conversation: "not in the Message Store",
        },
      },
    ],
  },
} as const;

export const editFixture = {
  event: "messages.upsert",
  timestamp: 1_753_700_460_000,
  data: {
    messages: {
      key: {
        id: "edit-event-1",
        fromMe: true,
        remoteJid: "15550101@s.whatsapp.net",
      },
      message: {
        protocolMessage: {
          key: {
            id: "inbound-text-1",
            fromMe: true,
            remoteJid: "15550101@s.whatsapp.net",
          },
          type: 14,
          timestampMs: 1_753_700_450_000,
          editedMessage: {
            extendedTextMessage: {
              text: "hello, edited",
            },
          },
        },
      },
    },
  },
} as const;

export const deletionFixture = {
  event: "messages.delete",
  timestamp: 1_753_700_520,
  data: {
    keys: [
      {
        id: "inbound-text-1",
        fromMe: false,
        remoteJid: "15550101@s.whatsapp.net",
      },
      {
        fromMe: false,
        remoteJid: "15550102@s.whatsapp.net",
      },
    ],
  },
} as const;

export const statusFixture = {
  event: "messages.update",
  timestamp: 1_753_700_580_000,
  data: [
    {
      key: {
        id: "outbound-1",
        fromMe: true,
        remoteJid: "15550105@s.whatsapp.net",
      },
      update: {
        status: 4,
      },
    },
    {
      key: {
        id: "outbound-2",
        fromMe: true,
        remoteJid: "15550106@s.whatsapp.net",
      },
      update: {
        status: 0,
      },
    },
  ],
} as const;

export const sentFixtures = [
  {
    event: "message.sent",
    timestamp: 1_753_700_590_000,
    data: {
      key: {
        id: "outbound-sent-1",
        fromMe: true,
        remoteJid: "15550110@s.whatsapp.net",
      },
      message: {
        conversation: "sent text",
      },
      success: true,
    },
  },
  {
    event: "message.sent",
    timestamp: 1_753_700_591_000,
    data: {
      key: {
        id: "outbound-failed-1",
        fromMe: true,
        remoteJid: "15550110@s.whatsapp.net",
      },
      success: false,
    },
  },
] as const;

export const receiptFixture = {
  event: "message-receipt.update",
  timestamp: 1_753_700_640_000,
  data: {
    message: {
      key: {
        id: "outbound-3",
        fromMe: true,
        remoteJid: "120363000000@g.us",
        participant: "15550107@s.whatsapp.net",
      },
      receipt: {
        readTimestamp: 1_753_700_630,
        userJid: "15550107@s.whatsapp.net",
      },
    },
  },
} as const;

export const contactsFixture = {
  event: "contacts.upsert",
  timestamp: 1_753_700_700,
  data: [
    {
      jid: "15550108@s.whatsapp.net",
      name: "Ada",
    },
    {
      jid: "15550109@s.whatsapp.net",
    },
    {
      jid: "123456789@lid",
      name: "Linked identity",
    },
    {
      name: "missing identity",
    },
  ],
} as const;

export const groupsFixture = {
  event: "groups.upsert",
  timestamp: 1_753_700_760,
  data: [
    {
      jid: "120363000001@g.us",
      subject: "Family",
    },
  ],
} as const;

export const connectionFixtures = [
  {
    event: "session.status",
    timestamp: 1_753_700_820,
    data: { status: "connected" },
  },
  {
    event: "session.status",
    timestamp: 1_753_700_810,
    data: { status: "connecting" },
  },
  {
    event: "session.status",
    timestamp: 1_753_700_800,
    data: { status: "need_scan" },
  },
] as const;
