import { IconTag, IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { mailboxesQuery } from "../queries";
import type { LabelColour, LabelId, LabelSummary, MailboxId } from "../types";

// The dot carries the colour and the text stays in a colour that reads on every
// surface. Whole class names, because Tailwind only finds names it can read.
export const LABEL_COLOUR_DISPLAY: Record<
  LabelColour,
  { name: string; dot: string; text: string }
> = {
  secondary: { name: "Grey", dot: "bg-secondary", text: "text-secondary" },
  accent: { name: "Blue", dot: "bg-accent", text: "text-accent" },
  "tag-2": { name: "Green", dot: "bg-tag-2", text: "text-tag-2" },
  "tag-1": { name: "Orange", dot: "bg-tag-1", text: "text-tag-1" },
  danger: { name: "Red", dot: "bg-danger", text: "text-danger" },
};

export function useLabels(mailboxId: MailboxId): LabelSummary[] {
  const { data } = useQuery(mailboxesQuery());
  return useMemo(
    () => data?.find((entry) => entry.id === mailboxId)?.summary.labels ?? [],
    [data, mailboxId],
  );
}

export function LabelChip({
  label,
  onRemove,
}: {
  label: LabelSummary;
  onRemove?: () => void;
}) {
  return (
    <span
      title={label.name}
      className="inline-flex max-w-32 flex-none items-center gap-1 rounded-full border border-line px-1.5 py-px text-xs text-secondary"
    >
      <span
        aria-hidden
        className={`size-2 flex-none rounded-full ${LABEL_COLOUR_DISPLAY[label.colour].dot}`}
      />
      <span className="min-w-0 truncate">{label.name}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove the label ${label.name}`}
          onClick={onRemove}
          className="-mr-0.5 flex-none cursor-pointer rounded-full outline-accent hover:text-text focus-visible:outline-2"
        >
          <IconX size={12} stroke={2} aria-hidden />
        </button>
      )}
    </span>
  );
}

const SHOWN_ON_A_ROW = 2;

export function RowLabels({
  labels,
  labelIds,
}: {
  labels: LabelSummary[];
  labelIds: readonly LabelId[];
}) {
  const present = labels.filter((label) => labelIds.includes(label.id));
  if (present.length === 0) return null;
  return (
    <>
      {present.slice(0, SHOWN_ON_A_ROW).map((label) => (
        <LabelChip key={label.id} label={label} />
      ))}
      {present.length > SHOWN_ON_A_ROW && (
        <span className="flex-none text-xs text-secondary">
          +{present.length - SHOWN_ON_A_ROW}
        </span>
      )}
    </>
  );
}

export function LabelIcon({ colour }: { colour: LabelColour }) {
  return (
    <IconTag
      size={18}
      stroke={1.75}
      aria-hidden
      className={`flex-none ${LABEL_COLOUR_DISPLAY[colour].text}`}
    />
  );
}
