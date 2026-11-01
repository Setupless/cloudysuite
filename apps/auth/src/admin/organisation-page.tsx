import { Button, Modal, Notice, Section } from "@cloudysuite/ui";
import { IconRocket } from "@tabler/icons-react";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ToggleableApp } from "../../../../src/routing";
import { useAction } from "../account/use-action";
import { AdminPage } from "./admin-page";
import {
  changeAppEnabled,
  changeRequire2fa,
  getUpdateNotice,
  type OrganisationView,
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
      <p className="text-sm text-secondary">
        CloudySuite version {view.runningVersion}
      </p>
    </AdminPage>
  );
}
