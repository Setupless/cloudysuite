import { Button, Page, TextField } from "@cloudysuite/ui";
import { IconCloud, IconKey } from "@tabler/icons-react";
import { type FormEvent, useState } from "react";
import { leave } from "./account/use-action";
import { authClient } from "./client";

type Step = "passkey" | "password" | "code" | "backup-code";

type Failure = { status: number; code?: string } | null;

const TOO_MANY_TRIES = "That's too many tries. Wait a minute, then try again.";

export const SUSPENDED =
  "Your account has been suspended. Ask your admin if you think this is a mistake.";
const USE_PASSKEY =
  "Your organisation asks you to sign in with your passkey, because this account has no authenticator app.";

function explain(failure: NonNullable<Failure>, otherwise: string): string {
  if (failure.status === 429) return TOO_MANY_TRIES;
  if (failure.code === "BANNED_USER") return SUSPENDED;
  if (failure.code === "PASSKEY_REQUIRED") return USE_PASSKEY;
  return otherwise;
}

export function SignIn({ returnTo }: { returnTo: string }) {
  const [step, setStep] = useState<Step>("passkey");
  // Both belong to the step whose action started them. The passkey prompt can
  // hang, so the person can move to their password while it is still open.
  const [errors, setErrors] = useState<Partial<Record<Step, string>>>({});
  const [pending, setPending] = useState<Step | null>(null);
  const error = errors[step];
  const busy = pending === step;

  function goTo(next: Step) {
    setErrors({});
    setStep(next);
  }

  const finish = () => leave(returnTo);

  // The action returns a message when it didn't sign the person in.
  async function attempt(action: () => Promise<string | void>) {
    const from = step;
    setErrors({});
    setPending(from);
    let message: string | void;
    try {
      message = await action();
    } catch {
      message =
        "We couldn't reach CloudySuite. Check your connection and try again.";
    }
    if (message) setErrors((shown) => ({ ...shown, [from]: message }));
    setPending((running) => (running === from ? null : running));
  }

  function signInWithPasskey() {
    return attempt(async () => {
      const { error: failure } = await authClient.signIn.passkey();
      if (failure) {
        return explain(
          failure,
          "We couldn't sign you in with a passkey. Try again, or use your password instead.",
        );
      }
      await finish();
    });
  }

  function signInWithPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    return attempt(async () => {
      const { data, error: failure } = await authClient.signIn.email({
        email: String(form.get("email")),
        password: String(form.get("password")),
      });
      if (failure) {
        return explain(
          failure,
          "That email or password isn't right. Check them and try again.",
        );
      }
      if ("twoFactorRedirect" in data && data.twoFactorRedirect) {
        goTo("code");
        return;
      }
      await finish();
    });
  }

  function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code")).trim();
    return attempt(async () => {
      const { error: failure } =
        step === "code"
          ? await authClient.twoFactor.verifyTotp({ code })
          : await authClient.twoFactor.verifyBackupCode({ code });
      if (failure) {
        return explain(
          failure,
          step === "code"
            ? "That code isn't right. Codes change every 30 seconds, so try the newest one."
            : "That backup code isn't right, or it has already been used.",
        );
      }
      await finish();
    });
  }

  return (
    <Page icon={IconCloud} title={STEP_TITLES[step]}>
      {step === "passkey" && (
        <>
          <Button icon={IconKey} pending={busy} onClick={signInWithPasskey}>
            Continue with passkey
          </Button>
          <Button variant="link" onClick={() => goTo("password")}>
            Use a password instead
          </Button>
        </>
      )}

      {step === "password" && (
        <form className="contents" onSubmit={signInWithPassword}>
          <TextField
            label="Email"
            name="email"
            type="email"
            autoComplete="username"
            required
            autoFocus
          />
          <TextField
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <Button type="submit" pending={busy}>
            Sign in
          </Button>
          <Button
            variant="link"
            disabled={busy}
            onClick={() => goTo("passkey")}
          >
            Use a passkey instead
          </Button>
        </form>
      )}

      {(step === "code" || step === "backup-code") && (
        <form key={step} className="contents" onSubmit={verifyCode}>
          {step === "code" ? (
            <TextField
              label="6-digit code from your authenticator app"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              autoFocus
            />
          ) : (
            <TextField
              label="Backup code"
              name="code"
              autoComplete="off"
              required
              autoFocus
            />
          )}
          <Button type="submit" pending={busy}>
            Continue
          </Button>
          <Button
            variant="link"
            disabled={busy}
            onClick={() => goTo(step === "code" ? "backup-code" : "code")}
          >
            {step === "code"
              ? "Use a backup code instead"
              : "Use your authenticator app instead"}
          </Button>
          <p className="text-sm text-secondary">
            Lost your device and your backup codes? Ask your admin to reset your
            sign-in.
          </p>
        </form>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </Page>
  );
}

const STEP_TITLES: Record<Step, string> = {
  passkey: "Sign in",
  password: "Sign in with your password",
  code: "Enter your code",
  "backup-code": "Enter a backup code",
};
