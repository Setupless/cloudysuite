import { Spinner } from "@cloudysuite/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { IconAlertCircle, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useOffline } from "../../pwa/connectivity";
import { callAction, refreshMailbox } from "../../queries";
import type { MailboxId } from "../../types";
import { useToast } from "../../ui/toast";
import { reopenOutgoing, undoSend } from "../functions";
import {
  type OutgoingId,
  type OutgoingSummary,
  SEND_FAILURES,
  UNKNOWN_OUTCOME_TEXT,
} from "../types";
import { useCompose } from "./compose-context";
import { composeKeys, isOnItsWay, outgoingQuery } from "./queries";

const SENT_NOTE_MS = 6_000;

const TRAY_ACTION =
  "inline-flex cursor-pointer items-center gap-1.5 font-semibold underline outline-page focus-visible:outline-2 disabled:cursor-default disabled:not-aria-busy:opacity-60 aria-busy:cursor-progress";
const NOTICE_ACTION =
  "inline-flex cursor-pointer items-center gap-1.5 font-semibold text-accent underline outline-accent focus-visible:outline-2 disabled:cursor-default disabled:not-aria-busy:opacity-60 aria-busy:cursor-progress";

const STILL_GOING_OFFLINE =
  "You're offline, so Undo isn't available. This message doesn't need this device and will still go.";

const DISMISSED_KEY = "cloudysuite-send-notices-put-aside";

// For this tab's session, so a reload doesn't bring back what was just moved aside.
function readDismissed(): ReadonlySet<OutgoingId> {
  if (typeof sessionStorage === "undefined") return new Set();
  const stored = sessionStorage.getItem(DISMISSED_KEY);
  return new Set(stored ? (JSON.parse(stored) as OutgoingId[]) : []);
}

function secondsLeft(job: OutgoingSummary, fetchedAt: number, now: number) {
  const left = (job.msUntilDue ?? 0) - Math.max(0, now - fetchedAt);
  return Math.max(0, Math.ceil(left / 1000));
}

function useTick(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function useUndoSend(mailboxId: MailboxId) {
  const { openDraft } = useCompose();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [undoing, setUndoing] = useState<OutgoingId | null>(null);
  const undo = async (job: OutgoingSummary) => {
    setUndoing(job.id);
    try {
      const { undone } = await callAction(() =>
        undoSend({ data: { mailboxId, id: job.id } }),
      );
      if (undone) {
        openDraft(job.id);
        toast({ message: "Stopped. Your message is back as a draft." });
      } else {
        toast({
          tone: "danger",
          message: "It's too late to undo. This message is already on its way.",
        });
      }
    } catch (error) {
      toast({
        tone: "danger",
        message: `We couldn't undo that. ${(error as Error).message}`,
      });
    }
    await queryClient.invalidateQueries({
      queryKey: composeKeys.outgoing(mailboxId),
    });
    setUndoing((current) => (current === job.id ? null : current));
  };
  return { undo, undoing };
}

function Card({
  message,
  children,
}: {
  message: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      role="status"
      data-testid="send-status"
      className="pointer-events-auto flex max-w-xl flex-wrap items-center gap-x-4 gap-y-1 rounded bg-text px-4 py-2.5 text-sm text-page shadow-lg"
    >
      <span className="min-w-0 flex-1">{message}</span>
      {children}
    </div>
  );
}

function Notice({
  tone,
  message,
  children,
}: {
  tone: "info" | "danger";
  message: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      data-testid="send-status"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-sidebar px-4 py-2 text-sm"
    >
      <span className="flex min-w-0 flex-1 basis-60 items-start gap-2">
        {tone === "danger" && (
          <IconAlertCircle
            size={18}
            stroke={1.75}
            aria-hidden
            className="mt-px flex-none text-danger"
          />
        )}
        <span className="min-w-0 break-words">{message}</span>
      </span>
      <span className="flex items-center gap-3">{children}</span>
    </div>
  );
}

// What can wait for minutes sits in the page above the mail, not over it, so it never
// covers a row or a button however long it stays. One at a time keeps it from eating
// the screen: the rest are in Drafts with the same words.
export function SendNotices() {
  const { mailboxId, openDraft } = useCompose();
  const queryClient = useQueryClient();
  const toast = useToast();
  const outgoing = useQuery(outgoingQuery(mailboxId));
  const mine = (outgoing.data ?? []).filter((job) => job.sentByViewer);
  const { undo, undoing } = useUndoSend(mailboxId);
  const [reopening, setReopening] = useState<OutgoingId | null>(null);
  const [dismissed, setDismissed] = useState(readDismissed);
  const offline = useOffline();

  const retrying = mine.filter((job) => job.retrying);
  const now = useTick(retrying.length > 0);
  const unsettled = mine.filter(
    (job) =>
      (job.state === "failed" || job.state === "unknown") &&
      !dismissed.has(job.id),
  );

  const reopen = async (job: OutgoingSummary) => {
    setReopening(job.id);
    try {
      await callAction(() =>
        reopenOutgoing({ data: { mailboxId, id: job.id } }),
      );
      openDraft(
        job.id,
        job.state === "unknown" ? { warning: UNKNOWN_OUTCOME_TEXT } : undefined,
      );
    } catch (error) {
      toast({ tone: "danger", message: (error as Error).message });
    }
    await queryClient.invalidateQueries({
      queryKey: composeKeys.outgoing(mailboxId),
    });
    setReopening((current) => (current === job.id ? null : current));
  };
  const dismiss = (job: OutgoingSummary) => {
    const next = new Set(dismissed).add(job.id);
    setDismissed(next);
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...next]));
  };

  // A wait comes first because its Undo has nowhere else to live.
  const [waiting] = retrying;
  const [failed] = waiting ? [] : unsettled;
  const hiddenCount =
    retrying.length + unsettled.length - (waiting || failed ? 1 : 0);

  // What this list knows stopped updating, and none of its buttons can work. The same
  // messages are back here on reconnecting.
  if (offline || (!waiting && !failed)) return null;
  return (
    <div className="flex-none">
      {waiting && (
        <Notice
          tone="info"
          message={`"${waiting.subject}" hasn't gone yet. We'll try again in ${secondsLeft(waiting, outgoing.dataUpdatedAt, now)} seconds.`}
        >
          <button
            type="button"
            className={NOTICE_ACTION}
            disabled={undoing !== null}
            aria-busy={undoing === waiting.id || undefined}
            onClick={() => void undo(waiting)}
          >
            Undo
            {undoing === waiting.id && <Spinner size={14} />}
          </button>
        </Notice>
      )}
      {failed && (
        <Notice
          tone="danger"
          message={
            failed.state === "unknown"
              ? `"${failed.subject}": ${UNKNOWN_OUTCOME_TEXT}`
              : `"${failed.subject}" wasn't sent. ${failed.failure ? SEND_FAILURES[failed.failure] : ""}`
          }
        >
          <button
            type="button"
            className={NOTICE_ACTION}
            disabled={reopening !== null}
            aria-busy={reopening === failed.id || undefined}
            onClick={() => void reopen(failed)}
          >
            {failed.state === "unknown" ? "Open as a draft" : "Open draft"}
            {reopening === failed.id && <Spinner size={14} />}
          </button>
          <button
            type="button"
            aria-label="Put this aside. It stays in Drafts."
            title="Put this aside. It stays in Drafts."
            className="cursor-pointer text-secondary outline-accent focus-visible:outline-2"
            onClick={() => dismiss(failed)}
          >
            <IconX size={16} stroke={1.75} aria-hidden />
          </button>
        </Notice>
      )}
      {hiddenCount > 0 && (
        <Notice
          tone="danger"
          message={`${hiddenCount} more ${hiddenCount === 1 ? "message needs" : "messages need"} a look.`}
        >
          <Link
            to="/mail/$mailboxId/$view"
            params={{ mailboxId, view: "drafts" }}
            className={NOTICE_ACTION}
          >
            Open Drafts
          </Link>
        </Notice>
      )}
    </div>
  );
}

// The seconds right after pressing Send. It floats because it's gone within moments.
export function SendTray() {
  const { mailboxId } = useCompose();
  const queryClient = useQueryClient();
  const outgoing = useQuery(outgoingQuery(mailboxId));
  const mine = (outgoing.data ?? []).filter((job) => job.sentByViewer);

  const hasCountdown = mine.some((job) => job.state === "scheduled");
  const now = useTick(hasCountdown);
  const fetchedAt = outgoing.dataUpdatedAt;

  // A job this screen watched finish, as opposed to one finished yesterday.
  const watching = useRef(new Set<OutgoingId>());
  const [justSent, setJustSent] = useState<OutgoingSummary | null>(null);
  useEffect(() => {
    const finished: OutgoingSummary[] = [];
    for (const job of mine) {
      if (["scheduled", "sending", "accepted"].includes(job.state)) {
        watching.current.add(job.id);
      } else if (watching.current.delete(job.id) && job.state === "sent") {
        finished.push(job);
      }
    }
    const [latest] = finished;
    if (!latest) return;
    setJustSent(latest);
    void refreshMailbox(queryClient, mailboxId);
  }, [outgoing.data]);

  const justSentId = justSent?.id;
  useEffect(() => {
    if (justSentId === undefined) return;
    const timer = setTimeout(() => setJustSent(null), SENT_NOTE_MS);
    return () => clearTimeout(timer);
  }, [justSentId]);

  const { undo, undoing } = useUndoSend(mailboxId);
  const offline = useOffline();

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-16 z-30 flex flex-col items-center gap-2 px-4">
      {mine.map((job) => {
        if (offline) {
          return isOnItsWay(job) ? (
            <Card key={job.id} message={STILL_GOING_OFFLINE} />
          ) : null;
        }
        if (job.state === "scheduled" && !job.retrying) {
          const seconds = secondsLeft(job, fetchedAt, now);
          return (
            <Card
              key={job.id}
              message={seconds > 0 ? `Sending in ${seconds}…` : "Sending…"}
            >
              <button
                type="button"
                className={TRAY_ACTION}
                disabled={undoing !== null}
                aria-busy={undoing === job.id || undefined}
                onClick={() => void undo(job)}
              >
                Undo
                {undoing === job.id && <Spinner size={14} />}
              </button>
            </Card>
          );
        }
        if (job.state === "sending" || job.state === "accepted") {
          return <Card key={job.id} message="Sending…" />;
        }
        return null;
      })}
      {justSent && (
        <Card message="Sent.">
          {justSent.threadId !== null && (
            <Link
              to="/mail/$mailboxId/$view/$threadId"
              params={{
                mailboxId,
                view: "sent",
                threadId: String(justSent.threadId),
              }}
              className={TRAY_ACTION}
            >
              View message
            </Link>
          )}
        </Card>
      )}
    </div>
  );
}
