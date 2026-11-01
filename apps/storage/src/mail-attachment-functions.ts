import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireStorageUser } from "./access";
import {
  listMailAttachments,
  type MailAttachmentRow,
  saveMailAttachment,
} from "./mail-attachments";
import { parseMailAttachmentInput } from "./wire";

export const getMailAttachments = createServerFn({ method: "GET" }).handler(
  async (): Promise<MailAttachmentRow[]> => {
    const me = await requireStorageUser(getRequest());
    return listMailAttachments(me.id);
  },
);

export const saveAttachmentFromMail = createServerFn({ method: "POST" })
  .validator(parseMailAttachmentInput)
  .handler(async ({ data }): Promise<void> => {
    const me = await requireStorageUser(getRequest());
    await saveMailAttachment(me.id, data);
  });
