import type { UserId } from "@cloudysuite/access";
import { Button, Modal } from "@cloudysuite/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useOffline } from "../../pwa/connectivity";
import { forgetKeptDraft } from "../../pwa/device-store";
import { mailboxesQuery } from "../../queries";
import { keptAsText, withoutAccess } from "../kept";
import type { KeptDraft } from "../types";
import { plainTextOf } from "./device-html";
import { keptDraftsQuery } from "./kept-drafts";

function KeptCard({
  draft,
  onRemoved,
  onLater,
}: {
  draft: KeptDraft;
  onRemoved: () => void;
  onLater: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  const box = useRef<HTMLTextAreaElement>(null);
  const text = keptAsText(draft, plainTextOf(draft.content.html));
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopy("done");
    } catch {
      box.current?.select();
      setCopy("failed");
    }
  };
  return (
    <section
      aria-labelledby="kept-without-access"
      className="fixed inset-x-2 bottom-2 z-20 flex max-h-[70dvh] flex-col gap-2 rounded border border-line bg-panel p-4 text-sm text-text shadow-lg sm:left-auto sm:w-96"
    >
      <h2 id="kept-without-access" className="font-semibold">
        You no longer have access to this mailbox
      </h2>
      <p className="text-secondary">
        You were writing this from {draft.content.from || "a mailbox"}, and it
        can't be saved there now. This browser has the only copy of what's
        below. Copy what you need, then remove it. Ask your admin if you should
        still have access.
      </p>
      <textarea
        ref={box}
        readOnly
        aria-label="What you wrote"
        rows={6}
        value={text}
        className="min-h-0 w-full flex-1 resize-none rounded border border-line bg-field p-2 text-sm text-text outline-accent focus-visible:outline-2"
      />
      {copy === "done" && <p role="status">Copied.</p>}
      {copy === "failed" && (
        <p role="alert" className="text-danger">
          We couldn't copy it for you. The text is selected, so press Ctrl+C or
          ⌘C.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="action" onClick={() => void copyText()}>
          Copy text
        </Button>
        <Button variant="quiet" onClick={onLater}>
          Later
        </Button>
        <span className="flex-1" />
        <Button variant="quiet" onClick={() => setConfirming(true)}>
          Remove
        </Button>
      </div>
      {confirming && (
        <Modal
          title="Remove this message?"
          onClose={() => setConfirming(false)}
        >
          <p className="text-sm text-secondary">
            It's only on this browser, so you can't get it back after this.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="quiet"
              autoFocus
              onClick={() => setConfirming(false)}
            >
              Keep it
            </Button>
            <Button variant="danger" onClick={onRemoved}>
              Remove
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

// Above the mailbox screens, because a person who has lost their only mailbox has none,
// and words from a lost mailbox would otherwise show nowhere. Nothing here writes to it.
export function KeptWithoutAccess({ userId }: { userId: UserId }) {
  const queryClient = useQueryClient();
  const kept = useQuery(keptDraftsQuery(userId)).data ?? [];
  const offline = useOffline();
  const mailboxes = useQuery({
    ...mailboxesQuery(),
    enabled: kept.length > 0,
  });
  const [later, setLater] = useState<readonly string[]>([]);
  // Offline, the list is only this device's last copy of it.
  const lost = withoutAccess(
    kept,
    !offline && mailboxes.isSuccess ? mailboxes.data : undefined,
  ).filter((draft) => !later.includes(draft.id));
  const [first] = lost;
  if (!first) return null;
  return (
    <KeptCard
      key={first.id}
      draft={first}
      onLater={() => setLater((ids) => [...ids, first.id])}
      onRemoved={() =>
        void forgetKeptDraft(userId, first.id, first.keptAt).finally(() =>
          queryClient.invalidateQueries({
            queryKey: keptDraftsQuery(userId).queryKey,
          }),
        )
      }
    />
  );
}
