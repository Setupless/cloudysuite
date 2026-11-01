import { env } from "cloudflare:workers";
import { checkMailboxAccess, parseMailboxId } from "@cloudysuite/access";
import { requireReadyUser } from "@cloudysuite/auth/guard";
import { readSettings } from "../../../../src/settings";
import { openMailboxImports } from "../client";
import { isFromMailApp } from "./origin";
import { type Outcome, readUpTo } from "./uploads";

const JOB_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const refusal = (status: number, message: string) => json({ message }, status);

const reply = <Value>(outcome: Outcome<Value>) =>
  outcome.ok ? json(outcome.value) : refusal(outcome.status, outcome.message);

function declaredBytes(request: Request): number | null {
  const header = request.headers.get("Content-Length");
  return header !== null && /^\d{1,12}$/.test(header) ? Number(header) : null;
}

async function respond(request: Request, path: string): Promise<Response> {
  const user = await requireReadyUser(request);
  if (request.method !== "GET") {
    // The hostname router sends every request to /setup until a domain is stored.
    const { primaryDomain } = await readSettings(env.DB);
    if (primaryDomain === null || !isFromMailApp(request, primaryDomain)) {
      return refusal(403, "This request didn't come from CloudySuite.");
    }
  }

  const [rawMailboxId, resource, rawJobId, action, rawPart] = path.split("/");
  const mailboxId = parseMailboxId(rawMailboxId ?? "");
  const cannotImport = () =>
    refusal(403, "Only a manager of this mailbox can import mail into it.");
  if (!mailboxId) return cannotImport();
  const access = await checkMailboxAccess(env.DB, user.id, mailboxId);
  if (!access.allowed) return cannotImport();
  const imports = openMailboxImports(env, access.grant);
  if (!imports) return cannotImport();

  const notFound = refusal(404, "There is nothing at this address.");
  if (resource === undefined) {
    return request.method === "GET" ? json(await imports.status()) : notFound;
  }
  if (resource !== "jobs") return notFound;
  if (rawJobId === undefined) {
    if (request.method !== "POST") return notFound;
    const file: unknown = await request.json().catch(() => null);
    return reply(await imports.start(file));
  }
  if (!JOB_ID.test(rawJobId)) return notFound;

  if (action === "parts" && request.method === "PUT") {
    if (!/^\d{1,5}$/.test(rawPart ?? "")) return notFound;
    return reply(
      await imports.putPart(rawJobId, Number(rawPart), {
        declaredBytes: declaredBytes(request),
        read: (limit) => readUpTo(request.body, limit),
      }),
    );
  }
  if (rawPart !== undefined || request.method !== "POST") return notFound;
  if (action === "finish") return reply(await imports.finishUpload(rawJobId));
  if (action === "cancel") return reply(await imports.cancel(rawJobId));
  return notFound;
}

// A refusal sent while the browser is still sending a 10 MB part reaches it as a
// dropped connection, and the person sees "check your connection" instead of the
// reason. Reading to the end costs little, because nothing keeps the bytes and the
// platform caps a request's size.
async function drain(request: Request): Promise<void> {
  if (request.body && !request.bodyUsed) {
    await request.body.pipeTo(new WritableStream());
  }
}

// Every call checks the session and the mailbox role again, including each part of
// a file, because access can be removed while a long upload runs.
export async function handleImportRequest(
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
    console.error("An import request failed.", error);
    return refusal(
      500,
      "Something went wrong on our side. Your file is safe. Try again.",
    );
  }
}
