import type { MoveDestination, MoveNotice } from "../types";

// What happened, then why and where it is, then what to do next.
export type NoticeWords = { lead: string; rest: string; next: string };

const placeOf = (to: MoveDestination) =>
  to.kind === "personal" ? "your private tasks" : to.name;

function reasonOf(notice: MoveNotice): { why: string; next: string } {
  const place = placeOf(notice.to);
  switch (notice.setback) {
    case "noAccess":
      return notice.to.kind === "team"
        ? {
            why: "because you no longer have Can edit there.",
            next: `Ask one of ${place}'s managers for Can edit, then move it again.`,
          }
        : {
            why: "because you can no longer add tasks there.",
            next: "You can move it to another board instead.",
          };
    case "busy":
    case "dropped":
      return {
        why: `because ${place} couldn't take it just then.`,
        next: "Move it again in a minute.",
      };
    case "noAnswer":
      return {
        why: "because we couldn't get it there for an hour, so we stopped trying.",
        next: "Move it again to try once more.",
      };
  }
}

export function noticeWords(notice: MoveNotice): NoticeWords {
  const place = placeOf(notice.to);
  const { why, next } = reasonOf(notice);
  if (notice.task === null) {
    // They can't open the board it stayed on, so they can't move it again themselves.
    return {
      lead: `A task you moved didn't move to ${place}`,
      rest: `, ${why} It's still on a board you can no longer open.`,
      next: "If it still needs to move, ask someone on that board to move it.",
    };
  }
  const { title, stillOn } = notice.task;
  return {
    lead: `"${title}" didn't move to ${place}`,
    rest: `, ${why} ${
      stillOn.kind === "personal"
        ? "It's still in your private tasks."
        : `It's still on ${stillOn.name}.`
    }`,
    next,
  };
}
