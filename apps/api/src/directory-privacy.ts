import type { PersistedDirectoryCiphertext } from "@whatsapp-mcp/db/webhook-event";
import type { DirectoryContact } from "@whatsapp-mcp/whatsapp-provider/session";
import { Data, Effect, Encoding } from "effect";
import type {
  ConnectionKeyEnvelope,
  EnvelopeEncryption,
  PersonalAccountKeyEnvelope,
} from "./encryption/envelope";

export class DirectoryPrivacyError extends Data.TaggedError(
  "DirectoryPrivacyError",
) {}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export const normalizeContactDisplayName = (value: string): string =>
  value
    .normalize("NFKC")
    .trim()
    .replace(/\p{White_Space}+/gu, " ")
    .toLowerCase();

const indexValue = (
  key: CryptoKey,
  connectionId: string,
  namespace: "display-name-prefix" | "phone" | "provider-identity",
  value: string,
): Effect.Effect<string, DirectoryPrivacyError> =>
  Effect.tryPromise({
    try: async () => {
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(
          `directory-index-v1\0${connectionId}\0${namespace}\0${value}`,
        ),
      );
      return `di1_${Encoding.encodeBase64Url(new Uint8Array(signature))}`;
    },
    catch: () => new DirectoryPrivacyError(),
  });

export const contactProviderIdentityIndex = (
  key: CryptoKey,
  connectionId: string,
  identity: string,
) => indexValue(key, connectionId, "provider-identity", identity);

export const importDirectoryIndexKey = (
  secret: Uint8Array,
): Effect.Effect<CryptoKey, DirectoryPrivacyError> => {
  if (secret.byteLength < 32) {
    return Effect.fail(new DirectoryPrivacyError());
  }
  return Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        "raw",
        secret,
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["sign"],
      ),
    catch: () => new DirectoryPrivacyError(),
  });
};

export const contactSearchIndex = (
  key: CryptoKey,
  connectionId: string,
  search: string,
): Effect.Effect<
  { readonly index: string; readonly kind: "name" | "phone" },
  DirectoryPrivacyError
> => {
  if (/^\+[1-9]\d{6,14}$/u.test(search)) {
    return indexValue(key, connectionId, "phone", search).pipe(
      Effect.map((index) => ({ index, kind: "phone" as const })),
    );
  }
  if (search.startsWith("+")) {
    return Effect.fail(new DirectoryPrivacyError());
  }
  const normalized = normalizeContactDisplayName(search);
  if (Array.from(normalized).length < 3 || Array.from(normalized).length > 64) {
    return Effect.fail(new DirectoryPrivacyError());
  }
  return indexValue(key, connectionId, "display-name-prefix", normalized).pipe(
    Effect.map((index) => ({ index, kind: "name" as const })),
  );
};

const namePrefixIndexes = (
  key: CryptoKey,
  connectionId: string,
  displayName: string | null,
) => {
  if (displayName === null) return Effect.succeed([] as ReadonlyArray<string>);
  const characters = Array.from(normalizeContactDisplayName(displayName)).slice(
    0,
    64,
  );
  return Effect.forEach(
    characters
      .slice(2)
      .map((_, index) => characters.slice(0, index + 3).join("")),
    (prefix) => indexValue(key, connectionId, "display-name-prefix", prefix),
  );
};

const encryptString = (
  encryption: EnvelopeEncryption,
  input: {
    readonly accountKey: PersonalAccountKeyEnvelope;
    readonly connectionKey: ConnectionKeyEnvelope;
    readonly field: string;
    readonly providerIdentityIndex: string;
    readonly value: string | null;
  },
): Effect.Effect<PersistedDirectoryCiphertext | null, DirectoryPrivacyError> =>
  input.value === null
    ? Effect.succeed(null)
    : Effect.acquireUseRelease(
        Effect.sync(() => encoder.encode(input.value ?? "")),
        (plaintext) =>
          encryption.encrypt({
            accountKey: input.accountKey,
            connectionKey: input.connectionKey,
            context: {
              accountId: input.accountKey.personalAccountId,
              connectionId: input.connectionKey.connectionId,
              entity: "directory-contact",
              fieldOrObjectPurpose: input.field,
              recordId: input.providerIdentityIndex,
            },
            plaintext,
          }),
        (plaintext) => Effect.sync(() => plaintext.fill(0)),
      ).pipe(Effect.mapError(() => new DirectoryPrivacyError()));

export interface ProtectedDirectoryContact {
  readonly displayNameCiphertext: PersistedDirectoryCiphertext | null;
  readonly displayNameSort: string;
  readonly namePrefixIndexes: ReadonlyArray<string>;
  readonly phoneCiphertext: PersistedDirectoryCiphertext | null;
  readonly phoneIndex: string | null;
  readonly providerIdentityCiphertext: PersistedDirectoryCiphertext;
  readonly providerIdentityIndex: string;
}

export const protectDirectoryContact = (input: {
  readonly accountKey: PersonalAccountKeyEnvelope;
  readonly connectionKey: ConnectionKeyEnvelope;
  readonly contact: DirectoryContact;
  readonly encryption: EnvelopeEncryption;
  readonly indexKey: CryptoKey;
}): Effect.Effect<ProtectedDirectoryContact, DirectoryPrivacyError> =>
  Effect.gen(function* () {
    const providerIdentityIndex = yield* indexValue(
      input.indexKey,
      input.connectionKey.connectionId,
      "provider-identity",
      input.contact.identity,
    );
    const fields = {
      accountKey: input.accountKey,
      connectionKey: input.connectionKey,
      providerIdentityIndex,
    } as const;
    const [providerIdentityCiphertext, displayNameCiphertext, phoneCiphertext] =
      yield* Effect.all(
        [
          encryptString(input.encryption, {
            ...fields,
            field: "provider-identity",
            value: input.contact.recipient,
          }),
          encryptString(input.encryption, {
            ...fields,
            field: "display-name",
            value: input.contact.active ? input.contact.displayName : null,
          }),
          encryptString(input.encryption, {
            ...fields,
            field: "phone-number",
            value: input.contact.active ? input.contact.phoneNumber : null,
          }),
        ],
        { concurrency: "unbounded" },
      );
    if (providerIdentityCiphertext === null) {
      return yield* Effect.fail(new DirectoryPrivacyError());
    }
    const prefixes = input.contact.active
      ? yield* namePrefixIndexes(
          input.indexKey,
          input.connectionKey.connectionId,
          input.contact.displayName,
        )
      : [];
    const phoneIndex =
      input.contact.active && input.contact.phoneNumber !== null
        ? yield* indexValue(
            input.indexKey,
            input.connectionKey.connectionId,
            "phone",
            input.contact.phoneNumber,
          )
        : null;
    const displayNameSort =
      input.contact.active && input.contact.displayName !== null
        ? normalizeContactDisplayName(input.contact.displayName)
        : "";
    if (encoder.encode(displayNameSort).byteLength > 1_024) {
      return yield* Effect.fail(new DirectoryPrivacyError());
    }
    return {
      displayNameCiphertext,
      displayNameSort,
      namePrefixIndexes: prefixes,
      phoneCiphertext,
      phoneIndex,
      providerIdentityCiphertext,
      providerIdentityIndex,
    };
  });

export const decryptDirectoryString = (input: {
  readonly accountKey: PersonalAccountKeyEnvelope;
  readonly ciphertext: PersistedDirectoryCiphertext | null;
  readonly connectionKey: ConnectionKeyEnvelope;
  readonly encryption: EnvelopeEncryption;
  readonly field: "display-name" | "phone-number";
  readonly providerIdentityIndex: string;
}): Effect.Effect<string | null, DirectoryPrivacyError> =>
  input.ciphertext === null
    ? Effect.succeed(null)
    : Effect.acquireUseRelease(
        input.encryption.decrypt({
          accountKey: input.accountKey,
          ciphertext: input.ciphertext,
          connectionKey: input.connectionKey,
          context: {
            accountId: input.accountKey.personalAccountId,
            connectionId: input.connectionKey.connectionId,
            entity: "directory-contact",
            fieldOrObjectPurpose: input.field,
            recordId: input.providerIdentityIndex,
          },
        }),
        (bytes) =>
          Effect.try({
            try: () => decoder.decode(bytes),
            catch: () => new DirectoryPrivacyError(),
          }),
        (bytes) => Effect.sync(() => bytes.fill(0)),
      ).pipe(Effect.mapError(() => new DirectoryPrivacyError()));
