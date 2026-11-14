import {
  requireRememberedUser,
  type SignedIn,
} from "@cloudysuite/auth/session";

export function requireTasksUser(location: {
  publicHref: string;
}): Promise<SignedIn> {
  return requireRememberedUser("tasks", location);
}
