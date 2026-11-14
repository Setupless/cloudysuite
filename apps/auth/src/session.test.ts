import { beforeAll, expect, mock, test } from "bun:test";
import type { UserId } from "@cloudysuite/access";
import { testWorkerEnv } from "../../../src/db/test-database";
import { readRequestFrom } from "../../../src/test-server-fn";
import { createKit } from "./admin/test-kit";

mock.module("cloudflare:workers", () => ({
  env: testWorkerEnv,
  DurableObject: class {},
}));

// The session ended on the server, and each session check that reads it counts.
const asked = { checks: 0 };
readRequestFrom(() => {
  asked.checks++;
  return new Request("https://calendar.example.com/");
});

const { recheckRememberedUser, rememberUser, watchRememberedUser } =
  await import("./session");

beforeAll(async () => {
  const kit = await createKit();
  Object.assign(testWorkerEnv, {
    DB: kit.database,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
  });
});

const ADA = {
  id: "ada" as UserId,
  name: "Ada",
  email: "ada@example.com",
  role: "admin" as const,
  apps: { calendar: "https://calendar.example.com/" },
};

// A tab whose visibility and focus the test changes as a browser would.
function tab() {
  const page = new EventTarget();
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    focused: true,
    hasFocus: () => doc.focused,
  });
  const globals: Record<string, unknown> = {
    document: doc,
    addEventListener: page.addEventListener.bind(page),
    location: { pathname: "/schedule", search: "", hash: "" },
    navigator: { onLine: true },
  };
  const before = Object.fromEntries(
    Object.keys(globals).map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const router = { refreshes: 0 };
  rememberUser(ADA);
  asked.checks = 0;
  watchRememberedUser("calendar", {
    invalidate: async () => router.refreshes++,
  });
  return {
    router,
    hide: () => {
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
    },
    show: () => {
      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
    },
    blur: (intoFrame: boolean) => {
      doc.focused = intoFrame;
      page.dispatchEvent(new Event("blur"));
    },
    focus: () => {
      doc.focused = true;
      page.dispatchEvent(new Event("focus"));
    },
    // A check here finds the session ended and drops the copy, so no later test file
    // starts with this one's person.
    restore: async () => {
      await recheckRememberedUser();
      for (const [name, descriptor] of Object.entries(before)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

const settled = async () => {
  for (let step = 0; step < 5; step++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

test("coming back to the tab after the session ended sends the page on", async () => {
  const browser = tab();
  try {
    browser.hide();
    browser.show();
    await settled();
    expect(asked.checks).toBe(1);
    expect(browser.router.refreshes).toBe(1);
  } finally {
    await browser.restore();
  }
});

test("coming back to the window after using another one checks too", async () => {
  const browser = tab();
  try {
    browser.blur(false);
    browser.focus();
    await settled();
    expect(asked.checks).toBe(1);
    expect(browser.router.refreshes).toBe(1);
  } finally {
    await browser.restore();
  }
});

test("focus that moves into a message and back stays on the page", async () => {
  const browser = tab();
  try {
    browser.blur(true);
    browser.focus();
    browser.focus();
    await settled();
    expect(asked.checks).toBe(0);
    expect(browser.router.refreshes).toBe(0);
  } finally {
    await browser.restore();
  }
});
