import type { ReactNode } from "react";

export function AdminPage({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-secondary">{description}</p>
      </header>
      {children}
    </div>
  );
}
