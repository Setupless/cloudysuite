import {
  rememberUser,
  requireRememberedUser,
  requireUser,
  type SignedIn,
} from "@cloudysuite/auth/session";
import { isRedirect } from "@tanstack/react-router";
import {
  isConnectionFailure,
  isOffline,
  markUnreachable,
} from "../pwa/connectivity";
import { clearDevice, readTrustedOwner } from "../pwa/device";
import { readServerSession } from "../pwa/device-store";
import { NoSavedIdentity } from "../pwa/offline-notice";
import { setSavedMailReader } from "../pwa/saved-mail";

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

// A hover must change nothing on this device, so it only asks the server, and not at
// all while offline. A click can share a hover's question, so it decides what the
// answer means for this device only once the answer arrives: it clears the device for
// someone who signed out, and falls back to the saved owner with no connection.
export async function requireMailUser(
  location: { publicHref: string },
  preload = false,
): Promise<SignedIn> {
  if (import.meta.env.SSR) return requireUser("mail", location);
  if (preload) {
    if (isOffline())
      throw new Error("Offline, so there is nothing to preload.");
    return requireRememberedUser("mail", location);
  }
  try {
    return await requireRememberedUser("mail", location, () =>
      navigator.onLine ? requireUser("mail", location) : fromDevice(),
    );
  } catch (thrown) {
    // A page the service worker started offline finds out here that its person left.
    if (isRedirect(thrown)) {
      const session = await readServerSession();
      if (session.kind === "signed-out") await clearDevice();
    }
    if (!isConnectionFailure(thrown)) throw thrown;
    const owner = await fromDevice();
    rememberUser(owner);
    return owner;
  }
}
