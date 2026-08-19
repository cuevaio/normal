import { Effect, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import {
  type DeletionCapsuleKmsReader,
  type DeletionCapsuleKmsWriter,
  makeDeletionCapsuleCoordinator,
  makeDeletionCapsuleStore,
} from "../src/deletion/capsule";
import {
  type DeletionObjectBucket,
  makeDeletionMarkerStore,
} from "../src/deletion/marker";

const markerSecret = Redacted.make(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
);

interface StoredObject {
  readonly body: string;
  readonly etag: string;
  readonly key: string;
}

const makeBucket = (pageSize = Number.POSITIVE_INFINITY) => {
  const objects = new Map<string, StoredObject>();
  let deleteCount = 0;
  let overwriteAttempts = 0;
  const bucket: DeletionObjectBucket = {
    delete: (key) => {
      deleteCount += 1;
      objects.delete(key);
      return Promise.resolve();
    },
    get: (key) => {
      const object = objects.get(key);
      return Promise.resolve(
        object
          ? {
              text: () => Promise.resolve(object.body),
            }
          : null,
      );
    },
    list: ({ cursor, prefix }) => {
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + pageSize);
      const next = start + page.length;
      return Promise.resolve({
        cursor: next < keys.length ? String(next) : undefined,
        objects: page.map((key) => ({ key })),
        truncated: next < keys.length,
      });
    },
    put: (key, value, options) => {
      if (objects.has(key) && options?.onlyIf?.etagDoesNotMatch === "*") {
        overwriteAttempts += 1;
        return Promise.resolve(null);
      }
      const stored = {
        body: value,
        etag: `"${objects.size + 1}"`,
        key,
      };
      objects.set(key, stored);
      return Promise.resolve(stored);
    },
  };
  return {
    bucket,
    deleteCount: () => deleteCount,
    objects,
    overwriteAttempts: () => overwriteAttempts,
  };
};

describe("restore-safe deletion markers", () => {
  test("uses a dedicated domain-separated HMAC without exposing the opaque identifier", async () => {
    const storage = makeBucket();
    const production = makeDeletionMarkerStore({
      bucket: storage.bucket,
      environment: "production",
      hmacSecret: markerSecret,
    });
    const preview = makeDeletionMarkerStore({
      bucket: storage.bucket,
      environment: "preview",
      hmacSecret: markerSecret,
    });

    const connection = await Effect.runPromise(
      production.create({
        deletionKind: "whatsapp_connection",
        keyUnavailableAt: "2026-07-31T12:01:00.000Z",
        opaqueEntityId: "connection-sensitive-identifier",
        requestedAt: "2026-07-31T12:00:00.000Z",
      }),
    );
    const account = await Effect.runPromise(
      production.create({
        deletionKind: "personal_account",
        keyUnavailableAt: "2026-07-31T12:01:00.000Z",
        opaqueEntityId: "connection-sensitive-identifier",
        requestedAt: "2026-07-31T12:00:00.000Z",
      }),
    );
    const otherEnvironment = await Effect.runPromise(
      preview.create({
        deletionKind: "whatsapp_connection",
        keyUnavailableAt: "2026-07-31T12:01:00.000Z",
        opaqueEntityId: "connection-sensitive-identifier",
        requestedAt: "2026-07-31T12:00:00.000Z",
      }),
    );

    expect(connection.markerId).toMatch(/^[a-f0-9]{64}$/);
    expect(connection.objectKey).toBe(`markers/v1/${connection.markerId}.json`);
    expect(connection.objectKey).not.toContain("connection-sensitive");
    expect(account.markerId).not.toBe(connection.markerId);
    expect(otherEnvironment.markerId).not.toBe(connection.markerId);
  });

  test("writes an exact content-free body once and treats replay as idempotent", async () => {
    const storage = makeBucket();
    const markers = makeDeletionMarkerStore({
      bucket: storage.bucket,
      environment: "production",
      hmacSecret: markerSecret,
    });
    const input = {
      deletionKind: "whatsapp_connection" as const,
      keyUnavailableAt: "2026-07-31T12:01:00.000Z",
      opaqueEntityId: "connection-sensitive-identifier",
      requestedAt: "2026-07-31T12:00:00.000Z",
    };

    const first = await Effect.runPromise(markers.create(input));
    const replay = await Effect.runPromise(markers.create(input));
    const stored = storage.objects.get(first.objectKey);

    expect(replay).toEqual(first);
    expect(storage.overwriteAttempts()).toBe(1);
    expect(stored && JSON.parse(stored.body)).toEqual({
      deletionKind: "whatsapp_connection",
      keyUnavailableAt: "2026-07-31T12:01:00.000Z",
      requestedAt: "2026-07-31T12:00:00.000Z",
      version: 1,
    });
    expect(Object.keys(stored ? JSON.parse(stored.body) : {}).sort()).toEqual([
      "deletionKind",
      "keyUnavailableAt",
      "requestedAt",
      "version",
    ]);
  });

  test("reuses locked timestamps when a deletion request is retried", async () => {
    const storage = makeBucket();
    const markers = makeDeletionMarkerStore({
      bucket: storage.bucket,
      environment: "production",
      hmacSecret: markerSecret,
    });
    const base = {
      deletionKind: "personal_account" as const,
      keyUnavailableAt: "2026-07-31T12:01:00.000Z",
      opaqueEntityId: "account-sensitive-identifier",
      requestedAt: "2026-07-31T12:00:00.000Z",
    };

    const first = await Effect.runPromise(markers.create(base));
    const replay = await Effect.runPromise(
      markers.create({
        ...base,
        keyUnavailableAt: "2026-07-31T12:03:00.000Z",
        requestedAt: "2026-07-31T12:02:00.000Z",
      }),
    );

    expect(replay).toEqual(first);
    expect(storage.objects).toHaveLength(1);
  });

  test("enumerates and validates every marker page for restore replay", async () => {
    const storage = makeBucket(1);
    const markers = makeDeletionMarkerStore({
      bucket: storage.bucket,
      environment: "production",
      hmacSecret: markerSecret,
    });

    await Effect.runPromise(
      markers.create({
        deletionKind: "personal_account",
        keyUnavailableAt: "2026-07-31T12:01:00.000Z",
        opaqueEntityId: "account-a",
        requestedAt: "2026-07-31T12:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      markers.create({
        deletionKind: "whatsapp_connection",
        keyUnavailableAt: "2026-07-31T12:03:00.000Z",
        opaqueEntityId: "connection-b",
        requestedAt: "2026-07-31T12:02:00.000Z",
      }),
    );

    const restored = await Effect.runPromise(markers.enumerate());

    expect(restored).toHaveLength(2);
    expect(restored.map(({ marker }) => marker.deletionKind).sort()).toEqual([
      "personal_account",
      "whatsapp_connection",
    ]);
    expect(
      restored.every(({ markerId }) => /^[a-f0-9]{64}$/.test(markerId)),
    ).toBe(true);
  });

  test("fails closed when restore enumeration repeats a truncated page cursor", async () => {
    const storage = makeBucket();
    const markers = makeDeletionMarkerStore({
      bucket: {
        ...storage.bucket,
        list: () =>
          Promise.resolve({
            cursor: "repeated-cursor",
            objects: [],
            truncated: true,
          }),
      },
      environment: "production",
      hmacSecret: markerSecret,
    });

    const result = await Effect.runPromise(Effect.either(markers.enumerate()));

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "DeletionPrimitiveError",
        operation: "enumerate-markers",
      },
    });
  });

  test("rejects a restore marker with any extra identity field", async () => {
    const storage = makeBucket();
    storage.objects.set(`markers/v1/${"d".repeat(64)}.json`, {
      body: JSON.stringify({
        deletionKind: "personal_account",
        keyUnavailableAt: "2026-07-31T12:01:00.000Z",
        personalAccountId: "must-not-be-retained",
        requestedAt: "2026-07-31T12:00:00.000Z",
        version: 1,
      }),
      etag: '"unsafe"',
      key: `markers/v1/${"d".repeat(64)}.json`,
    });
    const markers = makeDeletionMarkerStore({
      bucket: storage.bucket,
      environment: "production",
      hmacSecret: markerSecret,
    });

    const result = await Effect.runPromise(Effect.either(markers.enumerate()));

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "DeletionPrimitiveError",
        operation: "enumerate-markers",
      },
    });
  });
});

describe("Deletion Capsules", () => {
  test("encrypts only provider cleanup identifiers under the separate key and authenticated context", async () => {
    const storage = makeBucket();
    const encryptionCalls: Array<{
      readonly encryptionContext: Readonly<Record<string, string>>;
      readonly keyId: string;
      readonly plaintext: Uint8Array;
    }> = [];
    let scopedPlaintext: Uint8Array | undefined;
    const writer: DeletionCapsuleKmsWriter = {
      encrypt: (input) => {
        scopedPlaintext = input.plaintext;
        encryptionCalls.push({
          ...input,
          plaintext: input.plaintext.slice(),
        });
        return Effect.succeed(new Uint8Array([7, 8, 9]));
      },
    };
    const capsules = makeDeletionCapsuleStore({
      bucket: storage.bucket,
      environment: "production",
      keyId: "arn:aws:kms:us-east-1:111122223333:key/deletion-coordinator-key",
      kmsWriter: writer,
    });

    await Effect.runPromise(
      capsules.create({
        deletionMarkerId: "a".repeat(64),
        keyVersion: 3,
        providerCleanupIdentifiers: {
          sessionLocator: "wsl_provider-cleanup-only",
        },
      }),
    );

    expect(encryptionCalls).toHaveLength(1);
    expect(encryptionCalls[0]?.keyId).toContain("deletion-coordinator-key");
    expect(encryptionCalls[0]?.encryptionContext).toEqual({
      deletionMarkerId: "a".repeat(64),
      environment: "production",
      keyVersion: "3",
      purpose: "deletion-capsule",
    });
    const plaintext = JSON.parse(
      new TextDecoder().decode(encryptionCalls[0]?.plaintext),
    );
    expect(plaintext).toEqual({
      providerCleanupIdentifiers: {
        sessionLocator: "wsl_provider-cleanup-only",
      },
      version: 1,
    });
    expect(Object.keys(plaintext)).toEqual([
      "providerCleanupIdentifiers",
      "version",
    ]);
    const storedBody = [...storage.objects.values()][0]?.body ?? "";
    expect(storedBody).not.toContain("wsl_provider-cleanup-only");
    expect(JSON.parse(storedBody)).toEqual({
      ciphertext: "BwgJ",
      keyVersion: 3,
      version: 1,
    });
    expect(Array.from(scopedPlaintext ?? [])).toEqual(
      new Array(scopedPlaintext?.length ?? 0).fill(0),
    );
  });

  test("lets the coordinator reconcile absence and destroys the capsule only after confirmation", async () => {
    const storage = makeBucket();
    const markerId = "b".repeat(64);
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        providerCleanupIdentifiers: {
          sessionLocator: "wsl_provider-cleanup-only",
        },
        version: 1,
      }),
    );
    const writer: DeletionCapsuleKmsWriter = {
      encrypt: () => Effect.succeed(new Uint8Array([1, 2, 3])),
    };
    const decryptionCalls: Array<{
      readonly encryptionContext: Readonly<Record<string, string>>;
      readonly keyId: string;
    }> = [];
    const reader: DeletionCapsuleKmsReader = {
      decrypt: (input) => {
        decryptionCalls.push(input);
        return Effect.succeed(plaintext);
      },
    };
    const capsules = makeDeletionCapsuleStore({
      bucket: storage.bucket,
      environment: "production",
      keyId: "arn:aws:kms:us-east-1:111122223333:key/deletion-coordinator-key",
      kmsWriter: writer,
    });
    await Effect.runPromise(
      capsules.create({
        deletionMarkerId: markerId,
        keyVersion: 1,
        providerCleanupIdentifiers: {
          sessionLocator: "wsl_provider-cleanup-only",
        },
      }),
    );
    const observations: Array<string> = [];
    const cleanupCalls: Array<string> = [];
    const coordinator = makeDeletionCapsuleCoordinator({
      capsuleStore: capsules,
      kmsReader: reader,
      confirmProviderAbsence: ({ deletionMarkerId }) => {
        cleanupCalls.push(deletionMarkerId);
        return Effect.succeed({ state: "complete" as const });
      },
      reconcileProviderAbsence: ({ sessionLocator }) => {
        observations.push(sessionLocator);
        return Effect.succeed({ state: "absent" as const });
      },
    });

    const result = await Effect.runPromise(
      coordinator.reconcile({ deletionMarkerId: markerId }),
    );
    const replay = await Effect.runPromise(
      coordinator.reconcile({ deletionMarkerId: markerId }),
    );

    expect(result).toEqual({ state: "complete" });
    expect(replay).toEqual({ state: "complete" });
    expect(observations).toEqual(["wsl_provider-cleanup-only"]);
    expect(cleanupCalls).toEqual([markerId]);
    expect(storage.deleteCount()).toBe(1);
    expect(Array.from(plaintext)).toEqual(new Array(plaintext.length).fill(0));
    expect(decryptionCalls[0]).toEqual({
      ciphertext: new Uint8Array([1, 2, 3]),
      encryptionContext: {
        deletionMarkerId: markerId,
        environment: "production",
        keyVersion: "1",
        purpose: "deletion-capsule",
      },
      keyId: "arn:aws:kms:us-east-1:111122223333:key/deletion-coordinator-key",
    });
  });

  test("fails closed and clears malformed decrypted capsule plaintext", async () => {
    const storage = makeBucket();
    const markerId = "e".repeat(64);
    const malformed = new TextEncoder().encode(
      JSON.stringify({
        personalAccountId: "must-not-be-present",
        version: 1,
      }),
    );
    const capsules = makeDeletionCapsuleStore({
      bucket: storage.bucket,
      environment: "production",
      keyId: "arn:aws:kms:us-east-1:111122223333:key/deletion-coordinator-key",
      kmsWriter: {
        encrypt: () => Effect.succeed(new Uint8Array([1, 2, 3])),
      },
    });
    await Effect.runPromise(
      capsules.create({
        deletionMarkerId: markerId,
        keyVersion: 1,
        providerCleanupIdentifiers: {
          sessionLocator: "wsl_provider-cleanup-only",
        },
      }),
    );
    const coordinator = makeDeletionCapsuleCoordinator({
      capsuleStore: capsules,
      kmsReader: {
        decrypt: () => Effect.succeed(malformed),
      },
      confirmProviderAbsence: () =>
        Effect.succeed({ state: "complete" as const }),
      reconcileProviderAbsence: () =>
        Effect.succeed({ state: "absent" as const }),
    });

    const result = await Effect.runPromise(
      Effect.either(coordinator.reconcile({ deletionMarkerId: markerId })),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "DeletionPrimitiveError",
        operation: "decrypt-capsule",
      },
    });
    expect(Array.from(malformed)).toEqual(new Array(malformed.length).fill(0));
    expect(storage.deleteCount()).toBe(0);
  });

  test("rejects a replay that changes immutable capsule key metadata", async () => {
    const storage = makeBucket();
    const markerId = "f".repeat(64);
    const capsules = makeDeletionCapsuleStore({
      bucket: storage.bucket,
      environment: "production",
      keyId: "arn:aws:kms:us-east-1:111122223333:key/deletion-coordinator-key",
      kmsWriter: {
        encrypt: () => Effect.succeed(new Uint8Array([1, 2, 3])),
      },
    });
    await Effect.runPromise(
      capsules.create({
        deletionMarkerId: markerId,
        keyVersion: 1,
        providerCleanupIdentifiers: {
          sessionLocator: "wsl_provider-cleanup-only",
        },
      }),
    );

    const result = await Effect.runPromise(
      Effect.either(
        capsules.create({
          deletionMarkerId: markerId,
          keyVersion: 2,
          providerCleanupIdentifiers: {
            sessionLocator: "wsl_provider-cleanup-only",
          },
        }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "DeletionPrimitiveError",
        operation: "create-capsule",
      },
    });
  });

  test("retains a capsule while provider cleanup remains present", async () => {
    const storage = makeBucket();
    const markerId = "c".repeat(64);
    const writer: DeletionCapsuleKmsWriter = {
      encrypt: () => Effect.succeed(new Uint8Array([1, 2, 3])),
    };
    const reader: DeletionCapsuleKmsReader = {
      decrypt: () =>
        Effect.succeed(
          new TextEncoder().encode(
            JSON.stringify({
              providerCleanupIdentifiers: {
                sessionLocator: "wsl_still-present",
              },
              version: 1,
            }),
          ),
        ),
    };
    const capsules = makeDeletionCapsuleStore({
      bucket: storage.bucket,
      environment: "production",
      keyId: "arn:aws:kms:us-east-1:111122223333:key/deletion-coordinator-key",
      kmsWriter: writer,
    });
    await Effect.runPromise(
      capsules.create({
        deletionMarkerId: markerId,
        keyVersion: 1,
        providerCleanupIdentifiers: {
          sessionLocator: "wsl_still-present",
        },
      }),
    );
    const coordinator = makeDeletionCapsuleCoordinator({
      capsuleStore: capsules,
      kmsReader: reader,
      confirmProviderAbsence: () =>
        Effect.succeed({ state: "complete" as const }),
      reconcileProviderAbsence: () =>
        Effect.succeed({ state: "present" as const }),
    });

    const result = await Effect.runPromise(
      coordinator.reconcile({ deletionMarkerId: markerId }),
    );

    expect(result).toEqual({ state: "pending" });
    expect(storage.deleteCount()).toBe(0);
    expect(storage.objects.size).toBe(1);
  });

  test("records provider absence before capsule destruction and retains the capsule when recording fails", async () => {
    const storage = makeBucket();
    const markerId = "d".repeat(64);
    const capsules = makeDeletionCapsuleStore({
      bucket: storage.bucket,
      environment: "production",
      keyId: "arn:aws:kms:us-east-1:111122223333:key/deletion-coordinator-key",
      kmsWriter: {
        encrypt: () => Effect.succeed(new Uint8Array([1, 2, 3])),
      },
    });
    await Effect.runPromise(
      capsules.create({
        deletionMarkerId: markerId,
        keyVersion: 1,
        providerCleanupIdentifiers: {
          sessionLocator: "wsl_provider-cleanup-only",
        },
      }),
    );
    const calls: Array<string> = [];
    const coordinator = makeDeletionCapsuleCoordinator({
      capsuleStore: capsules,
      kmsReader: {
        decrypt: () =>
          Effect.succeed(
            new TextEncoder().encode(
              JSON.stringify({
                providerCleanupIdentifiers: {
                  sessionLocator: "wsl_provider-cleanup-only",
                },
                version: 1,
              }),
            ),
          ),
      },
      confirmProviderAbsence: () => {
        calls.push("confirm-absence");
        return Effect.fail(new Error("database unavailable"));
      },
      reconcileProviderAbsence: () => {
        calls.push("provider-absent");
        return Effect.succeed({ state: "absent" as const });
      },
    });

    const result = await Effect.runPromise(
      Effect.either(coordinator.reconcile({ deletionMarkerId: markerId })),
    );

    expect(calls).toEqual(["provider-absent", "confirm-absence"]);
    expect(result).toMatchObject({
      _tag: "Left",
      left: { operation: "confirm-provider-absence" },
    });
    expect(storage.objects.size).toBe(1);
    expect(storage.deleteCount()).toBe(0);
  });

  test("retains failed cleanup for retry and eventually completes idempotently", async () => {
    const storage = makeBucket();
    const markerId = "1".repeat(64);
    const capsules = makeDeletionCapsuleStore({
      bucket: storage.bucket,
      environment: "production",
      keyId: "arn:aws:kms:us-east-1:111122223333:key/deletion-coordinator-key",
      kmsWriter: {
        encrypt: () => Effect.succeed(new Uint8Array([1, 2, 3])),
      },
    });
    await Effect.runPromise(
      capsules.create({
        deletionMarkerId: markerId,
        keyVersion: 1,
        providerCleanupIdentifiers: {
          sessionLocator: "wsl_retry-until-absent",
        },
      }),
    );
    let providerAttempts = 0;
    let absenceConfirmations = 0;
    const coordinator = makeDeletionCapsuleCoordinator({
      capsuleStore: capsules,
      kmsReader: {
        decrypt: () =>
          Effect.succeed(
            new TextEncoder().encode(
              JSON.stringify({
                providerCleanupIdentifiers: {
                  sessionLocator: "wsl_retry-until-absent",
                },
                version: 1,
              }),
            ),
          ),
      },
      confirmProviderAbsence: () => {
        absenceConfirmations += 1;
        return Effect.succeed({ state: "complete" as const });
      },
      reconcileProviderAbsence: () => {
        providerAttempts += 1;
        return providerAttempts === 1
          ? Effect.fail(new Error("provider unavailable"))
          : Effect.succeed({ state: "absent" as const });
      },
    });

    await expect(
      Effect.runPromise(coordinator.reconcile({ deletionMarkerId: markerId })),
    ).rejects.toThrow();
    expect(storage.objects.size).toBe(1);
    expect(storage.deleteCount()).toBe(0);

    await expect(
      Effect.runPromise(coordinator.reconcile({ deletionMarkerId: markerId })),
    ).resolves.toEqual({ state: "complete" });
    await expect(
      Effect.runPromise(coordinator.reconcile({ deletionMarkerId: markerId })),
    ).resolves.toEqual({ state: "complete" });
    expect(providerAttempts).toBe(2);
    expect(absenceConfirmations).toBe(1);
    expect(storage.objects.size).toBe(0);
    expect(storage.deleteCount()).toBe(1);
  });
});
