import { expect, test } from "bun:test";
import { join } from "node:path";
import { followableRule } from "./followable";
import { HOSTILE_RULES } from "./outside/test-support";

const CHILD = join(import.meta.dir, "followable-test-support.ts");
// Longer than any child is given, so the child is always stopped before the test is.
const TEST_LIMIT = 60_000;

// The child prints a line before each rule, so a hang names the rule that caused it.
async function runChild(args: string[], limit: number) {
  const child = Bun.spawn(["bun", CHILD, ...args], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const timer = setTimeout(() => child.kill(9), limit);
  const output = await new Response(child.stdout).text();
  await child.exited;
  clearTimeout(timer);
  // A child stopped mid-line leaves half a line, which says nothing.
  const lines = output.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  const last = lines.at(-1);
  return {
    stuckOn: child.signalCode ? last?.running : null,
    results: lines.filter((line) => !("running" in line)),
  };
}

test(
  "every hostile rule imports as its first date only, at once",
  async () => {
    const { stuckOn, results } = await runChild(["hostile"], 10_000);
    expect(stuckOn).toBeNull();
    expect(results).toHaveLength(HOSTILE_RULES.length);
    for (const { milliseconds, ...result } of results) {
      expect(result).toEqual({
        rule: result.rule,
        followable: false,
        imported: {
          status: "done",
          summary: {
            added: 1,
            updated: 0,
            unchanged: 0,
            organisedElsewhere: 0,
            firstDateOnly: 1,
            mainRepeatOnly: 0,
            skipped: {},
          },
        },
        shown: ["2026-02-03 09:00"],
        repeat: { frequency: "custom" },
      });
      expect({
        rule: result.rule,
        quick: (milliseconds as number) < 250,
      }).toEqual({ rule: result.rule, quick: true });
    }
  },
  TEST_LIMIT,
);

test("rules Google, Outlook, Apple, and the event dialog write are all followed", () => {
  const written = [
    "FREQ=DAILY",
    "FREQ=DAILY;COUNT=10",
    "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    "FREQ=WEEKLY;UNTIL=20261231",
    "FREQ=MONTHLY;UNTIL=20270105T125959Z",
    "FREQ=YEARLY",
    "FREQ=WEEKLY;WKST=MO;BYDAY=TU",
    "FREQ=WEEKLY;WKST=SU;INTERVAL=2;BYDAY=MO,WE,FR",
    "FREQ=WEEKLY;UNTIL=20261231T125959Z;INTERVAL=3;BYDAY=TH",
    "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR",
    "FREQ=DAILY;INTERVAL=3",
    "FREQ=MONTHLY;BYMONTHDAY=15",
    "FREQ=MONTHLY;BYMONTHDAY=-1",
    "FREQ=MONTHLY;COUNT=6;BYDAY=2TH",
    "FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR",
    "FREQ=MONTHLY;BYDAY=5SA",
    "FREQ=MONTHLY;BYDAY=1MO,-1MO",
    "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
    "FREQ=MONTHLY;BYDAY=SA,SU;BYSETPOS=1",
    "FREQ=YEARLY;BYMONTHDAY=15;BYMONTH=3",
    "FREQ=YEARLY;BYDAY=1SU;BYMONTH=10",
    "FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "FREQ=YEARLY;BYMONTH=1,3;BYDAY=1SU",
    "FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR;BYMONTH=3;BYSETPOS=-1",
  ];
  expect(written.filter((rule) => followableRule(rule) === null)).toEqual([]);
});

test("no hostile rule is followed", () => {
  expect(HOSTILE_RULES.filter((rule) => followableRule(rule) !== null)).toEqual(
    [],
  );
});

test(
  "every rule Calendar follows comes back at once, on the dates RFC 5545 gives",
  async () => {
    const { stuckOn, results } = await runChild(
      ["fuzz", "20261105", "1500"],
      30_000,
    );
    expect(stuckOn).toBeNull();
    const [summary] = results as {
      followed: number;
      disagreements: unknown[];
    }[];
    expect(summary?.disagreements).toEqual([]);
    expect(summary?.followed).toBeGreaterThan(300);
  },
  TEST_LIMIT,
);
