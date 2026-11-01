import { migrationDigests } from "@cloudysuite/object-sql";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "./migrations";

test("released migrations do not change", async () => {
  expect(await migrationDigests(MIGRATIONS)).toEqual([
    "64d76cc75a9c4fde8212b0e492e008d51d777bc8ff7397f0a6531049efb0bb04",
    "3521e4d8fa8b43d605caf0c3e41498076d269bbc497ac13f036966d1f90e2117",
    "e45855e92d326470830ff91d585e07ae4c4bb2ff1d7eb7709cab55c20382f42d",
    "3a0cc3e4d8dc3b4302a38bd5a8667cc13f545bbd91a4e1ced344d24748f08aef",
    "86db2189a19567c7e86ec85edc1ea89d7b5ec42b71e2c1a962ce807d6acfaf25",
    "188f4e4c9cac3ec0ce8b932c1d5a652605e04112058c08573d5c3919739b4dda",
    "7a916817e3983bb1710f4ffe263543ff52ba7810194fb2d02deb4ae709c9212b",
    "9b435c5b91ff3ed4f306f730e201edfd27cd63ccc943919ecdcaa444d09007fd",
  ]);
});
