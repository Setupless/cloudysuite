import { requireUser, type SignedIn } from "@cloudysuite/auth/session";
import { isRedirect } from "@tanstack/react-router";
import { isConnectionFailure, markUnreachable } from "../pwa/connectivity";
import { clearDevice, readTrustedOwner } from "../pwa/device";
import { readServerSession } from "../pwa/device-store";
import { NoSavedIdentity } from "../pwa/offline-notice";
import { setSavedMailReader } from "../pwa/saved-mail";

let signedIn: SignedIn | undefined;

// With no connection the server cannot be asked, so this device's saved owner stands
// in, and only to show what they saved here. Every mailbox call still checks the session
// itself once it can reach the server.
async function fromDevice(): Promise<SignedIn> {
  markUnreachable();
  const owner = await readTrustedOwner();
  if (!owner) throw new NoSavedIdentity();
  setSavedMailReader(owner.user.id);
  return owner.user;
}

// Waiting on the server at each click would make every folder feel slow. Every
// mailbox call checks the session itself, and a 401 reloads this page, so this
// copy only ever decides what the shell shows.
export async function requireMailUser(location: {
  publicHref: string;
}): Promise<SignedIn> {
  if (import.meta.env.SSR) return requireUser("mail", location);
  if (signedIn) return signedIn;
  if (!navigator.onLine) {
    signedIn = await fromDevice();
    return signedIn;
  }
  try {
    signedIn = await requireUser("mail", location);
  } catch (thrown) {
    // A page the service worker started offline finds out here that its person left.
    if (isRedirect(thrown)) {
      const session = await readServerSession();
      if (session.kind === "signed-out") await clearDevice();
    }
    if (!isConnectionFailure(thrown)) throw thrown;
    signedIn = await fromDevice();
  }
  return signedIn;
}
