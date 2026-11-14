import { teamColourFill } from "@cloudysuite/ui";

// Written out in full, because Tailwind only makes the classes it finds in the source.
const BORDERS = [
  "border-avatar-1",
  "border-avatar-2",
  "border-avatar-3",
  "border-avatar-4",
  "border-avatar-5",
  "border-avatar-6",
];
const TINTS = [
  "bg-event-1",
  "bg-event-2",
  "bg-event-3",
  "bg-event-4",
  "bg-event-5",
  "bg-event-6",
];

export const calendarFill = teamColourFill;
export const calendarBorder = (colour: number) =>
  BORDERS[(colour - 1) % BORDERS.length];
export const calendarTint = (colour: number) =>
  TINTS[(colour - 1) % TINTS.length];
