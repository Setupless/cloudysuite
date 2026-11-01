import type { Icon } from "@tabler/icons-react";
import type { ComponentProps, ReactNode } from "react";

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
  secondary: "border border-line bg-panel px-4 py-2.5 font-medium text-text",
  link: "text-sm text-accent",
};

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
    <button
      type={type}
      className={`flex cursor-pointer items-center justify-center gap-2 rounded outline-accent focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-60 ${BUTTON_VARIANTS[variant]}`}
      {...props}
    >
      {ButtonIcon && <ButtonIcon size={18} stroke={1.75} aria-hidden />}
      {children}
    </button>
  );
}

export function TextField({
  label,
  ...props
}: Omit<ComponentProps<"input">, "className"> & { label: string }) {
  return (
    <label className="flex w-full flex-col gap-1.5 text-left text-sm font-medium">
      {label}
      <input
        className="w-full rounded border border-line bg-field px-3 py-2.5 text-base font-normal text-text outline-accent focus-visible:outline-2"
        {...props}
      />
    </label>
  );
}
