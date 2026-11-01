import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { readSettings } from "../../../../src/settings";
import { openMailboxFor } from "../access";
import { renderBody } from "../email/render-body";
import type { MessageId } from "../types";
import {
  requireThreadId,
  requireMailboxId,
  requireMessageId,
  badRequest,
} from "../wire";
import {
  MAX_BATCH_BYTES,
  MAX_BODIES_PER_BATCH,
  MAX_SAVED_BODY_BYTES,
  type SavedBodyEntry,
  type SavedThreadBatch,
  THREADS_PER_BATCH,
} from "./offline-model";

const MAX_KNOWN_BODIES = 2000;

function parseBatchInput(raw: unknown) {
  const input = raw as {
    mailboxId?: unknown;
    threadIds?: unknown;
    haveBodies?: unknown;
  } | null;
  if (
    !Array.isArray(input?.threadIds) ||
    input.threadIds.length === 0 ||
    input.threadIds.length > THREADS_PER_BATCH ||
    !Array.isArray(input.haveBodies) ||
    input.haveBodies.length > MAX_KNOWN_BODIES
  ) {
    throw badRequest();
  }
  return {
    mailboxId: requireMailboxId(input.mailboxId),
    threadIds: input.threadIds.map(requireThreadId),
    haveBodies: input.haveBodies.map(requireMessageId),
  };
}

// What a device saves for reading offline. Bodies go through the same renderBody as
// reading online, so a saved copy holds only what the sanitizer let through. A body left
// out of the answer once the batch is full comes back on the device's next refresh.
export const getSavedThreadBatch = createServerFn({ method: "POST" })
  .validator(parseBatchInput)
  .handler(async ({ data }): Promise<SavedThreadBatch> => {
    const mailbox = await openMailboxFor(getRequest(), data.mailboxId);
    const { primaryDomain } = await readSettings(env.DB);
    if (primaryDomain === null) throw new Error("No primary domain is stored.");

    const threads = (
      await Promise.all(data.threadIds.map((id) => mailbox.getThread(id)))
    ).filter((thread) => thread !== null);
    const have = new Set<MessageId>(data.haveBodies);
    const bodies: SavedBodyEntry[] = [];
    let bytes = 0;
    for (const message of threads.flatMap((thread) => thread.messages)) {
      if (have.has(message.id)) continue;
      if (bodies.length >= MAX_BODIES_PER_BATCH || bytes >= MAX_BATCH_BYTES) {
        break;
      }
      const body = await renderBody(mailbox, message.id, primaryDomain);
      const size = JSON.stringify(body).length;
      if (size > MAX_SAVED_BODY_BYTES) {
        bodies.push({ messageId: message.id, state: "tooLarge" });
        continue;
      }
      bytes += size;
      bodies.push({ messageId: message.id, state: "saved", body });
    }
    return { threads, bodies };
  });
