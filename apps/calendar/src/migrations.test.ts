import { migrationDigests } from "@cloudysuite/object-sql";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "./migrations";

test("released migrations do not change", async () => {
  expect(await migrationDigests(MIGRATIONS)).toEqual([
    "26b252aecbb64b1649e166ea4e1956e9eb1e58aa70fb4c1a02939675f09a8892",
    "e415d164b7a47e335e3bd444974597feba0ff358fb124a303d0dcd0b614aa846",
    "180136c0abfad5a72202566638833ae27536ab32e450294fe3d9c237552de4e5",
    "404a9b8e62c58fc1b592cad8668e215859352a0c4bddc71f234917cf8e5141b4",
  ]);
});
