import { Button, Page, TextField } from "@cloudysuite/ui";
import { IconCloud, IconLink } from "@tabler/icons-react";
import type { FormEvent } from "react";
import { useAction } from "../account/use-action";
import { PASSWORD_HINT } from "../account/password";
import { authClient } from "../client";
import { acceptInvite } from "./functions";
import { inviteRefusal, type InviteView } from "./invite-view";

export function InvitePage({
  token,
  invite,
}: {
  token: string;
  invite: InviteView;
}) {
  const { pending, error, run } = useAction();

  if (invite.state !== "open") {
    return (
      <Page icon={IconLink} title="This invite doesn't work any more">
        {inviteRefusal(invite.state)}
      </Page>
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const password = String(values.get("password"));
    return run(async () => {
      const outcome = await acceptInvite({
        data: { token, name: String(values.get("name")), password },
      });
      if (!outcome.ok) return outcome.message;
      const { error: failure } = await authClient.signIn.email({
        email: outcome.signInEmail,
        password,
      });
      // The account exists either way, so signing in by hand still works.
      window.location.assign(failure ? "/sign-in" : "/");
    });
  }

  return (
    <Page icon={IconCloud} title="Welcome to CloudySuite">
      <p className="text-secondary">
        You'll sign in as <strong>{invite.signInEmail}</strong>. Finish your
        account below.
      </p>
      <form className="contents" onSubmit={submit}>
        <TextField
          label="Your name"
          name="name"
          autoComplete="name"
          required
          autoFocus
        />
        <TextField
          label="Choose a password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          hint={PASSWORD_HINT}
          required
        />
        <Button type="submit" disabled={pending}>
          Create my account
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </Page>
  );
}
