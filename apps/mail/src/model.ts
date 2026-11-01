import type { Folder, LabelId, ThreadId, ThreadView } from "./types";

// What the list beside the reading pane is showing. A folder holds mail from one
// place. A label and a search can hold mail from several.
export type MailListing = ThreadView | { search: string };

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

const SEARCH_PARAM = "search";

export function viewParam(listing: MailListing): string {
  if ("search" in listing) return SEARCH_PARAM;
  return "folder" in listing ? listing.folder : `label-${listing.labelId}`;
}

// The URL's query string, which only a search listing uses.
export const listingSearchParams = (listing: MailListing): { q?: string } =>
  "search" in listing ? { q: listing.search } : {};

export function parseViewParam(raw: string): ThreadView | null {
  if (isFolder(raw)) return { folder: raw };
  const match = /^label-([1-9]\d{0,15})$/.exec(raw);
  return match ? { labelId: Number(match[1]) as LabelId } : null;
}

export function parseListing(
  raw: string,
  q: string | undefined,
): MailListing | null {
  return raw === SEARCH_PARAM ? { search: q ?? "" } : parseViewParam(raw);
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
    // In a listing that spans folders, the folders this move takes messages from.
    from: readonly Folder[];
    // Archiving does not take a conversation out of a label or a search.
    staysInMixedListing: boolean;
  }
> = {
  archive: {
    label: "Archive",
    done: "Archived.",
    verb: "archive",
    to: "archive",
    from: ["inbox"],
    staysInMixedListing: true,
  },
  toInbox: {
    label: "Move to Inbox",
    done: "Moved to Inbox.",
    verb: "move",
    to: "inbox",
    from: ["archive"],
    staysInMixedListing: true,
  },
  spam: {
    label: "Mark as spam",
    done: "Moved to Spam.",
    verb: "move",
    to: "spam",
    from: ["inbox", "archive"],
    staysInMixedListing: false,
  },
  trash: {
    label: "Move to Trash",
    done: "Moved to Trash.",
    verb: "move",
    to: "trash",
    from: ["inbox", "archive", "sent", "drafts", "spam"],
    staysInMixedListing: false,
  },
  restore: {
    label: "Restore",
    done: "Restored.",
    verb: "restore",
    to: "inbox",
    from: ["trash"],
    staysInMixedListing: false,
  },
  notSpam: {
    label: "Not spam",
    done: "Moved out of Spam.",
    verb: "move",
    to: "inbox",
    from: ["spam"],
    staysInMixedListing: false,
  },
  deleteForever: {
    label: "Delete forever",
    done: "Deleted forever.",
    verb: "delete",
    to: null,
    from: ["spam", "trash"],
    staysInMixedListing: false,
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

const MOVE_ORDER: readonly MoveId[] = [
  "archive",
  "toInbox",
  "spam",
  "notSpam",
  "trash",
  "restore",
  "deleteForever",
];

// In a folder, a conversation's moves come from the folder. Elsewhere they come
// from wherever that conversation's messages are.
export function movesFor(
  listing: MailListing,
  folders: readonly Folder[],
): readonly MoveId[] {
  if ("folder" in listing) return MOVES_BY_FOLDER[listing.folder];
  return MOVE_ORDER.filter((move) =>
    folders.some((folder) => MOVES_BY_FOLDER[folder].includes(move)),
  );
}
