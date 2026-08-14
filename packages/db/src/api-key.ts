import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { makeDatabase, makeQueryConnection } from "./database";
import type {
  PersonalAccountConnection,
  PersonalAccountConnectionProvider,
} from "./personal-account";
import { withPgRequestConnection } from "./request-connection";
import {
  apiKeyConnectionsInApp,
  apiKeysInApp,
  personalAccountsInApp,
  whatsappConnectionsInApp,
} from "./schema";
import { withTransaction } from "./transaction";

export const API_KEY_PERMISSIONS = [
  "connections:read",
  "directory:read",
  "messages:read",
  "messages:send",
] as const;

export type ApiKeyPermission = (typeof API_KEY_PERMISSIONS)[number];

export type ApiKeyPresentationState = "active" | "expired" | "revoked";

export interface CreateApiKeyInput {
  readonly clerkUserId: string;
  readonly connectionIds: ReadonlyArray<string>;
  readonly createdAt: Date;
  readonly credentialDigest: Uint8Array;
  readonly credentialHint: string;
  readonly expiresAt: Date | null;
  readonly id: string;
  readonly name: string;
  readonly permissions: ReadonlyArray<ApiKeyPermission>;
  readonly publicId: string;
  readonly reverifiedAt: Date;
}

export interface ApiKeySummary {
  readonly connectionIds: ReadonlyArray<string>;
  readonly createdAt: Date;
  readonly credentialHint: string;
  readonly expiresAt: Date | null;
  readonly id: string;
  readonly lastUsedAt: Date | null;
  readonly name: string;
  readonly permissions: ReadonlyArray<ApiKeyPermission>;
  readonly revokedAt: Date | null;
  readonly state: ApiKeyPresentationState;
}

export type CreateApiKeyResult =
  | { readonly outcome: "created"; readonly summary: ApiKeySummary }
  | { readonly outcome: "duplicate_name" }
  | { readonly outcome: "invalid" }
  | { readonly outcome: "limit_reached" }
  | { readonly outcome: "not_found" };

export interface AuthenticatedApiKey {
  readonly connectionIds: ReadonlyArray<string>;
  readonly expiresAt: Date | null;
  readonly id: string;
  readonly name: string;
  readonly permissions: ReadonlyArray<ApiKeyPermission>;
}

export interface ApiKeyRepository {
  readonly authenticate: (input: {
    readonly digest: Uint8Array;
    readonly publicId: string;
  }) => Promise<AuthenticatedApiKey | null>;
  readonly create: (input: CreateApiKeyInput) => Promise<CreateApiKeyResult>;
  readonly list: (
    clerkUserId: string,
    observedAt: Date,
  ) => Promise<ReadonlyArray<ApiKeySummary> | null>;
  readonly revoke: (input: {
    readonly clerkUserId: string;
    readonly publicId: string;
    readonly revokedAt: Date;
  }) => Promise<{ readonly revokedAt: Date } | null>;
}

const API_KEY_HANDLE = /^apk_[A-Za-z0-9_-]{21}$/u;
const ACTIVE_KEY_LIMIT = 10;
const METADATA_RETENTION_DAYS = 90;

const enterClerkContext = async (
  connection: PersonalAccountConnection,
  clerkUserId: string,
): Promise<string | null> => {
  const db = makeDatabase(connection);
  const result = await db.execute<{ personal_account_id: string | null }>(sql`
    SELECT public.bootstrap_personal_account_for_clerk(${clerkUserId})
      AS personal_account_id
  `);
  const personalAccountId = result[0]?.personal_account_id;
  if (typeof personalAccountId !== "string") return null;
  await db.execute(
    sql`SELECT set_config('public.personal_account_id', ${personalAccountId}, true)`,
  );
  const account = await db
    .select({ id: personalAccountsInApp.id })
    .from(personalAccountsInApp)
    .where(
      and(
        eq(personalAccountsInApp.id, personalAccountId),
        eq(personalAccountsInApp.state, "active"),
      ),
    );
  return account.length === 1 ? personalAccountId : null;
};

const uniqueValues = (values: ReadonlyArray<string>): boolean =>
  values.length > 0 && new Set(values).size === values.length;

const isAllowedPermission = (value: string): value is ApiKeyPermission =>
  (API_KEY_PERMISSIONS as ReadonlyArray<string>).includes(value);

const presentationState = (
  row: {
    readonly expiresAt: string | null;
    readonly state: string;
  },
  observedAt: Date,
): ApiKeyPresentationState => {
  if (row.state === "revoked") return "revoked";
  if (row.expiresAt !== null && new Date(row.expiresAt) <= observedAt) {
    return "expired";
  }
  return "active";
};

const loadGrantConnections = async (
  connection: PersonalAccountConnection,
  apiKeyId: string,
): Promise<ReadonlyArray<string>> => {
  const db = makeDatabase(connection);
  const selected = await db
    .select({
      publicId: whatsappConnectionsInApp.publicId,
    })
    .from(apiKeyConnectionsInApp)
    .innerJoin(
      whatsappConnectionsInApp,
      and(
        eq(
          whatsappConnectionsInApp.personalAccountId,
          apiKeyConnectionsInApp.personalAccountId,
        ),
        eq(
          whatsappConnectionsInApp.id,
          apiKeyConnectionsInApp.whatsappConnectionId,
        ),
      ),
    )
    .where(eq(apiKeyConnectionsInApp.apiKeyId, apiKeyId))
    .orderBy(
      asc(whatsappConnectionsInApp.createdAt),
      asc(whatsappConnectionsInApp.publicId),
    );
  return selected.map((row) => row.publicId);
};

export const makeApiKeyRepository = (
  provider: PersonalAccountConnectionProvider,
): ApiKeyRepository => ({
  authenticate: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if (
          !API_KEY_HANDLE.test(input.publicId) ||
          input.digest.byteLength !== 32
        ) {
          return null;
        }
        const db = makeDatabase(connection);
        const bootstrapped = await db.execute<{
          api_key_id: string | null;
        }>(sql`
          SELECT public.bootstrap_api_key(${input.publicId}, ${input.digest})
            AS api_key_id
        `);
        const apiKeyId = bootstrapped[0]?.api_key_id;
        if (typeof apiKeyId !== "string") return null;
        const grants = await db
          .select({
            expiresAt: apiKeysInApp.expiresAt,
            name: apiKeysInApp.name,
            permissions: apiKeysInApp.permissions,
            publicId: apiKeysInApp.publicId,
            state: apiKeysInApp.state,
          })
          .from(apiKeysInApp)
          .where(eq(apiKeysInApp.id, apiKeyId));
        const grant = grants[0];
        if (grant === undefined || grant.state !== "active") return null;
        return {
          connectionIds: await loadGrantConnections(connection, apiKeyId),
          expiresAt:
            grant.expiresAt === null ? null : new Date(grant.expiresAt),
          id: grant.publicId,
          name: grant.name,
          permissions: grant.permissions.filter(isAllowedPermission),
        };
      }),
    ),
  create: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        const personalAccountId = await enterClerkContext(
          connection,
          input.clerkUserId,
        );
        if (personalAccountId === null)
          return { outcome: "not_found" as const };
        const name = input.name.trim();
        if (
          name.length === 0 ||
          name.length > 64 ||
          name !== input.name ||
          input.credentialDigest.byteLength !== 32 ||
          !API_KEY_HANDLE.test(input.publicId) ||
          !uniqueValues(input.permissions) ||
          !input.permissions.every(isAllowedPermission) ||
          !uniqueValues(input.connectionIds) ||
          (input.expiresAt !== null && input.expiresAt <= input.createdAt)
        ) {
          return { outcome: "invalid" as const };
        }

        await db
          .select({ id: personalAccountsInApp.id })
          .from(personalAccountsInApp)
          .where(eq(personalAccountsInApp.id, personalAccountId))
          .for("update");

        const active = await db
          .select({ id: apiKeysInApp.id })
          .from(apiKeysInApp)
          .where(eq(apiKeysInApp.state, "active"));
        if (active.length >= ACTIVE_KEY_LIMIT) {
          return { outcome: "limit_reached" as const };
        }

        const duplicate = await db
          .select({ id: apiKeysInApp.id })
          .from(apiKeysInApp)
          .where(
            and(
              eq(apiKeysInApp.state, "active"),
              sql`lower(${apiKeysInApp.name}) = ${name.toLowerCase()}`,
            ),
          );
        if (duplicate.length > 0) {
          return { outcome: "duplicate_name" as const };
        }

        const selected = await db
          .select({
            id: whatsappConnectionsInApp.id,
            publicId: whatsappConnectionsInApp.publicId,
          })
          .from(whatsappConnectionsInApp)
          .where(
            and(
              inArray(whatsappConnectionsInApp.publicId, input.connectionIds),
              ne(whatsappConnectionsInApp.state, "deleting"),
            ),
          )
          .orderBy(asc(whatsappConnectionsInApp.publicId));
        if (selected.length !== input.connectionIds.length) {
          return { outcome: "not_found" as const };
        }

        await db.insert(apiKeysInApp).values({
          createdAt: input.createdAt.toISOString(),
          credentialDigest: input.credentialDigest,
          credentialHint: input.credentialHint,
          expiresAt: input.expiresAt?.toISOString() ?? null,
          id: input.id,
          name,
          permissions: [...input.permissions],
          personalAccountId,
          publicId: input.publicId,
          reverifiedAt: input.reverifiedAt.toISOString(),
          state: "active",
        });
        await db.insert(apiKeyConnectionsInApp).values(
          selected.map((row) => ({
            apiKeyId: input.id,
            personalAccountId,
            whatsappConnectionId: row.id,
          })),
        );
        return {
          outcome: "created" as const,
          summary: {
            connectionIds: selected.map((row) => row.publicId),
            createdAt: input.createdAt,
            credentialHint: input.credentialHint,
            expiresAt: input.expiresAt,
            id: input.publicId,
            lastUsedAt: null,
            name,
            permissions: [...input.permissions],
            revokedAt: null,
            state: "active" as const,
          },
        };
      }),
    ),
  list: (clerkUserId, observedAt) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        const db = makeDatabase(connection);
        if ((await enterClerkContext(connection, clerkUserId)) === null) {
          return null;
        }
        const result = await db
          .select({
            connectionPublicId: sql<
              string | null
            >`${whatsappConnectionsInApp.publicId}`.as("connection_public_id"),
            createdAt: apiKeysInApp.createdAt,
            credentialHint: apiKeysInApp.credentialHint,
            expiresAt: apiKeysInApp.expiresAt,
            lastUsedAt: apiKeysInApp.lastUsedAt,
            metadataExpiresAt: apiKeysInApp.metadataExpiresAt,
            name: apiKeysInApp.name,
            permissions: apiKeysInApp.permissions,
            publicId: apiKeysInApp.publicId,
            revokedAt: apiKeysInApp.revokedAt,
            state: apiKeysInApp.state,
          })
          .from(apiKeysInApp)
          .leftJoin(
            apiKeyConnectionsInApp,
            and(
              eq(
                apiKeyConnectionsInApp.personalAccountId,
                apiKeysInApp.personalAccountId,
              ),
              eq(apiKeyConnectionsInApp.apiKeyId, apiKeysInApp.id),
            ),
          )
          .leftJoin(
            whatsappConnectionsInApp,
            and(
              eq(
                whatsappConnectionsInApp.personalAccountId,
                apiKeyConnectionsInApp.personalAccountId,
              ),
              eq(
                whatsappConnectionsInApp.id,
                apiKeyConnectionsInApp.whatsappConnectionId,
              ),
            ),
          )
          .orderBy(
            desc(apiKeysInApp.createdAt),
            asc(apiKeysInApp.publicId),
            asc(whatsappConnectionsInApp.createdAt),
            asc(whatsappConnectionsInApp.publicId),
          );
        const summaries = new Map<string, ApiKeySummary>();
        for (const row of result) {
          if (
            row.metadataExpiresAt !== null &&
            new Date(row.metadataExpiresAt) <= observedAt
          ) {
            continue;
          }
          const existing = summaries.get(row.publicId);
          if (existing !== undefined) {
            if (row.connectionPublicId !== null) {
              (existing.connectionIds as Array<string>).push(
                row.connectionPublicId,
              );
            }
            continue;
          }
          summaries.set(row.publicId, {
            connectionIds:
              row.connectionPublicId === null ? [] : [row.connectionPublicId],
            createdAt: new Date(row.createdAt),
            credentialHint: row.credentialHint,
            expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt),
            id: row.publicId,
            lastUsedAt:
              row.lastUsedAt === null ? null : new Date(row.lastUsedAt),
            name: row.name,
            permissions: row.permissions.filter(isAllowedPermission),
            revokedAt: row.revokedAt === null ? null : new Date(row.revokedAt),
            state: presentationState(row, observedAt),
          });
        }
        return [...summaries.values()];
      }),
    ),
  revoke: (input) =>
    provider.withConnection((connection) =>
      withTransaction(connection, async () => {
        if (!API_KEY_HANDLE.test(input.publicId)) return null;
        const db = makeDatabase(connection);
        if ((await enterClerkContext(connection, input.clerkUserId)) === null) {
          return null;
        }
        const existing = await db
          .select({
            revokedAt: apiKeysInApp.revokedAt,
            state: apiKeysInApp.state,
          })
          .from(apiKeysInApp)
          .where(eq(apiKeysInApp.publicId, input.publicId));
        const current = existing[0];
        if (current === undefined) return null;
        if (current.state === "revoked" && current.revokedAt !== null) {
          return { revokedAt: new Date(current.revokedAt) };
        }
        const revoked = await db
          .update(apiKeysInApp)
          .set({
            credentialDigest: null,
            metadataExpiresAt: new Date(
              input.revokedAt.getTime() +
                METADATA_RETENTION_DAYS * 24 * 60 * 60 * 1000,
            ).toISOString(),
            revokedAt: input.revokedAt.toISOString(),
            state: "revoked",
          })
          .where(eq(apiKeysInApp.publicId, input.publicId))
          .returning({ revokedAt: apiKeysInApp.revokedAt });
        const revokedAt = revoked[0]?.revokedAt;
        return revokedAt == null ? null : { revokedAt: new Date(revokedAt) };
      }),
    ),
});

const makePgConnectionProvider = (
  connectionString: string,
): PersonalAccountConnectionProvider => ({
  withConnection: (use) =>
    withPgRequestConnection(connectionString, (client) =>
      use(makeQueryConnection(client)),
    ),
});

export const makePgApiKeyRepository = (
  connectionString: string,
): ApiKeyRepository =>
  makeApiKeyRepository(makePgConnectionProvider(connectionString));
