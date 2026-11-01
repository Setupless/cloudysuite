import { IconAlertCircle, IconCloudOff } from "@tabler/icons-react";
import { Button, Page } from "@cloudysuite/ui";
import { NotSavedOnDevice } from "../failure";
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

function TryAgain({ children }: { children: string }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-secondary">{children}</p>
      <Button variant="quiet" onClick={() => location.reload()}>
        Try again
      </Button>
    </div>
  );
}

export function MailRouteError({ error }: { error: unknown }) {
  const offline = useOffline();
  if (error instanceof NoSavedIdentity) {
    return (
      <Page icon={IconCloudOff} title="You're offline">
        <TryAgain>
          No mail is saved on this device yet. Connect to the internet and try
          again.
        </TryAgain>
      </Page>
    );
  }
  if (error instanceof NotSavedOnDevice) {
    return (
      <Page icon={IconCloudOff} title="You're offline">
        <TryAgain>{error.message}</TryAgain>
      </Page>
    );
  }
  if (offline) {
    return (
      <Page icon={IconCloudOff} title="You're offline">
        <div className="flex flex-col items-center gap-3">
          <p className="text-secondary">
            This page needs a connection. Your saved mail is still here.
          </p>
          <a href="/" className="font-medium text-accent underline">
            Go to your saved mail
          </a>
        </div>
      </Page>
    );
  }
  return (
    <Page icon={IconAlertCircle} title="Something went wrong">
      <TryAgain>We couldn't open this page. Try again in a moment.</TryAgain>
    </Page>
  );
}
