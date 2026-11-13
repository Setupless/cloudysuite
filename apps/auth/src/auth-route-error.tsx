import { Page, Working } from "@cloudysuite/ui";
import { IconCloud } from "@tabler/icons-react";
import {
  ErrorComponent,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { recheckRememberedUser } from "./session";

const refusedWith = (error: unknown) =>
  error instanceof Response ? error.status : null;

// A page's own server call finds out first when the session ended, or when this page's
// copy of the person is out of date: another person signed in, their role changed, or
// two-step sign-in became required. Each of those ends on the page the server picks.
export function AuthRouteError({ error }: ErrorComponentProps) {
  const status = refusedWith(error);
  const [checking, setChecking] = useState(status === 401 || status === 403);
  useEffect(() => {
    if (status === 401) {
      window.location.reload();
    } else if (status === 403) {
      setChecking(true);
      void recheckRememberedUser().then(setChecking);
    }
  }, [error, status]);
  if (!checking) return <ErrorComponent error={error} />;
  return (
    <Page icon={IconCloud} title="One moment">
      <Working>Checking your sign-in…</Working>
    </Page>
  );
}
