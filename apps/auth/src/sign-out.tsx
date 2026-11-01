import { Button, Page } from "@cloudysuite/ui";
import { IconLogout } from "@tabler/icons-react";
import { useState } from "react";
import { authClient } from "./client";

// The only place that signs out, so every app links here. Better Auth's route
// exists on this hostname alone, and the session cookie covers every app. The
// page only asks: a link in an email must not be able to sign anyone out.
export function SignOut() {
  const [state, setState] = useState<"ready" | "working" | "failed">("ready");

  async function signOut() {
    setState("working");
    try {
      const { error } = await authClient.signOut();
      if (error) setState("failed");
      else window.location.assign("/sign-in");
    } catch {
      setState("failed");
    }
  }

  return (
    <Page
      icon={IconLogout}
      title={state === "failed" ? "You're still signed in" : "Sign out?"}
    >
      {state === "failed" ? (
        <p className="text-secondary">
          We couldn't reach CloudySuite. Check your connection and try again.
        </p>
      ) : (
        <p className="text-secondary">
          You'll need to sign in again to use CloudySuite.
        </p>
      )}
      <Button
        variant={state === "failed" ? "secondary" : "primary"}
        disabled={state === "working"}
        onClick={signOut}
      >
        {state === "failed" ? "Try again" : "Sign out"}
      </Button>
    </Page>
  );
}
