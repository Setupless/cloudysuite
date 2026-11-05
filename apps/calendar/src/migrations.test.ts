import { migrationDigests } from "@cloudysuite/object-sql";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "./migrations";

test("released migrations do not change", async () => {
  expect(await migrationDigests(MIGRATIONS)).toEqual([
    "26b252aecbb64b1649e166ea4e1956e9eb1e58aa70fb4c1a02939675f09a8892",
    "e415d164b7a47e335e3bd444974597feba0ff358fb124a303d0dcd0b614aa846",
    "180136c0abfad5a72202566638833ae27536ab32e450294fe3d9c237552de4e5",
    "c6f2af8616badd22fdace7b754d7bfcc56823ef2b0b955c3b643986a8a9e660a",
  ]);
});
