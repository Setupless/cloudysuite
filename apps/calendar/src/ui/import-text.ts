import { type ImportSummary, SKIP_REASON_TEXT, SKIP_REASONS } from "../types";

const number = (count: number) => count.toLocaleString("en");
const events = (count: number) =>
  count === 1 ? "1 event" : `${number(count)} events`;

function leftLine(unchanged: number, organisedElsewhere: number): string {
  const left = unchanged + organisedElsewhere;
  const kept =
    left === 1
      ? "Left 1 event as it was"
      : `Left ${number(left)} events as they were`;
  if (unchanged === 0) {
    return `${kept}, because import doesn't change events organised by someone else.`;
  }
  const why =
    left === 1
      ? "this calendar already has it or it was removed here"
      : "this calendar already has them or they were removed here";
  const others = organisedElsewhere
    ? ` This includes ${events(organisedElsewhere)} organised by someone else, which import doesn't change.`
    : "";
  return `${kept}, because ${why}.${others}`;
}

// What happened, in the order a person would want to know it.
export function importLines({
  added,
  updated,
  unchanged,
  organisedElsewhere,
  firstDateOnly,
  mainRepeatOnly,
  skipped,
}: ImportSummary): string[] {
  const lines: string[] = [];
  if (added) lines.push(`Added ${events(added)}.`);
  if (updated) lines.push(`Updated ${events(updated)} with newer details.`);
  if (unchanged + organisedElsewhere) {
    lines.push(leftLine(unchanged, organisedElsewhere));
  }
  if (firstDateOnly) {
    lines.push(
      firstDateOnly === 1
        ? "1 event repeats in a way Calendar can't follow, so only its first date shows."
        : `${number(firstDateOnly)} events repeat in a way Calendar can't follow, so only their first date shows.`,
    );
  }
  if (mainRepeatOnly) {
    lines.push(
      mainRepeatOnly === 1
        ? "1 event repeats with extra dates or rules Calendar can't keep, so only its main repeat shows."
        : `${number(mainRepeatOnly)} events repeat with extra dates or rules Calendar can't keep, so only their main repeat shows.`,
    );
  }
  const reasons = SKIP_REASONS.flatMap((reason) => {
    const count = skipped[reason] ?? 0;
    const text = SKIP_REASON_TEXT[reason];
    return count ? [{ count, text: count === 1 ? text.one : text.many }] : [];
  });
  const notImported = reasons.reduce((total, { count }) => total + count, 0);
  if (notImported) {
    lines.push(
      `Couldn't import ${events(notImported)}: ${reasons
        .map(({ count, text }) => `${number(count)} ${text}`)
        .join(", ")}.`,
    );
  }
  return lines.length > 0 ? lines : ["The file has no events in it."];
}
