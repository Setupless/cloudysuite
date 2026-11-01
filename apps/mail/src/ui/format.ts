import type { Address } from "../types";

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

export function formatListDate(timestamp: number, now: Date): string {
  const date = new Date(timestamp);
  if (sameDay(date, now)) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString(
    undefined,
    date.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" },
  );
}

export const formatFullDate = (timestamp: number) =>
  new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const displayName = (person: Address | null): string =>
  person ? person.name.trim() || person.address : "Unknown sender";

export const formatAddress = (person: Address): string =>
  person.name.trim()
    ? `${person.name.trim()} <${person.address}>`
    : person.address;

export const sendersLine = (senders: Address[]): string =>
  senders.length === 0
    ? "Unknown sender"
    : senders
        .map((person) =>
          senders.length > 1
            ? (displayName(person).split(/\s+/)[0] ?? person.address)
            : displayName(person),
        )
        .join(", ");
