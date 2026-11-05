import { beforeEach, expect, test } from "bun:test";
import { ensurePersonalCalendar } from "@cloudysuite/access";
import {
  readMyCalendars,
  removeMember,
  setHidden,
  setMemberRole,
} from "./directory";
import { ALICE, BOB, createCalendarTest, TEAM } from "./test-support";

let kit: Awaited<ReturnType<typeof createCalendarTest>>;
const alice = { id: ALICE, name: "Alice Stone" };

beforeEach(async () => {
  kit = await createCalendarTest();
});

const personalRows = () =>
  kit.directory
    .query(
      "SELECT id, colour FROM calendars WHERE owner_id = ? AND kind = 'personal'",
    )
    .all(ALICE);

test("looking at Calendar makes nothing, and the personal calendar is listed first anyway", async () => {
  expect(
    (await readMyCalendars(kit.d1, alice)).map((entry) => entry.name),
  ).toEqual(["Alice Stone", "Marketing"]);
  expect((await readMyCalendars(kit.d1, alice))[0]).toEqual({
    id: null,
    kind: "personal",
    name: "Alice Stone",
    colour: 4,
    role: "manager",
    hidden: false,
  });
  expect(personalRows()).toEqual([]);
});

test("two tabs using Calendar at once make one personal calendar", async () => {
  const [first, second] = await Promise.all([
    ensurePersonalCalendar(kit.d1, ALICE),
    ensurePersonalCalendar(kit.d1, ALICE),
  ]);
  expect(second).toBe(first);
  expect(personalRows()).toEqual([{ id: first, colour: 4 }]);
  expect((await readMyCalendars(kit.d1, alice))[0]).toEqual({
    id: first,
    kind: "personal",
    name: "Alice Stone",
    colour: 4,
    role: "manager",
    hidden: false,
  });
});

test("hiding a calendar hides it for that person only", async () => {
  kit.join(BOB, "editor");
  await setHidden(kit.d1, TEAM, BOB, true);
  const bob = { id: BOB, name: "Bob Lee" };
  expect((await readMyCalendars(kit.d1, bob))[1]).toMatchObject({
    id: TEAM,
    hidden: true,
  });
  expect((await readMyCalendars(kit.d1, alice))[1]).toMatchObject({
    id: TEAM,
    hidden: false,
  });
});

test("a team calendar always keeps a manager", async () => {
  expect(await removeMember(kit.d1, TEAM, ALICE)).toBe("lastManager");
  expect(await setMemberRole(kit.d1, TEAM, ALICE, "editor")).toBe(
    "lastManager",
  );
  kit.join(BOB, "manager");
  expect(await removeMember(kit.d1, TEAM, ALICE)).toBe("done");
  expect(await removeMember(kit.d1, TEAM, ALICE)).toBe("notOnIt");
});
