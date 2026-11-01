import { expect, test } from "bun:test";
import { isFromMailApp } from "./origin";

const post = (url: string, headers: Record<string, string>) =>
  new Request(url, { method: "PUT", headers });

test("a deployment accepts only Mail's own https origin", () => {
  const url = "https://mail.example.org/api/import/x/jobs";
  const from = (origin: string) =>
    isFromMailApp(post(url, { Origin: origin }), "example.org");
  expect(from("https://mail.example.org")).toBe(true);
  expect(from("http://mail.example.org")).toBe(false);
  expect(from("https://mail.example.org:8443")).toBe(false);
  expect(from("https://auth.example.org")).toBe(false);
  expect(from("https://evil.example.org")).toBe(false);
  expect(from("null")).toBe(false);
  expect(isFromMailApp(post(url, {}), "example.org")).toBe(false);
});

test("wrangler dev accepts its own http origin and port, not https", () => {
  const url = "http://mail.cloudysuite.localhost:8787/api/import/x/jobs";
  const from = (origin: string) =>
    isFromMailApp(post(url, { Origin: origin }), "cloudysuite.localhost");
  expect(from("http://mail.cloudysuite.localhost:8787")).toBe(true);
  expect(from("https://mail.cloudysuite.localhost:8787")).toBe(false);
  expect(from("http://mail.cloudysuite.localhost:8788")).toBe(false);
  expect(from("http://mail.cloudysuite.localhost")).toBe(false);
  expect(from("http://auth.cloudysuite.localhost:8787")).toBe(false);
});

test("portless forwards https on the default port", () => {
  const url = "http://mail.cloudysuite.localhost/api/import/x/jobs";
  const forwarded = { "x-forwarded-proto": "https", "x-forwarded-port": "443" };
  const from = (origin: string) =>
    isFromMailApp(
      post(url, { ...forwarded, Origin: origin }),
      "cloudysuite.localhost",
    );
  expect(from("https://mail.cloudysuite.localhost")).toBe(true);
  expect(from("http://mail.cloudysuite.localhost")).toBe(false);
  expect(from("https://auth.cloudysuite.localhost")).toBe(false);
});
