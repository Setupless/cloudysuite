import { Avatar, Badge, Button, Notice } from "@cloudysuite/ui";
import {
  IconChevronDown,
  IconDownload,
  IconPaperclip,
  IconPhoto,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { safeFileName } from "../attachment-headers";
import { linkify } from "../email/linkify";
import type { RenderedBody } from "../email/render-body";
import { FOLDER_DISPLAY } from "../model";
import { bodyQuery } from "../queries";
import type {
  Address,
  AttachmentId,
  AttachmentInfo,
  AuthResults,
  AuthVerdict,
  MailboxId,
  MessageDetail,
  MessageId,
} from "../types";
import { EmailFrame } from "./email-frame";
import {
  displayName,
  formatAddress,
  formatFullDate,
  formatSize,
} from "./format";
import { useMailView } from "./mail-view-context";
import { FailureNotice, ThreadDate } from "./states";

const originalUrl = (mailboxId: MailboxId, messageId: MessageId) =>
  `/download/${mailboxId}/${messageId}/original`;

const attachmentUrl = (
  mailboxId: MailboxId,
  messageId: MessageId,
  attachmentId: AttachmentId,
) => `/download/${mailboxId}/${messageId}/${attachmentId}`;

function PlainTextBody({ text }: { text: string }) {
  return (
    <div
      dir="auto"
      className="text-sm leading-6 break-words whitespace-pre-wrap"
    >
      {linkify(text).map((segment, index) =>
        segment.kind === "text" ? (
          segment.text
        ) : (
          <a
            key={index}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline"
          >
            {segment.text}
          </a>
        ),
      )}
    </div>
  );
}

function HtmlBody({
  body,
  title,
}: {
  body: Extract<RenderedBody, { kind: "html" }>;
  title: string;
}) {
  const [showImages, setShowImages] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      {body.hasRemoteImages && !showImages && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded bg-sidebar px-3 py-2 text-sm text-secondary">
          <IconPhoto size={18} stroke={1.75} aria-hidden />
          <p className="min-w-0 flex-1 basis-48">
            Images are hidden, because they can tell the sender you opened this
            message.
          </p>
          <Button variant="quiet" onClick={() => setShowImages(true)}>
            Show images
          </Button>
        </div>
      )}
      <EmailFrame
        title={title}
        html={body.html}
        designed={body.designed}
        showRemoteImages={showImages}
      />
    </div>
  );
}

function Attachments({
  message,
  mailboxId,
  embedded,
}: {
  message: MessageDetail;
  mailboxId: MailboxId;
  embedded: readonly AttachmentId[];
}) {
  const shown = message.attachments.filter(
    (attachment: AttachmentInfo) => !embedded.includes(attachment.id),
  );
  if (shown.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Attachments">
      {shown.map((attachment) => (
        <li key={attachment.id} className="max-w-full">
          <a
            href={attachmentUrl(mailboxId, message.id, attachment.id)}
            download
            className="flex items-center gap-2 rounded border border-line px-3 py-2 text-sm outline-accent hover:bg-field focus-visible:outline-2"
          >
            <IconPaperclip
              size={16}
              stroke={1.75}
              className="flex-none text-secondary"
              aria-hidden
            />
            <span className="min-w-0 truncate">
              {safeFileName(attachment.filename, "Attachment")}
            </span>
            <span className="flex-none text-xs text-secondary">
              {formatSize(attachment.size)}
            </span>
            <IconDownload
              size={16}
              stroke={1.75}
              className="flex-none text-secondary"
              aria-hidden
            />
          </a>
        </li>
      ))}
    </ul>
  );
}

function MessageBody({
  message,
  mailboxId,
}: {
  message: MessageDetail;
  mailboxId: MailboxId;
}) {
  const query = useQuery(bodyQuery(mailboxId, message.id));
  const download = (
    <a href={originalUrl(mailboxId, message.id)} download className="underline">
      Download the original
    </a>
  );

  if (query.isPending) {
    return (
      <div aria-hidden className="flex animate-pulse flex-col gap-2 py-2">
        <div className="h-3 w-4/5 rounded bg-field" />
        <div className="h-3 w-3/5 rounded bg-field" />
        <div className="h-3 w-2/3 rounded bg-field" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <FailureNotice
        message={query.error.message}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const body = query.data;
  const embedded = body?.kind === "html" ? body.embedded : [];
  return (
    <div className="flex flex-col gap-3">
      {message.parseStatus === "failed" && (
        <Notice tone="info">
          We couldn't read this message's format. {download} to see it.
        </Notice>
      )}
      {!body && (
        <Notice tone="info">This message isn't available anymore.</Notice>
      )}
      {body?.kind === "html" && (
        <HtmlBody
          body={body}
          title={`Message from ${displayName(message.from)}`}
        />
      )}
      {body?.kind === "text" && <PlainTextBody text={body.text} />}
      {body?.kind === "empty" && message.parseStatus === "parsed" && (
        <p className="text-sm text-secondary">This message has no text.</p>
      )}
      {body?.kind === "tooLong" && (
        <Notice tone="info">
          This message is too long to show here. {download} to read it.
        </Notice>
      )}
      <Attachments
        message={message}
        mailboxId={mailboxId}
        embedded={embedded}
      />
    </div>
  );
}

const VERDICT_WORDS: Record<AuthVerdict, string> = {
  pass: "passed",
  fail: "failed",
  softfail: "failed",
  neutral: "no result",
  none: "not checked",
  temperror: "no result",
  permerror: "no result",
  policy: "no result",
};

function senderChecks(results: AuthResults): string {
  return (["spf", "dkim", "dmarc"] as const)
    .filter((check) => results[check] !== null)
    .map(
      (check) =>
        `${check.toUpperCase()} ${VERDICT_WORDS[results[check] as AuthVerdict]}`,
    )
    .join(", ");
}

const peopleLine = (people: Address[]) => people.map(formatAddress).join(", ");

function MessageDetails({
  message,
  mailboxId,
}: {
  message: MessageDetail;
  mailboxId: MailboxId;
}) {
  const rows: [string, string][] = [
    ["From", message.from ? formatAddress(message.from) : "Unknown sender"],
    ["Reply to", peopleLine(message.replyTo)],
    ["To", peopleLine(message.to)],
    ["Cc", peopleLine(message.cc)],
    ["Delivered to", message.envelopeTo ?? ""],
    ["Date", formatFullDate(message.sentAt ?? message.receivedAt)],
    ["Subject", message.subject ?? ""],
    [
      "Sender checks",
      message.authResults ? senderChecks(message.authResults) : "",
    ],
    ["Message ID", message.rfcMessageId ?? ""],
  ];
  return (
    <div className="flex flex-col gap-2 rounded bg-sidebar px-3 py-2 text-xs">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {rows
          .filter(([, value]) => value)
          .map(([name, value]) => (
            <div key={name} className="col-span-2 grid grid-cols-subgrid">
              <dt className="text-secondary">{name}</dt>
              <dd className="break-words">{value}</dd>
            </div>
          ))}
      </dl>
      <a
        href={originalUrl(mailboxId, message.id)}
        download
        className="self-start text-accent underline outline-accent focus-visible:outline-2"
      >
        Download the original
      </a>
    </div>
  );
}

export function MessageCard({
  message,
  open,
  onToggle,
}: {
  message: MessageDetail;
  open: boolean;
  onToggle: () => void;
}) {
  const { mailboxId, view } = useMailView();
  const [showDetails, setShowDetails] = useState(false);
  const sender = {
    name: displayName(message.from),
    email: message.from?.address ?? "",
  };
  const elsewhere =
    "folder" in view && message.folder !== view.folder
      ? FOLDER_DISPLAY[message.folder].title
      : null;
  const date = message.sentAt ?? message.receivedAt;

  if (!open) {
    return (
      <article className="border-b border-line">
        <button
          type="button"
          aria-expanded={false}
          onClick={onToggle}
          className="flex w-full cursor-pointer items-center gap-2.5 px-1 py-2.5 text-left outline-accent hover:bg-field focus-visible:outline-2"
        >
          <Avatar person={sender} />
          <span
            className={`w-32 flex-none truncate text-sm ${message.read ? "" : "font-semibold"}`}
          >
            {sender.name}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-secondary">
            {message.snippet}
          </span>
          {elsewhere && <Badge>In {elsewhere}</Badge>}
          <ThreadDate timestamp={date} />
        </button>
      </article>
    );
  }

  return (
    <article className="flex flex-col gap-3 border-b border-line py-3">
      <header className="flex items-start gap-2.5">
        <button
          type="button"
          aria-expanded
          aria-label={`Collapse message from ${sender.name}`}
          onClick={onToggle}
          className="flex-none cursor-pointer rounded-full outline-accent focus-visible:outline-2"
        >
          <Avatar person={sender} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">
            <span className="font-semibold">{sender.name}</span>
            {sender.email && sender.email !== sender.name && (
              <span className="ml-1.5 text-xs text-secondary">
                {sender.email}
              </span>
            )}
          </p>
          <button
            type="button"
            aria-expanded={showDetails}
            onClick={() => setShowDetails(!showDetails)}
            className="flex max-w-full cursor-pointer items-center gap-1 text-xs text-secondary outline-accent focus-visible:outline-2"
          >
            <span className="truncate">
              To{" "}
              {message.to.map(displayName).join(", ") || "undisclosed people"}
            </span>
            <IconChevronDown
              size={14}
              stroke={1.75}
              className={`flex-none ${showDetails ? "rotate-180" : ""}`}
              aria-hidden
            />
            <span className="sr-only">
              {showDetails ? "Hide details" : "Show details"}
            </span>
          </button>
        </div>
        {elsewhere && <Badge>In {elsewhere}</Badge>}
        <ThreadDate timestamp={date} />
      </header>
      {showDetails && (
        <MessageDetails message={message} mailboxId={mailboxId} />
      )}
      <MessageBody message={message} mailboxId={mailboxId} />
    </article>
  );
}
