import type { SignedIn } from "@cloudysuite/auth/session";
import { SuiteShell } from "@cloudysuite/auth/shell";
import {
  NAV_ITEM,
  NAV_ITEM_ACTIVE,
  useDestinationParam,
} from "@cloudysuite/ui";
import {
  IconAlertOctagon,
  IconArchive,
  IconBan,
  IconFile,
  IconFileImport,
  IconFilter,
  IconInbox,
  IconMailbox,
  IconSend,
  IconSettings,
  IconTags,
  IconTrash,
  IconUsers,
} from "@tabler/icons-react";
import type { Icon } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import {
  type DehydratedState,
  HydrationBoundary,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ComposeProvider } from "../compose/ui/compose-context";
import type { MailboxEntry } from "../functions";
import { FOLDER_DISPLAY, FOLDER_ORDER, viewParam } from "../model";
import { useOffline } from "../pwa/connectivity";
import { DEVICE_CLEARED_PATH } from "../pwa/sw-policy";
import { mailboxesQuery, REFRESH_MS } from "../queries";
import type { Folder, MailboxId, ThreadView } from "../types";
import { LabelIcon } from "./label-chip";
import { SearchBox } from "./search-box";

const FOLDER_ICONS: Record<Folder, Icon> = {
  inbox: IconInbox,
  archive: IconArchive,
  sent: IconSend,
  drafts: IconFile,
  spam: IconAlertOctagon,
  trash: IconTrash,
};

function FolderIcon({ folder }: { folder: Folder }) {
  const FolderGlyph = FOLDER_ICONS[folder];
  return <FolderGlyph size={18} stroke={1.75} aria-hidden />;
}

function UnreadCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-auto text-xs font-semibold">
      <span className="sr-only">Unread: </span>
      {count}
    </span>
  );
}

function ViewLink({
  mailboxId,
  view,
  icon,
  title,
  unread,
}: {
  mailboxId: MailboxId;
  view: ThreadView;
  icon: ReactNode;
  title: string;
  unread: number;
}) {
  return (
    <Link
      to="/mail/$mailboxId/$view"
      params={{ mailboxId, view: viewParam(view) }}
      className={NAV_ITEM}
      activeProps={{ className: NAV_ITEM_ACTIVE }}
    >
      {icon}
      <span className="min-w-0 truncate">{title}</span>
      <UnreadCount count={unread} />
    </Link>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="px-2.5 pt-3 pb-1 text-xs font-semibold text-secondary">
      {children}
    </h3>
  );
}

function MailNavigation({
  mailboxId,
  mailboxes,
  current,
}: {
  mailboxId: MailboxId;
  mailboxes: MailboxEntry[];
  current: MailboxEntry | undefined;
}) {
  const chosenMailbox = useDestinationParam("mailboxId") ?? mailboxId;
  return (
    <>
      {FOLDER_ORDER.map((folder) => (
        <ViewLink
          key={folder}
          mailboxId={mailboxId}
          view={{ folder }}
          icon={<FolderIcon folder={folder} />}
          title={FOLDER_DISPLAY[folder].title}
          unread={
            FOLDER_DISPLAY[folder].countsUnread
              ? (current?.summary.folderUnread[folder] ?? 0)
              : 0
          }
        />
      ))}
      {current && (
        <>
          <SectionTitle>Labels</SectionTitle>
          {current.summary.labels.map((label) => (
            <ViewLink
              key={label.id}
              mailboxId={mailboxId}
              view={{ labelId: label.id }}
              icon={<LabelIcon colour={label.colour} />}
              title={label.name}
              unread={label.unread}
            />
          ))}
          <Link
            to="/mail/$mailboxId/labels"
            params={{ mailboxId }}
            className={NAV_ITEM}
            activeProps={{ className: NAV_ITEM_ACTIVE }}
          >
            <IconTags size={18} stroke={1.75} aria-hidden />
            <span className="min-w-0 truncate">Edit labels</span>
          </Link>
        </>
      )}
      {current && (
        <Link
          to="/mail/$mailboxId/rules"
          params={{ mailboxId }}
          className={NAV_ITEM}
          activeProps={{ className: NAV_ITEM_ACTIVE }}
        >
          <IconFilter size={18} stroke={1.75} aria-hidden />
          <span className="min-w-0 truncate">Rules</span>
        </Link>
      )}
      {current && (
        <Link
          to="/mail/$mailboxId/senders"
          params={{ mailboxId }}
          className={NAV_ITEM}
          activeProps={{ className: NAV_ITEM_ACTIVE }}
        >
          <IconBan size={18} stroke={1.75} aria-hidden />
          <span className="min-w-0 truncate">Blocked and allowed</span>
        </Link>
      )}
      {current?.role === "manager" && (
        <Link
          to="/mail/import"
          search={{ mailbox: mailboxId }}
          className={NAV_ITEM}
          activeProps={{ className: NAV_ITEM_ACTIVE }}
        >
          <IconFileImport size={18} stroke={1.75} aria-hidden />
          <span className="min-w-0 truncate">Import mail</span>
        </Link>
      )}
      <Link
        to="/mail/device"
        className={NAV_ITEM}
        activeProps={{ className: NAV_ITEM_ACTIVE }}
      >
        <IconSettings size={18} stroke={1.75} aria-hidden />
        <span className="min-w-0 truncate">App and notifications</span>
      </Link>
      {mailboxes.length > 1 && (
        <>
          <SectionTitle>Mailboxes</SectionTitle>
          {mailboxes.map((mailbox) => (
            <Link
              key={mailbox.id}
              to="/mail/$mailboxId/$view"
              params={{ mailboxId: mailbox.id, view: "inbox" }}
              title={mailbox.address ?? undefined}
              aria-current={mailbox.id === chosenMailbox ? "true" : undefined}
              className={`${NAV_ITEM} ${mailbox.id === chosenMailbox ? NAV_ITEM_ACTIVE : ""}`}
            >
              {mailbox.kind === "shared" ? (
                <IconUsers size={18} stroke={1.75} aria-hidden />
              ) : (
                <IconMailbox size={18} stroke={1.75} aria-hidden />
              )}
              <span className="min-w-0 truncate">{mailbox.name}</span>
              <UnreadCount count={mailbox.summary.folderUnread.inbox} />
            </Link>
          ))}
        </>
      )}
    </>
  );
}

function MailboxShell({
  user,
  mailboxId,
  children,
}: {
  user: SignedIn;
  mailboxId: MailboxId;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const { data: mailboxes = [] } = useQuery({
    ...mailboxesQuery(),
    refetchInterval: () => (queryClient.isMutating() ? false : REFRESH_MS),
  });
  const current = mailboxes.find((mailbox) => mailbox.id === mailboxId);
  const offline = useOffline();
  return (
    <SuiteShell
      app="mail"
      user={user}
      signOutHref={offline ? DEVICE_CLEARED_PATH : undefined}
      navigationLabel={current?.name ?? "Mail"}
      headerContent={<SearchBox mailboxId={mailboxId} />}
      navigation={
        <MailNavigation
          mailboxId={mailboxId}
          mailboxes={mailboxes}
          current={current}
        />
      }
    >
      <ComposeProvider key={mailboxId} mailboxId={mailboxId} userId={user.id}>
        {children}
      </ComposeProvider>
    </SuiteShell>
  );
}

export function MailboxLayout({
  user,
  mailboxId,
  prefetched,
  children,
}: {
  user: SignedIn;
  mailboxId: string;
  prefetched: DehydratedState | undefined;
  children: ReactNode;
}) {
  return (
    <HydrationBoundary state={prefetched}>
      <MailboxShell user={user} mailboxId={mailboxId as MailboxId}>
        {children}
      </MailboxShell>
    </HydrationBoundary>
  );
}

export function NoMailbox({ user }: { user: SignedIn }) {
  return (
    <SuiteShell app="mail" user={user} navigationLabel="Mail">
      <div className="flex h-[calc(100dvh-3.25rem)] items-center justify-center p-6 text-center text-sm text-secondary">
        <p className="max-w-xs">
          You don't have a mailbox yet. Ask your admin to set one up for you.
        </p>
      </div>
    </SuiteShell>
  );
}
