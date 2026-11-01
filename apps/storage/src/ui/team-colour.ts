const TEAM_COLOURS = [
  "bg-avatar-1",
  "bg-avatar-2",
  "bg-avatar-3",
  "bg-avatar-4",
  "bg-avatar-5",
  "bg-avatar-6",
];

export const teamColour = (colour: number) =>
  TEAM_COLOURS[(colour - 1) % TEAM_COLOURS.length];
