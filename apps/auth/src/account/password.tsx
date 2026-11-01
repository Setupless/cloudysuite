import { Button, Notice, Section, TextField } from "@cloudysuite/ui";
import { type FormEvent, useState } from "react";
import { authClient } from "../client";
import { explainFailure, useAction } from "./use-action";

export const PASSWORD_HINT = "Use at least 8 characters.";

export function PasswordSection() {
  const [changed, setChanged] = useState(false);
  const { pending, error, run } = useAction();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const currentPassword = String(values.get("current"));
    const newPassword = String(values.get("next"));
    setChanged(false);
    return run(async () => {
      const { error: failure } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (failure) {
        return explainFailure(
          failure,
          failure.code === "PASSWORD_TOO_SHORT"
            ? "That new password is too short. Use at least 8 characters."
            : "Your current password isn't right. Check it and try again.",
        );
      }
      form.reset();
      setChanged(true);
    });
  }

  return (
    <Section
      title="Password"
      description="Your password is the backup if you can't use a passkey."
    >
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <TextField
          label="Current password"
          name="current"
          type="password"
          autoComplete="current-password"
          required
        />
        <TextField
          label="New password"
          name="next"
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          hint={PASSWORD_HINT}
          required
        />
        <div>
          <Button type="submit" variant="action" disabled={pending}>
            Change password
          </Button>
        </div>
        {changed && (
          <Notice tone="success">
            Your password has changed. Any other devices have been signed out.
          </Notice>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Section>
  );
}
