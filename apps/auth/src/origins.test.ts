import { expect, test } from "bun:test";
import { appOrigins, safeReturnUrl, signInUrl } from "./origins";

const request = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers });

const production = appOrigins(
  "example.com",
  request("https://auth.example.com/"),
);

test("a real deployment's origins come from the stored domain, not the request", () => {
  expect(appOrigins("example.com", request("http://evil.net:8443/"))).toEqual({
    auth: "https://auth.example.com",
    mail: "https://mail.example.com",
  });
});

test("forwarded headers cannot change a real deployment's origins", () => {
  expect(
    appOrigins(
      "example.com",
      request("https://auth.example.com/", {
        "x-forwarded-proto": "http",
        "x-forwarded-port": "8443",
      }),
    ),
  ).toEqual(production);
});

test.each([
  [
    "http://auth.dev.localhost:8787/",
    {},
    "http://auth.dev.localhost:8787",
    "http://mail.dev.localhost:8787",
  ],
  [
    "http://auth.dev.localhost/",
    { "x-forwarded-proto": "https", "x-forwarded-port": "443" },
    "https://auth.dev.localhost",
    "https://mail.dev.localhost",
  ],
])("local dev server at %s", (url, headers, auth, mail) => {
  expect(appOrigins("dev.localhost", request(url, headers))).toEqual({
    auth,
    mail,
  });
});

test.each([
  "https://mail.example.com/",
  "https://mail.example.com/inbox/1?q=a#b",
  "https://auth.example.com/",
  "https://MAIL.example.com/inbox",
])("%s is an allowed return address", (url) => {
  expect(safeReturnUrl(url, production)).toBe(new URL(url).href);
});

test.each([
  "https://evil.net/",
  "https://mail.example.com.evil.net/",
  "https://evilmail.example.com/",
  "https://calendar.example.com/",
  "https://example.com/",
  "http://mail.example.com/",
  "https://mail.example.com:8443/",
  "https://mail.example.com@evil.net/",
  "https://user:pass@mail.example.com/",
  "//evil.net/",
  "/\\evil.net",
  "/inbox",
  "javascript:alert(1)",
  "data:text/html,hi",
  "",
])("%j is rejected as a return address", (url) => {
  expect(safeReturnUrl(url, production)).toBeNull();
});

test("the sign-in address carries a safe return address", () => {
  const url = new URL(signInUrl(production, "https://mail.example.com/inbox"));
  expect(url.origin).toBe("https://auth.example.com");
  expect(url.pathname).toBe("/sign-in");
  expect(url.searchParams.get("returnTo")).toBe(
    "https://mail.example.com/inbox",
  );
});

test("the sign-in address drops a return address on the wrong domain", () => {
  expect(signInUrl(production, "https://evil.net/")).toBe(
    "https://auth.example.com/sign-in",
  );
});

test("a backslash cannot move a return address onto another host", () => {
  expect(safeReturnUrl("https:\\\\evil.net/", production)).toBeNull();
});
