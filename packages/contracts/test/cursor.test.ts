import { describe, expect, test } from "bun:test";
import { Effect, Encoding, Schema } from "effect";
import {
  type CursorContext,
  InvalidCursorError,
  importCursorSigningKey,
  type RestCursorContext,
  signCursor,
  signRestCursor,
  verifyCursor,
  verifyRestCursor,
} from "../src/cursor";
import { ConnectionId } from "../src/handles";

const connectionId = Schema.decodeUnknownSync(ConnectionId)(
  "con_123456789012345678901",
);
const secret = new TextEncoder().encode("0123456789abcdef0123456789abcdef");

const context: CursorContext = {
  authorizationId: "authorization-a",
  tool: "list_contacts",
  connectionId,
  filters: {
    search: "+12025550199",
    include_removed: false,
  },
  pageSize: 20,
  sortVersion: "contacts-v1",
};

const expiresAtEpochSeconds = 1_785_417_660;
const nowEpochSeconds = expiresAtEpochSeconds - 60;

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const runError = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flip(effect));

describe("authorization-bound cursors", () => {
  test("round trips the boundary without exposing bound authorization or filters", async () => {
    const key = await run(importCursorSigningKey(secret));
    const cursor = await run(
      signCursor(key, {
        context,
        boundary: ["ada", "ctc_123456789012345678901"],
        expiresAtEpochSeconds,
      }),
    );
    const boundary = await run(
      verifyCursor(key, cursor, context, nowEpochSeconds),
    );

    expect(boundary).toEqual(["ada", "ctc_123456789012345678901"]);

    const [encodedPayload] = cursor.split(".");
    const payload = Encoding.decodeBase64UrlString(encodedPayload ?? "");
    const serializedPayload =
      payload._tag === "Right" ? payload.right : "decode failed";
    expect(serializedPayload).not.toContain(context.authorizationId);
    expect(serializedPayload).not.toContain("+12025550199");
  });

  test("canonicalizes normalized filter keys before signing", async () => {
    const key = await run(importCursorSigningKey(secret));
    const cursor = await run(
      signCursor(key, {
        context,
        boundary: ["ada", "ctc_123456789012345678901"],
        expiresAtEpochSeconds,
      }),
    );
    const reorderedContext: CursorContext = {
      ...context,
      filters: {
        include_removed: false,
        search: "+12025550199",
      },
    };

    expect(
      await run(verifyCursor(key, cursor, reorderedContext, nowEpochSeconds)),
    ).toEqual(["ada", "ctc_123456789012345678901"]);
  });

  test("uses a total order for canonically distinct Unicode filter keys", async () => {
    const key = await run(importCursorSigningKey(secret));
    const unicodeContext: CursorContext = {
      ...context,
      filters: {
        é: 1,
        "e\u0301": 2,
      },
    };
    const cursor = await run(
      signCursor(key, {
        context: unicodeContext,
        boundary: ["ada", "ctc_123456789012345678901"],
        expiresAtEpochSeconds,
      }),
    );
    const reorderedContext: CursorContext = {
      ...context,
      filters: {
        "e\u0301": 2,
        é: 1,
      },
    };

    expect(
      await run(verifyCursor(key, cursor, reorderedContext, nowEpochSeconds)),
    ).toEqual(["ada", "ctc_123456789012345678901"]);
  });

  test("rejects every changed authorization-bound context field", async () => {
    const key = await run(importCursorSigningKey(secret));
    const cursor = await run(
      signCursor(key, {
        context,
        boundary: ["ada", "ctc_123456789012345678901"],
        expiresAtEpochSeconds,
      }),
    );
    const changedContexts: ReadonlyArray<CursorContext> = [
      { ...context, authorizationId: "authorization-b" },
      { ...context, tool: "list_groups" },
      {
        ...context,
        connectionId: Schema.decodeUnknownSync(ConnectionId)(
          "con_ABCDEFGHIJKLMNO123456",
        ),
      },
      { ...context, filters: { ...context.filters, search: "Ada" } },
      { ...context, pageSize: 50 },
      { ...context, sortVersion: "contacts-v2" },
    ];

    for (const changed of changedContexts) {
      expect(
        await runError(verifyCursor(key, cursor, changed, nowEpochSeconds)),
      ).toBeInstanceOf(InvalidCursorError);
    }
  });

  test("rejects expiry, tampering, malformed data, and another signing key alike", async () => {
    const key = await run(importCursorSigningKey(secret));
    const otherKey = await run(
      importCursorSigningKey(
        new TextEncoder().encode("abcdef0123456789abcdef0123456789"),
      ),
    );
    const cursor = await run(
      signCursor(key, {
        context,
        boundary: ["ada", "ctc_123456789012345678901"],
        expiresAtEpochSeconds,
      }),
    );
    const tampered = `${cursor.slice(0, -1)}${
      cursor.endsWith("a") ? "b" : "a"
    }`;

    for (const attempt of [
      verifyCursor(key, cursor, context, expiresAtEpochSeconds),
      verifyCursor(key, tampered, context, nowEpochSeconds),
      verifyCursor(key, "not-a-cursor", context, nowEpochSeconds),
      verifyCursor(otherKey, cursor, context, nowEpochSeconds),
    ]) {
      expect(await runError(attempt)).toBeInstanceOf(InvalidCursorError);
    }
  });

  test("rejects signing keys shorter than 256 bits", async () => {
    expect(
      await runError(
        importCursorSigningKey(new TextEncoder().encode("too-short")),
      ),
    ).toMatchObject({
      _tag: "CursorSigningError",
    });
  });

  test("rejects non-finite filter and boundary numbers before JSON canonicalization", async () => {
    const key = await run(importCursorSigningKey(secret));
    const invalidClaims = [
      {
        context: {
          ...context,
          filters: {
            score: Number.NaN,
          },
        },
        boundary: ["ada", "ctc_123456789012345678901"],
        expiresAtEpochSeconds,
      },
      {
        context,
        boundary: [Number.POSITIVE_INFINITY],
        expiresAtEpochSeconds,
      },
    ];

    for (const claims of invalidClaims) {
      expect(await runError(signCursor(key, claims))).toMatchObject({
        _tag: "CursorSigningError",
      });
    }
  });
});

const restContext: RestCursorContext = {
  grantId: "60000000-0000-4000-8000-000000000081",
  operationId: "listContacts",
  connectionId,
  filters: {
    search: "+12025550199",
  },
  pageSize: 20,
  sortVersion: "contacts-v1",
};

describe("REST authorization-bound cursors", () => {
  test("round trips a REST boundary without exposing the grant or search", async () => {
    const key = await run(importCursorSigningKey(secret));
    const cursor = await run(
      signRestCursor(key, {
        context: restContext,
        boundary: ["ada", "ctc_123456789012345678901"],
        expiresAtEpochSeconds,
      }),
    );
    const boundary = await run(
      verifyRestCursor(key, cursor, restContext, nowEpochSeconds),
    );

    expect(boundary).toEqual(["ada", "ctc_123456789012345678901"]);
    const [encodedPayload] = cursor.split(".");
    const payload = Encoding.decodeBase64UrlString(encodedPayload ?? "");
    const serializedPayload =
      payload._tag === "Right" ? payload.right : "decode failed";
    expect(serializedPayload).not.toContain(restContext.grantId);
    expect(serializedPayload).not.toContain("+12025550199");
  });

  test("rejects MCP cursors, parameter changes, expiry, and another grant", async () => {
    const key = await run(importCursorSigningKey(secret));
    const restCursor = await run(
      signRestCursor(key, {
        context: restContext,
        boundary: ["ada", "ctc_123456789012345678901"],
        expiresAtEpochSeconds,
      }),
    );
    const mcpCursor = await run(
      signCursor(key, {
        context,
        boundary: ["ada", "ctc_123456789012345678901"],
        expiresAtEpochSeconds,
      }),
    );

    expect(
      await runError(
        verifyRestCursor(key, mcpCursor, restContext, nowEpochSeconds),
      ),
    ).toBeInstanceOf(InvalidCursorError);
    expect(
      await runError(verifyCursor(key, restCursor, context, nowEpochSeconds)),
    ).toBeInstanceOf(InvalidCursorError);
    expect(
      await runError(
        verifyRestCursor(
          key,
          restCursor,
          { ...restContext, grantId: "60000000-0000-4000-8000-000000000082" },
          nowEpochSeconds,
        ),
      ),
    ).toBeInstanceOf(InvalidCursorError);
    expect(
      await runError(
        verifyRestCursor(
          key,
          restCursor,
          {
            ...restContext,
            connectionId: Schema.decodeUnknownSync(ConnectionId)(
              "con_ABCDEFGHIJKLMNO123456",
            ),
          },
          nowEpochSeconds,
        ),
      ),
    ).toBeInstanceOf(InvalidCursorError);
    expect(
      await runError(
        verifyRestCursor(
          key,
          restCursor,
          { ...restContext, filters: { search: "Ada" } },
          nowEpochSeconds,
        ),
      ),
    ).toBeInstanceOf(InvalidCursorError);
    expect(
      await runError(
        verifyRestCursor(key, restCursor, restContext, expiresAtEpochSeconds),
      ),
    ).toBeInstanceOf(InvalidCursorError);
    expect(
      await runError(
        verifyRestCursor(
          key,
          restCursor,
          { ...restContext, pageSize: 50 },
          nowEpochSeconds,
        ),
      ),
    ).toBeInstanceOf(InvalidCursorError);
    expect(
      await runError(
        verifyRestCursor(
          key,
          restCursor,
          { ...restContext, sortVersion: "contacts-v2" },
          nowEpochSeconds,
        ),
      ),
    ).toBeInstanceOf(InvalidCursorError);
    expect(
      await runError(
        verifyRestCursor(
          key,
          restCursor,
          { ...restContext, operationId: "listConversations" },
          nowEpochSeconds,
        ),
      ),
    ).toBeInstanceOf(InvalidCursorError);
    expect(
      await runError(
        verifyRestCursor(
          key,
          restCursor,
          { ...restContext, operationId: "listGroups" },
          nowEpochSeconds,
        ),
      ),
    ).toBeInstanceOf(InvalidCursorError);
    const tampered = `${restCursor.slice(0, -1)}${
      restCursor.endsWith("a") ? "b" : "a"
    }`;
    expect(
      await runError(
        verifyRestCursor(key, tampered, restContext, nowEpochSeconds),
      ),
    ).toBeInstanceOf(InvalidCursorError);
  });

  test("binds a groups cursor to listGroups and rejects contact interchange", async () => {
    const key = await run(importCursorSigningKey(secret));
    const groupsContext = {
      ...restContext,
      filters: { search: "fam" },
      operationId: "listGroups",
      sortVersion: "groups-v1",
    };
    const groupsCursor = await run(
      signRestCursor(key, {
        context: groupsContext,
        boundary: ["family", "grp_123456789012345678901"],
        expiresAtEpochSeconds,
      }),
    );
    const contactsCursor = await run(
      signRestCursor(key, {
        context: restContext,
        boundary: ["ada", "ctc_123456789012345678901"],
        expiresAtEpochSeconds,
      }),
    );
    expect(
      await run(
        verifyRestCursor(key, groupsCursor, groupsContext, nowEpochSeconds),
      ),
    ).toEqual(["family", "grp_123456789012345678901"]);
    expect(
      await runError(
        verifyRestCursor(key, groupsCursor, restContext, nowEpochSeconds),
      ),
    ).toBeInstanceOf(InvalidCursorError);
    expect(
      await runError(
        verifyRestCursor(key, contactsCursor, groupsContext, nowEpochSeconds),
      ),
    ).toBeInstanceOf(InvalidCursorError);
  });

  test("binds a search cursor to the keyed query digest and never encodes terms", async () => {
    const key = await run(importCursorSigningKey(secret));
    const searchContext = {
      ...restContext,
      filters: {
        conversation_id: null,
        direction: "all",
        index_version: "v1",
        query_digest: "keyed-query-digest",
      },
      operationId: "searchMessages",
      pageSize: 20,
      sortVersion: "message-search-sent-v1",
    };
    const cursor = await run(
      signRestCursor(key, {
        boundary: ["2026-08-14T11:58:00.000Z", "msg_123456789012345678901"],
        context: searchContext,
        expiresAtEpochSeconds,
      }),
    );
    expect(
      await run(verifyRestCursor(key, cursor, searchContext, nowEpochSeconds)),
    ).toEqual(["2026-08-14T11:58:00.000Z", "msg_123456789012345678901"]);
    const [encodedPayload] = cursor.split(".");
    const payload = Encoding.decodeBase64UrlString(encodedPayload ?? "");
    const serializedPayload =
      payload._tag === "Right" ? payload.right : "decode failed";
    expect(serializedPayload).not.toContain("invoice");
    expect(serializedPayload).not.toContain("confirmation");
    expect(serializedPayload).not.toContain("keyed-query-digest");
    expect(
      await runError(
        verifyRestCursor(
          key,
          cursor,
          {
            ...searchContext,
            filters: {
              ...searchContext.filters,
              query_digest: "other-digest",
            },
          },
          nowEpochSeconds,
        ),
      ),
    ).toBeInstanceOf(InvalidCursorError);
    expect(
      await runError(
        verifyRestCursor(key, cursor, restContext, nowEpochSeconds),
      ),
    ).toBeInstanceOf(InvalidCursorError);
  });
});
