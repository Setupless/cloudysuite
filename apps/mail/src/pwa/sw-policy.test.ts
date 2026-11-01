import { expect, test } from "bun:test";
import { policyFor } from "./sw-policy";

const ORIGIN = "https://mail.example.com";
const PUBLIC = new Set(["/device-cleared", "/manifest.webmanifest"]);
const kind = (method: string, mode: string, path: string) =>
  policyFor({ method, mode, url: new URL(path, ORIGIN).href }, ORIGIN, PUBLIC)
    .kind;

test.each([
  ["a server function read", "GET", "cors", "/_serverFn/abc?payload=x"],
  ["a server function write", "POST", "cors", "/_serverFn/abc"],
  ["an attachment download", "GET", "navigate", "/download/m/1/2"],
  [
    "an original message download",
    "GET",
    "same-origin",
    "/download/m/1/original",
  ],
  ["the sign-in API", "POST", "cors", "/api/auth/sign-in/email"],
  ["the sign-in API by GET", "GET", "cors", "/api/auth/get-session"],
  ["a sign-in API page load", "GET", "navigate", "/api/auth/anything"],
  ["an import upload", "PUT", "cors", "/api/import/x/parts/1"],
  ["the session check", "GET", "same-origin", "/pwa/session"],
  ["the shell itself", "GET", "navigate", "/offline-shell"],
  ["a form post", "POST", "navigate", "/"],
  [
    "another site's script",
    "GET",
    "no-cors",
    "https://evil.example/assets/a.js",
  ],
  [
    "another site's page",
    "GET",
    "navigate",
    "https://auth.example.com/sign-in",
  ],
  ["an image a page asks for", "GET", "no-cors", "/something.png"],
])("%s goes straight to the network", (_name, method, mode, path) => {
  expect(kind(method, mode, path)).toBe("network");
});

test.each([
  ["the app's first page", "/"],
  ["a mailbox", "/6f1d2c1e-8a0b-4d7e-9c55-0a1b2c3d4e5f/inbox"],
  ["a conversation", "/6f1d2c1e-8a0b-4d7e-9c55-0a1b2c3d4e5f/inbox/7"],
  ["the device page", "/device"],
])("%s can fall back to the anonymous shell", (_name, path) => {
  expect(kind("GET", "navigate", path)).toBe("page");
});

test("hashed build files and listed public files are served from the device", () => {
  expect(kind("GET", "no-cors", "/assets/app-abc123.css")).toBe("buildAsset");
  expect(kind("GET", "cors", "/assets/main-abc123.js")).toBe("buildAsset");
  expect(kind("GET", "navigate", "/device-cleared")).toBe("publicFile");
  expect(kind("GET", "no-cors", "/manifest.webmanifest")).toBe("publicFile");
});
