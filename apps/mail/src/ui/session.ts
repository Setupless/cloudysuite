import { requireUser, type SignedIn } from "@cloudysuite/auth/session";

let signedIn: SignedIn | undefined;

// Waiting on the server at each click would make every folder feel slow. Every
// mailbox call checks the session itself, and a 401 reloads this page, so this
// copy only ever decides what the shell shows.
export async function requireMailUser(location: {
  publicHref: string;
}): Promise<SignedIn> {
  if (import.meta.env.SSR) return requireUser("mail", location);
  signedIn ??= await requireUser("mail", location);
  return signedIn;
}
