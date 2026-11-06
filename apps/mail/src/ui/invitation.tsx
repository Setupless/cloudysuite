import { MailInvitationCard } from "@cloudysuite/calendar/mail-card-ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addInvitationFromMail,
  answerInvitationFromMail,
  getInvitationCard,
  removeInvitationFromMail,
} from "../invitation-functions";
import { useOffline } from "../pwa/connectivity";
import { call, callAction, mailKeys, retryUnlessRefused } from "../queries";
import { CALENDAR_TYPES, type MailboxId, type MessageDetail } from "../types";
import { FailureNotice } from "./states";

export const carriesInvitation = (message: MessageDetail) =>
  message.attachments.some((attachment) =>
    CALENDAR_TYPES.includes(attachment.mimeType),
  );

// Outside the message's sandboxed frame, in Mail's own page. It needs Calendar, so it
// isn't saved for reading offline.
export function MessageInvitation({
  message,
  mailboxId,
}: {
  message: MessageDetail;
  mailboxId: MailboxId;
}) {
  const offline = useOffline();
  const client = useQueryClient();
  const target = { mailboxId, messageId: message.id };
  const queryKey = mailKeys.invitation(mailboxId, message.id);
  const query = useQuery({
    queryKey,
    queryFn: () => call(() => getInvitationCard({ data: target })),
    enabled: !offline,
    retry: retryUnlessRefused,
  });

  if (offline || query.isPending || query.data === null) return null;
  if (query.isError) {
    return (
      <FailureNotice
        message={query.error.message}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const after = async (action: () => Promise<void>) => {
    await callAction(action);
    await client.invalidateQueries({ queryKey });
  };
  return (
    <MailInvitationCard
      card={query.data}
      actions={{
        answer: (answer) =>
          after(() =>
            answerInvitationFromMail({ data: { ...target, answer } }),
          ),
        add: () => after(() => addInvitationFromMail({ data: target })),
        remove: () => after(() => removeInvitationFromMail({ data: target })),
      }}
    />
  );
}
