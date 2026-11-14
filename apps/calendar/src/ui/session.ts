import {
  requireRememberedUser,
  type SignedIn,
} from "@cloudysuite/auth/session";

export function requireCalendarUser(location: {
  publicHref: string;
}): Promise<SignedIn> {
  return requireRememberedUser("calendar", location);
}
