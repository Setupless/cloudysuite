import { env } from "cloudflare:workers";
import { parseMailboxId } from "@cloudysuite/access";
import { isFromApp } from "@cloudysuite/auth/origins";
import { declaredBytes, drain, readUpTo } from "@cloudysuite/transfer";
import { readSettings } from "../../../../src/settings";
import { NO_ACCESS_MESSAGE, openMailboxAs, requireMailUser } from "../access";
import { badRequest } from "../wire";
import { mailboxSenderFacts } from "./addresses";
import { readReplySource } from "./reply-source";
import type { DraftStart } from "./types";
import {
  parseDraftStart,
  parseOutgoingId,
  parseRevision,
  parseSession,
} from "./wire";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const refusal = (status: number, message: string) => json({ message }, status);

function readStart(raw: string | null): DraftStart | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest();
  }
  return parseDraftStart(parsed);
}

// Only uploads need a route of their own, because a file's bytes can't pass through a
// server function.
// PUT /api/compose/<mailbox>/<outgoing>/attachments?name=<file name>&base=<revision>&session=<id>
// A file is the first thing added to a reply often enough, so this can make its row too,
// with `start` holding what a first save would say.
async function respond(request: Request, path: string): Promise<Response> {
  const user = await requireMailUser(request);
  // The hostname router sends every request to /setup until a domain is stored.
  const { primaryDomain } = await readSettings(env.DB);
  if (primaryDomain === null || !isFromApp(request, primaryDomain, "mail")) {
    return refusal(403, "This request didn't come from CloudySuite.");
  }

  const [rawMailboxId, rawOutgoingId, resource, ...rest] = path.split("/");
  const mailboxId = parseMailboxId(rawMailboxId ?? "");
  if (!mailboxId) return refusal(403, NO_ACCESS_MESSAGE);
  const mailbox = await openMailboxAs(user.id, mailboxId);

  const id = parseOutgoingId(rawOutgoingId);
  if (
    !id ||
    resource !== "attachments" ||
    rest.length > 0 ||
    request.method !== "PUT"
  ) {
    return refusal(404, "There is nothing at this address.");
  }

  const { searchParams } = new URL(request.url);
  const start = readStart(searchParams.get("start"));
  const baseRevision = parseRevision(Number(searchParams.get("base") ?? "x"));
  const session = parseSession(searchParams.get("session"));
  const { addresses } = await mailboxSenderFacts(env.DB, mailboxId);
  const ownAddresses = addresses.map(({ address }) => address);
  const source =
    start &&
    (await readReplySource(mailbox, start, {
      ownAddresses,
      ownDomain: primaryDomain,
    }));
  const result = await mailbox.outgoing.upload({
    id,
    baseRevision,
    session,
    fileName: searchParams.get("name") ?? "",
    mimeType: request.headers.get("Content-Type") ?? "",
    body: {
      declaredBytes: declaredBytes(request),
      read: (limit) => readUpTo(request.body, limit),
    },
    fromAddress: addresses[0]?.address ?? "",
    editor: { id: user.id, name: user.name },
    from: start && source ? { source, start } : undefined,
  });
  if (result.status === "behind") return json(result, 409);
  return result.status === "added"
    ? json({ ...result, originalGone: start !== undefined && !source })
    : refusal(result.httpStatus, result.message);
}

export async function handleComposeRequest(
  request: Request,
  path: string,
): Promise<Response> {
  try {
    const response = await respond(request, path);
    await drain(request);
    return response;
  } catch (error) {
    await drain(request).catch(() => {});
    if (error instanceof Response) return error;
    console.error("A file upload failed.", error);
    return refusal(
      500,
      "Something went wrong on our side, and the file wasn't attached. Try again.",
    );
  }
}
