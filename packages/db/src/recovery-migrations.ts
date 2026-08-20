import migration0000 from "../drizzle/0000_baseline.sql";
import migration0001 from "../drizzle/0001_allow_null_mcp_client_id.sql";
import migration0002 from "../drizzle/0002_delegate_waitlist_to_clerk.sql";
import migration0003 from "../drizzle/0003_admit_clerk_users_without_provider_reservation.sql";
import migration0004 from "../drizzle/0004_name_whatsapp_connections.sql";
import migration0005 from "../drizzle/0005_add_message_search_foundation.sql";
import migration0006 from "../drizzle/0006_add_whatsapp_recipient_exclusions.sql";
import migration0007 from "../drizzle/0007_add_personal_account_onboarding_profiles.sql";
import migration0008 from "../drizzle/0008_expand_activity_log_channels.sql";
import migration0009 from "../drizzle/0009_add_api_keys.sql";
import migration0010 from "../drizzle/0010_distinguish_send_grant_identities.sql";
import migration0011 from "../drizzle/0011_revoke_api_keys_on_personal_account_deletion.sql";
import migration0012 from "../drizzle/0012_expire_and_purge_api_key_metadata.sql";
import migration0013 from "../drizzle/0013_revoke_api_keys_on_connection_deletion.sql";
import migration0014 from "../drizzle/0014_load_protected_stored_media_for_api_keys.sql";
import migration0015 from "../drizzle/0015_record_health_check_failures.sql";
import migration0016 from "../drizzle/0016_invalidate_restored_api_keys.sql";
import migration0017 from "../drizzle/0017_record_connection_setup_provisioning_start.sql";
import migration0018 from "../drizzle/0018_reject_mismatched_qr_activation.sql";
import migration0019 from "../drizzle/0019_allow_api_keys_on_mcp.sql";
import migration0020 from "../drizzle/0020_persist_onboarding_security_completion.sql";
import migration0021 from "../drizzle/0021_add_recovery_verifier.sql";
import migration0022 from "../drizzle/0022_gate_recovery_drill_verification.sql";
import migration0023 from "../drizzle/0023_record_recovery_source_points.sql";
import migration0024 from "../drizzle/0024_rotate_recovery_verifier_password.sql";
import migration0025 from "../drizzle/0025_reject_content_free_stored_messages.sql";
import migration0026 from "../drizzle/0026_allow_direct_send_destinations.sql";
import { type QueryConnection, withPgQueryConnection } from "./database";
import { restrictedMigrationOwnerConnectionString } from "./restricted-runtime-config";

const migrations = [
  [1785787776687, migration0000],
  [1785959583000, migration0001],
  [1786134619000, migration0002],
  [1786143600000, migration0003],
  [1786464000000, migration0004],
  [1786467600000, migration0005],
  [1786471200000, migration0006],
  [1786474800000, migration0007],
  [1786478400000, migration0008],
  [1786482000000, migration0009],
  [1786485600000, migration0010],
  [1786489200000, migration0011],
  [1786492800000, migration0012],
  [1786496400000, migration0013],
  [1786500000000, migration0014],
  [1787022000000, migration0015],
  [1787112000000, migration0016],
  [1787115600000, migration0017],
  [1787119200000, migration0018],
  [1787119201000, migration0019],
  [1787122800000, migration0020],
  [1787126400000, migration0021],
  [1787130000000, migration0022],
  [1787166960000, migration0023],
  [1787191200000, migration0024],
  [1787242636000, migration0025],
  [1787250000000, migration0026],
] as const;
export const recoveryMigrationCreatedAts: ReadonlyArray<number> =
  migrations.map(([createdAt]) => createdAt);

const readLastAppliedMigration = async (client: QueryConnection) => {
  const ledger = await client.query<{ created_at: string }>(
    "SELECT created_at FROM public.drizzle_migrations ORDER BY created_at DESC LIMIT 1",
  );
  const lastApplied = Number(ledger.rows[0]?.created_at ?? 0);
  if (!Number.isFinite(lastApplied) || lastApplied < 0)
    throw new Error("Recovery migration ledger is invalid");
  return lastApplied;
};

export const rotateRecoveryVerifierPasswordWithClient = async (
  client: QueryConnection,
  password: string,
) => {
  if (!/^[a-f0-9]{64}$/.test(password))
    throw new Error("Recovery verifier password is invalid");
  try {
    await client.query("SELECT public.rotate_recovery_verifier_password($1)", [
      password,
    ]);
  } catch {
    throw new Error("Recovery verifier password rotation failed");
  }
};

export const rotateRecoveryVerifierPassword = (
  connectionString: string,
  password: string,
) =>
  withPgQueryConnection(
    restrictedMigrationOwnerConnectionString(connectionString),
    (client) => rotateRecoveryVerifierPasswordWithClient(client, password),
    30_000,
    10_000,
  );

const toHex = (value: ArrayBuffer) =>
  [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export const applyRecoveryMigrationsWithClient = async (
  client: QueryConnection,
) => {
  const lastApplied = await readLastAppliedMigration(client);

  let applied = 0;
  for (const [createdAt, source] of migrations) {
    if (createdAt <= lastApplied) continue;
    const hash = toHex(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)),
    );
    await client.query("BEGIN");
    try {
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim().length > 0) await client.query(statement);
      }
      await client.query(
        "INSERT INTO public.drizzle_migrations (hash, created_at) VALUES ($1, $2)",
        [hash, createdAt],
      );
      await client.query("COMMIT");
      applied += 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  return applied;
};

export const applyRecoveryMigrations = (connectionString: string) =>
  withPgQueryConnection(
    connectionString,
    applyRecoveryMigrationsWithClient,
    120_000,
    10_000,
  );
