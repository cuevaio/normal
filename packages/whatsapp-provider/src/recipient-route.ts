import { decodeBase64Url, encodeBase64Url } from "./base64-url";

const textEncoder = new TextEncoder();

export type RecipientRouteKind = "contact" | "group";

export interface RecipientRouteKeys {
  readonly encryption: CryptoKey;
  readonly nonce: CryptoKey;
}

type RecipientRouteVersion = "v1" | "v2";

const importRecipientRouteKeys = async (
  encryptionSeed: ArrayBuffer,
  nonceSeed: ArrayBuffer,
): Promise<RecipientRouteKeys> => ({
  encryption: await crypto.subtle.importKey(
    "raw",
    encryptionSeed,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  ),
  nonce: await crypto.subtle.importKey(
    "raw",
    nonceSeed,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  ),
});

export const deriveRecipientRouteKeys = async (
  authority: string,
): Promise<RecipientRouteKeys> => {
  const [encryptionSeed, nonceSeed] = await Promise.all([
    crypto.subtle.digest(
      "SHA-256",
      textEncoder.encode(`directory-locator-encryption-v1\0${authority}`),
    ),
    crypto.subtle.digest(
      "SHA-256",
      textEncoder.encode(`directory-locator-nonce-v1\0${authority}`),
    ),
  ]);
  return importRecipientRouteKeys(encryptionSeed, nonceSeed);
};

export const deriveIdentityRecipientRouteKeys = async (
  identityKey: CryptoKey,
): Promise<RecipientRouteKeys> => {
  const derive = (purpose: "encryption" | "nonce") =>
    crypto.subtle.sign(
      "HMAC",
      identityKey,
      textEncoder.encode(`directory-locator-${purpose}-v2`),
    );
  const [encryptionSeed, nonceSeed] = await Promise.all([
    derive("encryption"),
    derive("nonce"),
  ]);
  return importRecipientRouteKeys(encryptionSeed, nonceSeed);
};

const sealRoute = async (
  keys: RecipientRouteKeys,
  version: RecipientRouteVersion,
  kind: RecipientRouteKind,
  providerIdentifier: string,
): Promise<string> => {
  const context = textEncoder.encode(`directory-locator-${version}:${kind}`);
  const plaintext = textEncoder.encode(providerIdentifier);
  const nonceMaterial = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      keys.nonce,
      textEncoder.encode(`${kind}\0${providerIdentifier}`),
    ),
  );
  const iv = nonceMaterial.slice(0, 12);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { additionalData: context, iv, name: "AES-GCM" },
      keys.encryption,
      plaintext,
    ),
  );
  const sealed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  sealed.set(iv);
  sealed.set(ciphertext, iv.byteLength);
  return `loc_${version}_${kind === "contact" ? "c" : "g"}_${encodeBase64Url(sealed)}`;
};

export const sealRecipientRoute = (
  keys: RecipientRouteKeys,
  kind: RecipientRouteKind,
  providerIdentifier: string,
): Promise<string> => sealRoute(keys, "v1", kind, providerIdentifier);

export const sealIdentityRecipientRoute = (
  keys: RecipientRouteKeys,
  kind: RecipientRouteKind,
  providerIdentifier: string,
): Promise<string> => sealRoute(keys, "v2", kind, providerIdentifier);

const openRoute = async (
  keys: RecipientRouteKeys,
  version: RecipientRouteVersion,
  route: string,
): Promise<{
  readonly identifier: string;
  readonly kind: RecipientRouteKind;
} | null> => {
  const match = new RegExp(`^loc_${version}_(c|g)_([A-Za-z0-9_-]+)$`, "u").exec(
    route,
  );
  if (match === null) return null;
  const kind = match[1] === "c" ? "contact" : "group";
  const sealed = decodeBase64Url(match[2] ?? "");
  if (sealed === null || sealed.byteLength <= 28) return null;
  const iv = sealed.slice(0, 12);
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        additionalData: textEncoder.encode(
          `directory-locator-${version}:${kind}`,
        ),
        iv,
        name: "AES-GCM",
      },
      keys.encryption,
      sealed.slice(12),
    );
    const identifier = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(plaintext);
    return { identifier, kind };
  } catch {
    return null;
  }
};

export const openRecipientRoute = async (
  keys: RecipientRouteKeys,
  route: string,
): Promise<{
  readonly identifier: string;
  readonly kind: RecipientRouteKind;
} | null> => openRoute(keys, "v1", route);

export const openIdentityRecipientRoute = (
  keys: RecipientRouteKeys,
  route: string,
): Promise<{
  readonly identifier: string;
  readonly kind: RecipientRouteKind;
} | null> => openRoute(keys, "v2", route);
