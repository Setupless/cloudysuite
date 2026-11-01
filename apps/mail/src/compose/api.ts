import { env } from "cloudflare:workers";
import { parseMailboxId } from "@cloudysuite/access";
import { requireReadyUser } from "@cloudysuite/auth/guard";
import { isFromApp } from "@cloudysuite/auth/origins";
import { declaredBytes, drain, readUpTo } from "@cloudysuite/transfer";
import { readSettings } from "../../../../src/settings";
import { NO_ACCESS_MESSAGE, openMailboxAs } from "../access";
import { mailboxSenderFacts } from "./addresses";
import { parseOutgoingId } from "./wire";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const refusal = (status: number, message: string) => json({ message }, status);

// Only uploads need a route of their own, because a file's bytes can't pass through a
// server function. PUT /api/compose/<mailbox>/<outgoing>/attachments?name=<file name>
async function respond(request: Request, path: string): Promise<Response> {
  const user = await requireReadyUser(request);
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

  const { addresses } = await mailboxSenderFacts(env.DB, mailboxId);
  const result = await mailbox.outgoing.upload({
    id,
    fileName: new URL(request.url).searchParams.get("name") ?? "",
    mimeType: request.headers.get("Content-Type") ?? "",
    body: {
      declaredBytes: declaredBytes(request),
      read: (limit) => readUpTo(request.body, limit),
    },
    fromAddress: addresses[0]?.address ?? "",
    editor: { id: user.id, name: user.name },
  });
  return result.status === "added"
    ? json(result.attachment)
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
