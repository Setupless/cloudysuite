import type { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { createTestDatabase } from "../../../src/db/test-database";
import { createAuth, getActiveSession, readViewer } from "./auth";
import { appOrigins } from "./origins";

const AUTH = "https://auth.example.com";
const password = "a long enough password";

let sqlite: Database;
let database: D1Database;
let auth: ReturnType<typeof createAuth>;

beforeEach(() => {
  let d1: D1Database;
  ({ sqlite, d1 } = createTestDatabase());
  database = d1;
  auth = createAuth({
    database: d1,
    secret: "test-secret-test-secret-test-secret-0123",
    primaryDomain: "example.com",
    origins: appOrigins("example.com", new Request(`${AUTH}/`)),
  });
});

function signIn(email: string, origin = AUTH) {
  return auth.handler(
    new Request(`${AUTH}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, password }),
    }),
  );
}

test("the server can create a user with no session, and that user can sign in", async () => {
  const { user } = await auth.api.createUser({
    body: { email: "New@Example.com", password, name: "New", role: "admin" },
  });
  expect(user.email).toBe("new@example.com");
  expect(user.role).toBe("admin");
  expect((await signIn("new@example.com")).status).toBe(200);
});

test("anyone on the network cannot sign up or use the admin route", async () => {
  const body = JSON.stringify({ email: "a@example.com", password, name: "A" });
  const headers = { "content-type": "application/json", origin: AUTH };
  for (const path of ["/sign-up/email", "/admin/create-user"]) {
    const response = await auth.handler(
      new Request(`${AUTH}/api/auth${path}`, { method: "POST", headers, body }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  }
  expect(sqlite.query("SELECT count(*) AS n FROM user").get()).toEqual({
    n: 0,
  });
});

test("on a real domain the session cookie is secure and shared across apps", async () => {
  await auth.api.createUser({
    body: { email: "a@example.com", password, name: "A" },
  });
  const response = await signIn("a@example.com");
  const cookies = response.headers.getSetCookie();
  const session = cookies.find((cookie) => cookie.includes("session_token"));
  expect(session).toStartWith("__Secure-better-auth.session_token=");
  expect(session).toContain("Domain=example.com");
  expect(session).toContain("Secure");
  expect(session).toContain("HttpOnly");
  expect(session).toContain("SameSite=Lax");
  expect(cookies.some((cookie) => cookie.includes("session_data"))).toBe(false);
});

async function signedInHeaders(email: string) {
  await auth.api.createUser({ body: { email, password, name: "A" } });
  const cookies = (await signIn(email)).headers.getSetCookie();
  const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
  return new Headers({ cookie, origin: AUTH });
}

test("a banned user with a live session counts as signed out", async () => {
  const headers = await signedInHeaders("a@example.com");
  expect(await getActiveSession(auth, headers)).not.toBeNull();

  for (const expires of [null, Date.now() + 60_000]) {
    sqlite.run("UPDATE user SET banned = 1, ban_expires = ?", [expires]);
    expect(await getActiveSession(auth, headers)).toBeNull();
  }
  expect(sqlite.query("SELECT count(*) AS n FROM session").get()).toEqual({
    n: 1,
  });
});

test("a user whose ban has expired stays signed in", async () => {
  const headers = await signedInHeaders("a@example.com");
  sqlite.run("UPDATE user SET banned = 1, ban_expires = ?", [
    Date.now() - 60_000,
  ]);
  const session = await getActiveSession(auth, headers);
  expect(session?.user.email).toBe("a@example.com");
});

test("a banned user cannot start a new session", async () => {
  await auth.api.createUser({
    body: { email: "a@example.com", password, name: "A" },
  });
  sqlite.run("UPDATE user SET banned = 1");
  expect((await signIn("a@example.com")).status).toBe(403);
});

function addPasskey(email: string) {
  sqlite.run(
    `INSERT INTO passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up)
     SELECT 'key-' || ?, 'public', id, 'credential-' || ?, 0, 'singleDevice', 0 FROM user WHERE email = ?`,
    [email, email, email],
  );
}

function requireSecondWay() {
  sqlite.run("INSERT INTO org_settings (id, require_2fa) VALUES (1, 1)");
}

test("with the 2FA rule on, a person with only a password must enrol", async () => {
  const headers = await signedInHeaders("a@example.com");
  expect((await readViewer(auth, database, headers)).status).toBe("ready");
  requireSecondWay();
  expect((await readViewer(auth, database, headers)).status).toBe("must-enrol");
});

test("a passkey or an authenticator app satisfies the 2FA rule", async () => {
  const headers = await signedInHeaders("a@example.com");
  requireSecondWay();
  addPasskey("a@example.com");
  expect((await readViewer(auth, database, headers)).status).toBe("ready");
  sqlite.run("DELETE FROM passkey");
  sqlite.run("UPDATE user SET two_factor_enabled = 1");
  expect((await readViewer(auth, database, headers)).status).toBe("ready");
});

test("nobody is signed in without a session, rule or no rule", async () => {
  requireSecondWay();
  expect((await readViewer(auth, database, new Headers())).status).toBe(
    "signed-out",
  );
});

test("under the 2FA rule, a password alone cannot reach a passkey-only account", async () => {
  await auth.api.createUser({
    body: { email: "a@example.com", password, name: "A" },
  });
  addPasskey("a@example.com");
  expect((await signIn("a@example.com")).status).toBe(200);

  requireSecondWay();
  const refused = await signIn("a@example.com");
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ code: "PASSKEY_REQUIRED" });
});

test("a wrong password gets the same answer whatever the account has", async () => {
  await auth.api.createUser({
    body: { email: "a@example.com", password, name: "A" },
  });
  addPasskey("a@example.com");
  requireSecondWay();
  const response = await auth.handler(
    new Request(`${AUTH}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: AUTH },
      body: JSON.stringify({ email: "a@example.com", password: "wrong one" }),
    }),
  );
  expect(response.status).toBe(401);
});

async function deletePasskey(headers: Headers, id: string) {
  return auth.handler(
    new Request(`${AUTH}/api/auth/passkey/delete-passkey`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: headers.get("cookie") ?? "",
        origin: AUTH,
      },
      body: JSON.stringify({ id }),
    }),
  );
}

test("the server refuses to remove the last way in", async () => {
  const headers = await signedInHeaders("a@example.com");
  addPasskey("a@example.com");
  sqlite.run("DELETE FROM account");
  const response = await deletePasskey(headers, "key-a@example.com");
  expect(response.status).toBe(403);
  expect(sqlite.query("SELECT count(*) AS n FROM passkey").get()).toEqual({
    n: 1,
  });
});

test("the server refuses to remove what the 2FA rule depends on", async () => {
  const headers = await signedInHeaders("a@example.com");
  addPasskey("a@example.com");
  requireSecondWay();
  expect((await deletePasskey(headers, "key-a@example.com")).status).toBe(403);
});

test("a passkey can be removed when a password remains", async () => {
  const headers = await signedInHeaders("a@example.com");
  addPasskey("a@example.com");
  expect((await deletePasskey(headers, "key-a@example.com")).status).toBe(200);
  expect(sqlite.query("SELECT count(*) AS n FROM passkey").get()).toEqual({
    n: 0,
  });
});

test("Better Auth's admin routes are not reachable over HTTP, even for an admin", async () => {
  await auth.api.createUser({
    body: { email: "boss@example.com", password, name: "B", role: "admin" },
  });
  const cookies = (await signIn("boss@example.com")).headers.getSetCookie();
  const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
  for (const path of [
    "ban-user",
    "set-role",
    "remove-user",
    "impersonate-user",
  ]) {
    const response = await auth.handler(
      new Request(`${AUTH}/api/auth/admin/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: AUTH },
        body: JSON.stringify({ userId: "x" }),
      }),
    );
    expect(response.status).toBe(404);
  }
});
