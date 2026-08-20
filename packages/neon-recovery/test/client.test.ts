import { describe, expect, test } from "bun:test";
import {
  createNeonRecoveryClient,
  NeonRecoveryError,
  type RecoveryBranch,
} from "../src/client";

const projectId = "quiet-river-123456";
const parentId = "br-parent-123456";
const branchId = "br-recovery-123456";
const timestamp = "2026-08-17T12:00:00.000Z";
const branchName = "recovery/weekly-2026-08";
const time = "2026-08-18T12:00:00Z";
const recoveryAnnotation = `true:${parentId}:${timestamp}`;

const branch = (overrides: Record<string, unknown> = {}) => ({
  id: branchId,
  project_id: projectId,
  parent_id: parentId,
  parent_lsn: "0/1964D68",
  parent_timestamp: timestamp,
  name: branchName,
  current_state: "ready",
  state_changed_at: time,
  creation_source: "api",
  primary: false,
  default: false,
  protected: false,
  cpu_used_sec: 0,
  compute_time_seconds: 0,
  active_time_seconds: 0,
  written_data_bytes: 0,
  data_transfer_bytes: 0,
  created_at: time,
  updated_at: time,
  init_source: "parent-data",
  ...overrides,
});

const annotation = (overrides: Record<string, unknown> = {}) => ({
  object: { type: "console/branch", id: branchId },
  value: { "production-recovery": recoveryAnnotation },
  created_at: time,
  updated_at: time,
  ...overrides,
});

const operation = (
  status: "running" | "finished",
  action = "create_branch",
) => ({
  id: "00000000-0000-4000-8000-000000000001",
  project_id: projectId,
  branch_id: branchId,
  action,
  status,
  failures_count: 0,
  created_at: time,
  updated_at: time,
  total_duration_ms: status === "finished" ? 10 : 0,
});

const endpoint = (
  id = "ep-recovery-123456",
  host = "ep-recovery.us-east-1.aws.neon.tech",
) => ({
  host,
  id,
  project_id: projectId,
  branch_id: branchId,
  region_id: "aws-us-east-1",
  type: "read_write",
  current_state: "idle",
  settings: {},
  pooler_enabled: false,
  disabled: false,
  passwordless_access: false,
  created_at: time,
  updated_at: time,
});

const json = (value: unknown, status = 200) => Response.json(value, { status });
const config = (
  polling = { maxAttempts: 4, intervalMs: 10, timeoutMs: 1_000 },
) => ({
  apiKey: "neon-secret-control-plane-key",
  projectId,
  parentBranchId: parentId,
  branchNamePrefix: "recovery/",
  databaseName: "normal",
  polling,
});
const expected: RecoveryBranch = {
  id: branchId,
  name: branchName,
  parentId,
  parentTimestamp: timestamp,
};

describe("Neon recovery control-plane client", () => {
  test("reconciles an existing exact PITR child without mutating it", async () => {
    const calls: string[] = [];
    const client = createNeonRecoveryClient(config(), {
      now: () => Date.parse(time),
      fetch: async (input, init) => {
        calls.push(`${init?.method} ${input}`);
        return json({
          branches: [branch({ parent_timestamp: undefined })],
          annotations: { [branchId]: annotation() },
          pagination: { sort_by: "updated_at", sort_order: "DESC" },
        });
      },
    });

    await expect(
      client.reconcilePitrBranch({
        name: branchName,
        parentTimestamp: timestamp,
      }),
    ).resolves.toEqual(expected);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(
      "GET https://console.neon.tech/api/v2/projects/",
    );
  });

  test("accepts only backward Neon PITR normalization within the recovery objective", async () => {
    const reconcile = (parentTimestamp: string) =>
      createNeonRecoveryClient(config(), {
        now: () => Date.parse(time),
        fetch: async () =>
          json({
            branches: [branch({ parent_timestamp: parentTimestamp })],
            annotations: { [branchId]: annotation() },
            pagination: { sort_by: "updated_at", sort_order: "DESC" },
          }),
      }).reconcilePitrBranch({ name: branchName, parentTimestamp: timestamp });

    await expect(reconcile("2026-08-17T11:59:55.975Z")).resolves.toEqual(
      expected,
    );
    await expect(reconcile("2026-08-17T12:00:00.001Z")).rejects.toThrow(
      "parent_timestamp:1ms",
    );
    await expect(reconcile("2026-08-17T11:54:59.999Z")).rejects.toThrow(
      "parent_timestamp:-300001ms",
    );
  });

  test("finds an old exact child for cleanup without creating it", async () => {
    const methods: string[] = [];
    const client = createNeonRecoveryClient(config(), {
      now: () => Date.parse("2026-09-18T12:00:00.000Z"),
      fetch: async (_input, init) => {
        methods.push(String(init?.method));
        return json({
          branches: [branch()],
          annotations: { [branchId]: annotation() },
          pagination: { sort_by: "created_at", sort_order: "desc" },
        });
      },
    });
    await expect(
      client.findGuardedPitrBranch({
        name: branchName,
        parentTimestamp: timestamp,
      }),
    ).resolves.toEqual(expected);
    expect(methods).toEqual(["GET"]);
  });

  test("rotates the exact disposable branch endpoint", async () => {
    const predecessor = endpoint();
    const replacement = endpoint(
      "ep-replacement-123456",
      "ep-replacement.us-east-1.aws.neon.tech",
    );
    const responses = [
      json({ branch: branch(), annotation: annotation() }),
      json({ endpoints: [predecessor] }),
      json({ endpoint: predecessor, operations: [] }),
      json({ endpoints: [] }),
      json({ endpoint: replacement, operations: [] }, 201),
      json({ endpoints: [replacement] }),
    ];
    const methods: string[] = [];
    const client = createNeonRecoveryClient(config(), {
      fetch: async (_input, init) => {
        methods.push(String(init?.method));
        const response = responses.shift();
        if (!response) throw new Error("unexpected request");
        return response;
      },
    });

    await expect(client.rotateGuardedEndpoint(expected)).resolves.toEqual({
      predecessorEndpointId: predecessor.id,
      replacementEndpointId: replacement.id,
    });
    expect(methods).toEqual(["GET", "GET", "DELETE", "GET", "POST", "GET"]);
  });

  test("creates the exact child, polls its operations, and verifies fresh identity", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      json({
        branches: [],
        annotations: {},
        pagination: { sort_by: "updated_at", sort_order: "DESC" },
      }),
      json(
        {
          branch: branch({
            current_state: "init",
            pending_state: "ready",
            parent_timestamp: undefined,
          }),
          endpoints: [
            {
              host: "ep-recovery.us-east-1.aws.neon.tech",
              id: "ep-recovery-123456",
              project_id: projectId,
              branch_id: branchId,
              region_id: "aws-us-east-1",
              type: "read_write",
              current_state: "init",
              pending_state: "active",
              settings: { pg_settings: {} },
              pooler_enabled: false,
              disabled: false,
              passwordless_access: false,
              created_at: time,
              updated_at: time,
            },
          ],
          operations: [operation("running")],
          connection_uris: [],
          current_api_addition: true,
        },
        201,
      ),
      json({ code: "temporarily_unavailable", message: "retry" }, 503),
      json({ operation: operation("finished"), current_api_addition: true }),
      json({
        branch: branch({
          parent_timestamp: undefined,
          restricted_actions: [],
        }),
        annotation: annotation(),
      }),
    ];
    const sleeps: number[] = [];
    const client = createNeonRecoveryClient(config(), {
      now: () => Date.parse(time),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        const response = responses.shift();
        if (!response) throw new Error("unexpected request");
        return response;
      },
    });

    await expect(
      client.reconcilePitrBranch({
        name: branchName,
        parentTimestamp: timestamp,
      }),
    ).resolves.toEqual(expected);
    expect(sleeps).toEqual([10, 10]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      branch: {
        name: branchName,
        parent_id: parentId,
        parent_timestamp: timestamp,
        protected: false,
        init_source: "parent-data",
      },
      endpoints: [{ type: "read_write" }],
      annotation_value: { "production-recovery": recoveryAnnotation },
    });
    expect(requests[2]?.url).toContain(
      "/operations/00000000-0000-4000-8000-000000000001",
    );
    expect(requests[3]?.url).toContain(
      "/operations/00000000-0000-4000-8000-000000000001",
    );
  });

  test("resets only the restore role and returns a direct TLS URI", async () => {
    const requests: string[] = [];
    const responses = [
      json({ branch: branch(), annotation: annotation() }),
      json({
        role: {
          branch_id: branchId,
          name: "whatsapp_restore_runtime",
          password: "new-secret",
          protected: false,
          authentication_method: "password",
          created_at: time,
          updated_at: time,
        },
        operations: [],
      }),
      json({ branch: branch(), annotation: annotation() }),
      json({
        uri: "postgresql://whatsapp_restore_runtime:new-secret@ep-recovery.us-east-1.aws.neon.tech/normal?sslmode=require",
      }),
    ];
    const client = createNeonRecoveryClient(config(), {
      fetch: async (input) => {
        requests.push(String(input));
        return responses.shift() ?? json({}, 500);
      },
    });

    await expect(
      client.resetRestoreRuntimePassword(expected),
    ).resolves.toBeUndefined();
    await expect(client.getDirectRestoreUri(expected)).resolves.toContain(
      "postgresql://whatsapp_restore_runtime:",
    );
    expect(requests[1]).toEndWith(
      `/branches/${branchId}/roles/whatsapp_restore_runtime/reset_password`,
    );
    expect(requests[3]).toContain("pooled=false");
  });

  test("uses the migration owner only for the guarded recovery branch", async () => {
    const requests: string[] = [];
    const responses = [
      json({ branch: branch(), annotation: annotation() }),
      json({
        role: {
          branch_id: branchId,
          name: "whatsapp_migration_owner",
          password: "migration-secret",
          created_at: time,
          updated_at: time,
        },
        operations: [],
      }),
      json({ branch: branch(), annotation: annotation() }),
      json({
        uri: "postgresql://whatsapp_migration_owner:migration-secret@ep-recovery.us-east-1.aws.neon.tech/normal?sslmode=require",
      }),
    ];
    const client = createNeonRecoveryClient(config(), {
      fetch: async (input) => {
        requests.push(String(input));
        return responses.shift() ?? json({}, 500);
      },
    });

    await client.resetMigrationOwnerPassword(expected);
    await expect(client.getDirectMigrationUri(expected)).resolves.toContain(
      "postgresql://whatsapp_migration_owner:",
    );
    expect(requests[1]).toEndWith(
      `/branches/${branchId}/roles/whatsapp_migration_owner/reset_password`,
    );
    expect(requests[3]).toContain("role_name=whatsapp_migration_owner");
  });

  test("reconciles the exact child before retrying an ambiguous role reset", async () => {
    const methods: string[] = [];
    const responses: Array<Response | Error> = [
      json({ branch: branch(), annotation: annotation() }),
      new Error("reset response lost"),
      json({ branch: branch(), annotation: annotation() }),
      json({
        role: {
          branch_id: branchId,
          name: "whatsapp_restore_runtime",
          password: "newer-secret",
          created_at: time,
          updated_at: time,
        },
        operations: [],
      }),
    ];
    const client = createNeonRecoveryClient(config(), {
      fetch: async (_input, init) => {
        methods.push(String(init?.method));
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response ?? json({}, 500);
      },
    });

    await expect(
      client.resetRestoreRuntimePassword(expected),
    ).resolves.toBeUndefined();
    expect(methods).toEqual(["GET", "POST", "GET", "POST"]);
  });

  test("deletes only a freshly verified exact child and reconciles absence", async () => {
    const responses = [
      json({ branch: branch(), annotation: annotation() }),
      json({
        branch: branch(),
        operations: [operation("running", "delete_timeline")],
      }),
      json({ operation: operation("finished", "delete_timeline") }),
      json({ code: "not_found", message: "missing" }, 404),
    ];
    const client = createNeonRecoveryClient(config(), {
      now: () => Date.parse(time),
      sleep: async () => {},
      fetch: async () => responses.shift() ?? json({}, 500),
    });

    await expect(client.deleteGuardedBranch(expected)).resolves.toBe("deleted");
  });

  test("reconciles an ambiguous successful deletion from confirmed absence", async () => {
    const methods: string[] = [];
    const client = createNeonRecoveryClient(config(), {
      fetch: async (_input, init) => {
        methods.push(String(init?.method));
        if (methods.length === 1)
          return json({ branch: branch(), annotation: annotation() });
        if (methods.length === 2) throw new Error("response lost");
        return json({ code: "not_found", message: "missing" }, 404);
      },
    });

    await expect(client.deleteGuardedBranch(expected)).resolves.toBe("deleted");
    expect(methods).toEqual(["GET", "DELETE", "GET"]);
  });

  test("polls an annotated init branch found after ambiguous create", async () => {
    const responses: Array<Response | Error> = [
      json({
        branches: [],
        annotations: {},
        pagination: { sort_by: "updated_at", sort_order: "DESC" },
      }),
      new Error("create response lost"),
      json({
        branches: [branch({ current_state: "init" })],
        annotations: { [branchId]: annotation() },
        pagination: { sort_by: "updated_at", sort_order: "DESC" },
      }),
      json({ branch: branch(), annotation: annotation() }),
    ];
    const sleeps: number[] = [];
    const client = createNeonRecoveryClient(config(), {
      now: () => Date.parse(time),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      fetch: async () => {
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response ?? json({}, 500);
      },
    });

    await expect(
      client.reconcilePitrBranch({
        name: branchName,
        parentTimestamp: timestamp,
      }),
    ).resolves.toEqual(expected);
    expect(sleeps).toEqual([10]);
  });

  test("requires the exact recovery source annotation on reconcile, guard, and deletion", async () => {
    const reconcile = createNeonRecoveryClient(config(), {
      now: () => Date.parse(time),
      fetch: async () =>
        json({
          branches: [branch()],
          annotations: {
            [branchId]: annotation({
              value: {
                "production-recovery": `true:${parentId}:2026-08-17T12:00:01.000Z`,
              },
            }),
          },
          pagination: { sort_by: "updated_at", sort_order: "DESC" },
        }),
    });
    await expect(
      reconcile.reconcilePitrBranch({
        name: branchName,
        parentTimestamp: timestamp,
      }),
    ).rejects.toThrow("annotation guard");

    const guard = createNeonRecoveryClient(config(), {
      fetch: async () => json({ branch: branch() }),
    });
    await expect(guard.resetRestoreRuntimePassword(expected)).rejects.toThrow(
      "identity guard",
    );

    const deletion = createNeonRecoveryClient(config(), {
      fetch: async () =>
        json({
          branch: branch(),
          annotation: annotation({
            value: {
              "production-recovery": recoveryAnnotation,
              other: "true",
            },
          }),
        }),
    });
    await expect(deletion.deleteGuardedBranch(expected)).rejects.toThrow(
      "deletion guard",
    );
  });

  test("fails closed on mismatched branches and polling exhaustion", async () => {
    const mismatched = createNeonRecoveryClient(config(), {
      now: () => Date.parse(time),
      fetch: async () =>
        json({
          branches: [branch({ parent_id: "br-other-123456" })],
          annotations: { [branchId]: annotation() },
          pagination: { sort_by: "updated_at", sort_order: "DESC" },
        }),
    });
    await expect(
      mismatched.reconcilePitrBranch({
        name: branchName,
        parentTimestamp: timestamp,
      }),
    ).rejects.toThrow("does not match");

    await expect(
      mismatched.deleteGuardedBranch({
        ...expected,
        parentId: "br-other-123456",
      }),
    ).rejects.toThrow("configured recovery parent");

    let clock = Date.parse(time);
    const bounded = createNeonRecoveryClient(
      config({ maxAttempts: 2, intervalMs: 10, timeoutMs: 100 }),
      {
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        fetch: async (input) => {
          if (String(input).includes("?search="))
            return json({
              branches: [],
              annotations: {},
              pagination: { sort_by: "updated_at", sort_order: "DESC" },
            });
          if (String(input).endsWith("/branches"))
            return json(
              {
                branch: branch({ current_state: "init" }),
                endpoints: [],
                operations: [operation("running")],
              },
              201,
            );
          return json({ operation: operation("running") });
        },
      },
    );
    await expect(
      bounded.reconcilePitrBranch({
        name: branchName,
        parentTimestamp: timestamp,
      }),
    ).rejects.toThrow("polling bound");
  });

  test("accepts additive fields in current Neon response objects", async () => {
    const client = createNeonRecoveryClient(config(), {
      now: () => Date.parse(time),
      fetch: async () =>
        json({
          branches: [
            branch({
              primary: undefined,
              last_reset_at: time,
              restricted_actions: [],
              recovery: {
                deleted_at: time,
                recoverable_until: time,
                deletion_method: "user",
              },
            }),
          ],
          annotations: {
            [branchId]: annotation({
              object: {
                type: "console/branch",
                id: branchId,
                current_api_addition: true,
              },
              current_api_addition: true,
            }),
          },
          pagination: {
            sort_by: "updated_at",
            sort_order: "DESC",
            current_api_addition: true,
          },
          current_api_addition: true,
        }),
    });

    await expect(
      client.reconcilePitrBranch({
        name: branchName,
        parentTimestamp: timestamp,
      }),
    ).resolves.toEqual(expected);
  });

  test("rejects placeholder configuration before network access", async () => {
    expect(() =>
      createNeonRecoveryClient({
        ...config(),
        apiKey: "replace-with-neon-api-key",
      }),
    ).toThrow();
    const client = createNeonRecoveryClient(config(), {
      now: () => Date.parse(time),
      fetch: async () => {
        throw new Error("network must not run");
      },
    });
    await expect(
      client.reconcilePitrBranch({
        name: branchName,
        parentTimestamp: "2026-08-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("history window");
    await expect(
      client.deleteGuardedBranch({ ...expected, name: "feature/not-recovery" }),
    ).rejects.toThrow("configured recovery parent");
    expect(NeonRecoveryError).toBeDefined();
  });
});
