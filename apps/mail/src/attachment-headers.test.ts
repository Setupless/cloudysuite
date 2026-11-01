import { expect, test } from "bun:test";
import { downloadHeaders, safeFileName } from "./attachment-headers";

test("every download is an attachment that cannot be sniffed into something else", () => {
  const headers = downloadHeaders("report.pdf", "application/pdf", 3, "x");
  expect(headers.get("Content-Disposition")).toStartWith("attachment;");
  expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(headers.get("Content-Type")).toBe("application/pdf");
  expect(headers.get("Content-Length")).toBe("3");
});

test("anything a browser could run downloads as plain bytes", () => {
  for (const type of [
    "text/html",
    "TEXT/HTML",
    "image/svg+xml",
    "application/xhtml+xml",
    "text/javascript",
    "application/x-shockwave-flash",
    "multipart/x-mixed-replace",
    "text/html; charset=utf-8",
  ]) {
    expect(downloadHeaders("a", type, null, "x").get("Content-Type")).toBe(
      "application/octet-stream",
    );
  }
});

test("a file name cannot break the header or spoof its extension", () => {
  expect(() =>
    downloadHeaders(`a"\r\nSet-Cookie: x=1`, "text/plain", null, "x"),
  ).not.toThrow();
  const header = downloadHeaders(
    `a"\r\nSet-Cookie: x=1.txt`,
    "text/plain",
    null,
    "x",
  ).get("Content-Disposition") as string;
  expect(header).not.toContain("\r");
  expect(header).not.toContain("\n");
  expect(header.split('"')).toHaveLength(3);

  expect(safeFileName("invoice‮fdp.exe", "x")).toBe("invoice_fdp.exe");
  expect(safeFileName("../../etc/passwd", "x")).toBe(
    ".._.._etc_passwd".replace(/^\.+/, ""),
  );
  expect(safeFileName("  ...  ", "fallback")).toBe("fallback");
  expect(safeFileName(null, "fallback")).toBe("fallback");
});

test("a name outside plain ASCII keeps its letters for browsers that read them", () => {
  const header = downloadHeaders(
    "résumé (1).pdf",
    "application/pdf",
    null,
    "x",
  ).get("Content-Disposition") as string;
  expect(header).toContain(`filename="r_sum_ (1).pdf"`);
  expect(header).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%20%281%29.pdf");
});
