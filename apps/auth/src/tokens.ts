const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export function newToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

// A token has 256 random bits, so a fast hash is enough to make a stolen
// database row useless without slowing each check.
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return toHex(new Uint8Array(digest));
}
