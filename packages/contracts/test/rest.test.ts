import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { openApiDocument, restRouteRegistry } from "../src/openapi";
import {
  decodeProblemDetails,
  decodeRestConnectionList,
  ProblemDetailsContract,
  problemType,
  RestConnectionListContract,
} from "../src/rest";

const connectionId = "con_xxxxxxxxxxxxxxxxxxxxx";

const validList = {
  data: [
    {
      connection_id: connectionId,
      display_name: "Personal WhatsApp",
      number_last_four: "0000",
      state: "connected",
      state_changed_at: "2026-08-14T12:00:00.000Z",
    },
  ],
  pagination: {
    has_more: false,
    next_cursor: null,
  },
} as const;

describe("REST contracts", () => {
  test("rejects excess collection properties and cross-type handles", () => {
    expect(decodeRestConnectionList(validList) as unknown).toEqual(validList);
    expect(() =>
      decodeRestConnectionList({
        ...validList,
        meta: { secret: "do-not-accept" },
      }),
    ).toThrow();
    expect(() =>
      decodeRestConnectionList({
        ...validList,
        data: [
          {
            ...validList.data[0],
            connection_id: "apk_123456789012345678901",
          },
        ],
      }),
    ).toThrow();
  });

  test("keeps Problem Details closed and snake_case", () => {
    const problem = {
      code: "invalid_credentials",
      detail: "The API Key is missing, malformed, expired, or revoked.",
      status: 401,
      title: "Invalid credentials",
      type: problemType("invalid_credentials"),
    } as const;
    expect(decodeProblemDetails(problem) as unknown).toEqual(problem);
    expect(() =>
      decodeProblemDetails({
        ...problem,
        authorization: "Bearer secret",
      }),
    ).toThrow();
    expect(
      Schema.encodeSync(ProblemDetailsContract.schema)(
        decodeProblemDetails(problem),
      ),
    ).toMatchObject({
      code: "invalid_credentials",
      status: 401,
    });
  });

  test("generates a partial OpenAPI 3.1 document with stable operation IDs", () => {
    expect(openApiDocument.openapi).toBe("3.1.0");
    expect(restRouteRegistry).toEqual([
      expect.objectContaining({
        method: "GET",
        operationId: "listConnections",
        path: "/v1/connections",
        permission: "connections:read",
      }),
    ]);
    const serialized = JSON.stringify(openApiDocument);
    expect(serialized).toContain('"operationId":"listConnections"');
    expect(serialized).toContain('"type":"http"');
    expect(serialized).toContain('"scheme":"bearer"');
    expect(serialized).toContain("con_xxxxxxxxxxxxxxxxxxxxx");
    expect(serialized).not.toMatch(
      /normal_apk_[A-Za-z0-9_-]{21}\.[A-Za-z0-9_-]+/u,
    );
    expect(
      (openApiDocument.components as { schemas: Record<string, unknown> })
        .schemas.ConnectionList,
    ).toEqual(RestConnectionListContract.jsonSchema);
  });
});
