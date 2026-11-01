import { migrationDigests } from "@cloudysuite/object-sql";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "./migrations";

test("released migrations do not change", async () => {
  expect(await migrationDigests(MIGRATIONS)).toEqual([
    "f94c9a8eaa2a34802026cdf3ff32cf23bb366295ecddb8b5eb9a466701c79e6d",
  ]);
});
