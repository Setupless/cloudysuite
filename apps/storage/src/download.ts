import { parseDriveId } from "@cloudysuite/access";
import { NO_ACCESS_MESSAGE, openDriveFor } from "./access";
import type { DriveClient } from "./client";
import {
  downloadResponse,
  notFound,
  plainText,
  previewResponse,
} from "./file-responses";
import { type ItemId, parseItemId } from "./types";

type FileParams = { driveId: string; itemId: string };

// Thrown refusals are Responses, and these two routes are plain requests rather than
// server functions, so nothing else turns them into a reply.
async function respond(
  request: Request,
  params: FileParams,
  answer: (drive: DriveClient, itemId: ItemId) => Promise<Response>,
): Promise<Response> {
  const driveId = parseDriveId(params.driveId);
  if (!driveId) return plainText(403, NO_ACCESS_MESSAGE);
  try {
    const drive = await openDriveFor(request, driveId);
    const itemId = parseItemId(params.itemId);
    const response = itemId ? await answer(drive, itemId) : notFound();
    // Someone not on the drive gets one answer, so an id can't test what's in it.
    return drive.role === null && response.status === 404
      ? plainText(403, NO_ACCESS_MESSAGE)
      : response;
  } catch (failure) {
    if (failure instanceof Response) return failure;
    throw failure;
  }
}

export const downloadFile = (request: Request, params: FileParams) =>
  respond(request, params, downloadResponse);

export const previewFile = (request: Request, params: FileParams) =>
  respond(request, params, previewResponse);
