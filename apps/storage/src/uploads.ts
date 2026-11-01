import type { DriveGrant } from "@cloudysuite/access";
import {
  expectedPartBytes,
  isUploadGone,
  MAX_FILE_BYTES,
  type Outcome,
  type PartBody,
  partCountFor,
  refuse,
} from "@cloudysuite/transfer";
import type { Drive } from "./drive";
import { hasLimit, limitRefusal, NO_ROOM_NOW, readStorageRoom } from "./limits";
import { parseItemName } from "./names";
import type {
  CommitResult,
  CompletionPlan,
  NewUploadResult,
  PartPlan,
} from "./store";
import {
  FOLDER_BUSY,
  type FileItem,
  type ItemId,
  NO_SUCH_FOLDER,
  parseItemId,
  type UploadView,
} from "./types";

const MAX_FINGERPRINT_LENGTH = 128;
const MAX_MIME_TYPE_LENGTH = 127;
const MIME_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

const UPLOAD_ENDED = refuse(
  409,
  "This upload stopped for too long, so it was removed. Choose the file again to start over.",
);

const FOLDER_ENDED = refuse(
  409,
  "The folder this was going into was deleted or moved somewhere else, so this upload stopped. Choose the file again to send it to another folder.",
);

// A 5xx, because the tray keeps trying those, and the answer changes once the move ends.
const FOLDER_LOCKED = refuse(503, FOLDER_BUSY);

// What a browser claims is kept only to choose an icon and a download type. Download
// headers and the preview route decide for themselves what is safe to serve.
function cleanMimeType(raw: unknown): string {
  const type = typeof raw === "string" ? raw : "";
  const bare = (type.split(";")[0] ?? "").trim().toLowerCase();
  return bare.length <= MAX_MIME_TYPE_LENGTH && MIME_TYPE.test(bare)
    ? bare
    : "application/octet-stream";
}

export type DriveUploads = {
  start(input: unknown): Promise<Outcome<UploadView>>;
  putPart(
    id: ItemId,
    partNumber: number,
    body: PartBody,
  ): Promise<Outcome<null>>;
  complete(id: ItemId): Promise<Outcome<FileItem>>;
};

// Runs in the Worker so that file bytes never pass through the Durable Object and hold
// up everyone else using the drive. The object only keeps the records.
export function createDriveUploads(
  database: D1Database,
  bucket: R2Bucket,
  stub: DurableObjectStub<Drive>,
  grant: DriveGrant,
): DriveUploads {
  return {
    async start(input) {
      const { parentId, name, size, mimeType, fingerprint } = (input ??
        {}) as Record<string, unknown>;
      const parent =
        typeof parentId === "string" ? parseItemId(parentId) : null;
      if (
        (parentId !== null && parent === null) ||
        typeof name !== "string" ||
        typeof fingerprint !== "string" ||
        fingerprint.length === 0 ||
        fingerprint.length > MAX_FINGERPRINT_LENGTH ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 0
      ) {
        return refuse(400, "We couldn't read the details of that file.");
      }
      if (size > MAX_FILE_BYTES) {
        return refuse(
          413,
          "This file is larger than the 100 GB limit. Split it into smaller files, then upload each one.",
        );
      }
      const parsed = parseItemName(name);
      if (!parsed.ok) return refuse(400, parsed.message);
      if (parent !== null && !(await stub.folderExists(parent))) {
        return refuse(404, NO_SUCH_FOLDER);
      }
      const refused = limitRefusal(
        await readStorageRoom(database, grant.driveId),
        size,
      );
      if (refused) return refuse(413, refused);

      const found = {
        parentId: parent,
        name: parsed.name,
        size,
        fingerprint,
        createdBy: grant.userId,
      };
      const existing = (await stub.findUpload(found)) as UploadView | null;
      if (existing) return { ok: true, value: existing };

      const id = crypto.randomUUID() as ItemId;
      const r2Key = `drives/${grant.driveId}/files/${id}`;
      const multipart = await bucket.createMultipartUpload(r2Key);
      const created = (await stub.createUpload({
        ...found,
        id,
        mimeType: cleanMimeType(mimeType),
        r2Key,
        r2UploadId: multipart.uploadId,
      })) as NewUploadResult;
      if (created.status === "folderGone") {
        await multipart.abort().catch((error: unknown) => {
          console.error("Could not stop an unused upload.", error);
        });
        return refuse(404, NO_SUCH_FOLDER);
      }
      if (created.status === "lost") await multipart.abort();
      return { ok: true, value: created.upload };
    },

    async putPart(id, partNumber, body) {
      const plan = (await stub.partPlan(id, partNumber)) as PartPlan;
      switch (plan.status) {
        case "unknown":
          return UPLOAD_ENDED;
        case "folderGone":
          return FOLDER_ENDED;
        case "badPartNumber":
          return refuse(400, "This file doesn't have a part with that number.");
        // Another tab got here first. Nothing needs storing twice.
        case "finished":
        case "stored":
          return { ok: true, value: null };
        case "needed":
          break;
      }
      const expected = expectedPartBytes(plan.size, partNumber);
      const wrongSize = refuse(
        400,
        `This part of the file must be exactly ${expected} bytes.`,
      );
      if (body.declaredBytes === null) {
        return refuse(
          411,
          "We need to know the size of this part of the file.",
        );
      }
      if (body.declaredBytes !== expected) return wrongSize;
      const bytes = await body.read(expected);
      if (bytes?.byteLength !== expected) return wrongSize;

      try {
        const part = await bucket
          .resumeMultipartUpload(plan.r2Key, plan.r2UploadId)
          .uploadPart(partNumber, bytes);
        await stub.recordPart(id, partNumber, part.etag);
        return { ok: true, value: null };
      } catch (error) {
        if (isUploadGone(error)) {
          await stub.forgetUpload(id);
          return UPLOAD_ENDED;
        }
        throw error;
      }
    },

    // Safe to repeat. A crash after R2 finished the file makes R2 refuse the second
    // try, so what counts is whether the whole file is there under its key.
    async complete(id) {
      const plan = (await stub.completionPlan(id)) as CompletionPlan;
      if (plan.status === "unknown") return UPLOAD_ENDED;
      if (plan.status === "folderGone") return FOLDER_ENDED;
      if (plan.status === "finished") return { ok: true, value: plan.item };

      const multipart = bucket.resumeMultipartUpload(
        plan.r2Key,
        plan.r2UploadId,
      );
      if (plan.size === 0) {
        // R2 can't finish a multipart upload with no parts.
        await bucket.put(plan.r2Key, new Uint8Array());
        await multipart.abort().catch(() => {});
      } else {
        if (plan.parts.length < partCountFor(plan.size)) {
          return refuse(
            409,
            "Some of the file hasn't arrived yet. Keep this page open to finish sending it.",
          );
        }
        try {
          await multipart.complete(plan.parts);
        } catch (error) {
          const stored = await bucket.head(plan.r2Key);
          if (stored?.size !== plan.size) {
            if (isUploadGone(error)) {
              await stub.forgetUpload(id);
              return UPLOAD_ENDED;
            }
            throw error;
          }
        }
      }

      const committed = (await stub.commitUpload(
        id,
        grant.driveId,
        hasLimit(await readStorageRoom(database, grant.driveId)),
      )) as CommitResult;
      switch (committed.status) {
        case "committed":
          return { ok: true, value: committed.item };
        case "unknown":
          return UPLOAD_ENDED;
        case "folderGone":
          return FOLDER_ENDED;
        case "folderBusy":
          return FOLDER_LOCKED;
        case "overLimit":
          return refuse(
            413,
            limitRefusal(
              await readStorageRoom(database, grant.driveId),
              plan.size,
            ) ?? NO_ROOM_NOW,
          );
      }
    },
  };
}
