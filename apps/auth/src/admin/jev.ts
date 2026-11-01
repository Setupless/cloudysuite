import {
  checkJevKey,
  jevApiBase,
  type JevConnection,
  writeJevKey,
} from "@cloudysuite/jev";
import { type Outcome, refuse } from "../outcome";

export type SavedKey = { summary: string };

// Printable with no spaces, so it can't break out of an Authorization header.
const KEY_SHAPE = /^[\x21-\x7e]{8,512}$/;

// `acknowledged` is only ever `true`, so a caller can't reach this without it. Only
// Jev saying no stops the save. A key that can't be checked right now may be fine, and
// a bad key costs nothing: every check fails and the built-in filter decides.
export async function saveKey(
  database: D1Database,
  input: { key: string; acknowledged: true },
  apiOverride: string | undefined,
  fetch: JevConnection["fetch"],
): Promise<Outcome<SavedKey>> {
  const key = input.key.trim();
  if (!KEY_SHAPE.test(key)) {
    return refuse(
      "That doesn't look like a Jev key. Copy the whole key from your Jev account, then try again.",
    );
  }
  const check = await checkJevKey({
    base: jevApiBase(apiOverride),
    key,
    fetch,
  });
  if (check === "rejected") {
    return refuse(
      "Jev didn't accept that key, so it wasn't saved. Copy the whole key from your Jev account, then try again.",
    );
  }
  await writeJevKey(database, key);
  return {
    ok: true,
    summary:
      check === "accepted"
        ? "Key saved. Jev accepted it, so the check is now on."
        : "Key saved, but we couldn't reach Jev to check it. If the key is wrong, the built-in filter keeps deciding and the count of checks that couldn't finish goes up here.",
  };
}
