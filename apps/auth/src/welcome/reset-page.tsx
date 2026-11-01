import { Button, Page, TextField } from "@cloudysuite/ui";
import { IconKey, IconLink } from "@tabler/icons-react";
import type { FormEvent } from "react";
import { PASSWORD_HINT } from "../account/password";
import { useAction } from "../account/use-action";
import type { ResetView } from "../admin/reset";
import { authClient } from "../client";
import { finishReset } from "./functions";

export function ResetPage({
  token,
  reset,
}: {
  token: string;
  reset: ResetView;
}) {
  const { pending, error, run } = useAction();

  if (!reset.valid) {
    return (
      <Page icon={IconLink} title="This link doesn't work any more">
        It has already been used or has expired. Ask your admin for a new one.
      </Page>
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password"));
    return run(async () => {
      const outcome = await finishReset({ data: { token, password } });
      if (!outcome.ok) return outcome.message;
      const { error: failure } = await authClient.signIn.email({
        email: outcome.email,
        password,
      });
      window.location.assign(failure ? "/sign-in" : "/");
    });
  }

  return (
    <Page icon={IconKey} title="Choose a new password">
      <p className="text-secondary">
        Your admin reset your sign-in for <strong>{reset.email}</strong>. After
        this, add a passkey on your account page.
      </p>
      <form className="contents" onSubmit={submit}>
        <TextField
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          hint={PASSWORD_HINT}
          required
          autoFocus
        />
        <Button type="submit" disabled={pending}>
          Set my password
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
