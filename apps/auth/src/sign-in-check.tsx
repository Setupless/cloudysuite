import { Page, Working } from "@cloudysuite/ui";
import { IconCloud } from "@tabler/icons-react";
import {
  ErrorComponent,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { recheckRememberedUser } from "./session";

const refusedWith = (error: unknown) =>
  error instanceof Response ? error.status : null;

// A page's own server call can find out first that this page's copy of the person is
// out of date: the session ended, another person signed in, their role changed, or
// two-step sign-in became required. The copy asks the server, and each of those ends on
// the page the server picks. Only a copy that turns out to be right shows the refusal.
// Asking, rather than loading the page again, means a refusal the server repeats can't
// start a loop.
export function SignInCheck({
  error,
  children,
}: {
  error: unknown;
  children: ReactNode;
}) {
  const status = refusedWith(error);
  const doubted = status === 401 || status === 403;
  const [checking, setChecking] = useState(doubted);
  useEffect(() => {
    if (!doubted) return;
    setChecking(true);
    void recheckRememberedUser().then(setChecking);
  }, [error, doubted]);
  if (!doubted || !checking) return children;
  return (
    <Page icon={IconCloud} title="One moment">
      <Working>Checking your sign-in…</Working>
    </Page>
  );
}

export function AuthRouteError({ error }: ErrorComponentProps) {
  return (
    <SignInCheck error={error}>
      <ErrorComponent error={error} />
    </SignInCheck>
  );
}
