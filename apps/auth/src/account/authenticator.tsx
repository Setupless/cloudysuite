import { Button, CopyField, Notice, Section, TextField } from "@cloudysuite/ui";
import { IconDeviceMobile } from "@tabler/icons-react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { authClient } from "../client";
import { removalRefusal } from "../sign-in-methods";
import type { AccountView } from "./functions";
import { QrCode } from "./qr-code";
import { explainFailure, useAction } from "./use-action";

type SetupStep =
  | { step: "password" }
  | { step: "scan"; uri: string; backupCodes: string[] }
  | { step: "backup-codes"; backupCodes: string[] };

const WRONG_PASSWORD = "That password isn't right. Check it and try again.";

function BackupCodes({
  codes,
  onDone,
}: {
  codes: string[];
  onDone: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 text-left">
      <Notice tone="success">Your authenticator app is set up.</Notice>
      <p className="text-sm">
        Save these backup codes somewhere safe. Each one works once, and they
        get you in if you lose your phone. We won't show them again.
      </p>
      <ul className="grid grid-cols-2 gap-1 rounded bg-field p-3 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <CopyField label="Copy all codes" value={codes.join(" ")} />
      <div>
        <Button variant="action" onClick={onDone}>
          I've saved my codes
        </Button>
      </div>
    </div>
  );
}

export function AuthenticatorSetup({
  onDone,
  onCancel,
}: {
  onDone: () => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [setup, setSetup] = useState<SetupStep>({ step: "password" });
  const { pending, error, run } = useAction();

  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password"));
    return run(async () => {
      const { data, error: failure } = await authClient.twoFactor.enable({
        password,
      });
      if (failure) return explainFailure(failure, WRONG_PASSWORD);
      if (data.method !== "totp") {
        return "We couldn't start setting up your app. Try again.";
      }
      setSetup({
        step: "scan",
        uri: data.totpURI,
        backupCodes: data.backupCodes,
      });
    });
  }

  if (setup.step === "password") {
    return (
      <form className="flex flex-col gap-3 text-left" onSubmit={start}>
        <TextField
          label="Your password"
          name="password"
          type="password"
          autoComplete="current-password"
          hint="Enter it to confirm that this is you."
          required
        />
        <div className="flex gap-2">
          <Button
            type="submit"
            variant="action"
            icon={IconDeviceMobile}
            disabled={pending}
          >
            Set up authenticator app
          </Button>
          {onCancel && (
            <Button variant="quiet" onClick={onCancel}>
              Not now
            </Button>
          )}
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    );
  }

  if (setup.step === "backup-codes") {
    return <BackupCodes codes={setup.backupCodes} onDone={onDone} />;
  }

  const { uri, backupCodes } = setup;
  function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code")).trim();
    return run(async () => {
      const { error: failure } = await authClient.twoFactor.verifyTotp({
        code,
      });
      if (failure) {
        return explainFailure(
          failure,
          "That code isn't right. Codes change every 30 seconds, so try the newest one.",
        );
      }
      setSetup({ step: "backup-codes", backupCodes });
    });
  }

  const secret = new URL(uri).searchParams.get("secret") ?? "";
  return (
    <form
      className="flex flex-col items-start gap-3 text-left"
      onSubmit={verify}
    >
      <p className="text-sm">
        Open your authenticator app, such as Google Authenticator or 1Password,
        and scan this code.
      </p>
      <QrCode text={uri} label="Code to scan with your authenticator app" />
      <div className="w-full">
        <CopyField
          label="Can't scan it? Enter this key instead"
          value={secret}
        />
      </div>
      <TextField
        label="6-digit code from your app"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        required
      />
      <Button type="submit" variant="action" disabled={pending}>
        Confirm code
      </Button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}

function TurnOffForm({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { pending, error, run } = useAction();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password"));
    return run(async () => {
      const { error: failure } = await authClient.twoFactor.disable({
        password,
      });
      if (failure) return explainFailure(failure, WRONG_PASSWORD);
      onClose();
      await router.invalidate();
    });
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <TextField
        label="Your password"
        name="password"
        type="password"
        autoComplete="current-password"
        hint="Your backup codes will stop working too."
        required
      />
      <div className="flex gap-2">
        <Button type="submit" variant="danger" disabled={pending}>
          Turn off authenticator app
        </Button>
        <Button variant="quiet" onClick={onClose}>
          Keep it on
        </Button>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}

export function AuthenticatorSection({ account }: { account: AccountView }) {
  const router = useRouter();
  const [panel, setPanel] = useState<"closed" | "setup" | "turn-off">("closed");
  const on = account.methods.authenticator;
  const refusal = on
    ? removalRefusal(account.methods, "authenticator", account.require2fa)
    : null;

  return (
    <Section
      title="Authenticator app"
      description="When you sign in with your password, your app gives you a 6-digit code as a second check."
    >
      {panel === "setup" && (
        <AuthenticatorSetup
          onCancel={() => setPanel("closed")}
          onDone={async () => {
            setPanel("closed");
            await router.invalidate();
          }}
        />
      )}
      {panel === "turn-off" && (
        <TurnOffForm onClose={() => setPanel("closed")} />
      )}
      {panel === "closed" && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex-1 text-sm">
            {on
              ? "It's on. You'll be asked for a code when you sign in with your password."
              : "It's off."}
          </p>
          {on ? (
            <Button
              variant="danger"
              disabled={refusal !== null}
              onClick={() => setPanel("turn-off")}
            >
              Turn off
            </Button>
          ) : (
            <Button variant="action" onClick={() => setPanel("setup")}>
              Set up
            </Button>
          )}
        </div>
      )}
      {refusal && panel === "closed" && (
        <p className="text-sm text-secondary">{refusal}</p>
      )}
    </Section>
  );
}
