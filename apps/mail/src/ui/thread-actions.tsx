import { Spinner } from "@cloudysuite/ui";
import {
  IconAlertOctagon,
  IconArchive,
  IconInbox,
  IconMail,
  IconMailOpened,
  IconRestore,
  IconShieldCheck,
  IconStar,
  IconStarFilled,
  IconTag,
  IconTrash,
  IconTrashX,
} from "@tabler/icons-react";
import type { Icon } from "@tabler/icons-react";
import { MOVE_DISPLAY, type MoveId } from "../model";

const MOVE_ICONS: Record<MoveId, Icon> = {
  archive: IconArchive,
  toInbox: IconInbox,
  spam: IconAlertOctagon,
  trash: IconTrash,
  restore: IconRestore,
  notSpam: IconShieldCheck,
  deleteForever: IconTrashX,
};

export function IconButton({
  icon: ButtonIcon,
  label,
  onClick,
  pressed,
  tone,
  pending = false,
  disabled = false,
}: {
  icon: Icon;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  tone?: "star" | "danger";
  pending?: boolean;
  disabled?: boolean;
}) {
  const colour = {
    star: "text-tag-1",
    danger: "text-danger hover:text-danger",
    none: "text-secondary hover:text-text",
  }[tone ?? "none"];
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={pending || undefined}
      disabled={disabled || pending}
      onClick={onClick}
      className={`flex size-8 flex-none cursor-pointer items-center justify-center rounded outline-accent hover:bg-field focus-visible:outline-2 disabled:cursor-default disabled:not-aria-busy:opacity-60 aria-busy:cursor-progress ${colour}`}
    >
      {pending ? (
        <Spinner />
      ) : (
        <ButtonIcon size={18} stroke={1.75} aria-hidden />
      )}
    </button>
  );
}

export function StarButton({
  starred,
  onToggle,
}: {
  starred: boolean;
  onToggle: () => void;
}) {
  return (
    <IconButton
      icon={starred ? IconStarFilled : IconStar}
      label={starred ? "Remove star" : "Add star"}
      pressed={starred}
      tone={starred ? "star" : undefined}
      onClick={onToggle}
    />
  );
}

export function ReadButton({
  unread,
  onToggle,
}: {
  unread: boolean;
  onToggle: () => void;
}) {
  return (
    <IconButton
      icon={unread ? IconMailOpened : IconMail}
      label={unread ? "Mark as read" : "Mark as unread"}
      onClick={onToggle}
    />
  );
}

export function LabelButton({ onClick }: { onClick: () => void }) {
  return <IconButton icon={IconTag} label="Labels" onClick={onClick} />;
}

export function MoveButtons({
  moves,
  onMove,
}: {
  moves: readonly MoveId[];
  onMove: (move: MoveId) => void;
}) {
  return moves.map((move) => (
    <IconButton
      key={move}
      icon={MOVE_ICONS[move]}
      label={MOVE_DISPLAY[move].label}
      tone={move === "deleteForever" ? "danger" : undefined}
      onClick={() => onMove(move)}
    />
  ));
}
