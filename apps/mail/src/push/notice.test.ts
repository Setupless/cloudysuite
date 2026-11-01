import { expect, test } from "bun:test";
import { notificationFor, parsePushMessage, plainText } from "./notice";

const MAILBOX = "6f1d2c1e-8a0b-4d7e-9c55-0a1b2c3d4e5f";
const message = {
  to: "user-a",
  mailboxId: MAILBOX,
  kind: "message",
  threadId: 7,
  messageId: 9,
  sender: "Alice",
  subject: "Lunch?",
};

test("a click on a message opens that conversation on the same host", () => {
  const parsed = parsePushMessage(message);
  expect(parsed && notificationFor(parsed)).toEqual({
    title: "Alice",
    body: "Lunch?",
    tag: `message-${MAILBOX}-9`,
    path: `/${MAILBOX}/inbox/7`,
  });
});

test("several messages at once become one notification for the inbox", () => {
  const parsed = parsePushMessage({
    to: "user-a",
    mailboxId: MAILBOX,
    kind: "summary",
    count: 12,
  });
  expect(parsed && notificationFor(parsed)).toEqual({
    title: "12 new messages",
    body: "Open Mail to read them.",
    tag: `mailbox-${MAILBOX}`,
    path: `/${MAILBOX}/inbox`,
  });
});

test.each([
  ["a path in the mailbox id", { mailboxId: "//evil.example/x" }],
  ["a script URL in the mailbox id", { mailboxId: "javascript:alert(1)" }],
  ["a path in the thread id", { threadId: "//evil.example" }],
  ["a negative thread id", { threadId: -1 }],
  ["a sender that isn't text", { sender: { toString: "x" } }],
  ["no owner", { to: "" }],
  ["an unknown kind", { kind: "url" }],
])("a push with %s shows nothing", (_name, change) => {
  expect(parsePushMessage({ ...message, ...change })).toBeNull();
});

test("anything that isn't a push message shows nothing", () => {
  for (const raw of [null, undefined, "text", 5, []]) {
    expect(parsePushMessage(raw)).toBeNull();
  }
});

test("a URL field a sender slipped in cannot steer the click", () => {
  const parsed = parsePushMessage({
    ...message,
    path: "https://evil.example",
    url: "https://evil.example",
  });
  expect(parsed && notificationFor(parsed).path).toBe(`/${MAILBOX}/inbox/7`);
});

test("markup stays as visible text and direction tricks are removed", () => {
  const parsed = parsePushMessage({
    ...message,
    sender: "Bank‮gnp.exe\u0000 <b>Support</b>",
    subject: "Line one\r\nLine two​",
  });
  expect(parsed && notificationFor(parsed)).toMatchObject({
    title: "Bank gnp.exe <b>Support</b>",
    body: "Line one Line two",
  });
});

test("long text is cut, and an empty message still reads plainly", () => {
  expect(Array.from(plainText("😀".repeat(500), 10))).toHaveLength(10);
  const parsed = parsePushMessage({
    ...message,
    sender: "\u0000",
    subject: "",
  });
  expect(parsed && notificationFor(parsed)).toMatchObject({
    title: "New message",
    body: "(No subject)",
  });
});
