import type { DriveId } from "@cloudysuite/access";
import { Button, Modal, Notice, TextField } from "@cloudysuite/ui";
import { skeletonShown } from "@cloudysuite/ui/skeleton";
import {
  IconChevronRight,
  IconPlus,
  IconTrashX,
  IconUpload,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type DragEvent,
  Fragment,
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { folderQuery } from "../queries";
import type { ItemId } from "../types";
import type { Destination } from "./upload-queue";
import { destinationName } from "./upload-queue";
import { focusDetails } from "./details-focus";
import { MoveNotices } from "./move-notices";
import { FileRows } from "./pending";
import { useUploads } from "./uploads-context";

// A pointer passing over a list on its way elsewhere doesn't stop this long.
const HOVER_PREFETCH_MS = 120;

export function useFolderPrefetch(
  driveId: DriveId | null,
  folderId: ItemId | null,
) {
  const client = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const prefetch = () => {
    clearTimeout(timer.current);
    if (driveId !== null) {
      void client.prefetchInfiniteQuery(folderQuery(driveId, folderId));
    }
  };
  return {
    onPointerEnter: () => {
      timer.current = setTimeout(prefetch, HOVER_PREFETCH_MS);
    },
    onPointerLeave: () => clearTimeout(timer.current),
    onPointerDown: prefetch,
    onFocus: prefetch,
  };
}

export function FolderLink({
  driveId,
  folderId,
  file,
  className,
  children,
}: {
  driveId: DriveId;
  folderId: ItemId | null;
  file?: ItemId;
  className?: string;
  children: ReactNode;
}) {
  const prefetch = useFolderPrefetch(driveId, folderId);
  return folderId === null ? (
    <Link
      to="/storage/drive/$driveId"
      params={{ driveId }}
      search={{ file }}
      className={className}
      {...prefetch}
    >
      {children}
    </Link>
  ) : (
    <Link
      to="/storage/drive/$driveId/$folderId"
      params={{ driveId, folderId }}
      search={{ file }}
      className={className}
      {...prefetch}
    >
      {children}
    </Link>
  );
}

export type Crumb = { key: string; link: ReactNode };

export function Breadcrumb({
  trail,
  current,
}: {
  trail: readonly Crumb[];
  current: string;
}) {
  const crumbClass = "hover:text-accent";
  return (
    <nav
      aria-label="Where you are"
      className="flex flex-wrap items-center gap-[3px] px-4 pt-3 text-[13px] text-secondary"
    >
      <Link
        to="/storage"
        activeOptions={{ exact: true }}
        className={crumbClass}
      >
        Home
      </Link>
      {trail.map(({ key, link }) => (
        <Fragment key={key}>
          <IconChevronRight size={13} stroke={1.75} aria-hidden />
          <span className={crumbClass}>{link}</span>
        </Fragment>
      ))}
      <IconChevronRight size={13} stroke={1.75} aria-hidden />
      <span className="min-w-0 truncate" aria-current="page">
        {current}
      </span>
    </nav>
  );
}

// A long table stands between a keyboard and the panel's actions.
export function SkipToDetails() {
  return (
    <div className="px-4">
      <button
        type="button"
        className="sr-only cursor-pointer rounded text-sm text-accent outline-accent focus:not-sr-only focus:mb-1 focus:inline-block focus:px-2 focus:py-1 focus-visible:outline-2"
        onClick={focusDetails}
      >
        Go to the actions for this folder
      </button>
    </div>
  );
}

export function PageTop({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  // Every page has this, so a person sees why a move didn't happen wherever they are.
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3.5 pb-2.5">
        <h1 className="mr-auto min-w-0 text-[21px] font-semibold break-words">
          {title}
        </h1>
        {children}
      </div>
      <MoveNotices />
    </>
  );
}

export function NameDialog({
  title,
  hint,
  submitLabel,
  initialName = "",
  onSubmit,
  onClose,
}: {
  title: string;
  hint: string;
  submitLabel: string;
  initialName?: string;
  // Resolves once done, and throws with the words to show if it can't be.
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  // The box is turned off while saving, which takes the person's place away.
  useEffect(() => {
    if (pending || !error) return;
    field.current?.focus();
    field.current?.select();
  }, [pending, error]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await onSubmit(name);
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
      setPending(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose} busy={pending}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <TextField
          ref={field}
          label="Name"
          value={name}
          hint={hint}
          autoFocus
          disabled={pending}
          onChange={(event) => setName(event.target.value)}
        />
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button variant="toolbar" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="toolbarAction" pending={pending}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Modal title={title} onClose={onClose} busy={pending}>
      <p className="text-sm text-secondary">{body}</p>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button variant="toolbar" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          icon={IconTrashX}
          pending={pending}
          onClick={() => {
            setPending(true);
            setError(null);
            onConfirm()
              .then(onClose)
              .catch((failure: Error) => {
                setError(failure.message);
                setPending(false);
              });
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

export function PageActions({
  destination,
  onNewFolder,
}: {
  destination: Destination;
  onNewFolder: (name: string) => Promise<void>;
}) {
  const uploads = useUploads();
  const picker = useRef<HTMLInputElement>(null);
  const [naming, setNaming] = useState(false);
  return (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        aria-label={`Choose files to upload to ${destinationName(destination)}`}
        className="hidden"
        onChange={(event) => {
          uploads.add(destination, [...(event.target.files ?? [])]);
          // Picking the same file again must fire this again, because that resumes it.
          event.target.value = "";
        }}
      />
      <Button
        variant="toolbar"
        icon={IconUpload}
        onClick={() => picker.current?.click()}
      >
        Upload
      </Button>
      <Button
        variant="toolbarAction"
        icon={IconPlus}
        onClick={() => setNaming(true)}
      >
        New folder
      </Button>
      {naming && (
        <NameDialog
          title="New folder"
          hint={`It goes in ${destinationName(destination)}.`}
          submitLabel="Create folder"
          onSubmit={onNewFolder}
          onClose={() => setNaming(false)}
        />
      )}
    </>
  );
}

// A folder dragged in shows as a file with no readable bytes, so it's told apart here.
function droppedFiles(event: DragEvent): { files: File[]; hadFolder: boolean } {
  const entries = [...event.dataTransfer.items].map((item) =>
    item.webkitGetAsEntry(),
  );
  const hadFolder = entries.some((entry) => entry?.isDirectory);
  return {
    files: [...event.dataTransfer.files].filter(
      (_, index) => !entries[index]?.isDirectory,
    ),
    hadFolder,
  };
}

const carriesFiles = (event: DragEvent) =>
  event.dataTransfer.types.includes("Files");

export function DropZone({
  destination,
  className,
  children,
}: {
  destination: Destination;
  className?: string;
  children: ReactNode;
}) {
  const uploads = useUploads();
  const [over, setOver] = useState(false);
  const [folderRefused, setFolderRefused] = useState(false);
  return (
    <div
      data-drop-zone
      className={`${className ?? ""} ${over ? "outline-2 -outline-offset-2 outline-accent" : ""}`}
      onDragEnter={(event) => {
        if (carriesFiles(event)) setOver(true);
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOver(false);
        }
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setOver(false);
        const { files, hadFolder } = droppedFiles(event);
        setFolderRefused(hadFolder);
        uploads.add(destination, files);
      }}
    >
      {folderRefused && (
        <div className="px-4 pt-3">
          <Notice tone="danger">
            Folders can't be uploaded yet. Open the folder on your computer and
            drag in the files instead.
          </Notice>
        </div>
      )}
      {children}
    </div>
  );
}

// Faded in late, so a quick load doesn't flash it.
export function Loading({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const [fadeIn] = useState(() => !skeletonShown());
  return (
    <div
      role="status"
      className={`${className ?? ""} ${fadeIn ? "transition-opacity delay-300 duration-200 starting:opacity-0" : ""}`}
    >
      <span className="sr-only">Loading…</span>
      {children}
    </div>
  );
}

export const BONE = "animate-pulse rounded bg-field";

export function LoadingRows() {
  return (
    <Loading className="flex flex-col px-4 pt-2">
      <FileRows />
    </Loading>
  );
}

// For a page whose title comes with its contents.
export function LoadingPage({ title }: { title?: string }) {
  return (
    <div className="min-h-[calc(100dvh-52px)] pb-4">
      {title === undefined ? (
        <div aria-hidden className="px-4 pt-3.5 pb-2.5">
          <span className={`block h-[26px] w-48 ${BONE}`} />
        </div>
      ) : (
        <>
          <Breadcrumb trail={[]} current={title} />
          <PageTop title={title} />
        </>
      )}
      <LoadingRows />
    </div>
  );
}

export function Problem({ message }: { message: string }) {
  return (
    <div className="mx-auto mt-16 flex max-w-sm flex-col items-center gap-3 px-4 text-center">
      <p className="text-secondary">{message}</p>
      <Link to="/storage" className="text-sm text-accent underline">
        Go to Home
      </Link>
    </div>
  );
}
