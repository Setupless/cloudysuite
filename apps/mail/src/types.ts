import type { MailboxId } from "@cloudysuite/access";
import type { SpamFacts, SpamTraining, SpamVerdict } from "./spam/types";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type { MailboxId };
export type MessageId = Brand<number, "MessageId">;
export type ThreadId = Brand<number, "ThreadId">;
export type AttachmentId = Brand<number, "AttachmentId">;
export type LabelId = Brand<number, "LabelId">;

export const FOLDERS = [
  "inbox",
  "sent",
  "drafts",
  "spam",
  "trash",
  "archive",
] as const;
export type Folder = (typeof FOLDERS)[number];

export function liveFolders(folders: readonly Folder[]): Folder[] {
  const unique = [...new Set(folders)];
  const live = unique.filter((one) => one !== "spam" && one !== "trash");
  return live.length > 0 ? live : unique;
}

export type MessageSource = "inbound" | "import" | "sent";

export type ParseStatus = "parsed" | "failed";

export type BodyKind = "text" | "html";

export const AUTH_VERDICTS = [
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
  "policy",
] as const;
export type AuthVerdict = (typeof AUTH_VERDICTS)[number];

// Weakest first.
export const DMARC_POLICIES = ["none", "quarantine", "reject"] as const;
export type DmarcPolicy = (typeof DMARC_POLICIES)[number];

export type AuthResults = {
  spf: AuthVerdict | null;
  dkim: AuthVerdict | null;
  dmarc: AuthVerdict | null;
  // Which domains those passes were for. A pass alone says nothing about the From
  // line. These are absent when the header doesn't name them, and on older mail.
  dkimPassDomains?: string[];
  dmarcDomain?: string;
  // What the domain asks receivers to do with mail that fails, when the header says.
  dmarcPolicy?: DmarcPolicy;
};

export type Address = { name: string; address: string };

export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

// A Durable Object row holds at most 2 MB, and each body part is its own row.
export const BODY_INLINE_LIMIT_BYTES = 1024 * 1024;

export type NewBody = { kind: BodyKind; size: number } & (
  { inline: string } | { r2Key: string }
);

export type NewAttachment = {
  position: number;
  filename: string | null;
  mimeType: string;
  inline: boolean;
  contentId: string | null;
  size: number;
  r2Key: string;
};

export type NewMessage = {
  rawHash: string;
  rawSize: number;
  r2Prefix: string;
  source: MessageSource;
  envelopeFrom: string | null;
  envelopeTo: string | null;
  parseStatus: ParseStatus;
  rfcMessageId: string | null;
  references: string[];
  subject: string | null;
  from: Address | null;
  replyTo: Address[];
  to: Address[];
  cc: Address[];
  // Only a sent copy has this. An inbound message's Bcc header is the sender's business.
  bcc: Address[];
  snippet: string;
  sentAt: number | null;
  receivedAt: number;
  authResults: AuthResults | null;
  // Only inbound mail is scored, so only inbound mail has these.
  spamFacts?: SpamFacts | undefined;
  // The rule descriptions the optional Jev check said this message fits. Absent means
  // there is no key, so rules that use descriptions are paused. A failed check is an
  // empty list: nothing fits, and the rules still run.
  fits?: readonly string[] | undefined;
  searchBody: string;
  bodies: NewBody[];
  attachments: NewAttachment[];
};

export type MessageRef = {
  messageId: MessageId;
  threadId: ThreadId;
  folder: Folder;
};

export type CommitResult = { status: "stored" | "duplicate" } & MessageRef;

export type IngestResult = CommitResult | { status: "tooLarge" };

export type ThreadView = { folder: Folder } | { labelId: LabelId };

export type ThreadQuery = {
  view: ThreadView;
  cursor?: string | undefined;
  limit?: number | undefined;
};

export type ThreadSummary = {
  id: ThreadId;
  subject: string | null;
  snippet: string;
  senders: Address[];
  lastMessageAt: number;
  messageCount: number;
  unreadCount: number;
  starred: boolean;
  hasAttachments: boolean;
  folders: Folder[];
  labelIds: LabelId[];
};

export type ThreadPage = {
  threads: ThreadSummary[];
  nextCursor: string | null;
};

export type AttachmentInfo = {
  id: AttachmentId;
  filename: string | null;
  mimeType: string;
  inline: boolean;
  contentId: string | null;
  size: number;
};

export type MessageDetail = {
  id: MessageId;
  threadId: ThreadId;
  rfcMessageId: string | null;
  references: string[];
  from: Address | null;
  replyTo: Address[];
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string | null;
  snippet: string;
  sentAt: number | null;
  receivedAt: number;
  read: boolean;
  starred: boolean;
  folder: Folder;
  source: MessageSource;
  envelopeTo: string | null;
  parseStatus: ParseStatus;
  authResults: AuthResults | null;
  spam: SpamVerdict | null;
  spamTraining: SpamTraining | null;
  labelIds: LabelId[];
  attachments: AttachmentInfo[];
};

export type ThreadDetail = { id: ThreadId; messages: MessageDetail[] };

export const labelsOnThread = (detail: ThreadDetail): LabelId[] => [
  ...new Set(detail.messages.flatMap((message) => message.labelIds)),
];

export const LABEL_COLOURS = [
  "secondary",
  "accent",
  "tag-2",
  "tag-1",
  "danger",
] as const;
export type LabelColour = (typeof LABEL_COLOURS)[number];

export const parseColour = (raw: unknown): LabelColour =>
  LABEL_COLOURS.includes(raw as LabelColour)
    ? (raw as LabelColour)
    : "secondary";

export type LabelSummary = {
  id: LabelId;
  name: string;
  colour: LabelColour;
  unread: number;
};

// Unread counts conversations, the same rows a person sees in the list.
export type MailboxSummary = {
  folderUnread: Record<Folder, number>;
  labels: LabelSummary[];
};

export type MessageSelection =
  | { messageIds: MessageId[] }
  | { threadIds: ThreadId[]; inFolder?: Folder | Folder[] | undefined };

export type MessageFlags = {
  read?: boolean | undefined;
  starred?: boolean | undefined;
};

export type BodyRef = { kind: BodyKind } & (
  { inline: string } | { r2Key: string }
);

export type AttachmentRef = AttachmentInfo & { r2Key: string };

export type RecentAttachment = {
  messageId: MessageId;
  attachmentId: AttachmentId;
  filename: string | null;
  mimeType: string;
  fromName: string | null;
  fromAddress: string | null;
  receivedAt: number;
};

export type MessageBody = { text: string | null; html: string | null };
