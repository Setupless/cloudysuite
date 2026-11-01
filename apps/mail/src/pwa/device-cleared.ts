import { clearDevice, readOwner, readServerSession } from "./device-store";
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
  // A frame on another site gets no session cookie, so it would read as signed out.
  if (window.top !== window) return;
  const session = await readServerSession();
  const owner = await readOwner().catch(() => null);
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
