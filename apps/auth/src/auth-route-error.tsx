import {
  ErrorComponent,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect } from "react";

// A session that ended while this page was open surfaces here, from the page's own
// server call. The reload reaches the shell's sign-in check, which sends the person to
// sign in and back again.
export function AuthRouteError({ error }: ErrorComponentProps) {
  const signedOut = error instanceof Response && error.status === 401;
  useEffect(() => {
    if (signedOut) window.location.reload();
  }, [signedOut]);
  return signedOut ? null : <ErrorComponent error={error} />;
}
