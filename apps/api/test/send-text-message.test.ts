import {
  type AtomicSendRepository,
  apiSendGrant,
  mcpSendGrant,
  type SendEncryptionMaterial,
  type SendProviderMaterial,
} from "@whatsapp-mcp/db/send";
import { Effect } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  deriveRecipientRouteKeys,
  sealRecipientRoute,
} from "../../../packages/wasender/src/recipient-route";
import type { EnvelopeEncryption } from "../src/encryption/envelope";
import {
  importSendFingerprintKey,
  makeAtomicSendTextMessageService,
} from "../src/send-text-message";

const material: SendEncryptionMaterial = {
  accountKey: {
    ciphertext: new Uint8Array([1]),
    keyVersion: 1,
    kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/test",
    personalAccountId: "10000000-0000-4000-8000-000000000047",
  },
  connectionKey: {
    accountKeyVersion: 1,
    ciphertext: new Uint8Array([2]),
    connectionId: "20000000-0000-4000-8000-000000000047",
    keyVersion: 1,
    nonce: new Uint8Array(12),
    personalAccountId: "10000000-0000-4000-8000-000000000047",
  },
};

const protectedValue = (value: string) => ({
  ciphertext: new TextEncoder().encode(value),
  keyVersion: 1,
  nonce: new Uint8Array(12),
});

const recipientRoute = await sealRecipientRoute(
  await deriveRecipientRouteKeys("session-authority"),
  "contact",
  "15551234567",
);
const groupRecipientRoute = await sealRecipientRoute(
  await deriveRecipientRouteKeys("session-authority"),
  "group",
  "120363123456789012@g.us",
);
const storedAuthority = JSON.stringify({
  sessionCredential: "session-authority",
  webhookVerificationSecret: "webhook-secret",
});

const input = {
  channel: "mcp",
  connectionId: "con_123456789012345678947",
  grant: mcpSendGrant({
    authorizationId: "40000000-0000-4000-8000-000000000047",
    clientId: "approved-client",
    oauthSubject: "A".repeat(43),
  }),
  idempotencyKey: "123456789012345678947",
  recipientId: "ctc_123456789012345678947",
  text: " exact\ne\u0301 ",
} as const;

describe("atomic send workflow", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("keeps a slow group provider attempt alive after returning the committed receipt", async () => {
    const providerResponse = Promise.withResolvers<Response>();
    const recordProviderOutcome = vi.fn(async ({ status }) => ({
      createdAt: new Date("2026-08-03T12:00:00.000Z"),
      publicId: "snd_123456789012345678947",
      status,
      statusChangedAt: new Date("2026-08-03T12:00:01.000Z"),
    }));
    const repository: AtomicSendRepository = {
      commit: async () => ({
        outcome: "created",
        provider: {
          ...material,
          authority: protectedValue(storedAuthority),
          identityKey: protectedValue("x".repeat(32)),
          messageSearchKey: protectedValue("s".repeat(32)),
          recipient: protectedValue(groupRecipientRoute),
          recipientRecordId: `di1_${"G".repeat(43)}`,
          recipientType: "group",
        },
        receipt: {
          createdAt: new Date("2026-08-03T12:00:00.000Z"),
          publicId: "snd_123456789012345678947",
          status: "processing",
          statusChangedAt: new Date("2026-08-03T12:00:00.000Z"),
        },
      }),
      expireLeases: vi.fn(),
      recordProviderOutcome,
    };
    const encryption: EnvelopeEncryption = {
      createConnectionKey: () => Effect.die("unused"),
      createPersonalAccountKey: () => Effect.die("unused"),
      decrypt: ({ context }) =>
        Effect.succeed(
          new TextEncoder().encode(
            context.fieldOrObjectPurpose === "webhook-identity-key"
              ? "x".repeat(32)
              : context.fieldOrObjectPurpose === "message-search-key"
                ? "s".repeat(32)
                : context.fieldOrObjectPurpose === "provider-session-authority"
                  ? storedAuthority
                  : groupRecipientRoute,
          ),
        ),
      decryptMany: () => Effect.die("unused"),
      encrypt: () =>
        Effect.succeed({
          ciphertext: btoa("encrypted-pending-content"),
          keyVersion: 1,
          nonce: btoa(String.fromCharCode(...new Uint8Array(12))),
          version: 1,
        }),
    };
    const providerAttempt = vi.fn(() => providerResponse.promise);
    vi.stubGlobal("fetch", providerAttempt);
    const service = makeAtomicSendTextMessageService({
      encryption,
      fingerprintKey: await importSendFingerprintKey("47".repeat(32)),
      hourRequestLimit: 600,
      minuteRequestLimit: 60,
      nextAuditLogId: () => "50000000-0000-4000-8000-000000000047",
      nextSend: () => ({
        id: "60000000-0000-4000-8000-000000000047",
        publicId: "snd_123456789012345678947",
      }),
      now: () => new Date("2026-08-03T12:00:01.000Z"),
      repository,
      sendDailyLimit: 200,
      sendPerMinuteLimit: 10,
      telemetry: () => undefined,
    });
    let deferred: Promise<void> | undefined;
    const result = Effect.runPromise(
      service.send(
        { ...input, recipientId: "grp_123456789012345678947" },
        (attempt) => {
          deferred = attempt;
        },
      ),
    );

    await expect(
      Promise.race([
        result,
        new Promise((resolve) =>
          setTimeout(() => resolve("request-still-waiting"), 50),
        ),
      ]),
    ).resolves.toMatchObject({
      outcome: "receipt",
      receipt: { status: "processing" },
    });
    await vi.waitFor(() => expect(providerAttempt).toHaveBeenCalledTimes(1));
    providerResponse.resolve(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            jid: "120363123456789012@g.us",
            msgId: 47,
            status: "in_progress",
          },
        }),
      ),
    );
    await deferred;
    expect(recordProviderOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: "accepted" }),
    );
  });

  test("commits encrypted state before exactly one provider attempt", async () => {
    const order: string[] = [];
    const provider: SendProviderMaterial = {
      ...material,
      authority: protectedValue(storedAuthority),
      contactPhone: protectedValue("+15551234567"),
      identityKey: protectedValue("x".repeat(32)),
      messageSearchKey: protectedValue("s".repeat(32)),
      recipient: protectedValue(`wi1_${"r".repeat(43)}`),
      recipientRecordId: `di1_${"B".repeat(43)}`,
      recipientType: "contact",
    };
    const repository: AtomicSendRepository = {
      commit: async (request, encrypt) => {
        expect(request.grant).toEqual(input.grant);
        order.push("transaction-open");
        await encrypt(material);
        order.push("commit");
        return {
          outcome: "created",
          provider,
          receipt: {
            createdAt: new Date("2026-08-03T12:00:00.000Z"),
            publicId: "snd_123456789012345678947",
            status: "processing",
            statusChangedAt: new Date("2026-08-03T12:00:00.000Z"),
          },
        };
      },
      expireLeases: vi.fn(),
      recordProviderOutcome: async ({ status }) => {
        order.push("record-outcome");
        return {
          createdAt: new Date("2026-08-03T12:00:00.000Z"),
          publicId: "snd_123456789012345678947",
          status,
          statusChangedAt: new Date("2026-08-03T12:00:01.000Z"),
        };
      },
    };
    const encryption: EnvelopeEncryption = {
      createConnectionKey: () => Effect.die("unused"),
      createPersonalAccountKey: () => Effect.die("unused"),
      encrypt: () => {
        order.push("encrypt-pending");
        return Effect.succeed({
          ciphertext: btoa("encrypted-pending-content"),
          keyVersion: 1,
          nonce: btoa(String.fromCharCode(...new Uint8Array(12))),
          version: 1,
        });
      },
      decrypt: ({ context }) => {
        const value =
          context.fieldOrObjectPurpose === "provider-session-authority"
            ? storedAuthority
            : context.fieldOrObjectPurpose === "webhook-identity-key"
              ? "x".repeat(32)
              : context.fieldOrObjectPurpose === "phone-number"
                ? "+15551234567"
                : `wi1_${"r".repeat(43)}`;
        return Effect.succeed(new TextEncoder().encode(value));
      },
      decryptMany: () => Effect.die("unused"),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, request: RequestInit) => {
        order.push("provider-attempt");
        expect(JSON.parse(String(request.body))).toEqual({
          to: "+15551234567",
          text: input.text,
        });
        expect(new Headers(request.headers).get("authorization")).toBe(
          "Bearer session-authority",
        );
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              jid: "15551234567@s.whatsapp.net",
              msgId: 47,
              status: "in_progress",
            },
          }),
          { status: 200 },
        );
      }),
    );
    const fingerprintKey = await importSendFingerprintKey("47".repeat(32));
    const service = makeAtomicSendTextMessageService({
      encryption,
      fingerprintKey,
      hourRequestLimit: 600,
      minuteRequestLimit: 60,
      nextAuditLogId: () => "50000000-0000-4000-8000-000000000047",
      nextSend: () => ({
        id: "60000000-0000-4000-8000-000000000047",
        publicId: "snd_123456789012345678947",
      }),
      now: (() => {
        let offset = 0;
        return () => new Date(1_775_390_400_000 + offset++ * 1_000);
      })(),
      repository,
      sendDailyLimit: 200,
      sendPerMinuteLimit: 10,
      telemetry: () => undefined,
    });

    await expect(Effect.runPromise(service.send(input))).resolves.toMatchObject(
      {
        outcome: "receipt",
        receipt: { status: "accepted", idempotent_replay: false },
      },
    );
    expect(order).toEqual([
      "transaction-open",
      "encrypt-pending",
      "commit",
      "provider-attempt",
      "record-outcome",
    ]);
  });

  test.each([
    {
      destination: { phone: "+15551234567" },
      providerJid: "15551234567@s.whatsapp.net",
      recipientType: "phone" as const,
      to: "+15551234567",
    },
    {
      destination: { username: "@jane_doe" },
      providerJid: "15551234567@s.whatsapp.net",
      recipientType: "username" as const,
      to: "@jane_doe",
    },
  ])(
    "sends an arbitrary $recipientType without persisting its address",
    async (example) => {
      const recordProviderOutcome = vi.fn(async ({ status }) => ({
        createdAt: new Date("2026-08-03T12:00:00.000Z"),
        publicId: "snd_123456789012345678947",
        status,
        statusChangedAt: new Date("2026-08-03T12:00:01.000Z"),
      }));
      const repository: AtomicSendRepository = {
        commit: async (request, encrypt) => {
          expect(request).toMatchObject({
            directRecipientType: example.recipientType,
            recipientPublicId: null,
          });
          expect(JSON.stringify(request)).not.toContain(example.to);
          await encrypt(material);
          return {
            outcome: "created",
            provider: {
              ...material,
              authority: protectedValue(storedAuthority),
              identityKey: protectedValue("x".repeat(32)),
              messageSearchKey: protectedValue("s".repeat(32)),
              recipientType: example.recipientType,
            },
            receipt: {
              createdAt: new Date("2026-08-03T12:00:00.000Z"),
              publicId: "snd_123456789012345678947",
              status: "processing",
              statusChangedAt: new Date("2026-08-03T12:00:00.000Z"),
            },
          };
        },
        expireLeases: vi.fn(),
        recordProviderOutcome,
      };
      const encryption: EnvelopeEncryption = {
        createConnectionKey: () => Effect.die("unused"),
        createPersonalAccountKey: () => Effect.die("unused"),
        decrypt: ({ context }) =>
          Effect.succeed(
            new TextEncoder().encode(
              context.fieldOrObjectPurpose === "provider-session-authority"
                ? storedAuthority
                : "x".repeat(32),
            ),
          ),
        decryptMany: () => Effect.die("unused"),
        encrypt: () =>
          Effect.succeed({
            ciphertext: btoa("encrypted-pending-content"),
            keyVersion: 1,
            nonce: btoa(String.fromCharCode(...new Uint8Array(12))),
            version: 1,
          }),
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, request: RequestInit) => {
          expect(JSON.parse(String(request.body))).toEqual({
            to: example.to,
            text: input.text,
          });
          return Response.json({
            data: {
              jid: example.providerJid,
              msgId: 48,
              status: "in_progress",
            },
            success: true,
          });
        }),
      );
      const service = makeAtomicSendTextMessageService({
        encryption,
        fingerprintKey: await importSendFingerprintKey("47".repeat(32)),
        hourRequestLimit: 600,
        minuteRequestLimit: 60,
        nextAuditLogId: () => "50000000-0000-4000-8000-000000000047",
        nextSend: () => ({
          id: "60000000-0000-4000-8000-000000000047",
          publicId: "snd_123456789012345678947",
        }),
        now: () => new Date("2026-08-03T12:00:01.000Z"),
        repository,
        sendDailyLimit: 200,
        sendPerMinuteLimit: 10,
        telemetry: () => undefined,
      });
      const { recipientId: _recipientId, ...directInput } = input;

      await expect(
        Effect.runPromise(
          service.send({
            ...directInput,
            ...example.destination,
          }),
        ),
      ).resolves.toMatchObject({
        outcome: "receipt",
        receipt: { status: "accepted" },
      });
      expect(recordProviderOutcome).toHaveBeenCalledWith({
        changedAt: new Date("2026-08-03T12:00:01.000Z"),
        sendId: "60000000-0000-4000-8000-000000000047",
        status: "accepted",
      });
    },
  );

  test("projects identity-bearing sent evidence as a Stored Message", async () => {
    const recordProviderOutcome = vi.fn(async ({ status }) => ({
      createdAt: new Date("2026-08-03T12:00:00.000Z"),
      publicId: "snd_123456789012345678947",
      status,
      statusChangedAt: new Date("2026-08-03T12:00:01.000Z"),
    }));
    const repository: AtomicSendRepository = {
      commit: async () => ({
        outcome: "created",
        provider: {
          ...material,
          authority: protectedValue(storedAuthority),
          identityKey: protectedValue("x".repeat(32)),
          messageSearchKey: protectedValue("s".repeat(32)),
          recipient: protectedValue(recipientRoute),
          recipientRecordId: `di1_${"B".repeat(43)}`,
          recipientType: "contact",
        },
        receipt: {
          createdAt: new Date("2026-08-03T12:00:00.000Z"),
          publicId: "snd_123456789012345678947",
          status: "processing",
          statusChangedAt: new Date("2026-08-03T12:00:00.000Z"),
        },
      }),
      expireLeases: vi.fn(),
      recordProviderOutcome,
    };
    const encryption: EnvelopeEncryption = {
      createConnectionKey: () => Effect.die("unused"),
      createPersonalAccountKey: () => Effect.die("unused"),
      decrypt: ({ context }) =>
        Effect.succeed(
          new TextEncoder().encode(
            context.fieldOrObjectPurpose === "webhook-identity-key"
              ? "x".repeat(32)
              : context.fieldOrObjectPurpose === "message-search-key"
                ? "s".repeat(32)
                : context.fieldOrObjectPurpose === "provider-session-authority"
                  ? storedAuthority
                  : recipientRoute,
          ),
        ),
      decryptMany: () => Effect.die("unused"),
      encrypt: ({ plaintext }) =>
        Effect.succeed({
          ciphertext: btoa(String.fromCharCode(...new Uint8Array(plaintext))),
          keyVersion: 1,
          nonce: btoa(String.fromCharCode(...new Uint8Array(12))),
          version: 1,
        }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                key: {
                  fromMe: true,
                  id: "provider-message-51",
                  remoteJid: "15551234567@s.whatsapp.net",
                },
                status: "sent",
              },
            }),
          ),
      ),
    );
    const service = makeAtomicSendTextMessageService({
      encryption,
      fingerprintKey: await importSendFingerprintKey("47".repeat(32)),
      hourRequestLimit: 600,
      minuteRequestLimit: 60,
      nextAuditLogId: () => "50000000-0000-4000-8000-000000000047",
      nextStoredMessage: () => ({
        conversationId: "70000000-0000-4000-8000-000000000051",
        conversationPublicId: "cvs_123456789012345678951",
        messageId: "80000000-0000-4000-8000-000000000051",
        messagePublicId: "msg_123456789012345678951",
      }),
      nextSend: () => ({
        id: "60000000-0000-4000-8000-000000000047",
        publicId: "snd_123456789012345678947",
      }),
      now: (() => {
        let offset = 0;
        return () => new Date(1_775_390_400_000 + offset++ * 1_000);
      })(),
      repository,
      sendDailyLimit: 200,
      sendPerMinuteLimit: 10,
      telemetry: () => undefined,
    });

    await Effect.runPromise(service.send(input));

    expect(recordProviderOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        messageIdentity: expect.stringMatching(/^wi1_/u),
        status: "sent",
        storedMessage: expect.objectContaining({
          content: expect.objectContaining({ keyVersion: 1 }),
          contentType: "text",
          conversationPublicId: "cvs_123456789012345678951",
          messagePublicId: "msg_123456789012345678951",
          messageSearch: {
            indexVersion: 1,
            tokens: [
              expect.stringMatching(/^msi1_[A-Za-z0-9_-]{43}$/u),
              expect.stringMatching(/^msi1_[A-Za-z0-9_-]{43}$/u),
            ],
          },
        }),
      }),
    );
  });

  test("returns an exact replay without encryption or provider work", async () => {
    const repository: AtomicSendRepository = {
      commit: async (_request, encrypt) => {
        expect(encrypt).toBeTypeOf("function");
        return {
          outcome: "replay",
          receipt: {
            createdAt: new Date("2026-08-03T12:00:00.000Z"),
            publicId: "snd_123456789012345678947",
            status: "unknown",
            statusChangedAt: new Date("2026-08-03T12:00:30.000Z"),
          },
        };
      },
      expireLeases: vi.fn(),
      recordProviderOutcome: vi.fn(),
    };
    const encryption: EnvelopeEncryption = {
      createConnectionKey: () => Effect.die("unused"),
      createPersonalAccountKey: () => Effect.die("unused"),
      decrypt: () => Effect.die("replay must not decrypt provider material"),
      decryptMany: () =>
        Effect.die("replay must not decrypt provider material"),
      encrypt: () => Effect.die("replay must not encrypt pending content"),
    };
    const providerAttempt = vi.fn();
    vi.stubGlobal("fetch", providerAttempt);
    const service = makeAtomicSendTextMessageService({
      encryption,
      fingerprintKey: await importSendFingerprintKey("47".repeat(32)),
      hourRequestLimit: 600,
      minuteRequestLimit: 60,
      nextAuditLogId: () => "50000000-0000-4000-8000-000000000048",
      nextSend: () => ({
        id: "60000000-0000-4000-8000-000000000048",
        publicId: "snd_123456789012345678948",
      }),
      now: () => new Date("2026-08-03T12:01:00.000Z"),
      repository,
      sendDailyLimit: 200,
      sendPerMinuteLimit: 10,
      telemetry: () => undefined,
    });

    await expect(Effect.runPromise(service.send(input))).resolves.toEqual({
      outcome: "receipt",
      receipt: {
        created_at: "2026-08-03T12:00:00.000Z",
        idempotent_replay: true,
        send_id: "snd_123456789012345678947",
        status: "unknown",
        status_changed_at: "2026-08-03T12:00:30.000Z",
      },
    });
    expect(providerAttempt).not.toHaveBeenCalled();
    expect(repository.recordProviderOutcome).not.toHaveBeenCalled();
  });

  test("distinguishes a crash before the durable boundary from one after it", async () => {
    const encryption: EnvelopeEncryption = {
      createConnectionKey: () => Effect.die("unused"),
      createPersonalAccountKey: () => Effect.die("unused"),
      decrypt: ({ context }) =>
        Effect.succeed(
          new TextEncoder().encode(
            context.fieldOrObjectPurpose === "webhook-identity-key"
              ? "x".repeat(32)
              : context.fieldOrObjectPurpose === "provider-session-authority"
                ? storedAuthority
                : recipientRoute,
          ),
        ),
      decryptMany: () => Effect.die("unused"),
      encrypt: () =>
        Effect.succeed({
          ciphertext: btoa("encrypted-pending-content"),
          keyVersion: 1,
          nonce: btoa(String.fromCharCode(...new Uint8Array(12))),
          version: 1,
        }),
    };
    const baseOptions = {
      encryption,
      fingerprintKey: await importSendFingerprintKey("47".repeat(32)),
      hourRequestLimit: 600,
      minuteRequestLimit: 60,
      nextAuditLogId: () => "50000000-0000-4000-8000-000000000049",
      nextSend: () => ({
        id: "60000000-0000-4000-8000-000000000049",
        publicId: "snd_123456789012345678949",
      }),
      now: () => new Date("2026-08-03T12:00:01.000Z"),
      sendDailyLimit: 200,
      sendPerMinuteLimit: 10,
      telemetry: () => undefined,
    };
    const providerAttempt = vi.fn(async () => {
      throw new Error("worker crashed after dispatch");
    });
    vi.stubGlobal("fetch", providerAttempt);
    const beforeBoundary: AtomicSendRepository = {
      commit: async () => {
        throw new Error("transaction rolled back");
      },
      expireLeases: vi.fn(),
      recordProviderOutcome: vi.fn(),
    };
    await expect(
      Effect.runPromise(
        makeAtomicSendTextMessageService({
          ...baseOptions,
          repository: beforeBoundary,
        }).send(input),
      ),
    ).resolves.toEqual({ outcome: "service_unavailable" });
    expect(providerAttempt).not.toHaveBeenCalled();

    const recordProviderOutcome = vi.fn(async ({ status }) => ({
      createdAt: new Date("2026-08-03T12:00:00.000Z"),
      publicId: "snd_123456789012345678949",
      status,
      statusChangedAt: new Date("2026-08-03T12:00:01.000Z"),
    }));
    const afterBoundary: AtomicSendRepository = {
      commit: async () => ({
        outcome: "created",
        provider: {
          ...material,
          authority: protectedValue(storedAuthority),
          identityKey: protectedValue("x".repeat(32)),
          messageSearchKey: protectedValue("s".repeat(32)),
          recipient: protectedValue(recipientRoute),
          recipientRecordId: `di1_${"B".repeat(43)}`,
          recipientType: "contact",
        },
        receipt: {
          createdAt: new Date("2026-08-03T12:00:00.000Z"),
          publicId: "snd_123456789012345678949",
          status: "processing",
          statusChangedAt: new Date("2026-08-03T12:00:00.000Z"),
        },
      }),
      expireLeases: vi.fn(),
      recordProviderOutcome,
    };
    await expect(
      Effect.runPromise(
        makeAtomicSendTextMessageService({
          ...baseOptions,
          repository: afterBoundary,
        }).send(input),
      ),
    ).resolves.toMatchObject({
      outcome: "receipt",
      receipt: { status: "unknown" },
    });
    expect(providerAttempt).toHaveBeenCalledTimes(1);
    expect(recordProviderOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: "unknown" }),
    );
  });

  test("returns high-concurrency replays while one timed provider attempt is in flight", async () => {
    const providerStarted = Promise.withResolvers<void>();
    const releaseProvider = Promise.withResolvers<void>();
    const operationReceipt = {
      createdAt: new Date("2026-08-03T12:00:00.000Z"),
      publicId: "snd_123456789012345678947",
      status: "processing" as const,
      statusChangedAt: new Date("2026-08-03T12:00:00.000Z"),
    };
    let committed = false;
    const repository: AtomicSendRepository = {
      commit: async () => {
        if (committed)
          return { outcome: "replay" as const, receipt: operationReceipt };
        committed = true;
        return {
          outcome: "created" as const,
          provider: {
            ...material,
            authority: protectedValue(storedAuthority),
            identityKey: protectedValue("x".repeat(32)),
            messageSearchKey: protectedValue("s".repeat(32)),
            recipient: protectedValue(recipientRoute),
            recipientRecordId: `di1_${"B".repeat(43)}`,
            recipientType: "contact" as const,
          },
          receipt: operationReceipt,
        };
      },
      expireLeases: vi.fn(),
      recordProviderOutcome: async ({ status }) => ({
        ...operationReceipt,
        status,
        statusChangedAt: new Date("2026-08-03T12:00:15.000Z"),
      }),
    };
    const encryption: EnvelopeEncryption = {
      createConnectionKey: () => Effect.die("unused"),
      createPersonalAccountKey: () => Effect.die("unused"),
      decrypt: ({ context }) =>
        Effect.succeed(
          new TextEncoder().encode(
            context.fieldOrObjectPurpose === "webhook-identity-key"
              ? "x".repeat(32)
              : context.fieldOrObjectPurpose === "provider-session-authority"
                ? storedAuthority
                : recipientRoute,
          ),
        ),
      decryptMany: () => Effect.die("unused"),
      encrypt: () => Effect.die("repository controls this test"),
    };
    const providerAttempt = vi.fn(async () => {
      providerStarted.resolve();
      await releaseProvider.promise;
      throw new DOMException("timed out", "TimeoutError");
    });
    vi.stubGlobal("fetch", providerAttempt);
    let sequence = 0;
    const service = makeAtomicSendTextMessageService({
      encryption,
      fingerprintKey: await importSendFingerprintKey("47".repeat(32)),
      hourRequestLimit: 600,
      minuteRequestLimit: 60,
      nextAuditLogId: () =>
        `50000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
      nextSend: () => ({
        id: "60000000-0000-4000-8000-000000000047",
        publicId: "snd_123456789012345678947",
      }),
      now: () => new Date("2026-08-03T12:00:15.000Z"),
      repository,
      sendDailyLimit: 200,
      sendPerMinuteLimit: 10,
      telemetry: () => undefined,
    });

    const original = Effect.runPromise(service.send(input));
    await providerStarted.promise;
    const replays = await Promise.all(
      Array.from({ length: 31 }, () => Effect.runPromise(service.send(input))),
    );
    expect(replays).toHaveLength(31);
    expect(
      replays.every(
        (result) =>
          result.outcome === "receipt" && result.receipt.idempotent_replay,
      ),
    ).toBe(true);
    expect(providerAttempt).toHaveBeenCalledTimes(1);
    releaseProvider.resolve();
    await expect(original).resolves.toMatchObject({
      outcome: "receipt",
      receipt: { status: "unknown" },
    });
    expect(providerAttempt).toHaveBeenCalledTimes(1);
  });

  test("keeps API Key fingerprints distinct from MCP Authorization fingerprints", async () => {
    const fingerprints: string[] = [];
    const grants: unknown[] = [];
    const repository: AtomicSendRepository = {
      commit: async (request) => {
        fingerprints.push(request.fingerprint);
        grants.push(request.grant);
        return { outcome: "authorization_denied" };
      },
      expireLeases: vi.fn(),
      recordProviderOutcome: vi.fn(),
    };
    const service = makeAtomicSendTextMessageService({
      encryption: {
        createConnectionKey: () => Effect.die("unused"),
        createPersonalAccountKey: () => Effect.die("unused"),
        decrypt: () => Effect.die("unused"),
        decryptMany: () => Effect.die("unused"),
        encrypt: () => Effect.die("unused"),
      },
      fingerprintKey: await importSendFingerprintKey("47".repeat(32)),
      hourRequestLimit: 600,
      minuteRequestLimit: 60,
      nextAuditLogId: () => "50000000-0000-4000-8000-000000000047",
      nextSend: () => ({
        id: "60000000-0000-4000-8000-000000000047",
        publicId: "snd_123456789012345678947",
      }),
      now: () => new Date("2026-08-03T12:00:01.000Z"),
      repository,
      sendDailyLimit: 200,
      sendPerMinuteLimit: 10,
      telemetry: () => undefined,
    });
    const apiInput = {
      ...input,
      grant: apiSendGrant({
        grantId: "50000000-0000-4000-8000-000000000047",
        name: "Automation",
        permissions: ["messages:send"],
        personalAccountId: "10000000-0000-4000-8000-000000000047",
        publicId: "apk_123456789012345678947",
      }),
    };
    await Effect.runPromise(service.send(input));
    await Effect.runPromise(service.send(apiInput));
    expect(grants).toEqual([input.grant, apiInput.grant]);
    expect(fingerprints[0]).not.toEqual(fingerprints[1]);
    expect(fingerprints[0]).toMatch(/^sf1_/);
    expect(fingerprints[1]).toMatch(/^sf1_/);
  });

  test("accepts an uppercase hexadecimal fingerprint key", async () => {
    await expect(
      importSendFingerprintKey("AB".repeat(32)),
    ).resolves.toBeInstanceOf(CryptoKey);
  });
});
