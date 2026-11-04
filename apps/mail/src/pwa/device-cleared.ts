import {
  clearDevice,
  readKeptRows,
  readOwner,
  readServerSession,
} from "./device-store";
import { clearingStep } from "./offline-model";

// The stop between signing out and the sign-in page. Sign-out happens on the Account
// host, which cannot reach Mail's storage, so it sends the browser through here. This
// file is served without the Worker, so it loads while Mail is turned off.

function show(section: "kept" | "cleared"): void {
  for (const id of ["working", "kept", "cleared"]) {
    document.getElementById(id)?.toggleAttribute("hidden", id !== section);
  }
}

async function clearEverything(): Promise<void> {
  await clearDevice();
  localStorage.clear();
  sessionStorage.clear();
}

async function run(): Promise<void> {
  // A page that frames this one must not be able to make it clear someone's mail.
  if (window.top !== window) return;
  const session = await readServerSession();
  let ownerKnown = true;
  const owner = await readOwner().catch(() => {
    ownerKnown = false;
    return null;
  });
  switch (clearingStep(session.kind, owner, Date.now())) {
    case "backToMail":
      location.replace("/");
      return;
    case "clearThenSignIn":
      await clearEverything();
      location.replace(
        `${location.origin.replace("//mail.", "//auth.")}/sign-in`,
      );
      return;
    case "clearThenExplain":
      await clearEverything();
      show("cleared");
      return;
    case "askFirst":
      show("kept");
      // Storage that can't be read may still hold someone's words.
      if (
        !ownerKnown ||
        (owner &&
          (await readKeptRows(owner.user.id)
            .then((rows) => rows.length > 0)
            .catch(() => true)))
      ) {
        document.getElementById("unsaved")?.removeAttribute("hidden");
      }
      document
        .getElementById("remove")
        ?.addEventListener(
          "click",
          () => void clearEverything().then(() => show("cleared")),
          { once: true },
        );
      return;
  }
}

void run();
