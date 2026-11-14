import { Bone, type PendingPage } from "@cloudysuite/ui";

// What a page shows while it opens: a heading, then its sections.

function SectionBones({ fields }: { fields: number }) {
  return (
    <div className="flex flex-col gap-3 rounded border border-line bg-panel p-5">
      <Bone className="h-5 w-40" />
      <Bone className="h-3 w-3/4" />
      {Array.from({ length: fields }, (_, index) => (
        <Bone key={index} className="h-10" />
      ))}
    </div>
  );
}

function SettingsPage({ width }: { width: string }) {
  return (
    <div className={`mx-auto flex w-full flex-col gap-4 p-6 ${width}`}>
      <div className="flex flex-col gap-3 py-1">
        <Bone className="h-7 w-48" />
        <Bone className="h-4 w-72 max-w-full" />
      </div>
      <SectionBones fields={1} />
      <SectionBones fields={2} />
      <SectionBones fields={1} />
    </div>
  );
}

export const AccountPending = () => <SettingsPage width="max-w-2xl" />;
export const AdminPending = () => <SettingsPage width="max-w-3xl" />;

export const AUTH_PAGES: readonly PendingPage[] = [
  { to: "/auth", skeleton: AccountPending },
  { to: "/auth/admin", skeleton: AdminPending },
  { to: "/auth/admin/people", skeleton: AdminPending },
  { to: "/auth/admin/mailboxes", skeleton: AdminPending },
  { to: "/auth/admin/domains", skeleton: AdminPending },
];
