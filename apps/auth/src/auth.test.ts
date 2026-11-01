import type { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { createTestDatabase } from "../../../src/db/test-database";
import { createAuth } from "./auth";
import { appOrigins } from "./origins";

const AUTH = "https://auth.example.com";
const password = "a long enough password";

let sqlite: Database;
let auth: ReturnType<typeof createAuth>;

beforeEach(() => {
  let d1: D1Database;
  ({ sqlite, d1 } = createTestDatabase());
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
