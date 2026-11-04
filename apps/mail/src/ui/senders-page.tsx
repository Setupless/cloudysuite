import { Button, Notice, Section, TextField } from "@cloudysuite/ui";
import { IconBan, IconCheck, IconX } from "@tabler/icons-react";
import {
  type DehydratedState,
  HydrationBoundary,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  asMailFailure,
  call,
  isRefusal,
  mailboxesQuery,
  mailKeys,
  sendersQuery,
} from "../queries";
import { addSender, removeSender } from "../spam/functions";
import {
  BAD_SENDER_PATTERN,
  MAX_SENDER_ENTRIES,
  parseSenderPattern,
  type SenderEntry,
  type SenderList,
} from "../spam/types";
import type { MailboxId } from "../types";
import { FailureNotice, SkeletonLines } from "./states";
import { IconButton } from "./thread-actions";

function SenderRows({
  entries,
  empty,
  canEdit,
  removing,
  onRemove,
}: {
  entries: SenderEntry[];
  empty: string;
  canEdit: boolean;
  removing: string | null;
  onRemove: (pattern: string) => void;
}) {
  if (entries.length === 0) {
    return <p className="text-sm text-secondary">{empty}</p>;
  }
  return (
    <ul className="flex flex-col">
      {entries.map(({ pattern }) => (
        <li
          key={pattern}
          className="flex items-center gap-2 border-t border-line py-1.5 first:border-t-0"
        >
          <span className="min-w-0 flex-1 text-sm break-words">
            {pattern.includes("@") ? pattern : `Everyone at ${pattern}`}
          </span>
          {canEdit && (
            <IconButton
              icon={IconX}
              label={`Remove ${pattern}`}
              pending={removing === pattern}
              disabled={removing !== null}
              onClick={() => onRemove(pattern)}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

function AddSender({
  full,
  onAdd,
}: {
  full: boolean;
  onAdd: (pattern: string, list: SenderList) => Promise<string | null>;
}) {
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState<SenderList | null>(null);
  const field = useRef<HTMLInputElement>(null);

  const submit = async (list: SenderList) => {
    if (adding) return;
    const pattern = parseSenderPattern(value);
    if (pattern === null) {
      setProblem(BAD_SENDER_PATTERN);
      return;
    }
    setAdding(list);
    const failure = await onAdd(pattern, list);
    flushSync(() => {
      setAdding(null);
      setProblem(failure);
      if (failure === null) setValue("");
    });
    field.current?.focus();
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void submit("block");
      }}
    >
      <TextField
        label="Email address or domain"
        placeholder="name@example.com or example.com"
        autoComplete="off"
        spellCheck={false}
        ref={field}
        value={value}
        disabled={adding !== null}
        onChange={(event) => setValue(event.target.value)}
      />
      {problem && <Notice tone="danger">{problem}</Notice>}
      {full && (
        <Notice tone="info">
          This mailbox has reached its limit of {MAX_SENDER_ENTRIES} senders.
          Remove one to add another.
        </Notice>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="action"
          icon={IconBan}
          type="submit"
          pending={adding === "block"}
          disabled={full || value.trim() === "" || adding !== null}
        >
          Block
        </Button>
        <Button
          variant="quiet"
          icon={IconCheck}
          pending={adding === "allow"}
          disabled={full || value.trim() === "" || adding !== null}
          onClick={() => void submit("allow")}
        >
          Allow
        </Button>
      </div>
    </form>
  );
}

function Senders({ mailboxId }: { mailboxId: MailboxId }) {
  const queryClient = useQueryClient();
  const senders = useQuery(sendersQuery(mailboxId));
  const mailboxes = useQuery(mailboxesQuery());
  const canEdit =
    mailboxes.data?.find((entry) => entry.id === mailboxId)?.role === "manager";
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: mailKeys.senders(mailboxId) });

  const add = async (pattern: string, list: SenderList) => {
    let failure: string | null = null;
    try {
      await call(() => addSender({ data: { mailboxId, pattern, list } }));
    } catch (thrown) {
      failure = (await asMailFailure(thrown)).message;
    }
    await refresh();
    return failure;
  };

  const remove = async (pattern: string) => {
    setProblem(null);
    setRemoving(pattern);
    try {
      await call(() => removeSender({ data: { mailboxId, pattern } }));
    } catch (thrown) {
      setProblem((await asMailFailure(thrown)).message);
    }
    await refresh();
    setRemoving(null);
  };

  const entries = senders.data ?? [];
  let lists: ReactNode;
  if (senders.isPending) {
    lists = <SkeletonLines rows={3} />;
  } else if (senders.isError) {
    lists = (
      <FailureNotice
        message={senders.error.message}
        onRetry={
          isRefusal(senders.error) ? undefined : () => void senders.refetch()
        }
      />
    );
  } else {
    lists = (
      <>
        <Section
          title="Blocked"
          description="New mail from these senders goes straight to Spam. You can still find it there."
        >
          <SenderRows
            entries={entries.filter((entry) => entry.list === "block")}
            empty="No one is blocked."
            canEdit={canEdit}
            removing={removing}
            onRemove={(pattern) => void remove(pattern)}
          />
        </Section>
        <Section
          title="Allowed"
          description="New mail from these senders stays out of Spam, unless a message shows clear signs of being faked. An allowed domain also covers the mailing lists it runs, so you can allow a list by its domain."
        >
          <SenderRows
            entries={entries.filter((entry) => entry.list === "allow")}
            empty="No one is on the allowed list."
            canEdit={canEdit}
            removing={removing}
            onRemove={(pattern) => void remove(pattern)}
          />
        </Section>
      </>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 lg:p-6">
      <header>
        <h1 className="flex min-w-0 items-center gap-2 text-[21px] font-semibold">
          <IconBan size={22} stroke={1.75} aria-hidden />
          Blocked and allowed senders
        </h1>
      </header>
      <p className="text-sm text-secondary">
        Mail is never turned away. Blocking a sender only decides where their
        new mail lands. Mail you already have stays where it is.
      </p>
      {!canEdit && mailboxes.isSuccess && (
        <Notice tone="info">
          Only a manager of this mailbox can change these lists. You can still
          mark any message as spam or not spam.
        </Notice>
      )}
      {canEdit && (
        <Section title="Add a sender">
          <AddSender full={entries.length >= MAX_SENDER_ENTRIES} onAdd={add} />
        </Section>
      )}
      {problem && <Notice tone="danger">{problem}</Notice>}
      {lists}
    </div>
  );
}

export function SendersPage({
  mailboxId,
  prefetched,
}: {
  mailboxId: string;
  prefetched: DehydratedState | undefined;
}) {
  return (
    <HydrationBoundary state={prefetched}>
      <Senders mailboxId={mailboxId as MailboxId} />
    </HydrationBoundary>
  );
}
