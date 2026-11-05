// Invitation emails in the shapes Google Calendar and Outlook send, cut down to what
// Mail and Calendar read. Each property is spelled the way that app writes it.

export const DANA = "dana@partner.example.org";
export const SAM = "sam@contoso.example";
export const GOOGLE_INVITE_UID = "4fj2b1h8kq0c7m9r5t3v6x8z1a@google.com";
export const OUTLOOK_INVITE_UID =
  "040000008200E00074C5B7101A82E00800000000F0E1D2C3B4A5DA01000000000000000010000000AABBCCDDEEFF0011";
export const MEET = "https://meet.google.com/abc-defg-hij";
export const TEAMS =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_YmQ4%40thread.v2/0?context=%7b%22Tid%22%3a%2272f9%22%7d";

const CRLF = "\r\n";

// Cloudflare's verdict, as the first Authentication-Results header.
export const AUTH = {
  proved: (domain: string) =>
    `mx.cloudflare.net; dkim=pass header.d=${domain} header.s=s1 header.b=AbC; spf=pass smtp.mailfrom=${domain}; dmarc=pass header.from=${domain}`,
  // A failure the sender's domain doesn't enforce, so the message reaches the Inbox.
  failed: (domain: string) =>
    `mx.cloudflare.net; dkim=none; spf=softfail smtp.mailfrom=${domain}; dmarc=fail (p=none) header.from=${domain}`,
  // A failure the sender's domain enforces, which files the message in Spam.
  spam: (domain: string) =>
    `mx.cloudflare.net; dkim=none; spf=fail smtp.mailfrom=${domain}; dmarc=fail (p=reject dis=none) header.from=${domain}`,
};

const SYDNEY_ZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Australia/Sydney",
  "X-LIC-LOCATION:Australia/Sydney",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+1100",
  "TZOFFSETTO:+1000",
  "TZNAME:AEST",
  "DTSTART:19700405T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+1000",
  "TZOFFSETTO:+1100",
  "TZNAME:AEDT",
  "DTSTART:19701004T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
];

const WINDOWS_ZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:AUS Eastern Standard Time",
  "BEGIN:STANDARD",
  "DTSTART:16010401T030000",
  "TZOFFSETFROM:+1100",
  "TZOFFSETTO:+1000",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=4",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:16011007T020000",
  "TZOFFSETFROM:+1000",
  "TZOFFSETTO:+1100",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=10",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
];

export type Method = "REQUEST" | "CANCEL" | "REPLY";

export function googleCalendar(method: Method, ...events: string[][]) {
  return [
    "BEGIN:VCALENDAR",
    "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    ...SYDNEY_ZONE,
    ...events.flat(),
    "END:VCALENDAR",
    "",
  ].join(CRLF);
}

export function outlookCalendar(method: Method, ...events: string[][]) {
  return [
    "BEGIN:VCALENDAR",
    `METHOD:${method}`,
    "PRODID:Microsoft Exchange Server 2010",
    "VERSION:2.0",
    ...WINDOWS_ZONE,
    ...events.flat(),
    "END:VCALENDAR",
    "",
  ].join(CRLF);
}

type GoogleEvent = {
  uid?: string;
  sequence?: number;
  title?: string;
  start?: string;
  end?: string;
  status?: "CONFIRMED" | "CANCELLED";
  organiser?: string;
  // Each as Google writes the ATTENDEE line's value and PARTSTAT.
  guests?: [address: string, partstat: string, name?: string][];
  rule?: string;
  recurrenceId?: string;
  extra?: string[];
};

export function googleEvent(event: GoogleEvent = {}): string[] {
  const organiser = event.organiser ?? DANA;
  return [
    "BEGIN:VEVENT",
    `DTSTART;TZID=Australia/Sydney:${event.start ?? "20261110T100000"}`,
    `DTEND;TZID=Australia/Sydney:${event.end ?? "20261110T110000"}`,
    ...(event.rule ? [`RRULE:${event.rule}`] : []),
    ...(event.recurrenceId
      ? [`RECURRENCE-ID;TZID=Australia/Sydney:${event.recurrenceId}`]
      : []),
    "DTSTAMP:20261105T000000Z",
    `ORGANIZER;CN=Dana Wright:mailto:${organiser}`,
    `UID:${event.uid ?? GOOGLE_INVITE_UID}`,
    ...(
      event.guests ?? [
        [organiser, "ACCEPTED", "Dana Wright"],
        ["boss@example.com", "NEEDS-ACTION"],
      ]
    ).map(
      ([address, partstat, name]) =>
        `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=${partstat};RSVP=TRUE;CN=${name ?? address};X-NUM-GUESTS=0:mailto:${address}`,
    ),
    `X-GOOGLE-CONFERENCE:${MEET}`,
    "X-MICROSOFT-CDO-OWNERAPPTID:-1817839372",
    "CREATED:20261104T235900Z",
    `DESCRIPTION:-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-\\nJoin with Google Meet: ${MEET}\\n\\nLearn more about Meet at: https://support.google.com/a/users/answer/9282720\\n\\nPlease do not edit this section.\\n-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-`,
    "LAST-MODIFIED:20261105T000000Z",
    "LOCATION:",
    `SEQUENCE:${event.sequence ?? 0}`,
    `STATUS:${event.status ?? "CONFIRMED"}`,
    `SUMMARY:${event.title ?? "Supplier review"}`,
    "TRANSP:OPAQUE",
    ...(event.extra ?? []),
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:This is an event reminder",
    "TRIGGER:-P0DT0H10M0S",
    "END:VALARM",
    "END:VEVENT",
  ];
}

// Exchange writes the external link too, often empty, and a sip: address no browser opens.
export function outlookEvent(
  event: {
    teams?: string;
    external?: string;
    sequence?: number;
    status?: "CONFIRMED" | "CANCELLED";
    invitee?: string;
  } = {},
): string[] {
  return [
    "BEGIN:VEVENT",
    `ORGANIZER;CN=Sam Okafor:mailto:${SAM}`,
    `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Boss:mailto:${event.invitee ?? "boss@example.com"}`,
    "DESCRIPTION;LANGUAGE=en-US:\\n___________________________________________\\nMicrosoft Teams meeting\\nJoin on your computer\\, mobile app or room device\\nClick here to join the meeting <https://teams.microsoft.com/l/meetup-join/19%3ameeting_YmQ4%40thread.v2/0>\\n",
    `UID:${OUTLOOK_INVITE_UID}`,
    "SUMMARY;LANGUAGE=en-US:Quarterly planning",
    'DTSTART;TZID="AUS Eastern Standard Time":20261111T140000',
    'DTEND;TZID="AUS Eastern Standard Time":20261111T150000',
    "CLASS:PUBLIC",
    "PRIORITY:5",
    "DTSTAMP:20261105T010000Z",
    "TRANSP:OPAQUE",
    `STATUS:${event.status ?? "CONFIRMED"}`,
    `SEQUENCE:${event.sequence ?? 0}`,
    "LOCATION;LANGUAGE=en-US:Microsoft Teams Meeting",
    "X-MICROSOFT-CDO-APPT-SEQUENCE:0",
    "X-MICROSOFT-CDO-OWNERAPPTID:2124394122",
    "X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE",
    "X-MICROSOFT-CDO-INTENDEDSTATUS:BUSY",
    "X-MICROSOFT-CDO-ALLDAYEVENT:FALSE",
    "X-MICROSOFT-CDO-IMPORTANCE:1",
    "X-MICROSOFT-CDO-INSTTYPE:0",
    `X-MICROSOFT-SKYPETEAMSMEETINGURL:${event.teams ?? TEAMS}`,
    "X-MICROSOFT-SCHEDULINGSERVICEUPDATEURL:https://scheduler.teams.microsoft.com/teamsforbusiness/updatemeetinginfo",
    "X-MICROSOFT-SKYPETEAMSPROPERTIES:{}",
    "X-MICROSOFT-ONLINEMEETINGCONFLINK:conf:sip:sam@contoso.example\\;gruu\\;opaque=app:conf:focus:id:teams:2:0!19:meeting_YmQ4-thread.v2",
    `X-MICROSOFT-ONLINEMEETINGEXTERNALLINK:${event.external ?? ""}`,
    "X-MICROSOFT-DONOTFORWARDMEETING:FALSE",
    "X-MICROSOFT-DISALLOW-COUNTER:FALSE",
    "BEGIN:VALARM",
    "DESCRIPTION:REMINDER",
    "TRIGGER;RELATED=START:-PT15M",
    "ACTION:DISPLAY",
    "END:VALARM",
    "END:VEVENT",
  ];
}

// An answer, as Google Calendar sends one for a guest.
export function googleReply(
  uid: string,
  from: string,
  partstat: string,
  name = "Dana Wright",
  organiser = "boss@example.com",
): string {
  return googleCalendar("REPLY", [
    "BEGIN:VEVENT",
    "DTSTART;TZID=Australia/Sydney:20261110T100000",
    "DTEND;TZID=Australia/Sydney:20261110T110000",
    "DTSTAMP:20261105T020000Z",
    `ORGANIZER;CN=Boss:mailto:${organiser}`,
    `UID:${uid}`,
    `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=${partstat};CN=${name};X-NUM-GUESTS=0:mailto:${from}`,
    "SEQUENCE:0",
    "SUMMARY:Weekly planning",
    "END:VEVENT",
  ]);
}

const base64Lines = (text: string) =>
  (
    new TextEncoder()
      .encode(text)
      .toBase64()
      .match(/.{1,76}/g) ?? []
  ).join(CRLF);

export type InvitationEmail = {
  from: string;
  fromName?: string;
  to?: string;
  subject?: string;
  // The first Authentication-Results header, or none at all.
  auth: string | null;
  calendar: string;
  method: Method;
  // Google adds the same file as invite.ics, and Outlook sends base64.
  shape?: "google" | "outlook";
  messageId?: string;
  // More parts, already written, after the invitation.
  parts?: string[];
};

export function invitationEmail(email: InvitationEmail): string {
  const shape = email.shape ?? "google";
  const id = email.messageId ?? `${crypto.randomUUID()}@mail.example`;
  const calendarPart =
    shape === "google"
      ? [
          `Content-Type: text/calendar; charset="UTF-8"; method=${email.method}`,
          "Content-Transfer-Encoding: 7bit",
          "",
          email.calendar,
        ]
      : [
          `Content-Type: text/calendar; charset="utf-8"; method=${email.method}`,
          "Content-Transfer-Encoding: base64",
          "",
          base64Lines(email.calendar),
        ];
  const alternative = [
    "--alt",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    "You have been invited to an event.",
    "--alt",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    "<p>You have been invited to an event.</p>",
    "--alt",
    ...calendarPart,
    "--alt--",
  ];
  const file =
    shape === "google"
      ? [
          "--mixed",
          'Content-Type: application/ics; name="invite.ics"',
          'Content-Disposition: attachment; filename="invite.ics"',
          "Content-Transfer-Encoding: base64",
          "",
          base64Lines(email.calendar),
        ]
      : [];
  return [
    ...(email.auth ? [`Authentication-Results: ${email.auth}`] : []),
    `From: ${email.fromName ?? "Dana Wright"} <${email.from}>`,
    `To: ${email.to ?? "boss@example.com"}`,
    `Subject: ${email.subject ?? "Invitation: Supplier review"}`,
    "Date: Thu, 05 Nov 2026 00:00:00 +0000",
    `Message-ID: <${id}>`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="mixed"',
    "",
    "--mixed",
    'Content-Type: multipart/alternative; boundary="alt"',
    "",
    ...alternative,
    ...file,
    ...(email.parts ?? []).flatMap((part) => ["--mixed", part]),
    "--mixed--",
    "",
  ].join(CRLF);
}

// One more calendar part, attached as a file.
export const calendarAttachment = (calendar: string, name = "event.ics") =>
  [
    `Content-Type: text/calendar; charset="UTF-8"; name="${name}"`,
    `Content-Disposition: attachment; filename="${name}"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(calendar),
  ].join(CRLF);
