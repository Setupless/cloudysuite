const PANEL_ID = "details";

export const detailsPanelId = PANEL_ID;

export function focusDetails() {
  document.getElementById(PANEL_ID)?.focus();
}

let focusWhenShown = false;

// A file chosen from the keyboard takes focus to its actions once its panel has drawn.
export function focusDetailsOnNextFile() {
  focusWhenShown = true;
}

export function focusDetailsIfAsked() {
  if (focusWhenShown) focusDetails();
  focusWhenShown = false;
}
