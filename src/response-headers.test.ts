import { expect, test } from "bun:test";
import { downloadHeaders } from "@cloudysuite/transfer";
import { withResponseHeaders } from "./response-headers";

test("a page refuses to be framed and is not stored", async () => {
  const page = withResponseHeaders(
    new Response("<!doctype html><p>Inbox</p>", {
      headers: { "Content-Type": "text/html" },
    }),
  );

  expect(page.headers.get("Content-Security-Policy")).toBe(
    "frame-ancestors 'none'",
  );
  expect(page.headers.get("X-Frame-Options")).toBe("DENY");
  expect(page.headers.get("Cache-Control")).toBe("no-store");
  expect(await page.text()).toBe("<!doctype html><p>Inbox</p>");
});

test("a download keeps its own sandbox policy and also refuses to be framed", async () => {
  const download = withResponseHeaders(
    new Response("bytes", {
      headers: downloadHeaders("notes.txt", "text/plain", 5, "file"),
    }),
  );

  expect(download.headers.get("Content-Security-Policy")).toBe(
    "sandbox; default-src 'none', frame-ancestors 'none'",
  );
  expect(download.headers.get("X-Frame-Options")).toBe("DENY");
  expect(download.headers.get("Cache-Control")).toBe("private, no-store");
  expect(download.headers.get("Content-Disposition")).toStartWith("attachment");
  expect(await download.text()).toBe("bytes");
});
