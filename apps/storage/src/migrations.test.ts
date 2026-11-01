import { migrationDigests } from "@cloudysuite/object-sql";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "./migrations";

test("released migrations do not change", async () => {
  expect(await migrationDigests(MIGRATIONS)).toEqual([
    "4094748c3ccd67599b8889e354bd35fd29453f30415cd6e980daf44b2354da30",
  ]);
});
