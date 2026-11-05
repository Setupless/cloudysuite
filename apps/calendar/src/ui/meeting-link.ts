import { withLinks } from "./event-text";

export type MeetingService =
  "Google Meet" | "Microsoft Teams" | "Zoom" | "Webex";

export type MeetingLink = { service: MeetingService; url: string };

export type MeetingSources = {
  conference: string | null;
  location: string;
  notes: string;
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
function meetingAt(candidate: string): MeetingLink | null {
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
  return entry ? { service: entry.service, url: url.href } : null;
}

function meetingIn(text: string): MeetingLink | null {
  for (const segment of withLinks(text)) {
    const found = segment.kind === "link" && meetingAt(segment.href);
    if (found) return found;
  }
  return null;
}

export function meetingLink({
  conference,
  location,
  notes,
}: MeetingSources): MeetingLink | null {
  return (
    (conference === null ? null : meetingAt(conference)) ??
    meetingIn(location) ??
    meetingIn(notes)
  );
}
