import type { SignedIn } from "@cloudysuite/auth/session";
import { SuiteShell } from "@cloudysuite/auth/shell";
import { Button, NAV_ITEM, Notice, Section } from "@cloudysuite/ui";
import {
  IconArrowLeft,
  IconBell,
  IconBellOff,
  IconDeviceMobile,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  getPushSetup,
  type MailboxNotifications,
  setMailboxNotifications,
  subscribePush,
  unsubscribePush,
} from "../push/functions";
import { call } from "../queries";
import { useOffline } from "./connectivity";
import { DEVICE_CLEARED_PATH } from "./sw-policy";
import {
  isAppleMobile,
  isInstalledApp,
  promptInstall,
  useInstallState,
} from "./install";
import { OfflineBanner } from "./offline-notice";

function InstallSection() {
  const install = useInstallState();
  return (
    <Section
      title="Install Mail"
      description="Mail opens in its own window and can read saved mail with no connection."
    >
      {install.kind === "installed" && (
        <Notice tone="success">Mail is installed on this device.</Notice>
      )}
      {install.kind === "ready" && (
        <div>
          <Button
            variant="action"
            icon={IconDeviceMobile}
            onClick={() => void promptInstall()}
          >
            Install Mail
          </Button>
        </div>
      )}
      {install.kind === "appleMobile" && (
        <p className="text-sm">
          In Safari, tap the Share button, then tap{" "}
          <strong>Add to Home Screen</strong>.
        </p>
      )}
      {install.kind === "appleDesktop" && (
        <p className="text-sm">
          In Safari, open the <strong>File</strong> menu, then choose{" "}
          <strong>Add to Dock</strong>.
        </p>
      )}
      {install.kind === "notOffered" && (
        <p className="text-sm text-secondary">
          This browser hasn't offered to install Mail. If its menu has an
          Install option, use that. Chrome and Edge can install Mail on most
          devices.
        </p>
      )}
    </Section>
  );
}

type DevicePush =
  | { kind: "unsupported" }
  | { kind: "needsInstall" }
  | { kind: "blocked" }
  | { kind: "ready"; endpoint: string | null };

async function readDevicePush(): Promise<DevicePush> {
  if (isAppleMobile() && !isInstalledApp()) return { kind: "needsInstall" };
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return { kind: "unsupported" };
  }
  if (Notification.permission === "denied") return { kind: "blocked" };
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return { kind: "ready", endpoint: subscription?.endpoint ?? null };
}

const NOTIFICATION_FAILURE =
  "We couldn't turn notifications on. Try again in a moment.";

class NotificationRefusal extends Error {}

async function turnOn(publicKey: string): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new NotificationRefusal(
      permission === "denied"
        ? "Notifications are blocked for this site. You can allow them in your browser's site settings."
        : "Notifications stay off until you allow them.",
    );
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: publicKey,
  });
  const { endpoint, expirationTime, keys } = subscription.toJSON();
  try {
    await subscribePush({
      data: {
        endpoint,
        expirationTime,
        p256dh: keys?.p256dh,
        auth: keys?.auth,
      },
    });
  } catch (thrown) {
    // The server won't send to it, so don't leave the browser believing it will.
    await subscription.unsubscribe();
    throw thrown;
  }
}

async function turnOff(endpoint: string): Promise<void> {
  await unsubscribePush({ data: { endpoint } });
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  await subscription?.unsubscribe();
}

function MailboxChoice({ mailbox }: { mailbox: MailboxNotifications }) {
  const client = useQueryClient();
  // The box follows the click at once, and goes back if the server refuses.
  const [checked, setChecked] = useState(mailbox.enabled);
  useEffect(() => setChecked(mailbox.enabled), [mailbox.enabled]);
  const change = useMutation({
    mutationFn: (enabled: boolean) =>
      call(() =>
        setMailboxNotifications({ data: { mailboxId: mailbox.id, enabled } }),
      ),
    onError: () => setChecked(mailbox.enabled),
    onSettled: () => client.invalidateQueries({ queryKey: PUSH_KEY }),
  });
  return (
    <>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-accent"
          checked={checked}
          onChange={(event) => {
            setChecked(event.target.checked);
            change.mutate(event.target.checked);
          }}
        />
        {mailbox.name}
      </label>
      {change.isError && <Notice tone="danger">{change.error.message}</Notice>}
    </>
  );
}

function MailboxChoices({ mailboxes }: { mailboxes: MailboxNotifications[] }) {
  if (mailboxes.length < 2) return null;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="pb-1 text-sm font-medium">
        Which mailboxes can notify you
      </legend>
      {mailboxes.map((mailbox) => (
        <MailboxChoice key={mailbox.id} mailbox={mailbox} />
      ))}
    </fieldset>
  );
}

const PUSH_KEY = ["mail", "pushSetup"] as const;

function NotificationsSection() {
  const client = useQueryClient();
  const offline = useOffline();
  const [failure, setFailure] = useState<string | null>(null);
  const device = useQuery({
    queryKey: [...PUSH_KEY, "device"],
    queryFn: readDevicePush,
    enabled: !offline,
  });
  const endpoint = device.data?.kind === "ready" ? device.data.endpoint : null;
  const setup = useQuery({
    queryKey: [...PUSH_KEY, endpoint],
    queryFn: () => call(() => getPushSetup({ data: { endpoint } })),
    enabled: !offline && device.data?.kind === "ready",
  });

  const toggle = useMutation({
    mutationFn: async () => {
      if (setup.data?.subscribed && endpoint) await turnOff(endpoint);
      else if (setup.data) await turnOn(setup.data.publicKey);
    },
    onMutate: () => setFailure(null),
    onError: (error) =>
      setFailure(
        error instanceof NotificationRefusal
          ? error.message
          : NOTIFICATION_FAILURE,
      ),
    onSettled: () => client.invalidateQueries({ queryKey: PUSH_KEY }),
  });

  const on = setup.data?.subscribed === true;
  return (
    <Section
      title="Notifications"
      description="Get a notification on this device when new mail reaches your inbox. It shows who sent the message and its subject, so anyone who can see this screen can read them."
    >
      {offline && (
        <p className="text-sm text-secondary">
          You're offline. You can change notifications when you're back online.
        </p>
      )}
      {!offline && device.data?.kind === "unsupported" && (
        <p className="text-sm text-secondary">
          This browser can't show notifications from Mail.
        </p>
      )}
      {!offline && device.data?.kind === "needsInstall" && (
        <p className="text-sm text-secondary">
          On iPhone and iPad, notifications work once Mail is on your Home
          Screen. Follow the steps above, then open Mail from there and come
          back to this page.
        </p>
      )}
      {!offline && device.data?.kind === "blocked" && (
        <Notice tone="info">
          Notifications are blocked for this site. You can allow them in your
          browser's site settings.
        </Notice>
      )}
      {!offline && setup.isError && (
        <Notice tone="danger">{setup.error.message}</Notice>
      )}
      {!offline && setup.data && (
        <>
          <div>
            <Button
              variant={on ? "quiet" : "action"}
              icon={on ? IconBellOff : IconBell}
              disabled={toggle.isPending}
              onClick={() => toggle.mutate()}
            >
              {on
                ? "Turn off notifications on this device"
                : "Turn on notifications on this device"}
            </Button>
          </div>
          {failure && <Notice tone="danger">{failure}</Notice>}
          {on && <MailboxChoices mailboxes={setup.data.mailboxes} />}
        </>
      )}
    </Section>
  );
}

function SavedMailSection() {
  return (
    <Section
      title="Saved mail"
      description="Mail keeps your most recent conversations on this device so you can read them with no connection."
    >
      <p className="text-sm text-secondary">
        Up to 300 from your inbox, 100 sent, and 100 archived, for each mailbox.
        Attachments and very long messages aren't saved. Signing out removes all
        of it.
      </p>
    </Section>
  );
}

export function DevicePage({ user }: { user: SignedIn }) {
  const offline = useOffline();
  return (
    <SuiteShell
      app="mail"
      user={user}
      signOutHref={offline ? DEVICE_CLEARED_PATH : undefined}
      navigationLabel="Mail"
      navigation={
        <Link to="/mail" className={NAV_ITEM}>
          <IconArrowLeft size={18} stroke={1.75} aria-hidden />
          Back to Mail
        </Link>
      }
    >
      <OfflineBanner />
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
        <h1 className="text-[21px] font-semibold">App and notifications</h1>
        <InstallSection />
        <NotificationsSection />
        <SavedMailSection />
      </div>
    </SuiteShell>
  );
}
