import { Button, Modal, Notice, Section, TextField } from "@cloudysuite/ui";
import { IconKey, IconPlus } from "@tabler/icons-react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { authClient } from "../client";
import { removalRefusal } from "../sign-in-methods";
import type { AccountView, PasskeySummary } from "./functions";
import { explainFailure, useAction } from "./use-action";

export function AddPasskeyForm({
  onAdded,
  buttonLabel = "Add a passkey",
}: {
  onAdded: () => void | Promise<void>;
  buttonLabel?: string;
}) {
  const { pending, error, run } = useAction();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name")).trim();
    return run(async () => {
      // A name passed here would become the account name in the device's
      // passkey picker, so people would see "Work laptop" instead of their email.
      const { data, error: failure } = await authClient.passkey.addPasskey();
      if (failure) {
        return explainFailure(
          failure,
          "code" in failure &&
            failure.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED"
            ? "This device already has a passkey for your account. Use a different device or a security key."
            : "Your passkey wasn't added. If you closed the prompt, try again when you're ready.",
        );
      }
      if (data) {
        await authClient.passkey.updatePasskey({ id: data.id, name });
      }
      form.reset();
      await onAdded();
    });
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <TextField
        label="Name for this passkey"
        name="name"
        required
        maxLength={60}
        placeholder="Work laptop"
      />
      <div>
        <Button
          type="submit"
          variant="action"
          icon={IconPlus}
          disabled={pending}
        >
          {buttonLabel}
        </Button>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}

function PasskeyRow({
  passkey,
  account,
}: {
  passkey: PasskeySummary;
  account: AccountView;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"view" | "rename" | "remove">("view");
  const { pending, error, run } = useAction();
  const refusal = removalRefusal(
    account.methods,
    "passkey",
    account.require2fa,
  );
  const name = passkey.name ?? "Unnamed passkey";

  function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = String(new FormData(event.currentTarget).get("name")).trim();
    return run(async () => {
      const { error: failure } = await authClient.passkey.updatePasskey({
        id: passkey.id,
        name: next,
      });
      if (failure) {
        return explainFailure(failure, "We couldn't rename that passkey.");
      }
      setMode("view");
      await router.invalidate();
    });
  }

  function remove() {
    return run(async () => {
      const { error: failure } = await authClient.passkey.deletePasskey({
        id: passkey.id,
      });
      if (failure) {
        return explainFailure(failure, "We couldn't remove that passkey.");
      }
      await router.invalidate();
    });
  }

  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      {mode === "rename" ? (
        <form className="flex flex-col gap-2" onSubmit={rename}>
          <TextField
            label="New name"
            name="name"
            defaultValue={name}
            required
            maxLength={60}
            autoFocus
          />
          <div className="flex gap-2">
            <Button type="submit" variant="action" disabled={pending}>
              Save name
            </Button>
            <Button variant="quiet" onClick={() => setMode("view")}>
              Keep the old name
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <IconKey
            size={20}
            stroke={1.5}
            className="text-secondary"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{name}</p>
            {passkey.addedAt && (
              <p className="text-sm text-secondary">
                Added {passkey.addedAt.toLocaleDateString()}
              </p>
            )}
          </div>
          <Button variant="quiet" onClick={() => setMode("rename")}>
            Rename
          </Button>
          <Button
            variant="danger"
            disabled={refusal !== null}
            onClick={() => setMode("remove")}
          >
            Remove
          </Button>
        </div>
      )}
      {refusal && mode === "view" && (
        <p className="text-sm text-secondary">{refusal}</p>
      )}
      {error && mode !== "remove" && <Notice tone="danger">{error}</Notice>}
      {mode === "remove" && (
        <Modal title={`Remove ${name}?`} onClose={() => setMode("view")}>
          <p className="text-sm text-secondary">
            You won't be able to sign in with this passkey any more. You can add
            it again later.
          </p>
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Button variant="quiet" onClick={() => setMode("view")}>
              Keep it
            </Button>
            <Button variant="danger" disabled={pending} onClick={remove}>
              Remove passkey
            </Button>
          </div>
        </Modal>
      )}
    </li>
  );
}

export function PasskeysSection({ account }: { account: AccountView }) {
  const router = useRouter();
  const count = account.passkeys.length;
  const [added, setAdded] = useState(false);
  return (
    <Section
      title="Passkeys"
      description="A passkey signs you in with your fingerprint, face, or device PIN, so there is nothing to remember or type."
    >
      {count > 0 && (
        <ul className="flex flex-col divide-y divide-line">
          {account.passkeys.map((passkey) => (
            <PasskeyRow key={passkey.id} passkey={passkey} account={account} />
          ))}
        </ul>
      )}
      {added && <Notice tone="success">Your passkey is ready to use.</Notice>}
      {count === 0 && (
        <Notice tone="info">
          You don't have a passkey yet. Add one here, then add a second on
          another device.
        </Notice>
      )}
      {count === 1 && (
        <Notice tone="info">
          Add a second passkey on another device. If you lose this one, you can
          still sign in.
        </Notice>
      )}
      <AddPasskeyForm
        onAdded={async () => {
          setAdded(true);
          await router.invalidate();
        }}
      />
    </Section>
  );
}
