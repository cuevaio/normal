import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Redacted, Stream } from "effect";
import type { SessionAuthority } from "../src/control";
import {
  makeWasenderMediaRetrieval,
  type WasenderMediaAdapterDependencies,
} from "../src/media";
import { makeWasenderMediaRetrievalLayer } from "../src/media-live";
import {
  makeDownloadMediaSource,
  makeEncryptedMediaSource,
} from "../src/media-source";
import { MediaRetrieval, makeMediaDownloadByteLimit } from "../src/session";

const sessionAuthority = Redacted.make("session-api-key") as SessionAuthority;
const publicAddresses = ["104.21.12.34", "2606:4700:3030::6815:c22"];

const encryptedSource = makeEncryptedMediaSource({
  key: { id: "message-id" },
  message: {
    imageMessage: {
      fileLength: "4",
      fileName: "photo.jpg",
      fileSha256: "hash",
      mediaKey: "media-key",
      mimetype: "image/jpeg",
      url: "https://mmg.whatsapp.net/encrypted",
    },
  },
});

type Fetcher = WasenderMediaAdapterDependencies["fetch"];

const dependencies = (
  fetcher: Fetcher,
  overrides: Partial<WasenderMediaAdapterDependencies> = {},
): WasenderMediaAdapterDependencies => ({
  clearTimer: () => undefined,
  fetch: fetcher,
  now: () => 1_000,
  resolveHostname: async () => publicAddresses,
  scheduleTimer: () => 1,
  telemetry: { emit: () => undefined },
  ...overrides,
});

const runFailure = async <A>(effect: Effect.Effect<A, unknown>) => {
  const exit = await Effect.runPromiseExit(effect);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) {
    throw new Error("Expected failure");
  }
  return Cause.squash(exit.cause) as {
    readonly code: string;
    readonly operation: string;
    readonly retryDecision: string;
  };
};

const runStreamFailure = (stream: Stream.Stream<Uint8Array, unknown>) =>
  runFailure(Stream.runCollect(stream));

describe("real Wasender media adapter", () => {
  test("decrypts metadata with a bounded authenticated request", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const scheduled: number[] = [];
    const adapter = makeWasenderMediaRetrieval({
      dependencies: dependencies(
        async (input, init) => {
          calls.push({ input, init });
          return new Response(
            JSON.stringify({
              publicUrl:
                "https://api.wapi.crafter.run/api/decrypted-media/message-id",
              success: true,
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
        {
          scheduleTimer: (_callback, delayMs) => {
            scheduled.push(delayMs);
            return 1;
          },
        },
      ),
      sessionAuthority,
    });

    const metadata = await Effect.runPromise(
      adapter.getMetadata({ source: encryptedSource }),
    );

    expect(metadata).toMatchObject({
      expectedSizeBytes: 4,
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
    });
    expect(JSON.stringify(metadata)).not.toContain("decrypted-media");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(
      "https://api.wapi.crafter.run/api/decrypt-media",
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer session-api-key",
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      data: {
        messages: {
          key: { id: "message-id" },
          message: {
            imageMessage: {
              fileLength: "4",
              fileName: "photo.jpg",
              fileSha256: "hash",
              mediaKey: "media-key",
              mimetype: "image/jpeg",
              url: "https://mmg.whatsapp.net/encrypted",
            },
          },
        },
      },
    });
    expect(scheduled).toEqual([30_000]);
  });

  test("streams hashable bytes without forwarding authorization", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const scheduled: number[] = [];
    const adapter = makeWasenderMediaRetrieval({
      dependencies: dependencies(
        async (input, init) => {
          calls.push({ input, init });
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2]));
                controller.enqueue(new Uint8Array([3, 4]));
                controller.close();
              },
            }),
          );
        },
        {
          scheduleTimer: (_callback, delayMs) => {
            scheduled.push(delayMs);
            return 1;
          },
        },
      ),
      sessionAuthority,
    });
    const download = await Effect.runPromise(
      adapter.download({
        maxBytes: makeMediaDownloadByteLimit(4),
        source: makeDownloadMediaSource(
          "https://api.wapi.crafter.run/api/decrypted-media/message-id",
        ),
      }),
    );
    const chunks = await Effect.runPromise(Stream.runCollect(download.stream));
    const bytes = Uint8Array.from(
      Array.from(chunks).flatMap((chunk) => Array.from(chunk)),
    );
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    expect(digest).toHaveLength(32);
    expect(new Headers(calls[0]?.init.headers).has("authorization")).toBe(
      false,
    );
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(scheduled).toEqual([60_000]);
  });

  test.each([
    // Wrong scheme.
    "http://api.wapi.crafter.run/api/decrypted-media/id",
    // A sibling host of the provider's, which is not the provider.
    "https://wapi.crafter.run/api/decrypted-media/id",
    // Suffix confusion against the provider host.
    "https://api.wapi.crafter.run.evil.test/api/decrypted-media/id",
    "https://evil.example/api/decrypted-media/id",
    "https://127.0.0.1/api/decrypted-media/id",
    // Embedded credentials, which `URL.origin` would otherwise drop silently.
    "https://user:password@api.wapi.crafter.run/api/decrypted-media/id",
    // Explicit port.
    "https://api.wapi.crafter.run:444/api/decrypted-media/id",
  ])("rejects unsafe download URL %s", async (url) => {
    let fetches = 0;
    const adapter = makeWasenderMediaRetrieval({
      dependencies: dependencies(async () => {
        fetches += 1;
        return new Response();
      }),
      sessionAuthority,
    });

    const failure = await runFailure(
      adapter.download({
        maxBytes: makeMediaDownloadByteLimit(10),
        source: makeDownloadMediaSource(url),
      }),
    );

    expect(failure).toMatchObject({
      code: "source_rejected",
      operation: "media-download",
      retryDecision: "do_not_retry",
    });
    expect(fetches).toBe(0);
  });

  test.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fc00::1",
    "2001:db8::1",
    "2001::1",
    "2002:7f00:1::1",
    "2001:2::1",
    "2001:10::1",
    "2001:20::1",
    "3fff::1",
    "::ffff:127.0.0.1",
  ])("rejects unsafe DNS answer %s before fetching", async (address) => {
    let fetches = 0;
    const adapter = makeWasenderMediaRetrieval({
      dependencies: dependencies(
        async () => {
          fetches += 1;
          return new Response();
        },
        { resolveHostname: async () => [address] },
      ),
      sessionAuthority,
    });
    const download = await Effect.runPromise(
      adapter.download({
        maxBytes: makeMediaDownloadByteLimit(10),
        source: makeDownloadMediaSource(
          "https://api.wapi.crafter.run/api/decrypted-media/id",
        ),
      }),
    );

    const failure = await runStreamFailure(download.stream);

    expect(failure.code).toBe("source_rejected");
    expect(fetches).toBe(0);
  });

  test("revalidates redirects and rejects host escape", async () => {
    const calls: string[] = [];
    const adapter = makeWasenderMediaRetrieval({
      dependencies: dependencies(async (input) => {
        calls.push(input);
        return new Response(null, {
          headers: { location: "https://evil.example/stolen" },
          status: 302,
        });
      }),
      sessionAuthority,
    });
    const download = await Effect.runPromise(
      adapter.download({
        maxBytes: makeMediaDownloadByteLimit(10),
        source: makeDownloadMediaSource(
          "https://api.wapi.crafter.run/api/decrypted-media/id",
        ),
      }),
    );

    const failure = await runStreamFailure(download.stream);

    expect(failure.code).toBe("source_rejected");
    expect(calls).toEqual([
      "https://api.wapi.crafter.run/api/decrypted-media/id",
    ]);
  });

  test("revalidates DNS after an allowed redirect", async () => {
    let resolutions = 0;
    let fetches = 0;
    const adapter = makeWasenderMediaRetrieval({
      dependencies: dependencies(
        async () => {
          fetches += 1;
          return new Response(null, {
            headers: {
              location: "https://api.wapi.crafter.run/api/decrypted-media/next",
            },
            status: 307,
          });
        },
        {
          resolveHostname: async () => {
            resolutions += 1;
            return resolutions === 1 ? publicAddresses : ["127.0.0.1"];
          },
        },
      ),
      sessionAuthority,
    });
    const download = await Effect.runPromise(
      adapter.download({
        maxBytes: makeMediaDownloadByteLimit(10),
        source: makeDownloadMediaSource(
          "https://api.wapi.crafter.run/api/decrypted-media/id",
        ),
      }),
    );

    const failure = await runStreamFailure(download.stream);

    expect(failure.code).toBe("source_rejected");
    expect({ fetches, resolutions }).toEqual({ fetches: 1, resolutions: 2 });
  });

  test("follows a same-host redirect after revalidation", async () => {
    let fetches = 0;
    let resolutions = 0;
    const adapter = makeWasenderMediaRetrieval({
      dependencies: dependencies(
        async () => {
          fetches += 1;
          return fetches === 1
            ? new Response(null, {
                headers: { location: "/api/decrypted-media/next" },
                status: 302,
              })
            : new Response(new Uint8Array([1, 2, 3]));
        },
        {
          resolveHostname: async () => {
            resolutions += 1;
            return publicAddresses;
          },
        },
      ),
      sessionAuthority,
    });
    const download = await Effect.runPromise(
      adapter.download({
        maxBytes: makeMediaDownloadByteLimit(3),
        source: makeDownloadMediaSource(
          "https://api.wapi.crafter.run/api/decrypted-media/id",
        ),
      }),
    );

    const chunks = await Effect.runPromise(Stream.runCollect(download.stream));

    expect(Array.from(chunks).flatMap((chunk) => Array.from(chunk))).toEqual([
      1, 2, 3,
    ]);
    expect({ fetches, resolutions }).toEqual({ fetches: 2, resolutions: 2 });
  });

  test("aborts and fails before yielding a chunk that exceeds the hard limit", async () => {
    let cancelled = false;
    const adapter = makeWasenderMediaRetrieval({
      dependencies: dependencies(
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.enqueue(new Uint8Array([4, 5]));
              },
            }),
            { headers: { "content-length": "1" } },
          ),
      ),
      sessionAuthority,
    });
    const download = await Effect.runPromise(
      adapter.download({
        maxBytes: makeMediaDownloadByteLimit(4),
        source: makeDownloadMediaSource(
          "https://api.wapi.crafter.run/api/decrypted-media/id",
        ),
      }),
    );

    const failure = await runStreamFailure(download.stream);

    expect(failure).toMatchObject({
      code: "response_too_large",
      retryDecision: "restart_media_from_byte_zero",
    });
    expect(cancelled).toBe(true);
  });

  test("preserves the overflow failure when stream cancellation fails", async () => {
    const adapter = makeWasenderMediaRetrieval({
      dependencies: dependencies(
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                throw new Error("cancel failed");
              },
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
              },
            }),
          ),
      ),
      sessionAuthority,
    });
    const download = await Effect.runPromise(
      adapter.download({
        maxBytes: makeMediaDownloadByteLimit(2),
        source: makeDownloadMediaSource(
          "https://api.wapi.crafter.run/api/decrypted-media/id",
        ),
      }),
    );

    const failure = await runStreamFailure(download.stream);

    expect(failure).toMatchObject({
      code: "response_too_large",
      retryDecision: "restart_media_from_byte_zero",
    });
  });

  test("uses actual bytes when Content-Length is over-reported", async () => {
    const adapter = makeWasenderMediaRetrieval({
      dependencies: dependencies(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-length": "100000000" },
          }),
      ),
      sessionAuthority,
    });
    const download = await Effect.runPromise(
      adapter.download({
        maxBytes: makeMediaDownloadByteLimit(3),
        source: makeDownloadMediaSource(
          "https://api.wapi.crafter.run/api/decrypted-media/id",
        ),
      }),
    );

    const chunks = await Effect.runPromise(Stream.runCollect(download.stream));

    expect(Array.from(chunks).flatMap((chunk) => Array.from(chunk))).toEqual([
      1, 2, 3,
    ]);
  });

  test("starts a fresh byte-zero attempt each time the guarded stream runs", async () => {
    let fetches = 0;
    const adapter = makeWasenderMediaRetrieval({
      dependencies: dependencies(async () => {
        fetches += 1;
        return new Response(new Uint8Array([1, 2]));
      }),
      sessionAuthority,
    });
    const download = await Effect.runPromise(
      adapter.download({
        maxBytes: makeMediaDownloadByteLimit(2),
        source: makeDownloadMediaSource(
          "https://api.wapi.crafter.run/api/decrypted-media/id",
        ),
      }),
    );

    const first = await Effect.runPromise(Stream.runCollect(download.stream));
    const second = await Effect.runPromise(Stream.runCollect(download.stream));

    expect(Array.from(first).flatMap((chunk) => Array.from(chunk))).toEqual([
      1, 2,
    ]);
    expect(Array.from(second).flatMap((chunk) => Array.from(chunk))).toEqual([
      1, 2,
    ]);
    expect(fetches).toBe(2);
  });

  test("maps a truncated response stream to restart-from-zero", async () => {
    const adapter = makeWasenderMediaRetrieval({
      dependencies: dependencies(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2]));
                controller.error(new Error("truncated"));
              },
            }),
          ),
      ),
      sessionAuthority,
    });
    const download = await Effect.runPromise(
      adapter.download({
        maxBytes: makeMediaDownloadByteLimit(10),
        source: makeDownloadMediaSource(
          "https://api.wapi.crafter.run/api/decrypted-media/id",
        ),
      }),
    );

    const failure = await runStreamFailure(download.stream);

    expect(failure).toMatchObject({
      code: "unavailable",
      retryDecision: "restart_media_from_byte_zero",
    });
  });

  test("uses independent timeout budgets for metadata and streamed downloads", async () => {
    const delays: number[] = [];
    const abortingDependencies = dependencies(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          if (init.signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
      {
        scheduleTimer: (callback, delayMs) => {
          delays.push(delayMs);
          queueMicrotask(callback);
          return delayMs;
        },
      },
    );
    const adapter = makeWasenderMediaRetrieval({
      dependencies: abortingDependencies,
      sessionAuthority,
    });

    const metadataFailure = await runFailure(
      adapter.getMetadata({ source: encryptedSource }),
    );
    const download = await Effect.runPromise(
      adapter.download({
        maxBytes: makeMediaDownloadByteLimit(10),
        source: makeDownloadMediaSource(
          "https://api.wapi.crafter.run/api/decrypted-media/id",
        ),
      }),
    );
    const downloadFailure = await runStreamFailure(download.stream);

    expect(metadataFailure).toMatchObject({
      code: "timed_out",
      operation: "media-metadata",
    });
    expect(downloadFailure).toMatchObject({
      code: "timed_out",
      operation: "media-download",
    });
    expect(delays).toEqual([30_000, 60_000]);
  });

  test.each([
    [401, "authentication_failed"],
    [429, "throttled"],
    [503, "unavailable"],
  ])("maps metadata provider status %i to %s", async (status, code) => {
    const adapter = makeWasenderMediaRetrieval({
      dependencies: dependencies(async () => new Response(null, { status })),
      sessionAuthority,
    });

    const failure = await runFailure(
      adapter.getMetadata({ source: encryptedSource }),
    );

    expect(failure).toMatchObject({
      code,
      operation: "media-metadata",
      retryDecision: "do_not_retry",
    });
  });

  test("rejects an unsafe temporary URL as a metadata failure", async () => {
    const adapter = makeWasenderMediaRetrieval({
      dependencies: dependencies(
        async () =>
          new Response(
            JSON.stringify({
              publicUrl: "https://evil.example/decrypted-media/id",
              success: true,
            }),
          ),
      ),
      sessionAuthority,
    });

    const failure = await runFailure(
      adapter.getMetadata({ source: encryptedSource }),
    );

    expect(failure).toMatchObject({
      code: "source_rejected",
      operation: "media-metadata",
      retryDecision: "do_not_retry",
    });
  });

  test.each([
    [403, "authentication_failed", "do_not_retry"],
    [429, "throttled", "do_not_retry"],
    [206, "invalid_response", "do_not_retry"],
    [502, "unavailable", "restart_media_from_byte_zero"],
  ])(
    "maps download provider status %i to %s",
    async (status, code, retryDecision) => {
      const adapter = makeWasenderMediaRetrieval({
        dependencies: dependencies(async () => new Response(null, { status })),
        sessionAuthority,
      });
      const download = await Effect.runPromise(
        adapter.download({
          maxBytes: makeMediaDownloadByteLimit(10),
          source: makeDownloadMediaSource(
            "https://api.wapi.crafter.run/api/decrypted-media/id",
          ),
        }),
      );

      const failure = await runStreamFailure(download.stream);

      expect(failure).toMatchObject({
        code,
        operation: "media-download",
        retryDecision,
      });
    },
  );

  test("does not allow a transport error to spoof a provider-neutral failure", async () => {
    const adapter = makeWasenderMediaRetrieval({
      dependencies: dependencies(async () =>
        Promise.reject({
          _tag: "ProviderNeutralFailure",
          code: "source_rejected",
          secret: "transport-details",
        }),
      ),
      sessionAuthority,
    });

    const failure = await runFailure(
      adapter.getMetadata({ source: encryptedSource }),
    );

    expect(failure).toMatchObject({
      code: "unavailable",
      operation: "media-metadata",
    });
    expect(JSON.stringify(failure)).not.toContain("transport-details");
  });

  test("bounds the metadata response body", async () => {
    const adapter = makeWasenderMediaRetrieval({
      dependencies: dependencies(
        async () => new Response("x".repeat(1_048_577)),
      ),
      sessionAuthority,
    });

    const failure = await runFailure(
      adapter.getMetadata({ source: encryptedSource }),
    );

    expect(failure.code).toBe("response_too_large");
  });

  test("rejects invalid credentials when constructing the production service", () => {
    expect(() =>
      makeWasenderMediaRetrieval({
        dependencies: dependencies(async () => new Response()),
        sessionAuthority: Redacted.make("   ") as SessionAuthority,
      }),
    ).toThrow("Wasender session authority is invalid");
  });

  test("exposes only the fixed real transport through the production Layer", async () => {
    const service = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* MediaRetrieval;
      }).pipe(
        Effect.provide(makeWasenderMediaRetrievalLayer({ sessionAuthority })),
      ),
    );
    const invalidExit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* MediaRetrieval;
      }).pipe(
        Effect.provide(
          makeWasenderMediaRetrievalLayer({
            sessionAuthority: Redacted.make("") as SessionAuthority,
          }),
        ),
      ),
    );

    expect(typeof service.getMetadata).toBe("function");
    expect(typeof service.download).toBe("function");
    expect(Exit.isFailure(invalidExit)).toBe(true);
  });
});
