import {
  CRLF,
  domainOf,
  escapeHtml,
  headerText,
  mailbox,
  multipart,
  oneLine,
  part,
} from "@cloudysuite/app-email";
import type { DeliveredPart, EmailPlan } from "../invitations";
import { repeatOf } from "../repeat";
import { addDays } from "../time";
import type { EventTime, GivenAnswer, RepeatFrequency } from "../types";
import { type IcsAttendee, type IcsPerson, invitationIcs } from "./ics";

// One invitation email as raw MIME, laid out the way Google Calendar's are: text, HTML,
// and the invitation itself as alternatives, then the same file to download. Outlook
// and Gmail show their answer buttons from the text/calendar alternative.

export type SendablePlan = Exclude<EmailPlan, { method: "none" }>;

export type InvitationEmail = {
  plan: SendablePlan;
  from: IcsPerson;
  to: IcsPerson;
  // Everyone invited who has an address, for a request.
  attendees: IcsAttendee[];
  now: number;
  // Unique to this email.
  id: string;
};

const REPEATS: Record<RepeatFrequency, string> = {
  daily: "Every day",
  weekdays: "Every weekday",
  weekly: "Every week",
  fortnightly: "Every fortnight",
  monthly: "Every month",
  yearly: "Every year",
};

// Written on the server, which has no reader's language, so in the organisation's own
// English, on the event's own clock.
function dayText(date: Date, zone: string, withYear: boolean): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: zone,
  }).format(date);
}

const clockText = (date: Date, zone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: zone,
  }).format(date);

const yearOf = (date: Date, zone: string) =>
  new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone: zone }).format(
    date,
  );

// "Tue 10 Nov, 10:00 to 11:00 (Australia/Sydney)"
function whenText(time: EventTime, now: number): string {
  if (time.kind === "allDay") {
    const first = new Date(`${time.startDate}T00:00:00Z`);
    const last = new Date(`${addDays(time.endDate, -1)}T00:00:00Z`);
    const withYear =
      yearOf(first, "UTC") !== yearOf(new Date(now), "UTC") ||
      yearOf(last, "UTC") !== yearOf(first, "UTC");
    const firstText = dayText(first, "UTC", withYear);
    return time.startDate === addDays(time.endDate, -1)
      ? `${firstText}, all day`
      : `${firstText} to ${dayText(last, "UTC", withYear)}, all day`;
  }
  const zone = time.timeZone;
  const start = new Date(time.start);
  const end = new Date(time.end);
  const withYear = yearOf(start, zone) !== yearOf(new Date(now), zone);
  const startDay = dayText(start, zone, withYear);
  const endDay = dayText(
    end,
    zone,
    withYear || yearOf(end, zone) !== yearOf(start, zone),
  );
  const range =
    startDay === endDay
      ? `${startDay}, ${clockText(start, zone)} to ${clockText(end, zone)}`
      : `${startDay}, ${clockText(start, zone)} to ${endDay}, ${clockText(end, zone)}`;
  return `${range} (${zone})`;
}

function repeatLine(series: DeliveredPart): string | null {
  if (series.rule === null) return null;
  const repeat = repeatOf(series.rule, series.time);
  if (repeat.frequency === "custom") return "Repeats";
  const every = REPEATS[repeat.frequency];
  switch (repeat.end.kind) {
    case "never":
      return every;
    case "onDate":
      return `${every} until ${dayText(new Date(`${repeat.end.date}T00:00:00Z`), "UTC", true)}`;
    case "afterTimes":
      return `${every}, ${repeat.end.times} times in all`;
  }
}

const nameOf = (person: IcsPerson) => person.name || person.address;

// The words Google Calendar and Outlook use, so a reply reads the way people expect.
const REPLY_WORDS: Record<GivenAnswer, { subject: string; said: string }> = {
  yes: { subject: "Accepted", said: "accepted" },
  maybe: { subject: "Tentatively accepted", said: "tentatively accepted" },
  no: { subject: "Declined", said: "declined" },
};

type Words = {
  subject: string;
  opening: string;
  details: [string, string][];
  notes: string;
  closing: string | null;
};

function wordsOf(email: InvitationEmail): Words {
  const { plan, from, now } = email;
  const series =
    plan.method === "request"
      ? plan.parts[0]!
      : plan.method === "cancel" && plan.why === "dateCancelled"
        ? plan.date
        : plan.series;
  const title = series.title;
  const when = whenText(series.time, now);
  const organiser = nameOf(from);
  const repeats = repeatLine(series);
  const details: [string, string][] = [
    ["When", when],
    ...(repeats ? [["Repeats", repeats] as [string, string]] : []),
    ...(series.location
      ? [["Where", series.location] as [string, string]]
      : []),
  ];
  if (plan.method === "request") {
    const changed = plan.parts.length - 1;
    const who = [
      `${organiser} (organiser)`,
      ...email.attendees.map(nameOf),
    ].join(", ");
    return {
      subject: `${plan.first ? "Invitation" : "Updated invitation"}: ${title}, ${when}`,
      opening: plan.first
        ? `${organiser} invited you to ${title}.`
        : `${organiser} changed ${title}. This is the event as it is now.`,
      details: [
        ...details,
        ...(changed > 0
          ? [
              [
                "Changed dates",
                changed === 1
                  ? "1 date is different, which your calendar shows"
                  : `${changed} dates are different, which your calendar shows`,
              ] as [string, string],
            ]
          : []),
        ["Who", who],
      ],
      notes: series.notes,
      closing: "Answer Yes, Maybe, or No from your calendar or mail app.",
    };
  }
  if (plan.method === "reply") {
    const { subject, said } = REPLY_WORDS[plan.answer];
    return {
      subject: `${subject}: ${title}, ${when}`,
      opening: `${nameOf(from)} ${said} ${title}.`,
      details,
      notes: "",
      closing: null,
    };
  }
  return {
    subject: `Cancelled: ${title}, ${when}`,
    opening: {
      uninvited: `${organiser} took you off the list for ${title}, so you're no longer invited.`,
      dateCancelled: `${organiser} cancelled ${title} on this date only. The other dates haven't changed.`,
      deleted: `${organiser} cancelled ${title}.`,
      calendarDeleted: `${organiser} cancelled ${title}.`,
    }[plan.why],
    details,
    notes: "",
    closing: null,
  };
}

function plainText(words: Words): string {
  return [
    words.opening,
    "",
    ...words.details.map(([label, value]) => `${label}: ${value}`),
    ...(words.notes ? ["", "Notes:", words.notes] : []),
    ...(words.closing ? ["", words.closing] : []),
  ].join("\n");
}

// Every word in it came from someone, so all of it is escaped text and none is markup.
function htmlText(words: Words): string {
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
    ...(words.notes
      ? [`<p style="white-space:pre-wrap">${escapeHtml(words.notes)}</p>`]
      : []),
    ...(words.closing ? [`<p>${escapeHtml(words.closing)}</p>`] : []),
    "</body></html>",
  ].join("\n");
}

export function invitationMime(email: InvitationEmail): {
  subject: string;
  raw: string;
} {
  const words = wordsOf(email);
  const { plan } = email;
  const method = plan.method.toUpperCase();
  // A reply goes from someone invited to the organiser.
  const ics = invitationIcs({
    plan,
    organiser: plan.method === "reply" ? email.to : email.from,
    attendees:
      plan.method === "request"
        ? email.attendees
        : plan.method === "reply"
          ? [{ ...email.from, answer: plan.answer }]
          : [{ ...email.to, answer: "needsAnswer" }],
    stamp: email.now,
  });
  const body = multipart("mixed", `mixed-${email.id}`, [
    multipart("alternative", `alt-${email.id}`, [
      part(["Content-Type: text/plain; charset=UTF-8"], plainText(words)),
      part(["Content-Type: text/html; charset=UTF-8"], htmlText(words)),
      part(
        [`Content-Type: text/calendar; charset=UTF-8; method=${method}`],
        ics,
      ),
    ]),
    part(
      [
        'Content-Type: application/ics; name="invite.ics"',
        'Content-Disposition: attachment; filename="invite.ics"',
      ],
      ics,
    ),
  ]);
  const raw = [
    `From: ${mailbox(email.from)}`,
    `To: ${mailbox(email.to)}`,
    `Subject: ${headerText(words.subject)}`,
    `Date: ${new Date(email.now).toUTCString()}`,
    `Message-ID: <${email.id}@${domainOf(email.from.address)}>`,
    "MIME-Version: 1.0",
    body,
  ].join(CRLF);
  return { subject: oneLine(words.subject), raw };
}
