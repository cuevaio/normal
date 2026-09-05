export const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

export const decodeBase64Url = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(
      `${value.replaceAll("-", "+").replaceAll("_", "/")}${padding}`,
    );
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
};
