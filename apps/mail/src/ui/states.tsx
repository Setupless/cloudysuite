import { Button } from "@cloudysuite/ui";
import { IconAlertCircle } from "@tabler/icons-react";
import { useSyncExternalStore } from "react";
import { formatFullDate, formatListDate } from "./format";

const noSubscription = () => () => {};

// The server does not know the reader's time zone, so a date stays blank until the
// browser can write it, instead of flashing a time that then changes.
export function ThreadDate({ timestamp }: { timestamp: number }) {
  const hydrated = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  return (
    <time
      dateTime={new Date(timestamp).toISOString()}
      title={hydrated ? formatFullDate(timestamp) : undefined}
      className={`flex-none text-xs text-secondary ${hydrated ? "" : "invisible"}`}
    >
      {hydrated ? formatListDate(timestamp, new Date()) : "Nov 00"}
    </time>
  );
}

export function FailureNotice({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 px-6 py-12 text-center text-sm"
    >
      <IconAlertCircle
        className="text-danger"
        size={24}
        stroke={1.5}
        aria-hidden
      />
      <p className="max-w-xs text-secondary">{message}</p>
      {onRetry && (
        <Button variant="quiet" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function SkeletonLines({ rows }: { rows: number }) {
  return (
    <div aria-hidden className="flex animate-pulse flex-col gap-1 px-2 py-1">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex gap-2.5 px-2.5 py-2.5">
          <div className="size-8 flex-none rounded-full bg-field" />
          <div className="flex min-w-0 flex-1 flex-col gap-2 py-0.5">
            <div className="h-3 w-2/5 rounded bg-field" />
            <div className="h-3 w-4/5 rounded bg-field" />
          </div>
        </div>
      ))}
    </div>
  );
}
