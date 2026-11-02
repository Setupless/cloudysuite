import type { OutgoingId } from "./types";

// One editor gets one new draft beside each draft it was writing on, so a retry, or a
// repeat of the same work from another tab, finds it instead of making another.
export async function copyIdOf(
  id: OutgoingId,
  session: string,
): Promise<OutgoingId> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${id}:${session}`),
  );
  const hex = Array.from(new Uint8Array(digest).subarray(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-") as OutgoingId;
}

// For when someone else has taken over that new draft. Still the same answer every time,
// so a retry walks to the same place.
export const nextCopyId = (id: OutgoingId): OutgoingId => {
  const last = Number.parseInt(id.slice(-4), 16);
  const next = ((last + 1) & 0xffff).toString(16).padStart(4, "0");
  return `${id.slice(0, -4)}${next}` as OutgoingId;
};
