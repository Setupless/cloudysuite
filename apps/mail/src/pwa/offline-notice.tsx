import { IconCloudOff } from "@tabler/icons-react";
import { Page } from "@cloudysuite/ui";
import { useOffline } from "./connectivity";

export function OfflineBanner() {
  const offline = useOffline();
  if (!offline) return null;
  return (
    <p
      role="status"
      className="flex flex-none items-center gap-2 border-b border-line bg-sidebar px-4 py-2 text-sm text-secondary"
    >
      <IconCloudOff size={16} stroke={1.75} aria-hidden className="flex-none" />
      You're offline, showing mail saved on this device.
    </p>
  );
}

export class NoSavedIdentity extends Error {}

export function MailRouteError({ error }: { error: unknown }) {
  const offline = useOffline();
  if (error instanceof NoSavedIdentity) {
    return (
      <Page icon={IconCloudOff} title="You're offline">
        No mail is saved on this device yet. Connect to the internet and try
        again.
      </Page>
    );
  }
  return (
    <Page
      icon={IconCloudOff}
      title={offline ? "You're offline" : "Something went wrong"}
    >
      {offline
        ? "This page needs a connection. Your saved mail is still in your inbox."
        : "We couldn't open this page. Try again in a moment."}
    </Page>
  );
}
