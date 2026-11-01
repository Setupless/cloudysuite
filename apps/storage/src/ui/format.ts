export { formatBytes } from "@cloudysuite/transfer";

export const itemCount = (count: number) =>
  `${count} ${count === 1 ? "item" : "items"}`;

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

const daysAgo = (date: Date, now: Date) =>
  Math.round((startOfDay(now) - startOfDay(date)) / (24 * 60 * 60 * 1000));

function dayWord(date: Date, now: Date): string {
  const days = daysAgo(date, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) {
    return date.toLocaleDateString(undefined, { weekday: "long" });
  }
  return date.toLocaleDateString(
    undefined,
    date.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" },
  );
}

export function formatChanged(timestamp: number, now: Date): string {
  const date = new Date(timestamp);
  const word = dayWord(date, now);
  return daysAgo(date, now) === 0
    ? `${word}, ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
    : word;
}

// For the middle of a sentence: "today", "yesterday", "Monday", "Oct 3".
export function dayInSentence(timestamp: number, now: Date): string {
  const word = dayWord(new Date(timestamp), now);
  return word === "Today" || word === "Yesterday" ? word.toLowerCase() : word;
}

export function folderSummary(
  fileCount: number,
  changedAt: number,
  now: Date,
): string {
  if (fileCount === 0) return "No files yet";
  const when = dayInSentence(changedAt, now);
  return `${fileCount} ${fileCount === 1 ? "file" : "files"}, ${when}`;
}
