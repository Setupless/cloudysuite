import { record, refusal, requireMailboxId } from "../wire";
import { parseSenderPattern, SENDER_LISTS, type SenderList } from "./types";

const requirePattern = (raw: unknown) => {
  const pattern = parseSenderPattern(raw);
  if (pattern === null) {
    throw refusal(
      400,
      "Enter one email address, like name@example.com, or one domain, like example.com.",
    );
  }
  return pattern;
};

export const parseNewSenderInput = (raw: unknown) => {
  const input = record(raw);
  if (!SENDER_LISTS.includes(input.list as SenderList)) {
    throw refusal(400, "Choose whether to allow or block this sender.");
  }
  return {
    mailboxId: requireMailboxId(input.mailboxId),
    pattern: requirePattern(input.pattern),
    list: input.list as SenderList,
  };
};

export const parseSenderInput = (raw: unknown) => {
  const input = record(raw);
  return {
    mailboxId: requireMailboxId(input.mailboxId),
    pattern: requirePattern(input.pattern),
  };
};
