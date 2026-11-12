import { migrationDigests } from "@cloudysuite/object-sql";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "./migrations";

test("released migrations do not change", async () => {
  expect(await migrationDigests(MIGRATIONS)).toEqual([
    "1702a84693e336b7faf0cb45633992cd1c5fcfcf21bf565ca47dd474b5b0239a",
    "ff4e0aacab49f6707b7f64883e449123c385a43a73a2a6315b7b3e0b39f149c1",
    "48f1e12f62a4a8c8a5e8d05d13b3ef7b44e8f3faee9d509230bb7e681b878b92",
  ]);
});
