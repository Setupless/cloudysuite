import { expect, test } from "bun:test";
import type { UserId } from "@cloudysuite/access";
import { redirect } from "@tanstack/react-router";
import { APP_OFF_HEADER } from "../../../src/routing";
import { createRememberedUser } from "./remembered-user";
import type { SignedIn } from "./session";

const person = (id: string, changes: Partial<SignedIn> = {}): SignedIn => ({
  id: id as UserId,
  name: id,
  email: `${id}@example.com`,
  role: "admin",
  apps: { auth: "https://auth.example.com/", calendar: "https://c.example/" },
  ...changes,
});

const ADA = person("ada");

// The server's answer to each session check, in order. Anything thrown is thrown.
function browserWith(answers: unknown[]) {
  const seen = { checks: 0, reloads: 0, refreshes: 0 };
  let online = true;
  const copy = createRememberedUser({
    ask: async () => {
      seen.checks++;
      const answer = answers.shift();
      if (answer instanceof Error || answer instanceof Response) throw answer;
      return answer as SignedIn;
    },
    reload: () => seen.reloads++,
    online: () => online,
  });
  copy.watch({
    app: "calendar",
    path: () => "/schedule",
    refresh: async () => seen.refreshes++,
  });
  return {
    copy,
    seen,
    goOffline: () => {
      online = false;
    },
  };
}

const never = (): Promise<SignedIn> => {
  throw new Error("This load should not ask the server.");
};

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const appOff = () =>
  new Response(null, {
    status: 403,
    headers: { [APP_OFF_HEADER]: "calendar" },
  });

test("clicks before the first answer arrives share one session check", async () => {
  const { copy, seen } = browserWith([]);
  let asked = 0;
  const ask = async () => {
    asked++;
    return ADA;
  };
  const answers = await Promise.all([
    copy.require(ask),
    copy.require(ask),
    copy.require(ask),
  ]);
  expect(asked).toBe(1);
  expect(answers).toEqual([ADA, ADA, ADA]);
  expect(seen.checks).toBe(0);
});

test("a session check that fails is asked again on the next click", async () => {
  const { copy } = browserWith([]);
  await expect(
    copy.require(async () => {
      throw new TypeError("Failed to fetch");
    }),
  ).rejects.toThrow("Failed to fetch");
  expect(await copy.require(async () => ADA)).toEqual(ADA);
});

test("a click after the first page uses the first page's answer", async () => {
  const { copy } = browserWith([]);
  copy.remember(ADA);
  expect(await copy.require(never)).toEqual(ADA);
});

test("coming back after someone else signed in loads the page again", async () => {
  const { copy, seen } = browserWith([person("grace")]);
  copy.remember(ADA);
  expect(await copy.recheck()).toBe(true);
  expect(seen).toEqual({ checks: 1, reloads: 1, refreshes: 0 });
});

test("coming back after a role or app change updates the page in place", async () => {
  const demoted = person("ada", { role: "user" });
  const { copy, seen } = browserWith([demoted]);
  copy.remember(ADA);
  expect(await copy.recheck()).toBe(true);
  expect(seen).toEqual({ checks: 1, reloads: 0, refreshes: 1 });
  expect(await copy.require(never)).toEqual(demoted);

  const { copy: other, seen: otherSeen } = browserWith([
    person("ada", { apps: { auth: "https://auth.example.com/" } }),
  ]);
  other.remember(ADA);
  expect(await other.recheck()).toBe(true);
  expect(otherSeen.refreshes).toBe(1);
});

test("coming back as the same person changes nothing", async () => {
  const { copy, seen } = browserWith([person("ada")]);
  copy.remember(ADA);
  expect(await copy.recheck()).toBe(false);
  expect(seen).toEqual({ checks: 1, reloads: 0, refreshes: 0 });
});

test("coming back after signing out runs the page's own check, as a click would", async () => {
  const { copy, seen } = browserWith([
    redirect({ href: "https://auth.example.com/sign-in" }),
  ]);
  copy.remember(ADA);
  expect(await copy.recheck()).toBe(true);
  expect(seen).toEqual({ checks: 1, reloads: 0, refreshes: 1 });
  let asked = false;
  await copy.require(async () => {
    asked = true;
    return ADA;
  });
  expect(asked).toBe(true);
});

test("coming back with no connection keeps the page as it is", async () => {
  const failing = browserWith([new TypeError("Failed to fetch")]);
  failing.copy.remember(ADA);
  expect(await failing.copy.recheck()).toBe(false);
  expect(await failing.copy.require(never)).toEqual(ADA);

  const offline = browserWith([]);
  offline.copy.remember(ADA);
  offline.goOffline();
  expect(await offline.copy.recheck()).toBe(false);
  expect(offline.seen.checks).toBe(0);
});

test("returning to and refusing at the same time asks the server once", async () => {
  const { copy, seen } = browserWith([person("ada")]);
  copy.remember(ADA);
  await Promise.all([copy.recheck(), copy.recheck()]);
  expect(seen.checks).toBe(1);
});

test("losing one calendar shows the refusal without loading again", async () => {
  const { copy, seen } = browserWith([person("ada"), person("ada")]);
  copy.remember(ADA);
  const refusedQuery = {};
  for (let refresh = 0; refresh < 3; refresh++) {
    copy.noticeRefusal(
      { status: 403, appOff: false },
      { from: refusedQuery, opening: true },
    );
    await settled();
  }
  expect(seen).toEqual({ checks: 1, reloads: 0, refreshes: 0 });
  copy.noticeRefusal(
    { status: 403, appOff: false },
    { from: {}, opening: false },
  );
  await settled();
  expect(seen).toEqual({ checks: 2, reloads: 0, refreshes: 0 });
});

test("a refusal after two-step sign-in became required sends the person on", async () => {
  const { copy, seen } = browserWith([
    redirect({ href: "https://auth.example.com/enrol" }),
  ]);
  copy.remember(ADA);
  copy.noticeRefusal(
    { status: 403, appOff: false },
    { from: {}, opening: true },
  );
  await settled();
  expect(seen).toEqual({ checks: 1, reloads: 0, refreshes: 1 });
});

test("an app turned off sends a page that couldn't open to the off page", async () => {
  const { copy, seen } = browserWith([]);
  copy.remember(ADA);
  copy.noticeRefusal(
    { status: 403, appOff: true },
    { from: {}, opening: true },
  );
  expect(seen.reloads).toBe(1);
});

test("an app turned off leaves an open page alone until the next click", async () => {
  const { copy, seen } = browserWith([]);
  copy.remember(ADA);
  copy.noticeRefusal(
    { status: 403, appOff: true },
    { from: {}, opening: false },
  );
  expect(seen.reloads).toBe(0);
  await expect(
    copy.require(() => Promise.reject(appOff())),
  ).rejects.toBeInstanceOf(Response);
});

test("coming back to an app that was turned off asks on the next click", async () => {
  const { copy, seen } = browserWith([appOff()]);
  copy.remember(ADA);
  expect(await copy.recheck()).toBe(false);
  expect(seen.reloads).toBe(0);
  let asked = false;
  await copy.require(async () => {
    asked = true;
    return ADA;
  });
  expect(asked).toBe(true);
});

test("refusals that arrive while the page loads again don't start it over", async () => {
  const { copy, seen } = browserWith([person("grace")]);
  copy.remember(ADA);
  const refused = { status: 403, appOff: false };
  copy.noticeRefusal(refused, { from: {}, opening: true });
  await settled();
  copy.noticeRefusal(refused, { from: {}, opening: true });
  copy.noticeRefusal(
    { status: 403, appOff: true },
    { from: {}, opening: true },
  );
  await settled();
  expect(seen).toEqual({ checks: 1, reloads: 1, refreshes: 0 });
});
