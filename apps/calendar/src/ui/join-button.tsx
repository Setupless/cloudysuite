import { buttonClass } from "@cloudysuite/ui";
import { IconVideo } from "@tabler/icons-react";
import type { EventDetails } from "../types";
import { type MeetingLink, meetingLink } from "./meeting-link";

// Events don't keep an invitation's conference field yet, so only the place and
// notes are read until inbound invitations store it.
export const meetingOf = (event: EventDetails) =>
  meetingLink({ ...event, conference: null });

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
