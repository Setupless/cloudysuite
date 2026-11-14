import {
  type DueTasks,
  parseDueRangeInput,
  parseStatusInput,
  readDueTasks,
  setStatusFromCalendar,
} from "@cloudysuite/tasks/in-calendar";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireCalendarUser } from "./access";

// The person's own tasks, read from their boards each time, so a task lives only in
// Tasks. Calendar checks that it's on here, and Tasks checks that it's on too.

export const listDueTasks = createServerFn({ method: "GET" })
  .validator(parseDueRangeInput)
  .handler(async ({ data }): Promise<DueTasks> => {
    const person = await requireCalendarUser(getRequest());
    return readDueTasks({ id: person.id, name: person.name }, data);
  });

export const setTaskStatus = createServerFn({ method: "POST" })
  .validator(parseStatusInput)
  .handler(async ({ data }): Promise<void> => {
    const person = await requireCalendarUser(getRequest());
    await setStatusFromCalendar({ id: person.id, name: person.name }, data);
  });
