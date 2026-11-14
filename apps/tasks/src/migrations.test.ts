import { migrationDigests } from "@cloudysuite/object-sql";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "./migrations";

test("released migrations do not change", async () => {
  expect(await migrationDigests(MIGRATIONS)).toEqual([
    "1702a84693e336b7faf0cb45633992cd1c5fcfcf21bf565ca47dd474b5b0239a",
    "ff4e0aacab49f6707b7f64883e449123c385a43a73a2a6315b7b3e0b39f149c1",
    "48f1e12f62a4a8c8a5e8d05d13b3ef7b44e8f3faee9d509230bb7e681b878b92",
    "b4534d288d5dc5e5fd0f6c3b0ec65e5a0908444c9291f25701e197a0793b421e",
    "18efd8da1c163e4c2b83ab68eff7bd7a5906ca45a65876c886242cd3ab8c92ac",
    "4aa54d1713e045589dc909a47b3595dfa3880fa611e45c2c2ed8ad532827a451",
    "828036fd9cde81fd34252c8b1ae393704f1a9c2dc441ed9cfa2fa68f9b1447d9",
  ]);
});
