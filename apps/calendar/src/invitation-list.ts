import type { SqlDriver } from "@cloudysuite/object-sql";
import { type Found, seriesDate, shownOf, stillToCome } from "./event-search";
import type { Budget } from "./repeat";
import {
  type Actor,
  type EventRow,
  inViewerOrder,
  isRemovedHere,
  occurrenceOf,
  parseRow,
  readPeople,
  readRemovals,
  STEPS_PER_CALL,
} from "./store";
import type { Occurrence, TimeZone } from "./types";

const MOST_INVITATIONS = 50;

// The copies sent to this person that they haven't answered, each at its next date still
// to come. One called off, or with no date left, isn't waiting for an answer.
export function listInvitations(
  db: SqlDriver,
  actor: Actor,
  zone: TimeZone,
  now: number,
): Occurrence[] {
  const uids = db
    .exec<{ uid: string }>(
      `SELECT uid FROM event_people
       WHERE json_extract(reply, '$.for') = ?
         AND json_extract(reply, '$.answer') = 'needsAnswer'`,
      actor.userId,
    )
    .toArray()
    .map((row) => row.uid);
  if (uids.length === 0) return [];
  const rows = db
    .exec<EventRow>(
      "SELECT * FROM events WHERE uid IN (SELECT value FROM json_each(?))",
      JSON.stringify(uids),
    )
    .toArray()
    .map(parseRow);
  const people = readPeople(db, uids);
  const removals = readRemovals(db, uids);
  const budget: Budget = { steps: STEPS_PER_CALL };

  const waiting = uids.flatMap((uid) => {
    const series = rows.find(
      (row) => row.uid === uid && row.recurrenceId === null,
    );
    if (!series || series.cancelled) return [];
    const changes = rows.filter(
      (row) => row.uid === uid && row.recurrenceId !== null,
    );
    const found: Found[] = changes
      .filter((change) => !change.cancelled)
      .map((change) => ({
        event: change,
        occurrenceId: change.recurrenceId,
        time: change.time,
      }));
    if (series.rule === null) {
      found.push({ event: series, occurrenceId: null, time: series.time });
    } else {
      const skipped = new Set([
        ...series.exdates,
        ...changes.map((change) => change.recurrenceId as string),
      ]);
      const removal = removals.get(uid);
      const date = seriesDate(
        { ...series, rule: series.rule },
        (id) => skipped.has(id) || isRemovedHere(removal, series, id),
        zone,
        now,
        budget,
      );
      if (date) found.push(date);
    }
    const shown = shownOf(found, zone, now);
    return shown && stillToCome(shown.time, zone, now)
      ? [
          occurrenceOf(
            actor,
            series,
            shown.event,
            shown.occurrenceId,
            shown.time,
            people.get(uid),
          ),
        ]
      : [];
  });
  return waiting.sort(inViewerOrder(zone)).slice(0, MOST_INVITATIONS);
}
