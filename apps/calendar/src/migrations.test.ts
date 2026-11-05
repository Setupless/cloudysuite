import { migrationDigests } from "@cloudysuite/object-sql";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "./migrations";

test("released migrations do not change", async () => {
  expect(await migrationDigests(MIGRATIONS)).toEqual([
    "26b252aecbb64b1649e166ea4e1956e9eb1e58aa70fb4c1a02939675f09a8892",
    "e415d164b7a47e335e3bd444974597feba0ff358fb124a303d0dcd0b614aa846",
  ]);
});
