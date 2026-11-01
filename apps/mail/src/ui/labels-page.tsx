import { Button, Modal, Notice, Section, TextField } from "@cloudysuite/ui";
import { IconPlus, IconTag, IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useState } from "react";
import { deleteLabel, updateLabel } from "../functions";
import { cleanLabelName, MAX_LABEL_NAME_LENGTH } from "../labels/store";
import { asMailFailure, call, mailKeys, rulesQuery } from "../queries";
import {
  LABEL_COLOURS,
  type LabelColour,
  type LabelSummary,
  type MailboxId,
} from "../types";
import { LABEL_COLOUR_DISPLAY, useLabels } from "./label-chip";
import { useCreateLabel } from "./label-commands";

function ColourChoice({
  value,
  onChange,
  legend,
}: {
  value: LabelColour;
  onChange: (colour: LabelColour) => void;
  legend: string;
}) {
  const group = useId();
  return (
    <fieldset className="flex items-center gap-1">
      <legend className="sr-only">{legend}</legend>
      {LABEL_COLOURS.map((colour) => (
        <label
          key={colour}
          title={LABEL_COLOUR_DISPLAY[colour].name}
          className="flex size-7 cursor-pointer items-center justify-center rounded-full outline-accent has-checked:bg-selected has-focus-visible:outline-2"
        >
          <input
            type="radio"
            name={group}
            className="sr-only"
            checked={value === colour}
            aria-label={LABEL_COLOUR_DISPLAY[colour].name}
            onChange={() => onChange(colour)}
          />
          <span
            aria-hidden
            className={`size-3.5 rounded-full ${LABEL_COLOUR_DISPLAY[colour].dot}`}
          />
        </label>
      ))}
    </fieldset>
  );
}

function ConfirmDelete({
  label,
  ruleCount,
  onCancel,
  onConfirm,
}: {
  label: LabelSummary;
  ruleCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title={`Delete the label "${label.name}"?`} onClose={onCancel}>
      <p className="text-sm text-secondary">
        The mail stays where it is and only loses this label.
        {ruleCount > 0 &&
          ` ${ruleCount === 1 ? "1 rule adds" : `${ruleCount} rules add`} this label and will stop adding it.`}
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="quiet" autoFocus onClick={onCancel}>
          Keep it
        </Button>
        <Button variant="danger" onClick={onConfirm}>
          Delete label
        </Button>
      </div>
    </Modal>
  );
}

function LabelRow({
  mailboxId,
  label,
  onProblem,
}: {
  mailboxId: MailboxId;
  label: LabelSummary;
  onProblem: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(label.name);
  // Shows at once, and goes back if the save fails.
  const [colour, setColour] = useState(label.colour);
  // A colleague can rename it while this page is open, and blurring the box must
  // not write the old name back.
  useEffect(() => {
    setName(label.name);
    setColour(label.colour);
  }, [label.name, label.colour]);
  const [confirming, setConfirming] = useState<{ ruleCount: number } | null>(
    null,
  );

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: mailKeys.mailboxes });
    void queryClient.invalidateQueries({ queryKey: mailKeys.all(mailboxId) });
  };
  const attempt = async (run: () => Promise<unknown>) => {
    onProblem(null);
    try {
      await call(run);
      refresh();
      return true;
    } catch (thrown) {
      onProblem((await asMailFailure(thrown)).message);
      return false;
    }
  };

  const saveName = async () => {
    const clean = cleanLabelName(name);
    if (clean === null) {
      onProblem(
        `Give the label a name of up to ${MAX_LABEL_NAME_LENGTH} characters.`,
      );
      setName(label.name);
      return;
    }
    if (clean === label.name) return;
    const saved = await attempt(() =>
      updateLabel({ data: { mailboxId, labelId: label.id, name: clean } }),
    );
    if (!saved) setName(label.name);
  };

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <input
        value={name}
        maxLength={MAX_LABEL_NAME_LENGTH}
        aria-label={`Name of the label ${label.name}`}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => void saveName()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setName(label.name);
        }}
        className="min-w-40 flex-1 rounded border border-transparent bg-transparent px-2 py-1 text-sm text-text outline-accent hover:border-line focus-visible:outline-2"
      />
      <ColourChoice
        legend={`Colour of the label ${label.name}`}
        value={colour}
        onChange={async (next) => {
          setColour(next);
          const saved = await attempt(() =>
            updateLabel({
              data: { mailboxId, labelId: label.id, colour: next },
            }),
          );
          if (!saved) setColour(label.colour);
        }}
      />
      <button
        type="button"
        aria-label={`Delete the label ${label.name}`}
        title="Delete label"
        onClick={async () => {
          onProblem(null);
          try {
            const { rules } = await queryClient.fetchQuery(
              rulesQuery(mailboxId),
            );
            setConfirming({
              ruleCount: rules.filter(
                (rule) => rule.actions.labelId === label.id,
              ).length,
            });
          } catch (thrown) {
            onProblem((await asMailFailure(thrown)).message);
          }
        }}
        className="flex size-8 flex-none cursor-pointer items-center justify-center rounded text-secondary outline-accent hover:bg-field hover:text-danger focus-visible:outline-2"
      >
        <IconTrash size={18} stroke={1.75} aria-hidden />
      </button>
      {confirming && (
        <ConfirmDelete
          label={label}
          ruleCount={confirming.ruleCount}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            void attempt(() =>
              deleteLabel({ data: { mailboxId, labelId: label.id } }),
            );
          }}
        />
      )}
    </li>
  );
}

export function LabelsPage({ mailboxId: rawId }: { mailboxId: string }) {
  const mailboxId = rawId as MailboxId;
  const labels = useLabels(mailboxId);
  const createLabel = useCreateLabel(mailboxId);
  const [name, setName] = useState("");
  const [colour, setColour] = useState<LabelColour>("accent");
  const [problem, setProblem] = useState<string | null>(null);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    const clean = cleanLabelName(name);
    if (clean === null) {
      setProblem(
        `Give the label a name of up to ${MAX_LABEL_NAME_LENGTH} characters.`,
      );
      return;
    }
    if (await createLabel(clean, colour)) setName("");
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 lg:p-6">
      <h1 className="flex items-center gap-2 text-[21px] font-semibold">
        <IconTag size={22} stroke={1.75} aria-hidden />
        Labels
      </h1>
      {problem && <Notice tone="danger">{problem}</Notice>}
      <Section
        title="Create a label"
        description="Labels sort your mail without moving it. One conversation can have several."
      >
        <form onSubmit={create} className="flex flex-col gap-3">
          <TextField
            label="Name"
            value={name}
            maxLength={MAX_LABEL_NAME_LENGTH}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ColourChoice legend="Colour" value={colour} onChange={setColour} />
            <Button type="submit" variant="action" icon={IconPlus}>
              Create label
            </Button>
          </div>
        </form>
      </Section>
      <Section title="Your labels">
        {labels.length === 0 ? (
          <p className="text-sm text-secondary">
            You have no labels yet. Create one above, or press L on a
            conversation.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {labels.map((label) => (
              <LabelRow
                key={label.id}
                mailboxId={mailboxId}
                label={label}
                onProblem={setProblem}
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
