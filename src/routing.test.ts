import { expect, test } from "bun:test";
import { gate, type HostRoute, resolveHost, type Settings } from "./routing";

const allOn: Settings = { primaryDomain: "example.com", disabled: new Set() };
const mailOff: Settings = { ...allOn, disabled: new Set(["mail"]) };
const notSetUp: Settings = { primaryDomain: null, disabled: new Set() };

test.each([
  ["auth.example.com", allOn, { kind: "app", app: "auth" }],
  ["mail.example.com", allOn, { kind: "app", app: "mail" }],
  ["MAIL.Example.COM", allOn, { kind: "app", app: "mail" }],
  ["mail.example.com", mailOff, { kind: "off", app: "mail" }],
  ["auth.example.com", mailOff, { kind: "app", app: "auth" }],
  [
    "mail.EXAMPLE.com",
    { ...allOn, primaryDomain: "Example.com" },
    { kind: "app", app: "mail" },
  ],
  ["mail.example.com", notSetUp, { kind: "setup" }],
  ["cloudysuite.someone.workers.dev", notSetUp, { kind: "setup" }],
] as const)(
  "%s with the given settings routes to its app",
  (host, settings, route) => {
    expect(resolveHost(host, settings)).toEqual(route);
  },
);

test.each([
  "mail.example.com.evil.net",
  "evilmail.example.com",
  "example.com",
  "calendar.example.com",
  "a.mail.example.com",
  "mail.evil.example.com",
  "constructor.example.com",
  ".example.com",
])("%s is an unknown host", (host) => {
  expect(resolveHost(host, allOn)).toEqual({ kind: "unknown" });
});

const app: HostRoute = { kind: "app", app: "mail" };
const off: HostRoute = { kind: "off", app: "mail" };
const setup: HostRoute = { kind: "setup" };
const unknown: HostRoute = { kind: "unknown" };

test.each([
  [setup, "/setup", { action: "pass" }],
  [setup, "/setup/api", { action: "pass" }],
  [setup, "/setupx", { action: "redirect", to: "/setup" }],
  [setup, "/", { action: "redirect", to: "/setup" }],
  [setup, "/off", { action: "redirect", to: "/setup" }],
  [off, "/off", { action: "pass" }],
  [off, "/pwa/session", { action: "pass" }],
  [off, "/pwa/session/other", { action: "redirect", to: "/off" }],
  [off, "/", { action: "redirect", to: "/off" }],
  [off, "/inbox/1", { action: "redirect", to: "/off" }],
  [off, "/setup", { action: "redirect", to: "/off" }],
  [off, "/setup/api", { action: "redirect", to: "/off" }],
  [app, "/", { action: "pass" }],
  [app, "/inbox/1", { action: "pass" }],
  [app, "/off", { action: "redirect", to: "/" }],
  [app, "/setup", { action: "redirect", to: "/" }],
  [app, "/setup/api", { action: "redirect", to: "/" }],
  [unknown, "/", { action: "notFound" }],
  [unknown, "/setup", { action: "notFound" }],
  [unknown, "/setup/api", { action: "notFound" }],
] as const)("gate %j at %s", (route, pathname, expected) => {
  expect(gate(route, pathname, "GET")).toEqual(expected);
});

test.each(["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])(
  "with Mail off, %s on the device session address gets the off page",
  (method) => {
    expect(gate({ kind: "off", app: "mail" }, "/pwa/session", method)).toEqual({
      action: "redirect",
      to: "/off",
    });
  },
);

test("with Mail off, GET on the device session address still answers", () => {
  expect(gate({ kind: "off", app: "mail" }, "/pwa/session", "GET")).toEqual({
    action: "pass",
  });
});

test("only Mail's host serves the offline shell, and only while Mail is on", () => {
  const app = (name: "auth" | "mail") => ({ kind: "app" as const, app: name });
  expect(gate(app("mail"), "/offline-shell", "GET")).toEqual({
    action: "pass",
  });
  expect(gate(app("auth"), "/offline-shell", "GET")).toEqual({
    action: "notFound",
  });
  expect(gate({ kind: "off", app: "mail" }, "/offline-shell", "GET")).toEqual({
    action: "redirect",
    to: "/off",
  });
  expect(gate({ kind: "unknown" }, "/offline-shell", "GET")).toEqual({
    action: "notFound",
  });
});
