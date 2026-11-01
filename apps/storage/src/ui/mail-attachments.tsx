import { buttonClass } from "@cloudysuite/ui";
import { IconCheck } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { saveAttachmentFromMail } from "../mail-attachment-functions";
import type { MailAttachmentRow } from "../mail-attachments";
import { call, mailAttachmentsQuery, storageKeys } from "../queries";
import { FileIcon } from "./file-visuals";
import { dayInSentence } from "./format";

function AttachmentRow({ row }: { row: MailAttachmentRow }) {
  const client = useQueryClient();
  const { mailboxId, messageId, attachmentId } = row;
  const save = useMutation({
    mutationFn: () =>
      call(() =>
        saveAttachmentFromMail({
          data: { mailboxId, messageId, attachmentId },
        }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: storageKeys.all }),
  });
  const isSaved = row.saved || save.isSuccess;
  return (
    <li className="border-t border-line py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex-none text-secondary">
          <FileIcon file={{ name: row.name, mimeType: row.mimeType }} />
        </span>
        <div className="min-w-0 flex-1 text-sm sm:flex sm:items-center sm:gap-2.5">
          <span className="block min-w-0 truncate sm:flex-1">{row.name}</span>
          <span className="block min-w-0 truncate text-[13px] text-secondary sm:max-w-[50%]">
            From {row.sender}, {dayInSentence(row.receivedAt, new Date())}
          </span>
        </div>
        {isSaved ? (
          <span className="flex flex-none items-center gap-2 rounded border border-line bg-panel px-[11px] py-1.5 text-[13px] text-text">
            <IconCheck size={16} stroke={1.75} aria-hidden />
            Saved to My files
          </span>
        ) : (
          <button
            type="button"
            className={`flex-none ${buttonClass("toolbar")}`}
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save to Storage"}
          </button>
        )}
      </div>
      {save.isError && (
        <p role="alert" className="pt-1 text-[13px] text-danger">
          {save.error.message}
        </p>
      )}
    </li>
  );
}

export function MailAttachments({ mailHref }: { mailHref: string }) {
  const { data: rows } = useQuery(mailAttachmentsQuery());
  if (!rows || rows.length === 0) return null;
  return (
    <section>
      <div className="flex items-center px-4 pt-4 pb-2 text-sm font-semibold">
        <h2>Attachments from your mail</h2>
        <a
          href={mailHref}
          className="ml-auto text-[13px] font-normal text-accent"
        >
          Open in Mail
        </a>
      </div>
      <ul className="px-4">
        {rows.map((row) => (
          <AttachmentRow
            key={`${row.mailboxId}/${row.attachmentId}`}
            row={row}
          />
        ))}
      </ul>
    </section>
  );
}
