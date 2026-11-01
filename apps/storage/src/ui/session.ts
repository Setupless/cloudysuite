import { requireUser, type SignedIn } from "@cloudysuite/auth/session";

let signedIn: SignedIn | undefined;

// Waiting on the server at each click would make every folder feel slow. Every drive
// call checks the session itself, and a 401 reloads this page, so this copy only ever
// decides what the shell shows.
export async function requireStorageUser(location: {
  publicHref: string;
}): Promise<SignedIn> {
  if (import.meta.env.SSR) return requireUser("storage", location);
  signedIn ??= await requireUser("storage", location);
  return signedIn;
}
