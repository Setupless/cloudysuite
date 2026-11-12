import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gate, type HostRoute, resolveHost, type Settings } from "./routing";

const allOn: Settings = { primaryDomain: "example.com", disabled: new Set() };
const mailOff: Settings = { ...allOn, disabled: new Set(["mail"]) };
const storageOff: Settings = { ...allOn, disabled: new Set(["storage"]) };
const calendarOff: Settings = { ...allOn, disabled: new Set(["calendar"]) };
const tasksOff: Settings = { ...allOn, disabled: new Set(["tasks"]) };
const notSetUp: Settings = { primaryDomain: null, disabled: new Set() };

test.each([
  ["auth.example.com", allOn, { kind: "app", app: "auth" }],
  ["mail.example.com", allOn, { kind: "app", app: "mail" }],
  ["MAIL.Example.COM", allOn, { kind: "app", app: "mail" }],
  ["mail.example.com", mailOff, { kind: "off", app: "mail" }],
  ["auth.example.com", mailOff, { kind: "app", app: "auth" }],
  ["storage.example.com", allOn, { kind: "app", app: "storage" }],
  ["storage.example.com", storageOff, { kind: "off", app: "storage" }],
  ["mail.example.com", storageOff, { kind: "app", app: "mail" }],
  ["calendar.example.com", allOn, { kind: "app", app: "calendar" }],
  ["calendar.example.com", calendarOff, { kind: "off", app: "calendar" }],
  ["mail.example.com", calendarOff, { kind: "app", app: "mail" }],
  ["tasks.example.com", allOn, { kind: "app", app: "tasks" }],
  ["tasks.example.com", tasksOff, { kind: "off", app: "tasks" }],
  ["calendar.example.com", tasksOff, { kind: "app", app: "calendar" }],
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
  "docs.example.com",
  "a.mail.example.com",
  "mail.evil.example.com",
  "constructor.example.com",
  ".example.com",
])("%s is an unknown host", (host) => {
  expect(resolveHost(host, allOn)).toEqual({ kind: "unknown" });
});

const app: HostRoute = { kind: "app", app: "mail" };
const off: HostRoute = { kind: "off", app: "mail" };
const storageIsOff: HostRoute = { kind: "off", app: "storage" };
const setup: HostRoute = { kind: "setup" };
const unknown: HostRoute = { kind: "unknown" };

const request = (mode: string, method: string, path: string) =>
  new Request(`https://host.example.com${path}`, {
    method,
    headers: { "Sec-Fetch-Mode": mode },
  });
const opening = (path: string, method = "GET") =>
  request("navigate", method, path);
const calling = (path: string, method = "GET") =>
  request("same-origin", method, path);

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
] as const)("opening %j at %s", (route, pathname, expected) => {
  expect(gate(route, opening(pathname))).toEqual(expected);
});

test.each(["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])(
  "with Mail off, %s on the device session address is refused",
  (method) => {
    expect(gate(off, calling("/pwa/session", method))).toEqual({
      action: "refuse",
      app: "mail",
    });
  },
);

test("with Mail off, GET on the device session address still answers", () => {
  expect(gate(off, calling("/pwa/session"))).toEqual({ action: "pass" });
  expect(gate(off, opening("/pwa/session"))).toEqual({ action: "pass" });
});

test("only Mail's host serves the offline shell, and only while Mail is on", () => {
  const app = (name: "auth" | "mail") => ({ kind: "app" as const, app: name });
  expect(gate(app("mail"), opening("/offline-shell"))).toEqual({
    action: "pass",
  });
  expect(gate(app("auth"), opening("/offline-shell"))).toEqual({
    action: "notFound",
  });
  expect(gate(off, opening("/offline-shell"))).toEqual({
    action: "redirect",
    to: "/off",
  });
  expect(gate(off, calling("/offline-shell"))).toEqual({
    action: "refuse",
    app: "mail",
  });
  expect(gate(unknown, opening("/offline-shell"))).toEqual({
    action: "notFound",
  });
});

const STORAGE_REQUESTS = [
  ["GET", "/"],
  ["GET", "/drive/x"],
  ["GET", "/download/x/y"],
  ["GET", "/preview/x/y"],
  ["POST", "/api/drives/x/uploads"],
  ["PUT", "/api/drives/x/uploads/y/parts/1"],
  ["GET", "/pwa/session"],
  ["POST", "/_serverFn/anything"],
] as const;

test.each(STORAGE_REQUESTS)(
  "opening %s %s on Storage while it is off goes to the off page",
  (method, path) => {
    expect(gate(storageIsOff, opening(path, method))).toEqual({
      action: "redirect",
      to: "/off",
    });
  },
);

test.each(STORAGE_REQUESTS)(
  "a page left open that calls %s %s on Storage while it is off is refused",
  (method, path) => {
    expect(gate(storageIsOff, calling(path, method))).toEqual({
      action: "refuse",
      app: "storage",
    });
  },
);

const calendarIsOff: HostRoute = { kind: "off", app: "calendar" };

test.each([
  ["GET", "/"],
  ["GET", "/schedule"],
  ["GET", "/pwa/session"],
  ["POST", "/_serverFn/anything"],
] as const)(
  "%s %s on Calendar while it is off goes to the off page, or is refused when a page calls it",
  (method, path) => {
    expect(gate(calendarIsOff, opening(path, method))).toEqual({
      action: "redirect",
      to: "/off",
    });
    expect(gate(calendarIsOff, calling(path, method))).toEqual({
      action: "refuse",
      app: "calendar",
    });
  },
);

const tasksIsOff: HostRoute = { kind: "off", app: "tasks" };

test.each([
  ["GET", "/"],
  ["GET", "/boards/1b3f4e30-ac2d-4f90-9e77-2c3d4e5f6071"],
  ["GET", "/pwa/session"],
  ["POST", "/_serverFn/anything"],
] as const)(
  "%s %s on Tasks while it is off goes to the off page, or is refused when a page calls it",
  (method, path) => {
    expect(gate(tasksIsOff, opening(path, method))).toEqual({
      action: "redirect",
      to: "/off",
    });
    expect(gate(tasksIsOff, calling(path, method))).toEqual({
      action: "refuse",
      app: "tasks",
    });
  },
);

test("a request that doesn't say how it was made is refused, not sent to a page", () => {
  const bare = new Request("https://host.example.com/_serverFn/anything", {
    method: "POST",
  });
  expect(gate(off, bare)).toEqual({ action: "refuse", app: "mail" });
});

// A link marked `download` saves whatever comes back, so a turned-off app's off page
// would arrive as the file. Without it, the server's answer decides.
test("no link forces a download, so a download while the app is off shows the off page", () => {
  const apps = join(import.meta.dir, "../apps");
  // A glob doesn't follow links into node_modules, where Mail and Calendar would loop.
  const forced = [...new Bun.Glob("**/*.tsx").scanSync({ cwd: apps })]
    .filter((file) => !file.includes("node_modules"))
    .filter((file) =>
      /(^\s*|["}]\s)download(\s|=|>|$)/m.test(
        readFileSync(join(apps, file), "utf8"),
      ),
    );
  expect(forced).toEqual([]);
});
