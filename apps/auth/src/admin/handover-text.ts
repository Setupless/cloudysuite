// Kept apart from the database code because the removal dialog says these before they
// happen, and it runs in the browser.

export const SPACE_KINDS = ["files", "calendars"] as const;
export type SpaceKind = (typeof SPACE_KINDS)[number];

// What a person has that removing them would leave with nobody, or with no manager.
export type Holdings = {
  personal: boolean;
  aloneIn: number;
  managedAlone: number;
};
export type ToHand = Record<SpaceKind, Holdings>;

export const nothingToHand = (): ToHand => ({
  files: { personal: false, aloneIn: 0, managedAlone: 0 },
  calendars: { personal: false, aloneIn: 0, managedAlone: 0 },
});

export const needsRecipient = (holdings: Holdings) =>
  holdings.personal || holdings.aloneIn > 0;

// A calendar's name can be at most 100 characters, so a long name still fits.
const NAMED_AFTER = {
  files: { suffix: "'s files", maxName: 200 },
  calendars: { suffix: "'s calendar", maxName: 100 - "'s calendar".length },
} satisfies Record<SpaceKind, { suffix: string; maxName: number }>;

// The team folder or team calendar a removed person's own one becomes.
export function handedOverName(kind: SpaceKind, personName: string): string {
  const { suffix, maxName } = NAMED_AFTER[kind];
  return `${personName.trim().slice(0, maxName) || "Someone"}${suffix}`;
}
