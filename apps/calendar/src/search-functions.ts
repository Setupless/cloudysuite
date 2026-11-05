import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { openCalendarAs, requireCalendarUser } from "./access";
import { searchCalendars } from "./across-calendars";
import { parseEventSearch } from "./search-query";
import type { EventSearchAnswer } from "./types";
import { parseEventSearchInput } from "./wire";

export const searchEvents = createServerFn({ method: "GET" })
  .validator(parseEventSearchInput)
  .handler(async ({ data }): Promise<EventSearchAnswer> => {
    const person = await requireCalendarUser(getRequest());
    const parsed = parseEventSearch(data.text);
    if (!parsed.ok) return { status: "problem", problem: parsed.problem };
    return searchCalendars(
      env.DB,
      person,
      (calendarId) => openCalendarAs(person.id, calendarId),
      parsed.terms,
      data.timeZone,
    );
  });
