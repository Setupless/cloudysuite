import type { Icon } from "@tabler/icons-react";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

export * from "./shell";

const noSubscription = () => () => {};

// The server knows neither the reader's time zone nor their language. Anything written
// for them waits until this is true, so the first HTML and the browser's first render
// say the same thing.
export const useHydrated = (): boolean =>
  useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );

export function Page({
  icon: PageIcon,
  title,
  children,
}: {
  icon: Icon;
  title: string;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-page p-6 text-text">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-sidebar text-accent">
          <PageIcon size={28} stroke={1.5} aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {typeof children === "string" ? (
          <p className="text-secondary">{children}</p>
        ) : (
          children
        )}
      </div>
    </main>
  );
}

const BUTTON_VARIANTS = {
  primary: "w-full bg-accent px-4 py-2.5 font-medium text-on-accent",
  action: "bg-accent px-3.5 py-2 text-sm font-medium text-on-accent",
  secondary: "border border-line bg-panel px-4 py-2.5 font-medium text-text",
  quiet: "border border-line bg-panel px-3 py-1.5 text-sm text-text",
  // A page's toolbar: one height for both, with the smaller icon.
  toolbar: "border border-line bg-panel px-[11px] py-1.5 text-[13px] text-text",
  toolbarAction:
    "border border-accent bg-accent px-[11px] py-1.5 text-[13px] font-semibold text-on-accent",
  danger: "border border-line bg-panel px-3 py-1.5 text-sm text-danger",
  link: "text-sm text-accent",
};

export const buttonClass = (variant: keyof typeof BUTTON_VARIANTS) =>
  `flex cursor-pointer items-center justify-center gap-2 rounded outline-accent focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-60 ${BUTTON_VARIANTS[variant]}`;

export function Button({
  variant = "primary",
  icon: ButtonIcon,
  type = "button",
  children,
  ...props
}: Omit<ComponentProps<"button">, "className"> & {
  variant?: keyof typeof BUTTON_VARIANTS;
  icon?: Icon;
}) {
  return (
    <button type={type} className={buttonClass(variant)} {...props}>
      {ButtonIcon && (
        <ButtonIcon
          size={variant.startsWith("toolbar") ? 16 : 18}
          stroke={1.75}
          aria-hidden
        />
      )}
      {children}
    </button>
  );
}

export function TextField({
  label,
  hint,
  ...props
}: Omit<ComponentProps<"input">, "className"> & {
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex w-full flex-col gap-1.5 text-left text-sm font-medium">
      {label}
      <input
        className="w-full rounded border border-line bg-field px-3 py-2.5 text-base font-normal text-text outline-accent focus-visible:outline-2"
        {...props}
      />
      {hint && <span className="font-normal text-secondary">{hint}</span>}
    </label>
  );
}

export function SelectField({
  label,
  children,
  ...props
}: Omit<ComponentProps<"select">, "className"> & { label: string }) {
  return (
    <label className="flex w-full flex-col gap-1.5 text-left text-sm font-medium">
      {label}
      <select
        className="w-full rounded border border-line bg-field px-3 py-2.5 text-base font-normal text-text outline-accent focus-visible:outline-2"
        {...props}
      >
        {children}
      </select>
    </label>
  );
}

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded border border-line bg-panel p-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        {description && <p className="text-sm text-secondary">{description}</p>}
      </header>
      {children}
    </section>
  );
}

export function Notice({
  tone,
  children,
}: {
  tone: "success" | "danger" | "info";
  children: ReactNode;
}) {
  const colour = {
    success: "text-success",
    danger: "text-danger",
    info: "text-secondary",
  }[tone];
  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      className={`rounded bg-sidebar px-3 py-2 text-sm ${colour}`}
    >
      {children}
    </p>
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "danger" | "success";
  children: ReactNode;
}) {
  const colour = {
    neutral: "text-secondary",
    danger: "text-danger",
    success: "text-success",
  }[tone];
  return (
    <span
      className={`inline-block rounded-full bg-sidebar px-2 py-0.5 text-xs font-medium ${colour}`}
    >
      {children}
    </span>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      className="m-auto w-full max-w-md rounded border border-line bg-panel p-5 text-text backdrop:bg-text backdrop:opacity-30"
    >
      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </dialog>
  );
}

export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium">
      {label}
      <div className="flex gap-2">
        <input
          readOnly
          aria-label={label}
          value={value}
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 rounded border border-line bg-field px-3 py-2 font-mono text-sm font-normal text-text outline-accent focus-visible:outline-2"
        />
        <Button
          variant="quiet"
          icon={copied ? IconCheck : IconCopy}
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
