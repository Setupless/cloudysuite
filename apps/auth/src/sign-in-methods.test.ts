import { expect, test } from "bun:test";
import {
  isEnrolled,
  removalRefusal,
  type SignInMethods,
} from "./sign-in-methods";

const methods = (partial: Partial<SignInMethods>): SignInMethods => ({
  passkeys: 0,
  password: true,
  authenticator: false,
  ...partial,
});

test("a passkey or an authenticator app counts as a second way, a password doesn't", () => {
  expect(isEnrolled(methods({}))).toBe(false);
  expect(isEnrolled(methods({ passkeys: 1 }))).toBe(true);
  expect(isEnrolled(methods({ authenticator: true }))).toBe(true);
});

test.each([
  [
    "last passkey with no password",
    methods({ passkeys: 1, password: false }),
    "passkey",
    false,
    true,
  ],
  [
    "a spare passkey with no password",
    methods({ passkeys: 2, password: false }),
    "passkey",
    false,
    false,
  ],
  [
    "last passkey with a password",
    methods({ passkeys: 1 }),
    "passkey",
    false,
    false,
  ],
  [
    "last passkey under the rule",
    methods({ passkeys: 1 }),
    "passkey",
    true,
    true,
  ],
  [
    "last passkey under the rule, app still on",
    methods({ passkeys: 1, authenticator: true }),
    "passkey",
    true,
    false,
  ],
  [
    "the app under the rule with no passkey",
    methods({ authenticator: true }),
    "authenticator",
    true,
    true,
  ],
  [
    "the app under the rule with a passkey",
    methods({ passkeys: 1, authenticator: true }),
    "authenticator",
    true,
    false,
  ],
  [
    "the app with no rule",
    methods({ authenticator: true }),
    "authenticator",
    false,
    false,
  ],
] as const)("removing %s", (_, current, removal, rule, refused) => {
  expect(removalRefusal(current, removal, rule) !== null).toBe(refused);
});
