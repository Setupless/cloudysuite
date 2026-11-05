// Written out in full, because Tailwind only makes the classes it finds in the source.
const FILLS = [
  "bg-avatar-1",
  "bg-avatar-2",
  "bg-avatar-3",
  "bg-avatar-4",
  "bg-avatar-5",
  "bg-avatar-6",
];
const BORDERS = [
  "border-avatar-1",
  "border-avatar-2",
  "border-avatar-3",
  "border-avatar-4",
  "border-avatar-5",
  "border-avatar-6",
];

export const calendarFill = (colour: number) =>
  FILLS[(colour - 1) % FILLS.length];
export const calendarBorder = (colour: number) =>
  BORDERS[(colour - 1) % BORDERS.length];

// In the order of the avatar roles, so colour n is COLOUR_NAMES[n - 1].
export const COLOUR_NAMES = [
  "Blue",
  "Purple",
  "Green",
  "Brown",
  "Slate",
  "Red",
] as const;
