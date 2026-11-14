import type { BoardId } from "@cloudysuite/access";
import {
  CRLF,
  domainOf,
  type EmailPerson,
  escapeHtml,
  headerText,
  mailbox,
  multipart,
  oneLine,
  part,
} from "@cloudysuite/app-email";
import type { PlainDate, TaskId } from "../types";

export type AssignmentEmail = {
  from: EmailPerson;
  to: EmailPerson;
  title: string;
  boardName: string;
  due: PlainDate | null;
  link: string;
  now: number;
  // Unique to this email.
  id: string;
};

// The board's page, with the task's panel open.
export function taskLink(
  appDomain: string,
  boardId: BoardId,
  taskId: TaskId,
): string {
  const url = new URL(`https://tasks.${appDomain}/boards/${boardId}`);
  url.searchParams.set("task", taskId);
  return url.href;
}

// Written on the server, which has no reader's language, so in the organisation's own
// English. A due date is a day, the same everywhere.
function dueText(due: PlainDate, now: number): string {
  const day = new Date(`${due}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(day.getUTCFullYear() === new Date(now).getUTCFullYear()
      ? {}
      : { year: "numeric" }),
    timeZone: "UTC",
  }).format(day);
}

const nameOf = (person: EmailPerson) => person.name || person.address;

function wordsOf(email: AssignmentEmail) {
  return {
    subject: `${nameOf(email.from)} assigned you a task`,
    opening: `${nameOf(email.from)} assigned you a task on ${email.boardName}.`,
    details: [
      ["Task", email.title],
      ["Board", email.boardName],
      ...(email.due ? [["Due", dueText(email.due, email.now)]] : []),
    ] as [string, string][],
  };
}

// Every word in it came from someone, so all of it is escaped text and none is markup.
function htmlText(words: ReturnType<typeof wordsOf>, link: string): string {
  const rows = words.details
    .map(
      ([label, value]) =>
        `<tr><th align="left" valign="top" style="padding:2px 16px 2px 0;font-weight:normal">${escapeHtml(label)}</th><td style="padding:2px 0">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  return [
    "<!DOCTYPE html>",
    '<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;font-size:14px;line-height:1.5">',
    `<p>${escapeHtml(words.opening)}</p>`,
    `<table role="presentation" cellspacing="0" cellpadding="0">${rows}</table>`,
    `<p><a href="${escapeHtml(link)}">Open task</a></p>`,
    "</body></html>",
  ].join("\n");
}

export function assignmentMime(email: AssignmentEmail): {
  subject: string;
  raw: string;
} {
  const words = wordsOf(email);
  const plain = [
    words.opening,
    "",
    ...words.details.map(([label, value]) => `${label}: ${value}`),
    "",
    `Open task: ${email.link}`,
  ].join("\n");
  const raw = [
    `From: ${mailbox(email.from)}`,
    `To: ${mailbox(email.to)}`,
    `Subject: ${headerText(words.subject)}`,
    `Date: ${new Date(email.now).toUTCString()}`,
    `Message-ID: <${email.id}@${domainOf(email.from.address)}>`,
    "MIME-Version: 1.0",
    multipart("alternative", `alt-${email.id}`, [
      part(["Content-Type: text/plain; charset=UTF-8"], plain),
      part(
        ["Content-Type: text/html; charset=UTF-8"],
        htmlText(words, email.link),
      ),
    ]),
  ].join(CRLF);
  return { subject: oneLine(words.subject), raw };
}
