import { expect, test } from "bun:test";
import {
  renderFixture,
  SPAM_FIXTURES,
  type SpamFixture,
} from "../../scripts/spam-fixtures";
import { ingest } from "../ingest";
import { MailboxStore } from "../store";
import { createTestEnv, eml, MAILBOX_A, toArrayBuffer } from "../test-support";
import { SpamStore } from "./store";

const TO = "reception@cloudysuite.example";

function mailbox() {
  const test = createTestEnv();
  const { db } = test.instanceOf(MAILBOX_A);
  const store = new MailboxStore(db);
  const spam = new SpamStore(db);
  const inbound = async (raw: ArrayBuffer) => {
    const result = await ingest(test.env, {
      source: "inbound",
      mailboxId: MAILBOX_A,
      raw,
      envelope: { from: "bounces@example.org", to: TO },
    });
    if (result.status === "tooLarge") throw new Error("too large");
    return result;
  };
  const deliverFixture = async (fixture: SpamFixture) => {
    const { before } = fixture;
    if (before?.allow) spam.addSender(before.allow, "allow");
    if (before?.block) spam.addSender(before.block, "block");
    if (before?.sentId) {
      await ingest(test.env, {
        source: "sent",
        mailboxId: MAILBOX_A,
        raw: eml({
          to: "Someone <someone@example.org>",
          messageId: before.sentId,
        }),
      });
    }
    if (before?.knownSender) {
      await inbound(
        eml({
          from: `Known <${before.knownSender}>`,
          messageId: `known-${fixture.id}@x`,
          subject: "Welcome aboard",
        }),
      );
    }
    if (before?.notSpam) {
      const filed = await inbound(
        toArrayBuffer(
          renderFixture(before.notSpam, {
            id: `${fixture.id}-first`,
            to: TO,
            stamp: "test",
          }),
        ),
      );
      expect(filed.folder).toBe("spam");
      store.restore({ messageIds: [filed.messageId] });
    }
    return inbound(
      toArrayBuffer(
        renderFixture(fixture.shape, { id: fixture.id, to: TO, stamp: "test" }),
      ),
    );
  };
  return { deliverFixture };
}

test("each fixture has its own id", () => {
  const ids = SPAM_FIXTURES.map((fixture) => fixture.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("every row where the message and its folder disagree says why", () => {
  for (const fixture of SPAM_FIXTURES) {
    const expected = fixture.real ? "inbox" : "spam";
    expect(fixture.limit !== undefined).toBe(fixture.folder !== expected);
  }
});

for (const fixture of SPAM_FIXTURES) {
  test(`${fixture.real ? "real" : "forged"}: ${fixture.id} lands in ${fixture.folder}`, async () => {
    const { folder } = await mailbox().deliverFixture(fixture);
    expect(folder).toBe(fixture.folder);
  });
}

test("the whole table lands the same in one shared mailbox", async () => {
  const { deliverFixture } = mailbox();
  const wrong = [];
  for (const fixture of SPAM_FIXTURES) {
    const { folder } = await deliverFixture(fixture);
    if (folder !== fixture.folder) wrong.push(fixture.id);
  }
  expect(wrong).toEqual([]);
});
