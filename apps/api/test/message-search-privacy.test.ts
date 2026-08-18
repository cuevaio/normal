import { importCursorSigningKey } from "@whatsapp-mcp/contracts/cursor";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import {
  importMessageSearchIndexKey,
  messageSearchIndexesForQuery,
  messageSearchIndexesForText,
  messageSearchQueryDigest,
  tokenizeMessageSearchText,
  validateMessageSearchQuery,
  verifyMessageSearchCandidate,
} from "../src/message-search-privacy";

const connectionId = "20000000-0000-4000-8000-000000000041";

describe("Stored Message search privacy", () => {
  test("pins v1 normalization, boundaries, deduplication, and term order", () => {
    expect(
      tokenizeMessageSearchText(
        "  INVOICE, invoice Ｆｌｉｇｈｔ e\u0301lan 42 ✈ ",
      ),
    ).toEqual(["42", "flight", "invoice", "élan"]);
    expect(tokenizeMessageSearchText("voice/invoice running-run")).toEqual([
      "invoice",
      "run",
      "running",
      "voice",
    ]);
  });

  test("validates scalar and unique-term query bounds", () => {
    expect(validateMessageSearchQuery("one ONE, two").terms).toEqual([
      "one",
      "two",
    ]);
    expect(validateMessageSearchQuery("a".repeat(256)).terms).toEqual([
      "a".repeat(256),
    ]);
    expect(() => validateMessageSearchQuery("a".repeat(257))).toThrow();
    expect(() =>
      validateMessageSearchQuery(
        "one two three four five six seven eight nine",
      ),
    ).toThrow();
    expect(() => validateMessageSearchQuery(" ✈ ")).toThrow();
    expect(() => validateMessageSearchQuery("\ud800")).toThrow();
  });

  test("creates full deterministic connection-bound HMAC indexes", async () => {
    const key = await Effect.runPromise(
      importMessageSearchIndexKey(new Uint8Array(32).fill(41)),
    );
    const query = validateMessageSearchQuery("invoice flight invoice");
    const indexes = await Effect.runPromise(
      messageSearchIndexesForQuery(key, connectionId, query),
    );
    const fromText = await Effect.runPromise(
      messageSearchIndexesForText(key, connectionId, "FLIGHT, invoice."),
    );
    const otherConnection = await Effect.runPromise(
      messageSearchIndexesForQuery(
        key,
        "20000000-0000-4000-8000-000000000042",
        query,
      ),
    );

    expect(indexes).toEqual([
      "msi1_xhowjU_xNMgppwUcfm2NcyAd8PixY5oPhKNAKvjyIyM",
      "msi1_zmNnds6_pVyfbuTc8sl7NDFhjN1uTmwNojqex_P4KSQ",
    ]);
    expect(fromText).toEqual(indexes);
    expect(otherConnection).not.toEqual(indexes);
    expect(
      indexes.every((index) => /^msi1_[A-Za-z0-9_-]{43}$/u.test(index)),
    ).toBe(true);
    expect(JSON.stringify(indexes)).not.toContain("invoice");
  });

  test("verifies every exact query word against candidate plaintext", () => {
    const query = validateMessageSearchQuery("flight invoice");
    expect(
      verifyMessageSearchCandidate("INVOICE: your flight is confirmed", query),
    ).toBe(true);
    expect(verifyMessageSearchCandidate("invoice only", query)).toBe(false);
    expect(
      verifyMessageSearchCandidate(
        "invoices include preflight information",
        query,
      ),
    ).toBe(false);
    expect(verifyMessageSearchCandidate("flight invoice\ud800", query)).toBe(
      false,
    );
    expect(
      verifyMessageSearchCandidate("anything", {
        indexVersion: "v1",
        terms: [],
      }),
    ).toBe(false);
  });

  test("rejects invalid key and Connection inputs", async () => {
    await expect(
      Effect.runPromise(importMessageSearchIndexKey(new Uint8Array(31))),
    ).rejects.toBeDefined();
    const key = await Effect.runPromise(
      importMessageSearchIndexKey(new Uint8Array(32).fill(41)),
    );
    await expect(
      Effect.runPromise(
        messageSearchIndexesForQuery(
          key,
          "not-a-connection-id",
          validateMessageSearchQuery("invoice"),
        ),
      ),
    ).rejects.toBeDefined();
  });

  test("binds a domain-separated digest that does not contain query terms", async () => {
    const key = await Effect.runPromise(
      importCursorSigningKey(new Uint8Array(32).fill(19)),
    );
    const query = validateMessageSearchQuery("invoice confirmation");
    const digest = await Effect.runPromise(
      messageSearchQueryDigest(key, query.terms),
    );
    expect(digest).toMatch(/^[A-Za-z0-9+/]+=*$/u);
    expect(digest).not.toContain("invoice");
    expect(digest).not.toContain("confirmation");
    const other = await Effect.runPromise(
      messageSearchQueryDigest(
        key,
        validateMessageSearchQuery("different").terms,
      ),
    );
    expect(other).not.toEqual(digest);
  });
});
