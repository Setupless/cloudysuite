import { Button, Notice, Page } from "@cloudysuite/ui";
import { IconShieldLock } from "@tabler/icons-react";
import { useState } from "react";
import { AddPasskeyForm } from "./passkeys";
import { AuthenticatorSetup } from "./authenticator";
import { leave } from "./use-action";

export function EnrolPage({
  returnTo,
  signOutHref,
}: {
  returnTo: string;
  signOutHref: string;
}) {
  const [method, setMethod] = useState<"passkey" | "authenticator">("passkey");
  const proceed = () => leave(returnTo);
  return (
    <Page icon={IconShieldLock} title="Add a second way to prove it's you">
      <p className="text-secondary">
        Your organisation asks everyone to do this before using CloudySuite.
        Choose one to carry on.
      </p>
      <div className="flex w-full flex-col gap-3 text-left">
        {method === "passkey" ? (
          <AddPasskeyForm
            onAdded={proceed}
            after={(busy) => (
              <Button
                variant="link"
                disabled={busy}
                onClick={() => setMethod("authenticator")}
              >
                Use an authenticator app instead
              </Button>
            )}
          />
        ) : (
          <AuthenticatorSetup
            onDone={proceed}
            after={(busy) => (
              <Button
                variant="link"
                disabled={busy}
                onClick={() => setMethod("passkey")}
              >
                Use a passkey instead
              </Button>
            )}
          />
        )}
      </div>
      <Notice tone="info">
        Can't do this now?{" "}
        <a className="text-accent" href={signOutHref}>
          Sign out
        </a>{" "}
        and come back later.
      </Notice>
    </Page>
  );
}
