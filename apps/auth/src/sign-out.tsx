import { Button, Page } from "@cloudysuite/ui";
import { IconLogout } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { authClient } from "./client";

// The only place that signs out, so every app links here. Better Auth's route
// exists on this hostname alone, and the session cookie covers every app.
export function SignOut() {
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setFailed(false);
    const { error } = await authClient.signOut();
    if (error) setFailed(true);
    else window.location.assign("/sign-in");
  }

  useEffect(() => {
    void signOut();
  }, []);

  return (
    <Page
      icon={IconLogout}
      title={failed ? "You're still signed in" : "Signing you out"}
    >
      {failed ? (
        <>
          <p className="text-secondary">
            We couldn't reach CloudySuite. Check your connection and try again.
          </p>
          <Button variant="secondary" onClick={signOut}>
            Try again
          </Button>
        </>
      ) : (
        <p className="text-secondary">This only takes a moment.</p>
      )}
    </Page>
  );
}
