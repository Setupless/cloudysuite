import {
  addFromMail,
  answerFromMail,
  type InvitationCard,
  readInvitationCard,
  removeFromMail,
} from "@cloudysuite/calendar/mail-card";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { openMailboxAs, requireMailUser } from "./access";
import type { MailboxId, MessageId } from "./types";
import { parseInvitationAnswerInput, parseMessageInput, refusal } from "./wire";

// The invitation card above a message. Each function checks that Mail is on and that the
// person can open the mailbox, then hands Calendar the message's calendar parts. Calendar
// checks that it's on too, and reads or changes only the person's own calendar.

const GONE = "This message isn't here anymore.";

async function messageFor(input: {
  mailboxId: MailboxId;
  messageId: MessageId;
}) {
  const user = await requireMailUser(getRequest());
  const mailbox = await openMailboxAs(user.id, input.mailboxId);
  const mail = await mailbox.calendarParts(input.messageId);
  if (!mail) throw refusal(404, GONE);
  return { person: { id: user.id, name: user.name }, mail };
}

export const getInvitationCard = createServerFn({ method: "GET" })
  .validator(parseMessageInput)
  .handler(async ({ data }): Promise<InvitationCard | null> => {
    const { person, mail } = await messageFor(data);
    return readInvitationCard(person, mail);
  });

export const answerInvitationFromMail = createServerFn({ method: "POST" })
  .validator(parseInvitationAnswerInput)
  .handler(async ({ data }): Promise<void> => {
    const { person, mail } = await messageFor(data);
    await answerFromMail(person, mail, data.answer);
  });

export const addInvitationFromMail = createServerFn({ method: "POST" })
  .validator(parseMessageInput)
  .handler(async ({ data }): Promise<void> => {
    const { person, mail } = await messageFor(data);
    await addFromMail(person, mail);
  });

export const removeInvitationFromMail = createServerFn({ method: "POST" })
  .validator(parseMessageInput)
  .handler(async ({ data }): Promise<void> => {
    const { person, mail } = await messageFor(data);
    await removeFromMail(person, mail);
  });
