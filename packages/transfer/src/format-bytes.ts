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
