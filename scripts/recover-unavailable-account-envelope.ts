import { restrictedMigrationOwnerConnectionString } from "@whatsapp-mcp/db/restricted-runtime-config";
import {
  createNeonRecoveryClient,
  type RecoveryBranch,
} from "@whatsapp-mcp/neon-recovery/client";
import { Client } from "pg";

const branchNamePrefix = "normal-envelope-recovery-";
const changeReferencePattern = /^change_[a-f0-9]{32}$/u;

const required = (name: string) => {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`${name} is required`);
  return value;
};

const assertDatabaseIdentity = async (
  database: Client,
  expectedBranchId: string,
  expectedProjectId: string,
) => {
  const identity = await database.query<{
    branch_id: string;
    project_id: string;
  }>(`
    SELECT current_setting('neon.branch_id', true) AS branch_id,
      current_setting('neon.project_id', true) AS project_id
  `);
  if (
    identity.rowCount !== 1 ||
    identity.rows[0]?.branch_id !== expectedBranchId ||
    identity.rows[0]?.project_id !== expectedProjectId
  )
    throw new Error("Database identity does not match the guarded operation");
};

const verifyRecoveredEnvelope = async (
  production: Client,
  personalAccountId: string,
  keyVersion: number,
) => {
  const verification = await production.query<{ available: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM public.personal_accounts AS accounts
        JOIN public.personal_account_key_envelopes AS keys
          ON keys.personal_account_id = accounts.id
        WHERE accounts.id = $1
          AND accounts.state = 'active'
          AND keys.ciphertext IS NOT NULL
          AND keys.key_version = $2
          AND keys.kms_key_id IS NOT NULL
          AND keys.unavailable_at IS NULL
      )
      AND EXISTS (
        SELECT 1
        FROM public.whatsapp_connections AS connections
        WHERE connections.personal_account_id = $1
          AND connections.state <> 'deleting'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.whatsapp_connections AS connections
        LEFT JOIN public.whatsapp_connection_key_envelopes AS connection_keys
          ON connection_keys.personal_account_id = connections.personal_account_id
         AND connection_keys.whatsapp_connection_id = connections.id
        WHERE connections.personal_account_id = $1
          AND connections.state <> 'deleting'
          AND (
            connection_keys.account_key_version IS DISTINCT FROM $2
            OR connection_keys.ciphertext IS NULL
            OR connection_keys.nonce IS NULL
            OR connection_keys.key_version IS NULL
            OR connection_keys.unavailable_at IS NOT NULL
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.connection_setup_key_envelopes AS setup_keys
        WHERE setup_keys.personal_account_id = $1
          AND setup_keys.account_key_version IS DISTINCT FROM $2
      ) AS available
    `,
    [personalAccountId, keyVersion],
  );
  if (verification.rows[0]?.available !== true)
    throw new Error("Production envelope verification failed");
};

const findGuardedBranchWithinConsistencyWindow = async (
  client: ReturnType<typeof createNeonRecoveryClient>,
  branchIdentity: { readonly name: string; readonly parentTimestamp: string },
) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const guarded = await client.findGuardedPitrBranch(branchIdentity);
    if (guarded !== "absent") return guarded;
    if (attempt < 59) await Bun.sleep(5_000);
  }
  return "absent" as const;
};

const recoverEnvelope = async (
  branch: RecoveryBranch,
  client: ReturnType<typeof createNeonRecoveryClient>,
  productionConnectionString: string,
  productionBranchId: string,
  projectId: string,
) => {
  await client.resetMigrationOwnerPassword(branch);
  const source = new Client({
    connectionString: await client.getDirectMigrationUri(branch),
  });
  const production = new Client({
    connectionString: productionConnectionString,
  });
  try {
    await source.connect();
    await production.connect();
    await assertDatabaseIdentity(source, branch.id, projectId);
    await assertDatabaseIdentity(production, productionBranchId, projectId);

    await production.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    try {
      const changeReference = required("RECOVERY_CHANGE_REFERENCE");
      const sourcePoint = required("RECOVERY_SOURCE_POINT_AT");
      const completed = await production.query<{
        personal_account_id: string;
        recovered_key_version: number;
        source_matches: boolean;
      }>(
        `
          SELECT personal_account_id, recovered_key_version,
            source_point_at = $2::timestamptz AS source_matches
          FROM public.personal_account_envelope_recovery_operations
          WHERE change_reference = $1
          FOR UPDATE
        `,
        [changeReference, sourcePoint],
      );
      if (completed.rowCount === 1) {
        const evidence = completed.rows[0];
        if (evidence === undefined || evidence.source_matches !== true)
          throw new Error("Recovery evidence does not match this operation");
        await verifyRecoveredEnvelope(
          production,
          evidence.personal_account_id,
          evidence.recovered_key_version,
        );
        await production.query("COMMIT");
        return;
      }
      if (completed.rowCount !== 0)
        throw new Error("Recovery evidence is ambiguous");

      const candidates = await production.query<{
        personal_account_id: string;
      }>(`
        SELECT accounts.id AS personal_account_id
        FROM public.personal_accounts AS accounts
        JOIN public.personal_account_key_envelopes AS keys
          ON keys.personal_account_id = accounts.id
        WHERE accounts.state = 'active'
          AND keys.ciphertext IS NULL
          AND keys.unavailable_at IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public.whatsapp_connections AS connections
            WHERE connections.personal_account_id = accounts.id
              AND connections.state <> 'deleting'
          )
        FOR UPDATE OF keys
      `);
      if (candidates.rowCount !== 1)
        throw new Error(
          "Recovery requires exactly one active unavailable account with retained Connections",
        );
      const personalAccountId = candidates.rows[0]?.personal_account_id;
      if (personalAccountId === undefined)
        throw new Error("Recovery candidate was not returned");

      const recovered = await source.query<{
        ciphertext: Buffer | null;
        key_version: number | null;
        kms_key_id: string | null;
        state: string;
        unavailable_at: Date | null;
      }>(
        `
          SELECT keys.ciphertext, keys.key_version, keys.kms_key_id,
            keys.unavailable_at, accounts.state
          FROM public.personal_accounts AS accounts
          JOIN public.personal_account_key_envelopes AS keys
            ON keys.personal_account_id = accounts.id
          WHERE accounts.id = $1
        `,
        [personalAccountId],
      );
      if (recovered.rowCount !== 1)
        throw new Error(
          "PITR source does not contain exactly one matching envelope",
        );
      const envelope = recovered.rows[0];
      if (
        envelope === undefined ||
        envelope.state !== "active" ||
        envelope.ciphertext === null ||
        envelope.ciphertext.byteLength === 0 ||
        envelope.key_version === null ||
        envelope.key_version <= 0 ||
        envelope.kms_key_id === null ||
        envelope.kms_key_id.length === 0 ||
        envelope.unavailable_at !== null
      )
        throw new Error("PITR source envelope is not available");

      const connectionKeys = await production.query<{
        connection_count: number;
        matching_key_count: number;
      }>(
        `
          SELECT count(*)::integer AS connection_count,
            count(connection_keys.whatsapp_connection_id) FILTER (
              WHERE connection_keys.account_key_version = $2
                AND connection_keys.ciphertext IS NOT NULL
                AND connection_keys.nonce IS NOT NULL
                AND connection_keys.key_version IS NOT NULL
                AND connection_keys.unavailable_at IS NULL
            )::integer AS matching_key_count
          FROM public.whatsapp_connections AS connections
          LEFT JOIN public.whatsapp_connection_key_envelopes AS connection_keys
            ON connection_keys.personal_account_id = connections.personal_account_id
           AND connection_keys.whatsapp_connection_id = connections.id
          WHERE connections.personal_account_id = $1
            AND connections.state <> 'deleting'
        `,
        [personalAccountId, envelope.key_version],
      );
      const connectionKeyEvidence = connectionKeys.rows[0];
      if (
        connectionKeyEvidence === undefined ||
        connectionKeyEvidence.connection_count < 1 ||
        connectionKeyEvidence.matching_key_count !==
          connectionKeyEvidence.connection_count
      )
        throw new Error(
          "PITR account envelope does not match retained Connection envelopes",
        );

      const setupKeys = await production.query<{
        mismatched_key_count: number;
      }>(
        `
          SELECT count(*) FILTER (
            WHERE account_key_version IS DISTINCT FROM $2
          )::integer AS mismatched_key_count
          FROM public.connection_setup_key_envelopes
          WHERE personal_account_id = $1
        `,
        [personalAccountId, envelope.key_version],
      );
      if (setupKeys.rows[0]?.mismatched_key_count !== 0)
        throw new Error(
          "PITR account envelope does not match retained Setup envelopes",
        );

      const updated = await production.query(
        `
          UPDATE public.personal_account_key_envelopes
          SET ciphertext = $2, key_version = $3, kms_key_id = $4,
            unavailable_at = NULL
          WHERE personal_account_id = $1
            AND ciphertext IS NULL
            AND unavailable_at IS NOT NULL
        `,
        [
          personalAccountId,
          envelope.ciphertext,
          envelope.key_version,
          envelope.kms_key_id,
        ],
      );
      if (updated.rowCount !== 1)
        throw new Error("Production envelope changed during recovery");
      await production.query(
        `
          INSERT INTO public.personal_account_envelope_recovery_operations (
            change_reference, personal_account_id, source_point_at,
            recovered_key_version
          ) VALUES ($1, $2, $3::timestamptz, $4)
        `,
        [changeReference, personalAccountId, sourcePoint, envelope.key_version],
      );
      await verifyRecoveredEnvelope(
        production,
        personalAccountId,
        envelope.key_version,
      );
      await production.query("COMMIT");
    } catch (error) {
      await production.query("ROLLBACK");
      throw error;
    }
  } finally {
    await Promise.allSettled([source.end(), production.end()]);
  }
};

const main = async () => {
  const sourcePoint = required("RECOVERY_SOURCE_POINT_AT");
  const parsedSourcePoint = Date.parse(sourcePoint);
  if (
    !Number.isFinite(parsedSourcePoint) ||
    new Date(parsedSourcePoint).toISOString() !== sourcePoint
  )
    throw new Error(
      "RECOVERY_SOURCE_POINT_AT must be a canonical UTC timestamp",
    );
  const changeReference = required("RECOVERY_CHANGE_REFERENCE");
  if (!changeReferencePattern.test(changeReference))
    throw new Error("RECOVERY_CHANGE_REFERENCE must be an opaque reference");

  const productionConnectionString = restrictedMigrationOwnerConnectionString(
    required("MIGRATION_DATABASE_URL"),
  );
  const productionUrl = new URL(productionConnectionString);
  const projectId = required("NEON_PROJECT_ID");
  const productionBranchId = required("NEON_BRANCH_ID");
  const parentBranchId = required("NEON_PARENT_BRANCH_ID");
  if (productionBranchId !== parentBranchId)
    throw new Error("Serving and recovery parent branches do not match");
  const client = createNeonRecoveryClient({
    apiKey: required("NEON_RECOVERY_API_KEY"),
    branchNamePrefix,
    databaseName: decodeURIComponent(productionUrl.pathname.slice(1)),
    parentBranchId,
    polling: { intervalMs: 1_000, maxAttempts: 180, timeoutMs: 30_000 },
    projectId,
  });
  const branchIdentity = {
    name: `${branchNamePrefix}${changeReference}`,
    parentTimestamp: sourcePoint,
  };

  if (process.env.RECOVERY_MODE === "cleanup") {
    const guarded = await findGuardedBranchWithinConsistencyWindow(
      client,
      branchIdentity,
    );
    if (guarded !== "absent") await client.deleteGuardedBranch(guarded);
    console.info(`Recovery cleanup complete for ${changeReference}`);
    return;
  }

  let branch: RecoveryBranch | undefined;
  try {
    branch = await client.reconcilePitrBranch(branchIdentity);
    await recoverEnvelope(
      branch,
      client,
      productionConnectionString,
      productionBranchId,
      projectId,
    );
  } finally {
    const guarded =
      branch ??
      (await findGuardedBranchWithinConsistencyWindow(client, branchIdentity));
    if (guarded !== "absent") {
      await client.resetMigrationOwnerPassword(guarded).catch(() => undefined);
      await client.deleteGuardedBranch(guarded);
    }
  }

  console.info(`Recovery verified for ${changeReference}`);
};

await main().catch(() => {
  console.error("Personal Account envelope recovery failed");
  process.exitCode = 1;
});
