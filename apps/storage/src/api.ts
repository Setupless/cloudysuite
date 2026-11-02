import { env } from "cloudflare:workers";
import { parseDriveId } from "@cloudysuite/access";
import { isFromApp } from "@cloudysuite/auth/origins";
import {
  declaredBytes,
  drain,
  type Outcome,
  readUpTo,
} from "@cloudysuite/transfer";
import { readSettings } from "../../../src/settings";
import { NO_ACCESS_MESSAGE, openDriveFor } from "./access";
import { parseItemId } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const refusal = (status: number, message: string) => json({ message }, status);

const reply = <Value>(outcome: Outcome<Value>) =>
  outcome.ok ? json(outcome.value) : refusal(outcome.status, outcome.message);

// /api/drives/<drive>/uploads
// /api/drives/<drive>/uploads/<upload>/parts/<number>
// /api/drives/<drive>/uploads/<upload>/complete
async function respond(request: Request, path: string): Promise<Response> {
  // The hostname router sends every request to /setup until a domain is stored.
  const { primaryDomain } = await readSettings(env.DB);
  if (primaryDomain === null || !isFromApp(request, primaryDomain, "storage")) {
    return refusal(403, "This request didn't come from CloudySuite.");
  }

  const [rawDriveId, resource, rawUploadId, action, rawPart] = path.split("/");
  const driveId = parseDriveId(rawDriveId ?? "");
  if (!driveId) return refusal(403, NO_ACCESS_MESSAGE);
  const { uploads } = await openDriveFor(request, driveId);

  const notFound = refusal(404, "There is nothing at this address.");
  if (resource !== "uploads") return notFound;
  if (rawUploadId === undefined) {
    if (request.method !== "POST") return notFound;
    return reply(await uploads.start(await request.json().catch(() => null)));
  }
  const uploadId = parseItemId(rawUploadId);
  if (!uploadId) return notFound;

  if (action === "parts" && request.method === "PUT") {
    if (!/^\d{1,5}$/.test(rawPart ?? "")) return notFound;
    return reply(
      await uploads.putPart(uploadId, Number(rawPart), {
        declaredBytes: declaredBytes(request),
        read: (limit) => readUpTo(request.body, limit),
      }),
    );
  }
  if (action === "complete" && rawPart === undefined) {
    return request.method === "POST"
      ? reply(await uploads.complete(uploadId))
      : notFound;
  }
  return notFound;
}

// Every call checks the session and the drive's list again, including each part of a
// file, because access can be removed while a long upload runs.
export async function handleUploadRequest(
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
    console.error("An upload request failed.", error);
    return refusal(
      500,
      "Something went wrong on our side. What you already sent is safe. Try again.",
    );
  }
}
