import { describe, expect, test, vi } from "vitest";
import { handleRequest } from "../src/index";

const token = "a".repeat(32);
const operation = `recovery_operation_${"b".repeat(32)}`;

const environment = (overrides: Partial<Env> = {}) =>
  ({
    RECOVERY_CONTROL_TOKEN: token,
    RECOVERY_GATE: {
      getByName: () => ({
        fetch: vi.fn(async () =>
          Response.json({ operation, status: "running" }, { status: 202 }),
        ),
      }),
    },
    RECOVERY_WORKFLOW: {
      get: vi.fn(async () => ({
        status: async () => ({ status: "running", rollback: null }),
      })),
    },
    ...overrides,
  }) as unknown as Env;

const call = (request: Request, env = environment()) =>
  handleRequest(request as never, env, {} as ExecutionContext);

describe("recovery control public boundary", () => {
  test("rejects missing credentials without consulting recovery state", async () => {
    const getByName = vi.fn();
    const env = environment({
      RECOVERY_GATE: { getByName } as unknown as Env["RECOVERY_GATE"],
    });
    const response = await call(
      new Request("https://recovery.example.test/drills", { method: "POST" }),
      env,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ status: "failed" });
    expect(getByName).not.toHaveBeenCalled();
  });

  test("starts an exact non-serving drill through the serialized gate", async () => {
    const gateFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ operation, status: "running" }, { status: 202 }),
    );
    const env = environment({
      RECOVERY_GATE: {
        getByName: () => ({ fetch: gateFetch }),
      } as unknown as Env["RECOVERY_GATE"],
    });
    const source = new Date(Date.now() - 3_600_000).toISOString();
    const response = await call(
      new Request("https://recovery.example.test/drills", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          drill: "weekly_restore",
          requested_source_point_at: source,
          serving: false,
        }),
      }),
      env,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ operation, status: "running" });
    expect(gateFetch).toHaveBeenCalledOnce();
    const forwarded = gateFetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(forwarded?.body))).toEqual({
      drill: "weekly_restore",
      requested_source_point_at: source,
      serving: false,
    });
  });

  test("rejects extra fields and serving restores", async () => {
    const response = await call(
      new Request("https://recovery.example.test/drills", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          drill: "weekly_restore",
          requested_source_point_at: new Date(
            Date.now() - 3_600_000,
          ).toISOString(),
          serving: true,
          tenant: "forbidden",
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: "failed" });
  });

  test("rejects plaintext ingress before starting recovery", async () => {
    const response = await call(
      new Request("http://recovery.example.test/drills", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          drill: "weekly_restore",
          requested_source_point_at: new Date(
            Date.now() - 3_600_000,
          ).toISOString(),
          serving: false,
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: "failed" });
  });

  test("returns only running, failed, or closed completion status", async () => {
    const evidence = { version: 1, serving: false };
    const env = environment({
      RECOVERY_WORKFLOW: {
        get: vi.fn(async () => ({
          status: async () => ({
            status: "complete",
            output: evidence,
            rollback: null,
          }),
        })),
      } as unknown as Workflow,
    });
    const response = await call(
      new Request(`https://recovery.example.test/drills/${operation}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "complete", evidence });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("does not expose workflow errors", async () => {
    const env = environment({
      RECOVERY_WORKFLOW: {
        get: vi.fn(async () => ({
          status: async () => ({
            status: "errored",
            error: { name: "Error", message: "credential leaked here" },
            rollback: null,
          }),
        })),
      } as unknown as Workflow,
    });
    const response = await call(
      new Request(`https://recovery.example.test/drills/${operation}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      env,
    );
    expect(await response.json()).toEqual({ status: "failed" });
  });
});
