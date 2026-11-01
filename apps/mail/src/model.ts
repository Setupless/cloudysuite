import type { Folder, LabelId, ThreadId, ThreadView } from "./types";

export const FOLDER_ORDER: readonly Folder[] = [
  "inbox",
  "archive",
  "sent",
  "drafts",
  "spam",
  "trash",
];

export const FOLDER_DISPLAY: Record<
  Folder,
  { title: string; countsUnread: boolean; empty: string }
> = {
  inbox: {
    title: "Inbox",
    countsUnread: true,
    empty: "Your inbox is clear. New mail will show up here.",
  },
  archive: {
    title: "Archive",
    countsUnread: true,
    empty: "Nothing archived yet. Archived mail stays here until you need it.",
  },
  sent: {
    title: "Sent",
    countsUnread: false,
    empty: "Mail you send will show up here.",
  },
  drafts: {
    title: "Drafts",
    countsUnread: false,
    empty: "You have no drafts.",
  },
  spam: {
    title: "Spam",
    countsUnread: true,
    empty: "No spam. Mail that looks suspicious will wait here.",
  },
  trash: {
    title: "Trash",
    countsUnread: false,
    empty: "Trash is empty.",
  },
};

const isFolder = (raw: string): raw is Folder =>
  Object.hasOwn(FOLDER_DISPLAY, raw);

export function viewParam(view: ThreadView): string {
  return "folder" in view ? view.folder : `label-${view.labelId}`;
}

export function parseViewParam(raw: string): ThreadView | null {
  if (isFolder(raw)) return { folder: raw };
  const match = /^label-([1-9]\d{0,15})$/.exec(raw);
  return match ? { labelId: Number(match[1]) as LabelId } : null;
}

export function parseThreadParam(raw: string): ThreadId | null {
  return /^[1-9]\d{0,15}$/.test(raw) ? (Number(raw) as ThreadId) : null;
}

export type MoveId =
  | "archive"
  | "toInbox"
  | "spam"
  | "trash"
  | "restore"
  | "notSpam"
  | "deleteForever";

export const MOVE_DISPLAY: Record<
  MoveId,
  {
    label: string;
    done: string;
    verb: string;
    // Where the conversation lands, for the sidebar's count until the next refresh.
    to: Folder | null;
  }
> = {
  archive: {
    label: "Archive",
    done: "Archived.",
    verb: "archive",
    to: "archive",
  },
  toInbox: {
    label: "Move to Inbox",
    done: "Moved to Inbox.",
    verb: "move",
    to: "inbox",
  },
  spam: {
    label: "Mark as spam",
    done: "Moved to Spam.",
    verb: "move",
    to: "spam",
  },
  trash: {
    label: "Move to Trash",
    done: "Moved to Trash.",
    verb: "move",
    to: "trash",
  },
  restore: {
    label: "Restore",
    done: "Restored.",
    verb: "restore",
    to: "inbox",
  },
  notSpam: {
    label: "Not spam",
    done: "Moved out of Spam.",
    verb: "move",
    to: "inbox",
  },
  deleteForever: {
    label: "Delete forever",
    done: "Deleted forever.",
    verb: "delete",
    to: null,
  },
};

export const MOVES_BY_FOLDER: Record<Folder, readonly MoveId[]> = {
  inbox: ["archive", "spam", "trash"],
  archive: ["toInbox", "spam", "trash"],
  sent: ["trash"],
  drafts: ["trash"],
  spam: ["notSpam", "trash", "deleteForever"],
  trash: ["restore", "deleteForever"],
};

// A label holds mail from several folders, so moving out of one needs choices
// that belong with label management.
export const movesFor = (view: ThreadView): readonly MoveId[] =>
  "folder" in view ? MOVES_BY_FOLDER[view.folder] : [];
