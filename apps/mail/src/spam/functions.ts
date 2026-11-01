import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { openMailboxFor, openSenderListEditorFor } from "../access";
import { parseMailboxInput, refusal } from "../wire";
import { parseNewSenderInput, parseSenderInput } from "./wire";

export const getSenderLists = createServerFn({ method: "GET" })
  .validator(parseMailboxInput)
  .handler(async ({ data }) =>
    (await openMailboxFor(getRequest(), data.mailboxId)).listSenders(),
  );

export const addSender = createServerFn({ method: "POST" })
  .validator(parseNewSenderInput)
  .handler(async ({ data }) => {
    const editor = await openSenderListEditorFor(getRequest(), data.mailboxId);
    const write = await editor.add(data.pattern, data.list);
    if (!write.ok) throw refusal(write.status, write.message);
    return write.entry;
  });

export const removeSender = createServerFn({ method: "POST" })
  .validator(parseSenderInput)
  .handler(async ({ data }) => {
    const editor = await openSenderListEditorFor(getRequest(), data.mailboxId);
    await editor.remove(data.pattern);
  });
