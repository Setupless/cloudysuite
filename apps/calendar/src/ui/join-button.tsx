import { buttonClass } from "@cloudysuite/ui";
import { IconVideo } from "@tabler/icons-react";
import type { MeetingLink } from "./meeting-link";

export function JoinButton({ link }: { link: MeetingLink }) {
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`relative self-start ${buttonClass("toolbarAction")}`}
    >
      <IconVideo size={16} stroke={1.75} aria-hidden />
      Join {link.service}
    </a>
  );
}
