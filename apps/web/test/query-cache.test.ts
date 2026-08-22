import { describe, expect, test } from "bun:test";
import {
  apiKeySummaryFromCreated,
  applyApiKeyRevocation,
  applyRecipientExclusion,
  upsertApiKey,
} from "../src/lib/query/resources";

const created = {
  connection_ids: ["con_123456789012345678901"],
  created_at: "2026-08-14T12:00:00.000Z",
  credential:
    "normal_apk_123456789012345678901.abcdefghijklmnopqrstuvwxyz0123456789ABC",
  credential_hint: "normal_apk_123456789012345678901.…9ABC",
  expires_at: null,
  id: "apk_123456789012345678901",
  last_used_at: null,
  name: "CI",
  permissions: ["connections:read"] as const,
  revoked_at: null,
  state: "active" as const,
};

describe("personal-account query cache", () => {
  test("adds a created API Key to the list without waiting for a refetch", () => {
    const next = upsertApiKey([], apiKeySummaryFromCreated(created));
    expect(next).toEqual([
      {
        connection_ids: created.connection_ids,
        created_at: created.created_at,
        credential_hint: created.credential_hint,
        expires_at: null,
        id: created.id,
        last_used_at: null,
        name: "CI",
        permissions: ["connections:read"],
        revoked_at: null,
        state: "active",
      },
    ]);
    expect(JSON.stringify(next)).not.toContain(created.credential);
  });

  test("replaces an existing API Key with the same handle", () => {
    const current = upsertApiKey([], apiKeySummaryFromCreated(created));
    const replaced = upsertApiKey(current, {
      ...apiKeySummaryFromCreated(created),
      name: "CI rotated",
    });
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.name).toBe("CI rotated");
  });

  test("applies revocation from the mutation response", () => {
    const current = upsertApiKey([], apiKeySummaryFromCreated(created));
    expect(
      applyApiKeyRevocation(current, {
        id: created.id,
        revoked_at: "2026-08-14T12:05:00.000Z",
        state: "revoked",
      }),
    ).toEqual([
      {
        ...apiKeySummaryFromCreated(created),
        revoked_at: "2026-08-14T12:05:00.000Z",
        state: "revoked",
      },
    ]);
  });

  test("updates a recipient exclusion without dropping the current page", () => {
    const pages = applyRecipientExclusion(
      [
        {
          directory: {
            asOf: "2026-08-14T12:00:00.000Z",
            partial: false,
            stale: false,
          },
          nextCursor: null,
          recipients: [
            {
              displayName: "Ada",
              excluded: false,
              id: "ctc_123456789012345678901",
              kind: "contact",
              phoneLastFour: "1234",
            },
          ],
        },
      ],
      "ctc_123456789012345678901",
      true,
    );
    expect(pages?.[0]?.recipients[0]?.excluded).toBe(true);
  });
});
