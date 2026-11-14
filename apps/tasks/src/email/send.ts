import { type BoardId, levelOfRole, type UserId } from "@cloudysuite/access";
import {
  type EmailPort,
  readSendingFacts,
  type SendingFacts,
} from "@cloudysuite/app-email";
import { judgeSendError, retryDelay } from "@cloudysuite/mail/send-outcome";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { boards } from "../../../../src/db/schema";
import { roleNow } from "../client";
import type { TaskStore } from "../store";
import { type NotEmailedReason, type Task, UNDO_DELETE_MS } from "../types";
import { assignmentMime, taskLink } from "./message";
import { type CheckFailure, type QueuedEmail, WHEN_CHECK_FAILS } from "./queue";

const EMAILS_PER_WAKE_UP = 25;

type SendFailure = Extract<
  ReturnType<typeof judgeSendError>,
  { kind: "rejected" }
>["failure"];

// The service's refusals, said in the panel.
const REFUSED: Partial<Record<SendFailure, NotEmailedReason>> = {
  senderNotVerified: "senderNotVerified",
  senderDomainUnavailable: "senderNotVerified",
  dailyLimit: "dailyLimit",
  accountSuspended: "accountSuspended",
  recipientNotAllowed: "recipientNotAllowed",
  recipientSuppressed: "recipientSuppressed",
  deliveryRefused: "deliveryRefused",
};

type Context = {
  store: TaskStore;
  database: D1Database;
  email: EmailPort;
  // Puts what's been decided on disk before anything leaves.
  saveProgress: () => Promise<void>;
};

// What's read from D1 before each attempt, because the email waits a while.
type Facts = SendingFacts & {
  boardName: string | null;
  assigneeCanOpen: boolean;
  assignerCanEdit: boolean;
};

async function readFacts(
  database: D1Database,
  queued: QueuedEmail,
): Promise<Facts> {
  const [sending, board, assigneeRole, assignerRole] = await Promise.all([
    readSendingFacts(database, queued.assignedBy, [queued.assigneeId]),
    boardNameOf(database, queued.boardId),
    roleNow(database, queued.assigneeId, queued.boardId),
    roleNow(database, queued.assignedBy, queued.boardId),
  ]);
  return {
    ...sending,
    boardName: board,
    assigneeCanOpen: assigneeRole !== null,
    assignerCanEdit:
      assignerRole !== null && levelOfRole(assignerRole) === "edit",
  };
}

async function boardNameOf(
  database: D1Database,
  boardId: BoardId,
): Promise<string | null> {
  const [row] = await drizzle(database)
    .select({ name: boards.name })
    .from(boards)
    .where(eq(boards.id, boardId));
  return row?.name ?? null;
}

// What the task here says, checked first, because it needs nothing from D1.
function taskFailure(
  found: { task: Task; deletedAt: number | null } | null,
  assigneeId: UserId,
): CheckFailure | null {
  if (!found) return "taskGone";
  if (found.deletedAt !== null) return "taskDeleted";
  return found.task.assignee?.id === assigneeId ? null : "reassigned";
}

// A deleted board has no name, so its assignee can no longer open it either.
function directoryFailure(facts: Facts): CheckFailure | null {
  if (facts.appsOff.has("tasks")) return "tasksOff";
  if (facts.appsOff.has("mail")) return "mailOff";
  if (facts.appDomain === null) return "noAppDomain";
  if (!facts.assigneeCanOpen || facts.boardName === null) {
    return "assigneeCantOpen";
  }
  // Ahead of the edit check, because the board's access check also refuses a suspended
  // assigner, and only this check names that as the reason.
  if (!facts.sender) return "noSender";
  if (!facts.assignerCanEdit) return "assignerCantEdit";
  return null;
}

function tryLaterOrRefuse(
  { store }: Context,
  queued: QueuedEmail,
  reason: NotEmailedReason,
  now: number,
): void {
  const delay = retryDelay(queued.tries);
  if (delay === null) store.stepEmail(queued, "refuse", now, { reason });
  else store.stepEmail(queued, "tryLater", now, { tryAt: now + delay });
}

async function sendOne(
  context: Context,
  queued: QueuedEmail,
  now: number,
): Promise<void> {
  const { store, database, email } = context;
  const found = store.emailTask(queued.taskId);
  const failure = taskFailure(found, queued.assigneeId);
  if (failure) {
    settleFailure(context, queued, failure, found?.deletedAt ?? null, now);
    return;
  }
  const task = found!.task;
  let facts: Facts;
  try {
    facts = await readFacts(database, queued);
  } catch (error) {
    console.error("Could not check whether an assignment email may go.", error);
    tryLaterOrRefuse(context, queued, "checkUnavailable", now);
    return;
  }
  const refusal = directoryFailure(facts);
  if (refusal) {
    settleFailure(context, queued, refusal, null, now);
    return;
  }
  const to = facts.colleagues.get(queued.assigneeId);
  if (!to) {
    settleFailure(context, queued, "noAddress", null, now);
    return;
  }
  const sender = facts.sender!;
  const message = assignmentMime({
    from: sender,
    to: { address: to, name: task.assignee?.name ?? null },
    title: task.title,
    boardName: facts.boardName!,
    due: task.due,
    link: taskLink(facts.appDomain!, queued.boardId, task.id),
    now,
    id: crypto.randomUUID(),
  });

  if (!store.stepEmail(queued, "claim", now)) return;
  await context.saveProgress();
  try {
    await email.send({ from: sender.address, to, raw: message.raw });
  } catch (error) {
    const outcome = judgeSendError(error);
    if (outcome.kind === "temporary") {
      tryLaterOrRefuse(context, queued, "rateLimited", Date.now());
    } else if (outcome.kind === "rejected") {
      store.stepEmail(queued, "refuse", Date.now(), {
        reason: REFUSED[outcome.failure] ?? "invalidMessage",
      });
    } else {
      console.error("An assignment email ended without a clear answer.", error);
      store.stepEmail(queued, "unclear", Date.now());
    }
    return;
  }
  store.stepEmail(queued, "went", Date.now());
}

function settleFailure(
  { store }: Context,
  queued: QueuedEmail,
  failure: CheckFailure,
  deletedAt: number | null,
  now: number,
): void {
  const outcome = WHEN_CHECK_FAILS[failure];
  switch (outcome.kind) {
    case "drop":
      store.stepEmail(queued, "drop", now);
      return;
    case "wait":
      store.stepEmail(queued, "wait", now, {
        tryAt: (deletedAt ?? now) + UNDO_DELETE_MS,
      });
      return;
    case "refuse":
      store.stepEmail(queued, "refuse", now, { reason: outcome.reason });
  }
}

// Each step reads where the email stands and does only what's left, so a run after a
// crash at any point converges without a second send.
export async function runDueEmails(
  context: Context,
  now: number,
): Promise<void> {
  const { store } = context;
  for (const queued of store.dueEmails(now, EMAILS_PER_WAKE_UP)) {
    if (queued.state === "sending") {
      // Alarm handlers don't overlap, so whoever claimed this is gone, and there's no
      // telling whether the service took it first.
      store.stepEmail(queued, "unclear", now);
      continue;
    }
    try {
      await sendOne(context, queued, Date.now());
    } catch (error) {
      // One that was claimed is left to be found as sending, never tried again.
      console.error("An assignment email stopped.", error);
      store.stepEmail(queued, "stop", Date.now(), {
        reason: "checkUnavailable",
      });
    }
  }
}
