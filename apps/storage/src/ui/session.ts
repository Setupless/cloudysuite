import {
  requireRememberedUser,
  type SignedIn,
} from "@cloudysuite/auth/session";

export function requireStorageUser(location: {
  publicHref: string;
}): Promise<SignedIn> {
  return requireRememberedUser("storage", location);
}
