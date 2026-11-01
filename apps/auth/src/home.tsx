import { Button, Page } from "@cloudysuite/ui";
import { IconUserCircle } from "@tabler/icons-react";
import { useState } from "react";
import { authClient } from "./client";
import type { SessionUser } from "./session";

export function AuthHome({ user }: { user: SessionUser }) {
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    await authClient.signOut();
    window.location.assign("/sign-in");
  }

  return (
    <Page icon={IconUserCircle} title={user.name}>
      <p>You're signed in as {user.email}.</p>
      <Button variant="secondary" disabled={pending} onClick={signOut}>
        Sign out
      </Button>
    </Page>
  );
}
