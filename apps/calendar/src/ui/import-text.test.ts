import { expect, test } from "bun:test";
import { emptySummary } from "../store";
import type { ImportSummary } from "../types";
import { importLines } from "./import-text";

const lines = (counts: Partial<ImportSummary>) =>
  importLines({ ...emptySummary(), ...counts });

test("events left as they were say when someone else organises them", () => {
  expect(lines({ unchanged: 3 })).toEqual([
    "Left 3 events as they were, because this calendar already has them or they were removed here.",
  ]);
  expect(lines({ unchanged: 3, organisedElsewhere: 2 })).toEqual([
    "Left 5 events as they were, because this calendar already has them or they were removed here. This includes 2 events organised by someone else, which import doesn't change.",
  ]);
  expect(lines({ organisedElsewhere: 1 })).toEqual([
    "Left 1 event as it was, because import doesn't change events organised by someone else.",
  ]);
});

test("each way Calendar can't show every date says what does show", () => {
  expect(lines({ added: 2, firstDateOnly: 1, mainRepeatOnly: 1 })).toEqual([
    "Added 2 events.",
    "1 event repeats in a way Calendar can't follow, so only its first date shows.",
    "1 event repeats with extra dates or rules Calendar can't keep, so only its main repeat shows.",
  ]);
});

test("an event too long or complicated to read is counted among those not imported", () => {
  expect(lines({ added: 1, skipped: { tooComplex: 2, noStart: 1 } })).toEqual([
    "Added 1 event.",
    "Couldn't import 3 events: 2 have details too long or complicated to read, 1 has no start date.",
  ]);
});
