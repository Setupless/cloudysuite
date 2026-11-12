import { migrationDigests } from "@cloudysuite/object-sql";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "./migrations";

test("released migrations do not change", async () => {
  expect(await migrationDigests(MIGRATIONS)).toEqual([
    "1702a84693e336b7faf0cb45633992cd1c5fcfcf21bf565ca47dd474b5b0239a",
  ]);
});
