import { expect, test } from "bun:test";
import { type MeetingService, meetingLink } from "./meeting-link";

const MEET = "https://meet.google.com/abc-defg-hij";
const TEAMS =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0";
const ZOOM = "https://us04web.zoom.us/j/71695031152?pwd=T0g1d0JDZ";

const inPlace = (location: string) =>
  meetingLink({ conference: null, location, notes: "" });

const joins: [string, MeetingService, string][] = [
  [MEET, "Google Meet", MEET],
  ["https://MEET.Google.COM/abc-defg-hij", "Google Meet", MEET],
  [`${MEET}?authuser=0&hs=122`, "Google Meet", `${MEET}?authuser=0&hs=122`],
  ["https://meet.google.com:443/abc-defg-hij", "Google Meet", MEET],
  [TEAMS, "Microsoft Teams", TEAMS],
  [
    "https://teams.microsoft.com/meet/2153718?p=Xyz",
    "Microsoft Teams",
    "https://teams.microsoft.com/meet/2153718?p=Xyz",
  ],
  [
    "https://teams.live.com/meet/9876543210",
    "Microsoft Teams",
    "https://teams.live.com/meet/9876543210",
  ],
  ["https://zoom.us/j/123456789", "Zoom", "https://zoom.us/j/123456789"],
  [ZOOM, "Zoom", ZOOM],
  ["https://webex.com/meet/sam", "Webex", "https://webex.com/meet/sam"],
  [
    "https://cisco.webex.com/cisco/j.php?MTID=m4f4fb566",
    "Webex",
    "https://cisco.webex.com/cisco/j.php?MTID=m4f4fb566",
  ],
];

test.each(joins)("%s joins %s", (link, service, url) => {
  expect(inPlace(link)).toEqual({ service, url, from: "location" });
});

const noJoin: [string, string][] = [
  ["plain http", "http://meet.google.com/abc-defg-hij"],
  ["another scheme", "ftp://meet.google.com/abc-defg-hij"],
  ["a longer host", "https://meet.google.com.evil.com/abc-defg-hij"],
  ["a host in the path", "https://evil.com/meet.google.com"],
  ["a host in the query", "https://evil.com/?next=https://meet.google.com/x"],
  ["a host as userinfo", "https://meet.google.com@evil.com/abc-defg-hij"],
  ["the real host after a backslash", "https://evil.com\\@meet.google.com"],
  ["userinfo on the real host", "https://sam@meet.google.com/abc-defg-hij"],
  ["a password on the real host", "https://sam:pw@zoom.us/j/1"],
  ["a port", "https://meet.google.com:8443/abc-defg-hij"],
  ["a port on a subdomain", "https://us04web.zoom.us:444/j/1"],
  ["a Cyrillic look-alike", "https://meet.gооgle.com/abc-defg-hij"],
  ["a punycode look-alike", "https://meet.xn--ggle-55da.com/abc-defg-hij"],
  ["a digit look-alike", "https://meet.goog1e.com/abc-defg-hij"],
  ["a sibling Google host", "https://docs.google.com/document/d/1"],
  ["a subdomain of Meet", "https://evil.meet.google.com/abc"],
  ["a subdomain of Teams", "https://evil.teams.microsoft.com/l/1"],
  ["a bare parent domain", "https://microsoft.com/teams"],
  ["a domain ending in zoom.us", "https://evilzoom.us/j/1"],
  ["a domain ending in webex.com", "https://notwebex.com/meet/sam"],
  ["zoom.us under another domain", "https://zoom.us.evil.com/j/1"],
  ["a trailing dot", "https://meet.google.com./abc-defg-hij"],
  ["an IP address", "https://142.250.70.110/abc-defg-hij"],
  ["no link at all", "Room 4, second floor"],
];

test.each(noJoin)("%s gets no Join button", (_, link) => {
  expect(inPlace(link)).toBeNull();
  expect(meetingLink({ conference: link, location: "", notes: "" })).toBeNull();
  expect(
    meetingLink({ conference: null, location: "", notes: `Join ${link}` }),
  ).toBeNull();
});

// The URL parser reads a backslash as a slash and decodes %2E and full-width dots, so
// each of these names Meet's own host, and the button opens nowhere else.
const realHost: [string, string][] = [
  ["a backslash before @", "https://meet.google.com\\@evil.com/x"],
  ["%2E for each dot", "https://meet%2Egoogle%2Ecom/x"],
  ["full-width dots", "https://meet．google．com/x"],
];

test.each(realHost)("%s still joins Meet at its real host", (_, link) => {
  for (const sources of [
    { conference: link, location: "", notes: "" },
    { conference: null, location: link, notes: "" },
    { conference: null, location: "", notes: `Join ${link}` },
  ]) {
    const found = meetingLink(sources);
    expect(found?.service).toBe("Google Meet");
    expect(new URL(found!.url).host).toBe("meet.google.com");
  }
});

test("a Markdown link in the notes opens the Meet address it shows, not the hidden one", () => {
  const found = meetingLink({
    conference: null,
    location: "",
    notes: "[https://meet.google.com/x](https://evil.com)",
  });
  expect(found?.service).toBe("Google Meet");
  expect(new URL(found!.url).host).toBe("meet.google.com");
});

test("a link inside text is found without the punctuation after it", () => {
  expect(inPlace(`Online (${MEET}).`)).toEqual({
    service: "Google Meet",
    url: MEET,
    from: "location",
  });
});

test("the conference field comes first, then the place, then the notes", () => {
  const all = { conference: MEET, location: ZOOM, notes: TEAMS };
  expect(meetingLink(all)).toEqual({
    service: "Google Meet",
    url: MEET,
    from: "conference",
  });
  expect(meetingLink({ ...all, conference: null })?.from).toBe("location");
  expect(meetingLink({ ...all, conference: null, location: "Room 4" })).toEqual(
    { service: "Microsoft Teams", url: TEAMS, from: "notes" },
  );
});

test("a source with no meeting link passes to the next one", () => {
  expect(
    meetingLink({
      conference: "https://meet.google.com.evil.com/abc",
      location: "Room 4 https://maps.example.org/room-4",
      notes: `Agenda https://docs.google.com/d/1, then join ${TEAMS}`,
    }),
  ).toEqual({ service: "Microsoft Teams", url: TEAMS, from: "notes" });
});

test("a cancelled event or date offers no Join", () => {
  const all = { conference: MEET, location: ZOOM, notes: TEAMS };
  expect(meetingLink({ ...all, cancelled: true })).toBeNull();
  expect(meetingLink({ ...all, cancelled: false })?.service).toBe(
    "Google Meet",
  );
});

test("the first meeting link in a field wins", () => {
  expect(
    meetingLink({
      conference: null,
      location: "",
      notes: `Join ${ZOOM} or dial in. Backup: ${MEET}`,
    }),
  ).toEqual({ service: "Zoom", url: ZOOM, from: "notes" });
});
