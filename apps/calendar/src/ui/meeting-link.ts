import { withLinks } from "./event-text";

export type MeetingService =
  "Google Meet" | "Microsoft Teams" | "Zoom" | "Webex";

export type MeetingSources = {
  conference: string | null;
  location: string;
  notes: string;
};

// Where the link came from. A link from the place or notes is already on screen there.
export type MeetingLink = {
  service: MeetingService;
  url: string;
  from: keyof MeetingSources;
};

const HOSTS: { host: string; subdomains: boolean; service: MeetingService }[] =
  [
    { host: "meet.google.com", subdomains: false, service: "Google Meet" },
    {
      host: "teams.microsoft.com",
      subdomains: false,
      service: "Microsoft Teams",
    },
    { host: "teams.live.com", subdomains: false, service: "Microsoft Teams" },
    { host: "zoom.us", subdomains: true, service: "Zoom" },
    { host: "webex.com", subdomains: true, service: "Webex" },
  ];

// The URL parser lowercases the host, turns a look-alike in another script into
// punycode, and drops the default port, so an exact match on what it gives is enough.
function meetingAt(
  candidate: string,
  from: MeetingLink["from"],
): MeetingLink | null {
  const url = URL.parse(candidate.trim());
  if (
    !url ||
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  const entry = HOSTS.find(
    ({ host, subdomains }) =>
      url.hostname === host ||
      (subdomains && url.hostname.endsWith(`.${host}`)),
  );
  return entry ? { service: entry.service, url: url.href, from } : null;
}

function meetingIn(
  text: string,
  from: MeetingLink["from"],
): MeetingLink | null {
  for (const segment of withLinks(text)) {
    const found = segment.kind === "link" && meetingAt(segment.href, from);
    if (found) return found;
  }
  return null;
}

// A cancelled event or date has no meeting to join.
export function meetingLink({
  conference,
  location,
  notes,
  cancelled,
}: MeetingSources & { cancelled: boolean }): MeetingLink | null {
  if (cancelled) return null;
  return (
    (conference === null ? null : meetingAt(conference, "conference")) ??
    meetingIn(location, "location") ??
    meetingIn(notes, "notes")
  );
}
