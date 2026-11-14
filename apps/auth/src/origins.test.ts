import { expect, test } from "bun:test";
import {
  appOrigins,
  isFromApp,
  parseReturnTo,
  safeReturnUrl,
  signInUrl,
} from "./origins";

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
    storage: "https://storage.example.com",
    calendar: "https://calendar.example.com",
    tasks: "https://tasks.example.com",
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
    "http://storage.dev.localhost:8787",
    "http://calendar.dev.localhost:8787",
    "http://tasks.dev.localhost:8787",
  ],
  [
    "http://auth.dev.localhost/",
    { "x-forwarded-proto": "https", "x-forwarded-port": "443" },
    "https://auth.dev.localhost",
    "https://mail.dev.localhost",
    "https://storage.dev.localhost",
    "https://calendar.dev.localhost",
    "https://tasks.dev.localhost",
  ],
])(
  "local dev server at %s",
  (url, headers, auth, mail, storage, calendar, tasks) => {
    expect(appOrigins("dev.localhost", request(url, headers))).toEqual({
      auth,
      mail,
      storage,
      calendar,
      tasks,
    });
  },
);

test.each([
  "https://mail.example.com/",
  "https://mail.example.com/inbox/1?q=a#b",
  "https://auth.example.com/",
  "https://calendar.example.com/schedule",
  "https://MAIL.example.com/inbox",
])("%s is an allowed return address", (url) => {
  expect(safeReturnUrl(url, production)).toBe(new URL(url).href);
});

test.each([
  "https://evil.net/",
  "https://mail.example.com.evil.net/",
  "https://evilmail.example.com/",
  "https://docs.example.com/",
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

test.each([
  "https://evil.com",
  "https://evil.com/",
  "ftp",
  "https:",
  "HTTPS",
  "",
])("a local dev server ignores the forwarded protocol %j", (forwarded) => {
  expect(
    appOrigins(
      "dev.localhost",
      request("http://auth.dev.localhost:8787/", {
        "x-forwarded-proto": forwarded,
        "x-forwarded-port": "443",
      }),
    ),
  ).toEqual({
    auth: "http://auth.dev.localhost:8787",
    mail: "http://mail.dev.localhost:8787",
    storage: "http://storage.dev.localhost:8787",
    calendar: "http://calendar.dev.localhost:8787",
    tasks: "http://tasks.dev.localhost:8787",
  });
});

test("a forged forwarded protocol cannot move the sign-in address off the stored domain", () => {
  const origins = appOrigins(
    "dev.localhost",
    request("http://auth.dev.localhost:8787/", {
      "x-forwarded-proto": "https://evil.com",
    }),
  );
  expect(
    new URL(signInUrl(origins, "https://mail.dev.localhost/")).hostname,
  ).toBe("auth.dev.localhost");
});

test.each([
  [undefined, {}],
  [null, {}],
  ["x", {}],
  [{}, {}],
  [{ returnTo: 1 }, {}],
  [
    { returnTo: "https://mail.example.com/" },
    { returnTo: "https://mail.example.com/" },
  ],
])(
  "%j is read as the return address %j without throwing",
  (input, expected) => {
    expect(parseReturnTo(input)).toEqual(expected);
  },
);

const post = (url: string, headers: Record<string, string>) =>
  new Request(url, { method: "PUT", headers });

test("a deployment accepts only Mail's own https origin", () => {
  const url = "https://mail.example.org/api/import/x/jobs";
  const from = (origin: string) =>
    isFromApp(post(url, { Origin: origin }), "example.org", "mail");
  expect(from("https://mail.example.org")).toBe(true);
  expect(from("http://mail.example.org")).toBe(false);
  expect(from("https://mail.example.org:8443")).toBe(false);
  expect(from("https://auth.example.org")).toBe(false);
  expect(from("https://evil.example.org")).toBe(false);
  expect(from("null")).toBe(false);
  expect(isFromApp(post(url, {}), "example.org", "mail")).toBe(false);
});

test("wrangler dev accepts its own http origin and port, not https", () => {
  const url = "http://mail.cloudysuite.localhost:8787/api/import/x/jobs";
  const from = (origin: string) =>
    isFromApp(post(url, { Origin: origin }), "cloudysuite.localhost", "mail");
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
    isFromApp(
      post(url, { ...forwarded, Origin: origin }),
      "cloudysuite.localhost",
      "mail",
    );
  expect(from("https://mail.cloudysuite.localhost")).toBe(true);
  expect(from("http://mail.cloudysuite.localhost")).toBe(false);
  expect(from("https://auth.cloudysuite.localhost")).toBe(false);
});
