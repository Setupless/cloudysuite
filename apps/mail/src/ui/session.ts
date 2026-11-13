import {
  rememberedUser,
  rememberUser,
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

export async function requireMailUser(
  location: { publicHref: string },
  preload = false,
): Promise<SignedIn> {
  if (import.meta.env.SSR) return requireUser("mail", location);
  const remembered = rememberedUser();
  if (remembered) return remembered;
  // A hover must change nothing on this device, so it only asks the server, and not at
  // all while offline. It never clears the device or reads the saved owner. The click
  // that follows does both.
  if (preload) {
    if (isOffline())
      throw new Error("Offline, so there is nothing to preload.");
    return rememberUser(await requireUser("mail", location));
  }
  if (!navigator.onLine) return rememberUser(await fromDevice());
  try {
    return rememberUser(await requireUser("mail", location));
  } catch (thrown) {
    // A page the service worker started offline finds out here that its person left.
    if (isRedirect(thrown)) {
      const session = await readServerSession();
      if (session.kind === "signed-out") await clearDevice();
    }
    if (!isConnectionFailure(thrown)) throw thrown;
    return rememberUser(await fromDevice());
  }
}
