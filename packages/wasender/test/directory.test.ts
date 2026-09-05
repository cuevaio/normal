import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import {
  type DirectorySessionAuthority,
  makeWasenderSessionDirectory,
  type ProviderNeutralFailure,
  type WasenderDirectoryTelemetryEvent,
  type WasenderIdentityProtectionKey,
} from "../src/session";
import {
  changedPaginatedContactsSecondPage,
  contactsDirectoryResponse,
  duplicateContactsFirstPage,
  duplicatePaginatedContactsSecondPage,
  emptyDirectoryResponse,
  emptyPaginatedContactsFirstPage,
  groupsDirectoryResponse,
  largeDirectoryResponseBody,
  malformedDirectoryResponse,
  paginatedContactsFirstPage,
  throttledDirectoryResponses,
  transientDirectoryResponses,
} from "./fixtures/directory";

const originalFetch = globalThis.fetch;
const originalRandom = Math.random;
const credential =
  "session-directory-authority-for-reviewed-fixtures" as string;
const authority = Redacted.make(credential) as DirectorySessionAuthority;
const identityKey = Redacted.make(
  new Uint8Array(32).fill(39),
) as WasenderIdentityProtectionKey;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Math.random = originalRandom;
});

const jsonResponse = (value: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });

const readFailure = <Value>(
  effect: Effect.Effect<Value, ProviderNeutralFailure>,
) => Effect.runPromise(Effect.flip(effect));

describe("real Wasender Directory adapter", () => {
  test("authenticates contacts with only the per-session credential and normalizes provider fields", async () => {
    const requests: Request[] = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
      requests.push(request);
      return jsonResponse(contactsDirectoryResponse);
    }) as unknown as typeof fetch;

    const directory = makeWasenderSessionDirectory({ authority, identityKey });
    const observation = await Effect.runPromise(directory.readContacts());

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://api.wapi.crafter.run/api/contacts?paginated=true&page=1&limit=100",
    );
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.headers.get("authorization")).toBe(
      `Bearer ${credential}`,
    );
    expect(observation).toMatchObject({
      completeness: "complete",
      stale: false,
      entries: [
        {
          active: true,
          displayName: "Ada",
          phoneNumber: "+15550199",
        },
        {
          active: true,
          displayName: "Grace",
          phoneNumber: null,
        },
      ],
    });
    expect(new Date(observation.observedAt).toISOString()).toBe(
      observation.observedAt,
    );
    expect(JSON.stringify(observation)).not.toContain(
      "15550199@s.whatsapp.net",
    );
    expect(JSON.stringify(observation)).not.toContain("98555123@lid");
    expect(JSON.stringify(observation)).not.toContain("provider.invalid");
    expect(observation.entries[0]?.identity).toMatch(
      /^wi1_[A-Za-z0-9_-]{43}$/u,
    );
    expect(observation.entries[0]?.recipient).toMatch(
      /^loc_v2_c_[A-Za-z0-9_-]+$/u,
    );
  });

  test("returns currently joined groups without provider identifiers or roster data", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(groupsDirectoryResponse)) as unknown as typeof fetch;

    const observation = await Effect.runPromise(
      makeWasenderSessionDirectory({ authority, identityKey }).readGroups(),
    );

    expect(observation).toMatchObject({
      completeness: "complete",
      entries: [
        {
          displayName: "Family",
          joined: true,
        },
      ],
      stale: false,
    });
    expect(JSON.stringify(observation)).not.toContain("@g.us");
    expect(JSON.stringify(observation)).not.toContain("provider.invalid");
    expect(observation.entries[0]?.identity).toMatch(/^wi1_/u);
    expect(observation.entries[0]?.recipient).toMatch(/^loc_v2_g_/u);
  });

  test("accepts a schema-valid empty Directory observation", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(emptyDirectoryResponse)) as unknown as typeof fetch;

    const observation = await Effect.runPromise(
      makeWasenderSessionDirectory({ authority, identityKey }).readContacts(),
    );

    expect(observation.entries).toEqual([]);
    expect(observation.completeness).toBe("complete");
    expect(observation.stale).toBe(false);
  });

  test("accepts the live contact identifier field", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        data: {
          items: [{ id: "15550199@s.whatsapp.net", notify: "Ada" }],
          pagination: { limit: 100, page: 1, total: 1, totalPages: 1 },
        },
        success: true,
      })) as unknown as typeof fetch;

    const observation = await Effect.runPromise(
      makeWasenderSessionDirectory({ authority, identityKey }).readContacts(),
    );

    expect(observation).toMatchObject({
      completeness: "complete",
      entries: [{ displayName: "Ada", phoneNumber: "+15550199" }],
      stale: false,
    });
  });

  test("keeps valid contacts from a mixed provider page as partial evidence", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        data: {
          items: [
            { jid: "15550199@s.whatsapp.net", name: "Ada" },
            { jid: "status@broadcast", name: null },
            { jid: 42, name: ["invalid"] },
          ],
          pagination: { limit: 100, page: 1, total: 3, totalPages: 1 },
        },
        success: true,
      })) as unknown as typeof fetch;

    const observation = await Effect.runPromise(
      makeWasenderSessionDirectory({ authority, identityKey }).readContacts(),
    );

    expect(observation).toMatchObject({
      completeness: "partial",
      entries: [{ displayName: "Ada", phoneNumber: "+15550199" }],
      stale: true,
    });
  });

  test("rejects an oversized first response before parsing it", async () => {
    globalThis.fetch = (async () =>
      new Response(largeDirectoryResponseBody, {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const failure = await readFailure(
      makeWasenderSessionDirectory({ authority, identityKey }).readContacts(),
    );

    expect(failure).toEqual({
      _tag: "ProviderNeutralFailure",
      code: "response_too_large",
      operation: "safe-read",
      retryAfterMs: null,
      retryDecision: "do_not_retry",
    });
  });

  test("fails closed on a malformed first provider page", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(malformedDirectoryResponse)) as unknown as typeof fetch;

    const failure = await readFailure(
      makeWasenderSessionDirectory({ authority, identityKey }).readContacts(),
    );

    expect(failure).toEqual({
      _tag: "ProviderNeutralFailure",
      code: "invalid_response",
      operation: "safe-read",
      retryAfterMs: null,
      retryDecision: "do_not_retry",
    });
  });

  test("honors bounded Retry-After and stops after three throttled attempts", async () => {
    Math.random = () => 0;
    let attempts = 0;
    globalThis.fetch = (async () => {
      const fixture = throttledDirectoryResponses[attempts];
      attempts += 1;
      return jsonResponse(
        { success: false, message: "provider text must not escape" },
        {
          headers: { "retry-after": fixture?.retryAfter ?? "0" },
          status: fixture?.status ?? 500,
        },
      );
    }) as unknown as typeof fetch;

    const failure = await readFailure(
      makeWasenderSessionDirectory({ authority, identityKey }).readContacts(),
    );

    expect(attempts).toBe(3);
    expect(failure).toMatchObject({
      _tag: "ProviderNeutralFailure",
      code: "throttled",
      operation: "safe-read",
      retryDecision: "retry_within_safe_read_budget",
    });
    expect(Number(failure.retryAfterMs)).toBe(5_000);
    expect(JSON.stringify(failure)).not.toContain("provider text");
  });

  test("retries a transiently unavailable safe read and emits content-free telemetry", async () => {
    Math.random = () => 0;
    let attempts = 0;
    const events: WasenderDirectoryTelemetryEvent[] = [];
    globalThis.fetch = (async () => {
      const fixture = transientDirectoryResponses[attempts];
      attempts += 1;
      return fixture?.status === 200
        ? jsonResponse(fixture.body)
        : jsonResponse(
            { message: "temporary provider detail" },
            { status: 503 },
          );
    }) as unknown as typeof fetch;

    const observation = await Effect.runPromise(
      makeWasenderSessionDirectory({
        authority,
        emitTelemetry: (event) => events.push(event),
        identityKey,
      }).readGroups(),
    );

    expect(observation.entries).toEqual([]);
    expect(attempts).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      attempts: 2,
      operation: "safe-read",
      outcome: "complete",
    });
    expect(JSON.stringify(events)).not.toContain(credential);
    expect(JSON.stringify(events)).not.toContain("temporary provider detail");
  });

  test("returns a stale partial observation when a later provider page is malformed", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return attempts === 1
        ? jsonResponse(paginatedContactsFirstPage)
        : jsonResponse(malformedDirectoryResponse);
    }) as unknown as typeof fetch;

    const observation = await Effect.runPromise(
      makeWasenderSessionDirectory({ authority, identityKey }).readContacts(),
    );

    expect(attempts).toBe(2);
    expect(observation).toMatchObject({
      completeness: "partial",
      entries: [
        {
          active: true,
          displayName: "Ada",
          phoneNumber: "+15550199",
        },
      ],
      stale: true,
    });
  });

  test("preserves an empty validated page as partial evidence", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return attempts === 1
        ? jsonResponse(emptyPaginatedContactsFirstPage)
        : jsonResponse(malformedDirectoryResponse);
    }) as unknown as typeof fetch;

    const observation = await Effect.runPromise(
      makeWasenderSessionDirectory({ authority, identityKey }).readContacts(),
    );

    expect(observation).toMatchObject({
      completeness: "partial",
      entries: [],
      stale: true,
    });
  });

  test("retries a transport failure while streaming a successful response", async () => {
    Math.random = () => 0;
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("transport detail must not escape"));
            },
          }),
          { status: 200 },
        );
      }
      return jsonResponse(emptyDirectoryResponse);
    }) as unknown as typeof fetch;

    const observation = await Effect.runPromise(
      makeWasenderSessionDirectory({ authority, identityKey }).readGroups(),
    );

    expect(attempts).toBe(2);
    expect(observation).toMatchObject({
      completeness: "complete",
      entries: [],
      stale: false,
    });
  });

  test("marks changing cross-page pagination evidence as partial", async () => {
    let attempts = 0;
    let rejectedPageAt = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 2) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        rejectedPageAt = Date.now();
      }
      return jsonResponse(
        attempts === 1
          ? paginatedContactsFirstPage
          : changedPaginatedContactsSecondPage,
      );
    }) as unknown as typeof fetch;

    const observation = await Effect.runPromise(
      makeWasenderSessionDirectory({ authority, identityKey }).readContacts(),
    );

    expect(observation).toMatchObject({
      completeness: "partial",
      entries: [{ displayName: "Ada" }],
      stale: true,
    });
    expect(Date.parse(observation.observedAt)).toBeLessThan(rejectedPageAt);
  });

  test("marks duplicate provider identities across pages as partial", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return jsonResponse(
        attempts === 1
          ? paginatedContactsFirstPage
          : duplicatePaginatedContactsSecondPage,
      );
    }) as unknown as typeof fetch;

    const observation = await Effect.runPromise(
      makeWasenderSessionDirectory({ authority, identityKey }).readContacts(),
    );

    expect(observation).toMatchObject({
      completeness: "partial",
      entries: [{ displayName: "Ada" }],
      stale: true,
    });
  });

  test("fails closed when the first page repeats a provider identity", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(duplicateContactsFirstPage)) as unknown as typeof fetch;

    const failure = await readFailure(
      makeWasenderSessionDirectory({ authority, identityKey }).readContacts(),
    );

    expect(failure).toMatchObject({
      code: "invalid_response",
      operation: "safe-read",
      retryDecision: "do_not_retry",
    });
  });

  test("uses the larger complete representation for the aggregate byte bound", async () => {
    const contactCount = 250;
    const baseNameLength = 3_000;
    const locatorLength = 67;
    const rawContacts = Array.from({ length: contactCount }, (_, index) => ({
      jid: String(100_000_000_000_000 + index),
      name: "x".repeat(baseNameLength),
    }));
    const expectedEntries = rawContacts.map((entry) => ({
      active: true,
      displayName: entry.name,
      identity: "x".repeat(47),
      phoneNumber: `+${entry.jid}`,
      recipient: "x".repeat(locatorLength),
    }));
    const observedAt = "2026-07-30T12:00:00.000Z";
    const partialBytes = new TextEncoder().encode(
      JSON.stringify({
        completeness: "partial",
        entries: expectedEntries,
        observedAt,
        stale: true,
      }),
    ).byteLength;
    let remainingBytes = 1_048_576 - partialBytes;
    expect(remainingBytes).toBeGreaterThan(0);
    for (
      let index = 0;
      index < rawContacts.length && remainingBytes > 0;
      index += 1
    ) {
      const contact = rawContacts[index];
      const entry = expectedEntries[index];
      if (contact === undefined || entry === undefined) {
        throw new Error("missing generated contact fixture");
      }
      const addedBytes = Math.min(4_096 - contact.name.length, remainingBytes);
      contact.name += "x".repeat(addedBytes);
      entry.displayName = contact.name;
      remainingBytes -= addedBytes;
    }
    expect(remainingBytes).toBe(0);

    const pages = [0, 100, 200].map((start, pageIndex) => ({
      success: true,
      data: {
        items: rawContacts.slice(start, start + 100),
        pagination: {
          total: contactCount,
          page: pageIndex + 1,
          limit: 100,
          totalPages: 3,
        },
      },
    }));
    expect(
      pages.reduce(
        (total, page) =>
          total + new TextEncoder().encode(JSON.stringify(page)).byteLength,
        0,
      ),
    ).toBeLessThanOrEqual(1_048_576);
    let attempts = 0;
    globalThis.fetch = (async () => {
      const page = pages[attempts];
      attempts += 1;
      return jsonResponse(page);
    }) as unknown as typeof fetch;

    const observation = await Effect.runPromise(
      makeWasenderSessionDirectory({ authority, identityKey }).readContacts(),
    );

    expect(observation.entries).toHaveLength(contactCount);
    expect(observation.completeness).toBe("partial");
    expect(observation.stale).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(observation)).byteLength,
    ).toBe(1_048_576);
  });

  test("rejects invalid session authority before any provider request", () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return jsonResponse(emptyDirectoryResponse);
    }) as unknown as typeof fetch;

    expect(() =>
      makeWasenderSessionDirectory({
        authority: Redacted.make("  ") as DirectorySessionAuthority,
        identityKey,
      }),
    ).toThrow("session authority");
    expect(requests).toBe(0);
  });
});
