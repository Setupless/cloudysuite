import { Button, Modal, Notice, Section, TextField } from "@cloudysuite/ui";
import { IconRocket } from "@tabler/icons-react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import type { ToggleableApp } from "../../../../src/routing";
import { useAction } from "../account/use-action";
import { AdminPage } from "./admin-page";
import {
  changeAppEnabled,
  changeRequire2fa,
  getUpdateNotice,
  type OrganisationView,
  removeJevKey,
  saveJevKey,
} from "./functions";
import { UPDATE_STEPS_URL, type UpdateNotice } from "./updates";

const APP_TEXT: Record<ToggleableApp, { name: string; off: string }> = {
  mail: {
    name: "Mail",
    off: "People who open Mail will see a page saying an admin turned it off, and it leaves the app list. Nothing is deleted, and new mail keeps arriving, so it will all be there when you turn it back on.",
  },
};

function AppToggle({ id, enabled }: { id: ToggleableApp; enabled: boolean }) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [confirming, setConfirming] = useState(false);
  const { name, off } = APP_TEXT[id];

  const change = (next: boolean) =>
    run(async () => {
      await changeAppEnabled({ data: { app: id, enabled: next } });
      setConfirming(false);
      await router.invalidate();
    });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1">
          <strong className="font-medium">{name}</strong>{" "}
          <span className="text-secondary">
            is {enabled ? "on" : "off"} for everyone
          </span>
        </p>
        {enabled ? (
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Turn off {name}
          </Button>
        ) : (
          <Button
            variant="action"
            disabled={pending}
            onClick={() => change(true)}
          >
            Turn on {name}
          </Button>
        )}
      </div>
      {error && !confirming && <Notice tone="danger">{error}</Notice>}
      {confirming && (
        <Modal title={`Turn off ${name}?`} onClose={() => setConfirming(false)}>
          <p className="text-sm text-secondary">{off}</p>
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Button variant="quiet" onClick={() => setConfirming(false)}>
              Keep it on
            </Button>
            <Button
              variant="danger"
              disabled={pending}
              onClick={() => change(false)}
            >
              Turn off {name}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RequireSection({ view }: { view: OrganisationView }) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const count = view.peopleWithoutSecondWay;
  const others = count === 1 ? "1 person hasn't" : `${count} people haven't`;

  const change = (require2fa: boolean) =>
    run(async () => {
      await changeRequire2fa({ data: { require2fa } });
      await router.invalidate();
    });

  return (
    <Section
      title="Two-step sign-in"
      description="When this is on, everyone must add a passkey or an authenticator app before they can use any app."
    >
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-sm">
          {view.require2fa ? "It's required for everyone." : "It's optional."}
          {count > 0 &&
            ` ${others} added one yet${view.require2fa ? ", so they'll be asked to before they can carry on" : ""}.`}
        </p>
        {view.require2fa ? (
          <Button
            variant="danger"
            disabled={pending}
            onClick={() => change(false)}
          >
            Stop requiring it
          </Button>
        ) : (
          <Button
            variant="action"
            disabled={pending}
            onClick={() => change(true)}
          >
            Require it
          </Button>
        )}
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
    </Section>
  );
}

const JEV_PRIVACY_URL = "https://typesafe.ai/legal/privacy-policy";

const count = (total: number) => total.toLocaleString("en");

function JevUsageLine({ usage }: { usage: OrganisationView["jev"]["usage"] }) {
  const { checks, failed, inputTokens } = usage;
  return (
    <p className="text-sm text-secondary">
      This month: {checks === 1 ? "1 message" : `${count(checks)} messages`}{" "}
      checked, using {count(inputTokens)} tokens. Jev charges by the tokens it
      reads.
      {failed > 0 &&
        ` ${count(failed)} of these couldn't finish, so the built-in filter decided.`}
    </p>
  );
}

function JevKeyForm({
  onDone,
  onCancel,
}: {
  onDone: (saved: string) => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [key, setKey] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const result = await saveJevKey({
        data: { key, acknowledged: true },
      });
      if (!result.ok) return result.message;
      setKey("");
      onDone(result.summary);
      await router.invalidate();
      return null;
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded border border-line bg-selected p-3 text-sm">
        <p>
          <strong className="font-medium">
            Jev is a third-party service, run by another company.
          </strong>{" "}
          If you add a key, CloudySuite sends message content to Jev: the
          sender's name and address, the subject, and the first 6,000 characters
          of the text. Attachments are never sent.
        </p>
        <p>
          A message goes to Jev when the built-in filter is unsure about it, and
          when a rule in its mailbox uses a description. So with a rule like
          that, most new mail in that mailbox goes to Jev.
        </p>
        <p>
          Jev has no fixed period for how long it keeps what it receives. Only
          its enterprise customers get zero retention.{" "}
          <a
            className="text-accent underline outline-accent focus-visible:outline-2"
            href={JEV_PRIVACY_URL}
            target="_blank"
            rel="noreferrer"
          >
            Read Jev's privacy policy
          </a>
          .
        </p>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 flex-none accent-accent"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        I understand that message content goes to Jev, and that Jev may keep it.
      </label>
      <TextField
        label="Jev API key"
        type="password"
        autoComplete="off"
        value={key}
        onChange={(event) => setKey(event.target.value)}
      />
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="quiet" onClick={onCancel}>
            Keep the current key
          </Button>
        )}
        <Button
          type="submit"
          variant="action"
          disabled={pending || !acknowledged || key.trim() === ""}
        >
          Check and save key
        </Button>
      </div>
    </form>
  );
}

function JevSection({ jev }: { jev: OrganisationView["jev"] }) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const remove = () =>
    run(async () => {
      await removeJevKey();
      setRemoving(false);
      setSaved(null);
      await router.invalidate();
    });

  return (
    <Section
      title="Optional message check"
      description="Jev can improve spam filtering and lets a rule match a description, such as “looks like an invoice”. Spam filtering and rules all work without it."
    >
      {saved && <Notice tone="info">{saved}</Notice>}
      {jev.keySet ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <p className="flex-1 text-sm">
              A key is set. For safety, it can't be shown again.
            </p>
            {!replacing && (
              <Button variant="quiet" onClick={() => setReplacing(true)}>
                Replace key
              </Button>
            )}
            <Button variant="danger" onClick={() => setRemoving(true)}>
              Remove key
            </Button>
          </div>
          <JevUsageLine usage={jev.usage} />
        </>
      ) : (
        <p className="text-sm">No key is set, so nothing goes to Jev.</p>
      )}
      {(!jev.keySet || replacing) && (
        <JevKeyForm
          onDone={(summary) => {
            setSaved(summary);
            setReplacing(false);
          }}
          {...(jev.keySet ? { onCancel: () => setReplacing(false) } : {})}
        />
      )}
      {error && !removing && <Notice tone="danger">{error}</Notice>}
      {removing && (
        <Modal title="Remove the Jev key?" onClose={() => setRemoving(false)}>
          <p className="text-sm text-secondary">
            Nothing more goes to Jev, starting now. Spam filtering goes back to
            what's built in, and rules that use a description pause until a key
            is added again. No mail or rules are deleted.
          </p>
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Button variant="quiet" onClick={() => setRemoving(false)}>
              Keep it
            </Button>
            <Button variant="danger" disabled={pending} onClick={remove}>
              Remove key
            </Button>
          </div>
        </Modal>
      )}
    </Section>
  );
}

function UpdateBanner() {
  const [notice, setNotice] = useState<UpdateNotice>({ kind: "none" });
  useEffect(() => {
    // Only a nicety, so a failed check shows nothing.
    getUpdateNotice().then(setNotice, () => {});
  }, []);
  if (notice.kind !== "available") return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded border border-line bg-selected p-4 text-sm"
    >
      <IconRocket size={20} stroke={1.75} className="text-accent" aria-hidden />
      <p className="flex-1">
        CloudySuite {notice.latest} is available. Updates can include security
        fixes, and CloudySuite never updates itself.
      </p>
      <a className="text-accent" href={notice.releaseUrl}>
        What's new
      </a>
      <a className="font-medium text-accent" href={UPDATE_STEPS_URL}>
        How to update
      </a>
    </div>
  );
}

export function OrganisationPage({ view }: { view: OrganisationView }) {
  return (
    <AdminPage
      title="Organisation"
      description="Settings that apply to everyone."
    >
      <UpdateBanner />
      <RequireSection view={view} />
      <Section title="Apps" description="Turning an app off deletes nothing.">
        {view.apps.map((app) => (
          <AppToggle key={app.id} id={app.id} enabled={app.enabled} />
        ))}
      </Section>
      <JevSection jev={view.jev} />
      <p className="text-sm text-secondary">
        CloudySuite version {view.runningVersion}
      </p>
    </AdminPage>
  );
}
