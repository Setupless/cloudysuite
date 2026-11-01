import type { DriveId } from "@cloudysuite/access";
import type { ItemId } from "./types";

// A file's bytes live under one R2 key, and two objects can't share a transaction, so
// both drives hold rows for that key during a move. Only an unlocked row can be trashed,
// and so purged. That keeps one owner for the key at every step:
//
//   sender        receiver rows    who can delete the bytes
//   sending       none or locked   nobody
//   confirming    locked           nobody, and the sender's rows are gone
//   (record gone) unlocked         the receiver
//   abandoning    none or locked   the sender. Locked rows leave without touching R2.
//
// Each sender step retries from the alarm, and each receiver step is safe to repeat.
export type OutgoingPhase = "sending" | "confirming" | "abandoning";

// The record outlives the rows' lock, so a late copy of a delivery can't add them again.
export type IncomingPhase = "locked" | "unlocked" | "abandoned";

// What crosses between two objects. Parents come before their children.
export type MovedRow = {
  id: string;
  parentId: string | null;
  kind: "folder" | "file";
  name: string;
  nameKey: string;
  size: number | null;
  mimeType: string | null;
  r2Key: string | null;
  createdBy: string;
  createdAt: number;
  changedAt: number;
};

export type MoveDelivery = {
  moveId: string;
  fromDriveId: DriveId;
  toDriveId: DriveId;
  toParentId: ItemId | null;
  rows: MovedRow[];
};

export type OutgoingMove =
  | (MoveDelivery & { phase: "sending"; giveUpAt: number })
  | {
      phase: Exclude<OutgoingPhase, "sending">;
      moveId: string;
      toDriveId: DriveId;
    };

export type ReceiveResult =
  | { status: "received" }
  | { status: "nameTaken" }
  | { status: "noDestination" }
  | { status: "folderBusy" }
  | { status: "overLimit"; bytes: number };

export const movedBytes = (rows: readonly MovedRow[]) =>
  rows.reduce((total, row) => total + (row.size ?? 0), 0);
