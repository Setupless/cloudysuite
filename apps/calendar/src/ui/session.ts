import { requireUser, type SignedIn } from "@cloudysuite/auth/session";

let signedIn: SignedIn | undefined;

// Waiting on the server at each click would make every page feel slow. Every calendar
// call checks the session itself, and a 401 reloads this page, so this copy only ever
// decides what the shell shows.
export async function requireCalendarUser(location: {
  publicHref: string;
}): Promise<SignedIn> {
  if (import.meta.env.SSR) return requireUser("calendar", location);
  signedIn ??= await requireUser("calendar", location);
  return signedIn;
}
