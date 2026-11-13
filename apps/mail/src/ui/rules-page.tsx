import {
  Button,
  Modal,
  Notice,
  SelectField,
  Spinner,
  TextField,
} from "@cloudysuite/ui";
import {
  IconArrowDown,
  IconArrowUp,
  IconFilter,
  IconPencil,
  IconPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { PrefetchedData } from "@cloudysuite/page-data";
import {
  type DehydratedState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { isOffline, OFFLINE_ACTION_REFUSED } from "../pwa/saved-mail";
import {
  isRefusal,
  asMailFailure,
  callAction,
  mailboxesQuery,
  mailKeys,
  rulesQuery,
} from "../queries";
import {
  createRule,
  deleteRule,
  reorderRules,
  updateRule,
} from "../rules/functions";
import {
  hasAction,
  MAX_CONDITION_LENGTH,
  MAX_CONDITIONS,
  MAX_RULE_NAME_LENGTH,
  MAX_RULES,
  needsJev,
  type Rule,
  type RuleCondition,
  type RuleDraft,
  type RuleFolder,
  type RuleId,
  type RuleTextField,
} from "../rules/types";
import type { LabelId, LabelSummary, MailboxId } from "../types";
import { LabelChip, useLabels } from "./label-chip";
import { FailureNotice, SkeletonLines } from "./states";
import { IconButton } from "./thread-actions";

const TEXT_FIELD_NAMES: Record<RuleTextField, string> = {
  from: "From",
  to: "To",
  cc: "Cc",
  subject: "Subject",
  body: "Message text",
};

const MOVE_NAMES: Record<RuleFolder, string> = {
  archive: "Skip the inbox (archive it)",
  spam: "Move to Spam",
  trash: "Move to Trash",
};

type ConditionChoice =
  RuleTextField | "hasAttachment" | "sentToAlias" | "looksLike";

const choiceOf = (condition: RuleCondition): ConditionChoice =>
  condition.kind === "contains" ? condition.field : condition.kind;

function conditionFor(
  choice: ConditionChoice,
  previous: RuleCondition,
  addresses: string[],
): RuleCondition {
  if (choice === "hasAttachment") return { kind: "hasAttachment" };
  if (choice === "looksLike") return { kind: "looksLike", text: "" };
  if (choice === "sentToAlias") {
    return { kind: "sentToAlias", address: addresses[0] ?? "" };
  }
  return {
    kind: "contains",
    field: choice,
    text: previous.kind === "contains" ? previous.text : "",
  };
}

function describeCondition(condition: RuleCondition): string {
  switch (condition.kind) {
    case "contains":
      return `${TEXT_FIELD_NAMES[condition.field]} contains "${condition.text}"`;
    case "hasAttachment":
      return "Has a file attached";
    case "sentToAlias":
      return `Sent to ${condition.address}`;
    case "looksLike":
      return `Looks like "${condition.text}"`;
  }
}

function RuleSummary({ rule, labels }: { rule: Rule; labels: LabelSummary[] }) {
  const { actions } = rule;
  const label = labels.find((one) => one.id === actions.labelId);
  const parts: ReactNode[] = [
    ...(label ? [<LabelChip key="label" label={label} />] : []),
    ...(actions.move ? [MOVE_NAMES[actions.move]] : []),
    ...(actions.markRead ? ["Mark as read"] : []),
    ...(actions.star ? ["Add star"] : []),
  ];
  return (
    <dl className="flex flex-col gap-1 text-sm">
      <div className="flex gap-2">
        <dt className="w-10 flex-none text-secondary">
          {rule.match === "all" || rule.conditions.length === 1
            ? "If"
            : "If any"}
        </dt>
        <dd className="min-w-0 break-words">
          {rule.conditions
            .map(describeCondition)
            .join(rule.match === "all" ? ", and " : ", or ")}
        </dd>
      </div>
      <div className="flex gap-2">
        <dt className="w-10 flex-none text-secondary">Then</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {parts.length > 0 ? (
            parts.map((part, index) => <span key={index}>{part}</span>)
          ) : (
            <span className="text-danger">
              Nothing. Its label was deleted, so it turned off. Choose a new
              action to turn it back on.
            </span>
          )}
        </dd>
      </div>
    </dl>
  );
}

const EMPTY_CONDITION: RuleCondition = {
  kind: "contains",
  field: "from",
  text: "",
};

const NEW_RULE: RuleDraft = {
  name: "",
  enabled: true,
  match: "all",
  conditions: [EMPTY_CONDITION],
  actions: { move: null, labelId: null, markRead: false, star: false },
};

function ConditionRow({
  condition,
  addresses,
  jevIsSet,
  onChange,
  onRemove,
}: {
  condition: RuleCondition;
  addresses: string[];
  jevIsSet: boolean;
  onChange: (next: RuleCondition) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <select
        aria-label="What to look at"
        value={choiceOf(condition)}
        onChange={(event) =>
          onChange(
            conditionFor(
              event.target.value as ConditionChoice,
              condition,
              addresses,
            ),
          )
        }
        className="w-32 flex-none rounded border border-line bg-field px-2 py-2 text-sm text-text outline-accent focus-visible:outline-2 lg:w-44"
      >
        {Object.entries(TEXT_FIELD_NAMES).map(([field, name]) => (
          <option key={field} value={field}>
            {name}
          </option>
        ))}
        <option value="hasAttachment">Has a file attached</option>
        <option value="sentToAlias">Sent to this address</option>
        {(jevIsSet || condition.kind === "looksLike") && (
          <option value="looksLike">Looks like</option>
        )}
      </select>
      {condition.kind === "contains" && (
        <input
          aria-label="Contains"
          placeholder="contains…"
          value={condition.text}
          maxLength={MAX_CONDITION_LENGTH}
          onChange={(event) =>
            onChange({ ...condition, text: event.target.value })
          }
          className="min-w-0 flex-1 rounded border border-line bg-field px-2.5 py-2 text-text outline-accent placeholder:text-secondary focus-visible:outline-2 max-lg:text-base lg:text-sm"
        />
      )}
      {condition.kind === "looksLike" && (
        <input
          aria-label="Looks like"
          placeholder="an invoice"
          value={condition.text}
          maxLength={MAX_CONDITION_LENGTH}
          onChange={(event) =>
            onChange({ ...condition, text: event.target.value })
          }
          className="min-w-0 flex-1 rounded border border-line bg-field px-2.5 py-2 text-text outline-accent placeholder:text-secondary focus-visible:outline-2 max-lg:text-base lg:text-sm"
        />
      )}
      {condition.kind === "sentToAlias" && (
        <select
          aria-label="Address"
          value={condition.address}
          onChange={(event) =>
            onChange({ ...condition, address: event.target.value })
          }
          className="min-w-0 flex-1 rounded border border-line bg-field px-2 py-2 text-sm text-text outline-accent focus-visible:outline-2"
        >
          {addresses.map((address) => (
            <option key={address} value={address}>
              {address}
            </option>
          ))}
        </select>
      )}
      {onRemove && (
        <IconButton
          icon={IconX}
          label="Remove this condition"
          onClick={onRemove}
        />
      )}
    </div>
  );
}

function RuleEditor({
  title,
  initial,
  labels,
  addresses,
  jevIsSet,
  onCancel,
  onSave,
}: {
  title: string;
  initial: RuleDraft;
  labels: LabelSummary[];
  addresses: string[];
  jevIsSet: boolean;
  onCancel: () => void;
  onSave: (draft: RuleDraft) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { actions } = draft;
  const setActions = (change: Partial<RuleDraft["actions"]>) =>
    setDraft({ ...draft, actions: { ...actions, ...change } });
  const setCondition = (index: number, next: RuleCondition) =>
    setDraft({
      ...draft,
      conditions: draft.conditions.map((one, at) =>
        at === index ? next : one,
      ),
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!hasAction(actions)) {
      setProblem("Add at least one action.");
      return;
    }
    setSaving(true);
    // Saving with an action turns on a rule that turned off when its label went.
    const wasEmpty = !hasAction(initial.actions);
    setProblem(await onSave(wasEmpty ? { ...draft, enabled: true } : draft));
    setSaving(false);
  };

  return (
    <Modal title={title} onClose={onCancel} busy={saving}>
      <form onSubmit={submit}>
        <fieldset disabled={saving} className="flex min-w-0 flex-col gap-3">
          {problem && <Notice tone="danger">{problem}</Notice>}
          <TextField
            label="Name"
            autoFocus
            value={draft.name}
            maxLength={MAX_RULE_NAME_LENGTH}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
          />
          <SelectField
            label="When a new message matches"
            value={draft.match}
            onChange={(event) =>
              setDraft({ ...draft, match: event.target.value as "all" | "any" })
            }
          >
            <option value="all">All of these</option>
            <option value="any">Any of these</option>
          </SelectField>
          <div className="flex flex-col gap-2">
            {draft.conditions.map((condition, index) => (
              <ConditionRow
                key={index}
                condition={condition}
                addresses={addresses}
                jevIsSet={jevIsSet}
                onChange={(next) => setCondition(index, next)}
                onRemove={
                  draft.conditions.length > 1
                    ? () =>
                        setDraft({
                          ...draft,
                          conditions: draft.conditions.filter(
                            (_, at) => at !== index,
                          ),
                        })
                    : undefined
                }
              />
            ))}
            {needsJev(draft) && (
              <p className="text-sm text-secondary">
                New mail this rule needs to check goes to Jev, a third-party
                service, and the answer can be wrong. If Jev can't answer in
                time, the description doesn't match and the message arrives as
                usual.
              </p>
            )}
            {draft.conditions.length < MAX_CONDITIONS && (
              <div>
                <Button
                  variant="link"
                  icon={IconPlus}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      conditions: [...draft.conditions, EMPTY_CONDITION],
                    })
                  }
                >
                  Add a condition
                </Button>
              </div>
            )}
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="pb-1.5 text-sm font-medium">Then</legend>
            <SelectField
              label="Add a label"
              value={actions.labelId ?? ""}
              onChange={(event) =>
                setActions({
                  labelId: event.target.value
                    ? (Number(event.target.value) as LabelId)
                    : null,
                })
              }
            >
              <option value="">No label</option>
              {labels.map((label) => (
                <option key={label.id} value={label.id}>
                  {label.name}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Where it goes"
              value={actions.move ?? ""}
              onChange={(event) =>
                setActions({
                  move: (event.target.value || null) as RuleFolder | null,
                })
              }
            >
              <option value="">Stay in the inbox</option>
              {Object.entries(MOVE_NAMES).map(([folder, name]) => (
                <option key={folder} value={folder}>
                  {name}
                </option>
              ))}
            </SelectField>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={actions.markRead}
                onChange={(event) =>
                  setActions({ markRead: event.target.checked })
                }
              />
              Mark as read
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={actions.star}
                onChange={(event) => setActions({ star: event.target.checked })}
              />
              Add star
            </label>
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button variant="quiet" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" variant="action" pending={saving}>
              Save rule
            </Button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}

function draftOf({ id: _, ...draft }: Rule): RuleDraft {
  return draft;
}

function RuleCard({
  rule,
  labels,
  canEdit,
  paused,
  first,
  last,
  working,
  onEdit,
  onToggle,
  onMove,
  onDelete,
}: {
  rule: Rule;
  labels: LabelSummary[];
  canEdit: boolean;
  paused: boolean;
  first: boolean;
  last: boolean;
  working: "idle" | "toggling" | "other";
  onEdit: () => void;
  onToggle: () => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
}) {
  const toggling = working === "toggling";
  return (
    <li className="flex flex-col gap-2 rounded border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="min-w-0 flex-1 font-semibold break-words">
          {rule.name}
        </h2>
        {!rule.enabled && <span className="text-xs text-secondary">Off</span>}
        {rule.enabled && paused && (
          <span className="text-xs text-secondary">Paused</span>
        )}
        {canEdit && (
          <div className="flex flex-none items-center">
            <label
              title={rule.enabled ? "Turn off" : "Turn on"}
              className="mr-1 flex cursor-pointer items-center gap-1.5 text-sm text-secondary"
            >
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={rule.enabled}
                disabled={!hasAction(rule.actions) || working !== "idle"}
                aria-busy={toggling || undefined}
                aria-label={`${rule.name} is on`}
                onChange={onToggle}
              />
              On
              {toggling && <Spinner size={16} />}
            </label>
            {!first && (
              <IconButton
                icon={IconArrowUp}
                label="Move up"
                disabled={working !== "idle"}
                onClick={() => onMove(-1)}
              />
            )}
            {!last && (
              <IconButton
                icon={IconArrowDown}
                label="Move down"
                disabled={working !== "idle"}
                onClick={() => onMove(1)}
              />
            )}
            <IconButton
              icon={IconPencil}
              label="Edit"
              disabled={working !== "idle"}
              onClick={onEdit}
            />
            <IconButton
              icon={IconTrash}
              label="Delete"
              tone="danger"
              disabled={working !== "idle"}
              onClick={onDelete}
            />
          </div>
        )}
      </div>
      <RuleSummary rule={rule} labels={labels} />
      {rule.enabled && paused && (
        <Notice tone="info">
          This rule is paused because it uses a description, and your admin
          removed the Jev key. It will start again if a key is added. To use it
          now, take that condition out.
        </Notice>
      )}
    </li>
  );
}

function ConfirmDelete({
  name,
  busy,
  failure,
  onCancel,
  onConfirm,
}: {
  name: string;
  busy: boolean;
  failure: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title={`Delete the rule "${name}"?`} onClose={onCancel} busy={busy}>
      <p className="text-sm text-secondary">
        Mail it has already sorted stays where it is.
      </p>
      {failure && <Notice tone="danger">{failure}</Notice>}
      <div className="flex justify-end gap-2">
        <Button variant="quiet" autoFocus disabled={busy} onClick={onCancel}>
          Keep it
        </Button>
        <Button variant="danger" pending={busy} onClick={onConfirm}>
          Delete rule
        </Button>
      </div>
    </Modal>
  );
}

type Editing = { kind: "new" } | { kind: "existing"; rule: Rule } | null;
// Moving a rule shows at once, so only these wait on the server.
type RuleWork = { kind: "toggle" | "delete"; id: RuleId };

function Rules({ mailboxId }: { mailboxId: MailboxId }) {
  const queryClient = useQueryClient();
  const rulesData = useQuery(rulesQuery(mailboxId));
  const mailboxes = useQuery(mailboxesQuery());
  const labels = useLabels(mailboxId);
  const canEdit =
    mailboxes.data?.find((entry) => entry.id === mailboxId)?.role === "manager";
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<Rule | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState<RuleWork | null>(null);
  const [deleteProblem, setDeleteProblem] = useState<string | null>(null);

  const rules = rulesData.data?.rules ?? [];
  const addresses = rulesData.data?.addresses ?? [];
  const jevIsSet = rulesData.data?.jevIsSet ?? false;

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: mailKeys.rules(mailboxId) });

  const attempt = async (
    work: RuleWork | null,
    run: () => Promise<unknown>,
  ): Promise<string | null> => {
    setProblem(null);
    if (work) setWorking(work);
    let failure: string | null = null;
    try {
      await callAction(run);
    } catch (thrown) {
      failure = (await asMailFailure(thrown)).message;
    }
    await refresh();
    if (work) setWorking((current) => (current === work ? null : current));
    return failure;
  };

  const save = async (draft: RuleDraft): Promise<string | null> => {
    try {
      await callAction(() =>
        editing?.kind === "existing"
          ? updateRule({
              data: { mailboxId, ruleId: editing.rule.id, rule: draft },
            })
          : createRule({ data: { mailboxId, rule: draft } }),
      );
    } catch (thrown) {
      return (await asMailFailure(thrown)).message;
    }
    await refresh();
    setEditing(null);
    return null;
  };

  const move = (index: number, direction: -1 | 1) => {
    if (isOffline()) {
      setProblem(OFFLINE_ACTION_REFUSED);
      return;
    }
    const ids: RuleId[] = rules.map((rule) => rule.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + direction, 0, moved!);
    const current = queryClient.getQueryData(rulesQuery(mailboxId).queryKey);
    if (current) {
      const order = new Map(ids.map((id, at) => [id, at]));
      queryClient.setQueryData(rulesQuery(mailboxId).queryKey, {
        ...current,
        rules: current.rules.toSorted(
          (a, b) => order.get(a.id)! - order.get(b.id)!,
        ),
      });
    }
    void attempt(null, () =>
      reorderRules({ data: { mailboxId, ruleIds: ids } }),
    ).then(setProblem);
  };

  let body: ReactNode;
  if (rulesData.isPending) {
    body = <SkeletonLines rows={3} />;
  } else if (rulesData.isError) {
    body = (
      <FailureNotice
        message={rulesData.error.message}
        onRetry={
          isRefusal(rulesData.error)
            ? undefined
            : () => void rulesData.refetch()
        }
      />
    );
  } else if (rules.length === 0) {
    body = (
      <p className="rounded border border-line bg-panel px-6 py-10 text-center text-sm text-secondary">
        {canEdit
          ? "No rules yet. Add one to sort new mail as it arrives."
          : "This mailbox has no rules yet."}
      </p>
    );
  } else {
    body = (
      <ol className="flex flex-col gap-2">
        {rules.map((rule, index) => (
          <RuleCard
            key={rule.id}
            rule={rule}
            labels={labels}
            canEdit={canEdit}
            paused={!jevIsSet && needsJev(rule)}
            first={index === 0}
            last={index === rules.length - 1}
            working={
              working === null
                ? "idle"
                : working.kind === "toggle" && working.id === rule.id
                  ? "toggling"
                  : "other"
            }
            onEdit={() => setEditing({ kind: "existing", rule })}
            onToggle={() =>
              void attempt({ kind: "toggle", id: rule.id }, () =>
                updateRule({
                  data: {
                    mailboxId,
                    ruleId: rule.id,
                    rule: { ...draftOf(rule), enabled: !rule.enabled },
                  },
                }),
              ).then(setProblem)
            }
            onMove={(direction) => move(index, direction)}
            onDelete={() => setDeleting(rule)}
          />
        ))}
      </ol>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 lg:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="flex min-w-0 flex-1 items-center gap-2 text-[21px] font-semibold">
          <IconFilter size={22} stroke={1.75} aria-hidden />
          Rules
        </h1>
        {canEdit && (
          <Button
            variant="action"
            icon={IconPlus}
            disabled={rules.length >= MAX_RULES}
            onClick={() => setEditing({ kind: "new" })}
          >
            Add a rule
          </Button>
        )}
      </header>
      <p className="text-sm text-secondary">
        Rules sort new mail as it arrives, from the top down. Every rule that
        matches applies, and if two move a message, the higher one decides. They
        don't change mail you already have, imported mail, or mail you send.
      </p>
      {!canEdit && mailboxes.isSuccess && (
        <Notice tone="info">
          Only a manager of this mailbox can change its rules.
        </Notice>
      )}
      {canEdit && labels.length === 0 && (
        <p className="text-sm text-secondary">
          To add a label with a rule, first{" "}
          <Link
            to="/mail/$mailboxId/labels"
            params={{ mailboxId }}
            className="text-accent underline outline-accent focus-visible:outline-2"
          >
            create the label
          </Link>
          .
        </p>
      )}
      {problem && <Notice tone="danger">{problem}</Notice>}
      {body}
      {editing && (
        <RuleEditor
          title={editing.kind === "new" ? "Add a rule" : "Edit rule"}
          initial={editing.kind === "new" ? NEW_RULE : draftOf(editing.rule)}
          labels={labels}
          addresses={addresses}
          jevIsSet={jevIsSet}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      )}
      {deleting && (
        <ConfirmDelete
          name={deleting.name}
          busy={working?.kind === "delete" && working.id === deleting.id}
          failure={deleteProblem}
          onCancel={() => {
            setDeleting(null);
            setDeleteProblem(null);
          }}
          onConfirm={async () => {
            const { id } = deleting;
            setDeleteProblem(null);
            const failure = await attempt({ kind: "delete", id }, () =>
              deleteRule({ data: { mailboxId, ruleId: id } }),
            );
            if (failure) setDeleteProblem(failure);
            else setDeleting(null);
          }}
        />
      )}
    </div>
  );
}

export function RulesPage({
  mailboxId,
  prefetched,
}: {
  mailboxId: string;
  prefetched: DehydratedState | undefined;
}) {
  return (
    <PrefetchedData state={prefetched}>
      <Rules mailboxId={mailboxId as MailboxId} />
    </PrefetchedData>
  );
}
