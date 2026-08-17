import { Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  HumanIdentity,
  InvalidHumanIdentity,
} from "../src/auth/human-identity";
import { DeletionPrimitiveError } from "../src/deletion/marker";
import {
  ClerkIdentityAdministration,
  ClerkWebhookVerification,
  createPersonalAccountDeletionHandler,
  PersonalAccountDeletionPersistence,
} from "../src/personal-account-deletion";
import { RestoreSafeDeletion, SafeTelemetry } from "../src/services";

const browserOrigin = "https://app.example.test";
const clerkUserId = "user_2RfWKJREkjKbHZy0Wqa5qrHeAnb";

const makeHarness = (known = true, markerFails = false) => {
  const calls: Array<string> = [];
  let state: "active" | "deleting" = "active";
  const layer = Layer.mergeAll(
    Layer.succeed(HumanIdentity, {
      verify: (request) =>
        request.headers.get("authorization") === "Bearer valid"
          ? Effect.succeed(clerkUserId)
          : Effect.fail(new InvalidHumanIdentity()),
      verifyRecently: () => Effect.die("not used"),
    }),
    Layer.succeed(ClerkWebhookVerification, {
      verify: (request) =>
        request.headers.get("svix-signature") === "valid"
          ? Effect.succeed({ clerkUserId, type: "user.deleted" as const })
          : Effect.fail(new Error("invalid webhook")),
    }),
    Layer.succeed(ClerkIdentityAdministration, {
      deleteUser: () =>
        Effect.sync(() => {
          calls.push(`clerk:${state}`);
        }),
    }),
    Layer.succeed(PersonalAccountDeletionPersistence, {
      finish: () =>
        Effect.sync(() => {
          state = "deleting";
          calls.push("finish");
          return known;
        }),
      prepare: () =>
        known
          ? Effect.sync(() => {
              state = "deleting";
              calls.push("prepare");
              return {
                connectionPublicIds: [],
                personalAccountId: "10000000-0000-4000-8000-000000000001",
                requestedAt: "2026-08-03T00:00:00.000Z",
                state,
              };
            })
          : Effect.succeed(null),
    }),
    Layer.succeed(RestoreSafeDeletion, {
      capsules: { create: () => Effect.die("not used") },
      markers: {
        create: () =>
          markerFails
            ? Effect.fail(
                new DeletionPrimitiveError({ operation: "create-marker" }),
              )
            : Effect.sync(() => {
                calls.push("marker");
                return {
                  marker: {
                    deletionKind: "personal_account" as const,
                    keyUnavailableAt: "2026-08-03T00:00:00.000Z",
                    requestedAt: "2026-08-03T00:00:00.000Z",
                    version: 1 as const,
                  },
                  markerId: "a".repeat(64),
                  objectKey: `markers/v1/${"a".repeat(64)}.json`,
                };
              }),
        enumerate: () => Effect.die("not used"),
      },
    }),
    Layer.succeed(SafeTelemetry, { emit: () => Effect.void }),
  );
  return {
    calls,
    handler: createPersonalAccountDeletionHandler({
      browserOrigin,
      deleteConnection: () => Effect.void,
      layer,
      now: () => "2026-08-03T00:00:00.000Z",
    }),
    state: () => state,
  };
};

describe("Personal Account Deletion HTTP boundary", () => {
  test("durably enters deletion before deleting the Clerk identity", async () => {
    const harness = makeHarness();
    const response = await harness.handler(
      new Request("https://api.example.test/v1/personal-account", {
        headers: { authorization: "Bearer valid", origin: browserOrigin },
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      personal_account: { state: "deleting" },
    });
    expect(harness.calls).toEqual([
      "prepare",
      "marker",
      "finish",
      "clerk:deleting",
    ]);
  });

  test("verified Clerk deletion uses the same idempotent transition", async () => {
    const harness = makeHarness();
    const response = await harness.handler(
      new Request("https://api.example.test/v1/webhooks/clerk", {
        headers: { "svix-signature": "valid" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(204);
    expect(harness.calls).toEqual(["prepare", "marker", "finish"]);
  });

  test("replays product and Clerk entry points through the same prepare", async () => {
    const harness = makeHarness();
    const product = await harness.handler(
      new Request("https://api.example.test/v1/personal-account", {
        headers: { authorization: "Bearer valid", origin: browserOrigin },
        method: "DELETE",
      }),
    );
    const clerk = await harness.handler(
      new Request("https://api.example.test/v1/webhooks/clerk", {
        headers: { "svix-signature": "valid" },
        method: "POST",
      }),
    );

    expect(product.status).toBe(202);
    expect(clerk.status).toBe(204);
    expect(harness.calls).toEqual([
      "prepare",
      "marker",
      "finish",
      "clerk:deleting",
      "prepare",
      "marker",
      "finish",
    ]);
  });

  test("accepts a verified webhook for an unknown identity without creating an account", async () => {
    const harness = makeHarness(false);
    const response = await harness.handler(
      new Request("https://api.example.test/v1/webhooks/clerk", {
        headers: { "svix-signature": "valid" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(204);
    expect(harness.calls).toEqual([]);
  });

  test("keeps access terminal when restore-safe coordination must retry", async () => {
    const harness = makeHarness(true, true);
    const response = await harness.handler(
      new Request("https://api.example.test/v1/personal-account", {
        headers: { authorization: "Bearer valid", origin: browserOrigin },
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(503);
    expect(harness.state()).toBe("deleting");
    expect(harness.calls).toEqual(["prepare"]);
  });
});
