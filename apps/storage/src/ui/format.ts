const UNITS = ["KB", "MB", "GB", "TB", "PB"];

// Decimal, as the 100 GB upload limit is.
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 999.5 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const shown = unit === 0 ? Math.round(value) : Number(value.toFixed(1));
  return `${shown} ${UNITS[unit]}`;
}

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

export function folderSummary(
  fileCount: number,
  changedAt: number,
  now: Date,
): string {
  if (fileCount === 0) return "No files yet";
  const word = dayWord(new Date(changedAt), now);
  const when =
    word === "Today" || word === "Yesterday" ? word.toLowerCase() : word;
  return `${fileCount} ${fileCount === 1 ? "file" : "files"}, ${when}`;
}
