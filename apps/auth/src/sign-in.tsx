import { Button, Page, TextField } from "@cloudysuite/ui";
import { IconCloud, IconKey } from "@tabler/icons-react";
import { type FormEvent, useState } from "react";
import { authClient } from "./client";

type Step = "passkey" | "password" | "code" | "backup-code";

type Failure = { status: number; code?: string } | null;

const TOO_MANY_TRIES = "That's too many tries. Wait a minute, then try again.";

const SUSPENDED =
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
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function goTo(next: Step) {
    setError(null);
    setStep(next);
  }

  function finish() {
    window.location.assign(returnTo);
  }

  async function attempt(action: () => Promise<void>) {
    setError(null);
    setPending(true);
    try {
      await action();
    } catch {
      setError(
        "We couldn't reach CloudySuite. Check your connection and try again.",
      );
    } finally {
      setPending(false);
    }
  }

  function signInWithPasskey() {
    return attempt(async () => {
      const { error: failure } = await authClient.signIn.passkey();
      if (failure) {
        setError(
          explain(
            failure,
            "We couldn't sign you in with a passkey. Try again, or use your password instead.",
          ),
        );
        return;
      }
      finish();
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
        setError(
          explain(
            failure,
            "That email or password isn't right. Check them and try again.",
          ),
        );
        return;
      }
      if ("twoFactorRedirect" in data && data.twoFactorRedirect) {
        goTo("code");
        return;
      }
      finish();
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
        setError(
          explain(
            failure,
            step === "code"
              ? "That code isn't right. Codes change every 30 seconds, so try the newest one."
              : "That backup code isn't right, or it has already been used.",
          ),
        );
        return;
      }
      finish();
    });
  }

  return (
    <Page icon={IconCloud} title={STEP_TITLES[step]}>
      {step === "passkey" && (
        <>
          <Button icon={IconKey} disabled={pending} onClick={signInWithPasskey}>
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
          <Button type="submit" disabled={pending}>
            Sign in
          </Button>
          <Button variant="link" onClick={() => goTo("passkey")}>
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
          <Button type="submit" disabled={pending}>
            Continue
          </Button>
          <Button
            variant="link"
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
