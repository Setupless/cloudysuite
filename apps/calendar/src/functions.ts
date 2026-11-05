import { env } from "cloudflare:workers";
import {
  type CalendarId,
  ensurePersonalCalendar,
  levelOfRole,
  readOthers,
  type UserId,
} from "@cloudysuite/access";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { openCalendarAs, requireCalendarUser } from "./access";
import { withOwnCopies } from "./across-calendars";
import type { CalendarClient } from "./client";
import {
  addToTeam,
  createTeam,
  deleteTeam,
  readAddable,
  readInvitable,
  readKind,
  readMembers,
  readMyCalendars,
  removeMember,
  renameTeam,
  setColour,
  setHidden,
  setMemberRole,
  type TeamChange,
} from "./directory";
import { outsideInviting } from "./email/senders";
import { readCalendarFile } from "./outside/ics";
import {
  addSummary,
  countSkip,
  emptySummary,
  groupForImport,
  inViewerOrder,
} from "./store";
import {
  type CalendarEntry,
  type CalendarOccurrence,
  type ChangeResult,
  EVENT_GONE_MESSAGE,
  type EventDraft,
  type EventListing,
  type EventUid,
  IMPORT_NOT_CALENDAR_MESSAGE,
  IMPORT_TOO_LARGE_MESSAGE,
  IMPORT_TOO_MANY_MESSAGE,
  type ImportSummary,
  LAST_MANAGER_MESSAGE,
  MAX_OCCURRENCES,
  MAX_PERSON_NAME_LENGTH,
  type Member,
  NOT_A_PERSON_MESSAGE,
  NOT_ON_IT_MESSAGE,
  ONLY_MANAGERS_MESSAGE,
  OUTSIDE_REFUSED_MESSAGES,
  type OutsideInviting,
  PEOPLE_FOR_ONE_DATE_MESSAGE,
  PERSONAL_CALENDAR_MESSAGE,
  type Person,
  READ_ONLY_MESSAGE,
  VIEW_ONLY_MESSAGE,
} from "./types";
import {
  parseAddMembersInput,
  parseAnswerInput,
  parseCalendarInput,
  parseColourInput,
  parseEventChangeInput,
  parseEventRemovalInput,
  parseHiddenInput,
  parseImportInput,
  parseInvitationsInput,
  parseMemberInput,
  parseMemberRoleInput,
  parseNewEventInput,
  parseNewTeamCalendarInput,
  parseOrganiserInput,
  parseRangeInput,
  parseRenameInput,
  parseRetryEmailInput,
  refusal,
} from "./wire";

const me = () => requireCalendarUser(getRequest());

// Small enough that no one call to the Calendar object holds a large file.
const IMPORT_BATCH = 200;

const FILE_REFUSALS = {
  tooLarge: () => refusal(413, IMPORT_TOO_LARGE_MESSAGE),
  tooManyEvents: () => refusal(413, IMPORT_TOO_MANY_MESSAGE),
  notCalendar: () => refusal(400, IMPORT_NOT_CALENDAR_MESSAGE),
};

async function openAsManager(
  userId: UserId,
  calendarId: CalendarId,
): Promise<CalendarClient> {
  const calendar = await openCalendarAs(userId, calendarId);
  if (calendar.role !== "manager") throw refusal(403, ONLY_MANAGERS_MESSAGE);
  return calendar;
}

// A personal calendar is one person's, and invitations land there, so it has no members
// to manage and can't be deleted or left.
async function requireTeam(calendarId: CalendarId): Promise<void> {
  if ((await readKind(env.DB, calendarId)) !== "team") {
    throw refusal(403, PERSONAL_CALENDAR_MESSAGE);
  }
}

async function openTeamAsManager(userId: UserId, calendarId: CalendarId) {
  const calendar = await openAsManager(userId, calendarId);
  await requireTeam(calendarId);
  return calendar;
}

function answerTeamChange(change: TeamChange): void {
  switch (change) {
    case "done":
      return;
    case "lastManager":
      throw refusal(409, LAST_MANAGER_MESSAGE);
    case "notOnIt":
      throw refusal(404, NOT_ON_IT_MESSAGE);
  }
}

function answerChange(result: ChangeResult): void {
  switch (result.status) {
    case "done":
      return;
    case "noAccess":
      throw refusal(403, VIEW_ONLY_MESSAGE);
    case "readOnly":
      throw refusal(403, READ_ONLY_MESSAGE);
    case "gone":
      throw refusal(404, EVENT_GONE_MESSAGE);
    case "notInvitable":
      throw refusal(404, NOT_A_PERSON_MESSAGE);
    case "peopleForOneDate":
      throw refusal(400, PEOPLE_FOR_ONE_DATE_MESSAGE);
    case "outsideNotAllowed":
      throw refusal(403, OUTSIDE_REFUSED_MESSAGES[result.why]);
  }
}

// Reads D1 only, so the sidebar wakes no Calendar object.
export const getCalendars = createServerFn({ method: "GET" }).handler(
  async (): Promise<CalendarEntry[]> => readMyCalendars(env.DB, await me()),
);

// Made on first use, not on first look. Safe to repeat, so two tabs make one.
export const ensureMyCalendar = createServerFn({ method: "POST" }).handler(
  async (): Promise<CalendarId> =>
    ensurePersonalCalendar(env.DB, (await me()).id),
);

export const createTeamCalendar = createServerFn({ method: "POST" })
  .validator(parseNewTeamCalendarInput)
  .handler(async ({ data }): Promise<CalendarId> =>
    createTeam(env.DB, (await me()).id, data.name),
  );

export const renameTeamCalendar = createServerFn({ method: "POST" })
  .validator(parseRenameInput)
  .handler(async ({ data }): Promise<void> => {
    await openTeamAsManager((await me()).id, data.calendarId);
    await renameTeam(env.DB, data.calendarId, data.name);
  });

// A personal calendar's person is its manager, so they can change its colour too.
export const setCalendarColour = createServerFn({ method: "POST" })
  .validator(parseColourInput)
  .handler(async ({ data }): Promise<void> => {
    await openAsManager((await me()).id, data.calendarId);
    await setColour(env.DB, data.calendarId, data.colour);
  });

// Wakes the Calendar object, so only the delete confirmation asks.
export const countCalendarEvents = createServerFn({ method: "GET" })
  .validator(parseCalendarInput)
  .handler(async ({ data }): Promise<number> =>
    (await openCalendarAs((await me()).id, data.calendarId)).countEvents(),
  );

// D1 first, so the calendar is gone for everyone at once. If emptying the object then
// fails, nobody can reach what's left.
export const deleteTeamCalendar = createServerFn({ method: "POST" })
  .validator(parseCalendarInput)
  .handler(async ({ data }): Promise<void> => {
    const calendar = await openTeamAsManager((await me()).id, data.calendarId);
    await deleteTeam(env.DB, data.calendarId);
    if ((await calendar.erase()).status === "noAccess") {
      throw refusal(403, ONLY_MANAGERS_MESSAGE);
    }
  });

export const setCalendarHidden = createServerFn({ method: "POST" })
  .validator(parseHiddenInput)
  .handler(async ({ data }): Promise<void> => {
    const { id } = await me();
    await openCalendarAs(id, data.calendarId);
    await setHidden(env.DB, data.calendarId, id, data.hidden);
  });

export const getMembers = createServerFn({ method: "GET" })
  .validator(parseCalendarInput)
  .handler(async ({ data }): Promise<Member[]> => {
    await openCalendarAs((await me()).id, data.calendarId);
    return readMembers(env.DB, data.calendarId);
  });

// Everyone who could be added. It names no calendar, so it reads D1 only.
export const getPeopleChoices = createServerFn({ method: "GET" }).handler(
  async (): Promise<Person[]> => readOthers(env.DB, (await me()).id),
);

export const addMembers = createServerFn({ method: "POST" })
  .validator(parseAddMembersInput)
  .handler(async ({ data }): Promise<void> => {
    await openTeamAsManager((await me()).id, data.calendarId);
    const addable = await readAddable(env.DB, data.people);
    if (addable.length !== data.people.length) {
      throw refusal(404, NOT_A_PERSON_MESSAGE);
    }
    await addToTeam(env.DB, data.calendarId, addable, data.role);
  });

export const changeMemberRole = createServerFn({ method: "POST" })
  .validator(parseMemberRoleInput)
  .handler(async ({ data }): Promise<void> => {
    await openTeamAsManager((await me()).id, data.calendarId);
    answerTeamChange(
      await setMemberRole(env.DB, data.calendarId, data.userId, data.role),
    );
  });

export const removeCalendarMember = createServerFn({ method: "POST" })
  .validator(parseMemberInput)
  .handler(async ({ data }): Promise<void> => {
    await openTeamAsManager((await me()).id, data.calendarId);
    answerTeamChange(await removeMember(env.DB, data.calendarId, data.userId));
  });

export const leaveTeamCalendar = createServerFn({ method: "POST" })
  .validator(parseCalendarInput)
  .handler(async ({ data }): Promise<void> => {
    const { id } = await me();
    await openCalendarAs(id, data.calendarId);
    await requireTeam(data.calendarId);
    answerTeamChange(await removeMember(env.DB, data.calendarId, id));
  });

export const listEvents = createServerFn({ method: "GET" })
  .validator(parseRangeInput)
  .handler(async ({ data }): Promise<EventListing> => {
    const person = await me();
    const shown = (await readMyCalendars(env.DB, person)).flatMap((entry) =>
      entry.id && !entry.hidden ? [entry.id] : [],
    );
    const listings = await Promise.all(
      shown.map(async (calendarId) => {
        const calendar = await openCalendarAs(person.id, calendarId);
        const listing = await calendar.listRange(data);
        return {
          complete: listing.complete,
          occurrences: listing.occurrences.map((occurrence) => ({
            ...occurrence,
            calendarId,
          })),
        };
      }),
    );
    const occurrences = withOwnCopies(
      listings.flatMap((listing) => listing.occurrences),
      "perDate",
    ).sort(inViewerOrder(data.timeZone));
    return {
      occurrences: occurrences.slice(0, MAX_OCCURRENCES),
      complete:
        occurrences.length <= MAX_OCCURRENCES &&
        listings.every((listing) => listing.complete),
    };
  });

// Today shows these even when the personal calendar is hidden, so none is missed.
export const listInvitations = createServerFn({ method: "GET" })
  .validator(parseInvitationsInput)
  .handler(async ({ data }): Promise<CalendarOccurrence[]> => {
    const person = await me();
    const [personal] = await readMyCalendars(env.DB, person);
    if (!personal?.id) return [];
    const calendarId = personal.id;
    const calendar = await openCalendarAs(person.id, calendarId);
    return (await calendar.invitations(data.timeZone)).map((occurrence) => ({
      ...occurrence,
      calendarId,
    }));
  });

// Names come from the directory, never from the request.
const invitableIn = (draft: EventDraft) =>
  readInvitable(
    env.DB,
    draft.people.filter((person) => typeof person === "string"),
  );

// Kept on every event the person makes, so it can't be a whole page long.
const organiserName = (person: { name: string }) =>
  person.name.slice(0, MAX_PERSON_NAME_LENGTH);

export const createEvent = createServerFn({ method: "POST" })
  .validator(parseNewEventInput)
  .handler(async ({ data }): Promise<EventUid> => {
    const person = await me();
    const calendar = await openCalendarAs(person.id, data.calendarId);
    const result = await calendar.create(
      organiserName(person),
      data.draft,
      await invitableIn(data.draft),
    );
    switch (result.status) {
      case "created":
        return result.uid;
      case "noAccess":
        throw refusal(403, VIEW_ONLY_MESSAGE);
      case "notInvitable":
        throw refusal(404, NOT_A_PERSON_MESSAGE);
      case "outsideNotAllowed":
        throw refusal(403, OUTSIDE_REFUSED_MESSAGES[result.why]);
    }
  });

export const updateEvent = createServerFn({ method: "POST" })
  .validator(parseEventChangeInput)
  .handler(async ({ data }): Promise<void> => {
    const calendar = await openCalendarAs((await me()).id, data.calendarId);
    answerChange(
      await calendar.update(
        data.target,
        data.scope,
        data.draft,
        await invitableIn(data.draft),
      ),
    );
  });

export const deleteEvent = createServerFn({ method: "POST" })
  .validator(parseEventRemovalInput)
  .handler(async ({ data }): Promise<void> => {
    const calendar = await openCalendarAs((await me()).id, data.calendarId);
    answerChange(await calendar.remove(data.target, data.scope));
  });

// Each batch is safe to send again, so a retry after a failure part way through ends the
// same as one import that never failed.
export const importCalendarFile = createServerFn({ method: "POST" })
  .validator(parseImportInput)
  .handler(async ({ data }): Promise<ImportSummary> => {
    const person = await me();
    const calendar = await openCalendarAs(person.id, data.calendarId);
    if (levelOfRole(calendar.role) !== "edit") {
      throw refusal(403, VIEW_ONLY_MESSAGE);
    }
    const reading = readCalendarFile(data.file, data.timeZone);
    if (reading.status !== "read") {
      throw FILE_REFUSALS[reading.status]();
    }
    const summary = emptySummary();
    for (const reason of reading.skipped) countSkip(summary, reason, 1);
    const groups = groupForImport(reading.events);
    for (let first = 0; first < groups.length; first += IMPORT_BATCH) {
      const result = await calendar.importEvents(
        organiserName(person),
        groups.slice(first, first + IMPORT_BATCH),
      );
      if (result.status === "noAccess") throw refusal(403, VIEW_ONLY_MESSAGE);
      addSummary(summary, result.summary);
    }
    return summary;
  });

// Whether the dialog may offer addresses for an event whose emails go from this
// organiser's address. It reads D1 only.
export const getOutsideInviting = createServerFn({ method: "GET" })
  .validator(parseOrganiserInput)
  .handler(async ({ data }): Promise<OutsideInviting> => {
    await me();
    return outsideInviting(env.DB, data.organiser);
  });

export const retryInvitationEmail = createServerFn({ method: "POST" })
  .validator(parseRetryEmailInput)
  .handler(async ({ data }): Promise<void> => {
    const calendar = await openCalendarAs((await me()).id, data.calendarId);
    const result = await calendar.retryEmail(data.uid, data.recipient);
    if (result.status === "noAccess") throw refusal(403, VIEW_ONLY_MESSAGE);
    if (result.status === "gone") throw refusal(404, EVENT_GONE_MESSAGE);
  });

export const answerInvitation = createServerFn({ method: "POST" })
  .validator(parseAnswerInput)
  .handler(async ({ data }): Promise<void> => {
    const calendar = await openCalendarAs((await me()).id, data.calendarId);
    const result = await calendar.answer(data.uid, data.answer);
    if (result.status === "gone") throw refusal(404, EVENT_GONE_MESSAGE);
  });
