import { expect, test } from "bun:test";
import { readJevKey } from "@cloudysuite/jev";
import { createTestDatabase } from "../../../../src/db/test-database";
import { readJevAcknowledgement } from "./input";
import { saveKey } from "./jev";

const KEY = "jev-real-looking-key";
const status = (code: number) => async () =>
  new Response("{}", { status: code });

async function refused(thrown: unknown): Promise<number> {
  return (thrown as Response).status;
}

test("saving without the acknowledgement is refused", async () => {
  for (const input of [
    { key: KEY },
    { key: KEY, acknowledged: false },
    { key: KEY, acknowledged: "true" },
    null,
  ]) {
    let thrown: unknown;
    try {
      readJevAcknowledgement(input);
    } catch (error) {
      thrown = error;
    }
    expect(await refused(thrown)).toBe(400);
  }
  expect(readJevAcknowledgement({ key: KEY, acknowledged: true })).toBe(true);
});

test("a key Jev accepts is saved, and the reply doesn't contain it", async () => {
  const { d1 } = createTestDatabase();
  const result = await saveKey(
    d1,
    { key: `  ${KEY}\n`, acknowledged: true },
    undefined,
    status(200),
  );
  expect(result.ok).toBe(true);
  expect(JSON.stringify(result)).not.toContain(KEY);
  expect(await readJevKey(d1)).toBe(KEY);
});

test("a key Jev rejects is not saved, and the old one stays", async () => {
  const { d1 } = createTestDatabase();
  await saveKey(d1, { key: KEY, acknowledged: true }, undefined, status(200));
  const result = await saveKey(
    d1,
    { key: "a-rejected-key", acknowledged: true },
    undefined,
    status(401),
  );
  expect(result).toMatchObject({ ok: false });
  expect(await readJevKey(d1)).toBe(KEY);
});

test("a key that can't be checked right now is saved, and says so", async () => {
  const { d1 } = createTestDatabase();
  const result = await saveKey(
    d1,
    { key: KEY, acknowledged: true },
    undefined,
    status(529),
  );
  expect(result).toMatchObject({ ok: true });
  expect((result as { summary: string }).summary).toContain("couldn't reach");
  expect(await readJevKey(d1)).toBe(KEY);
});

test("something that can't be a key is refused before anything is sent", async () => {
  const { d1 } = createTestDatabase();
  let sent = 0;
  for (const key of ["", "short", "two words here", "line\r\nbreak-in-key"]) {
    const result = await saveKey(
      d1,
      { key, acknowledged: true },
      undefined,
      async () => {
        sent += 1;
        return new Response("{}");
      },
    );
    expect(result).toMatchObject({ ok: false });
  }
  expect(sent).toBe(0);
  expect(await readJevKey(d1)).toBeNull();
});
