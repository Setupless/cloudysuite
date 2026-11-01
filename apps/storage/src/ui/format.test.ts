import { expect, test } from "bun:test";
import { folderSummary, formatBytes, formatChanged, itemCount } from "./format";

test.each([
  [0, "0 bytes"],
  [1, "1 byte"],
  [999, "999 bytes"],
  [64_000, "64 KB"],
  [318_400, "318 KB"],
  [2_400_000, "2.4 MB"],
  [18_600_000, "18.6 MB"],
  [34_000_000_000, "34 GB"],
  [999_999_999, "1 GB"],
])("%d bytes reads as %s", (bytes, text) => {
  expect(formatBytes(bytes)).toBe(text);
});

test("counts agree with their number", () => {
  expect(itemCount(0)).toBe("0 items");
  expect(itemCount(1)).toBe("1 item");
  expect(itemCount(8)).toBe("8 items");
});

const now = new Date(2026, 10, 2, 15, 0);

test("a change reads as a day a person would say", () => {
  expect(formatChanged(new Date(2026, 10, 2, 9, 41).getTime(), now)).toMatch(
    /^Today, /,
  );
  expect(formatChanged(new Date(2026, 10, 1, 23, 59).getTime(), now)).toBe(
    "Yesterday",
  );
  expect(formatChanged(new Date(2026, 9, 29).getTime(), now)).toBe("Thursday");
  expect(formatChanged(new Date(2026, 9, 12).getTime(), now)).toMatch(/12/);
  expect(formatChanged(new Date(2025, 9, 12).getTime(), now)).toMatch(/2025/);
});

test("a team folder's card says how much it holds and when it last changed", () => {
  expect(folderSummary(48, now.getTime(), now)).toBe("48 files, today");
  expect(folderSummary(1, new Date(2026, 10, 1).getTime(), now)).toBe(
    "1 file, yesterday",
  );
  expect(folderSummary(96, new Date(2026, 9, 29).getTime(), now)).toBe(
    "96 files, Thursday",
  );
  expect(folderSummary(0, now.getTime(), now)).toBe("No files yet");
});
