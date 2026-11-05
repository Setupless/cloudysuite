import { dehydrate, QueryClient, queryOptions } from "@tanstack/react-query";
import { getCalendars } from "./functions";

const CANNOT_REACH =
  "We couldn't reach CloudySuite. Check your connection and try again.";
const SOMETHING_WENT_WRONG =
  "Something went wrong on our side. Try again in a moment.";

export class CalendarFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// A refusal from a server function arrives as a thrown Response. What the person sees is
// the plain message the server wrote, or a plain message from here.
async function asFailure(thrown: unknown): Promise<CalendarFailure> {
  if (thrown instanceof CalendarFailure) return thrown;
  if (!(thrown instanceof Response)) {
    return new CalendarFailure(0, CANNOT_REACH);
  }
  const body = (await thrown
    .clone()
    .json()
    .catch(() => null)) as { message?: unknown } | null;
  return new CalendarFailure(
    thrown.status,
    typeof body?.message === "string" ? body.message : SOMETHING_WENT_WRONG,
  );
}

export async function call<Result>(run: () => Promise<Result>) {
  try {
    return await run();
  } catch (thrown) {
    throw await asFailure(thrown);
  }
}

export const retryUnlessRefused = (failures: number, error: Error): boolean =>
  !(
    error instanceof CalendarFailure &&
    error.status >= 400 &&
    error.status < 500
  ) && failures < 2;

export const calendarKeys = {
  all: ["calendar"] as const,
  calendars: ["calendar", "calendars"] as const,
};

export const calendarsQuery = () =>
  queryOptions({
    queryKey: calendarKeys.calendars,
    queryFn: () => call(() => getCalendars()),
  });

// The first HTML holds the sidebar's calendars, so a reload shows them at once.
export async function prefetchCalendars() {
  if (!import.meta.env.SSR) return undefined;
  const client = new QueryClient();
  await client.prefetchQuery(calendarsQuery());
  return dehydrate(client);
}
