import { migrationDigests } from "@cloudysuite/object-sql";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "./migrations";

test("released migrations do not change", async () => {
  expect(await migrationDigests(MIGRATIONS)).toEqual([
    "f94c9a8eaa2a34802026cdf3ff32cf23bb366295ecddb8b5eb9a466701c79e6d",
    "8854567db76fc521debcc91faf2e1b09dfe5b5f025f805b61014a0243524dd72",
    "2481f40bad994fc977032e05a5f31aa5223b49d6be25ceb0184cb52cff0212a9",
    "e4d2ec00bd2b128dd931438f7256330db3c5f275c6537a720b62302922a12e3f",
  ]);
});
