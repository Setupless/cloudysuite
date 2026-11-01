// The one place that decides how outgoing mail threads.
//
// Cloudflare generates every message's Message-ID. Its docs block the header on
// `send()`, and the raw `EmailMessage` form does not help: local `wrangler` requires a
// Message-ID in the raw message and then replaces it, and that form takes one
// recipient per call, so a message to three people would be three sends, three charges
// against the quota, and a partial failure to explain.
//
// So we use `send()`, and the `messageId` it returns becomes our stored copy's id. The
// docs don't say that value equals the delivered header. A new message therefore also
// carries an id of our own in References. A recipient's client copies References into
// its reply, so the reply finds our copy even if the returned id is something else.
// Replies don't need this, because the parent's ids are already in the chain.

// Cloudflare refuses a header value over this many bytes.
const MAX_HEADER_BYTES = 2048;

// A parent's ids came from a stranger's message, so only plain ones are copied out.
const SAFE_ID = /^[\x21-\x3b\x3d\x3f-\x7e]+$/;

const safeId = (id: string) => SAFE_ID.test(id);

const bracketed = (ids: string[]) => ids.map((id) => `<${id}>`).join(" ");

const fits = (ids: string[]) => bracketed(ids).length <= MAX_HEADER_BYTES;

// Keeps the thread's root and its most recent ancestors, as RFC 5322 suggests.
function shortened(chain: string[]): string[] {
  const kept = [...chain];
  while (kept.length > 2 && !fits(kept)) kept.splice(1, 1);
  return fits(kept) ? kept : kept.slice(-1);
}

export type ThreadingHeaders = {
  "In-Reply-To"?: string;
  References: string;
};

export function ownReferenceId(
  outgoingId: string,
  fromAddress: string,
): string {
  return `${outgoingId}@${fromAddress.slice(fromAddress.lastIndexOf("@") + 1)}`;
}

export function threadingHeaders(
  parent: { rfcMessageId: string | null; references: string[] } | null,
  ownId: string,
): ThreadingHeaders {
  const parentId =
    parent?.rfcMessageId && safeId(parent.rfcMessageId)
      ? parent.rfcMessageId
      : null;
  if (!parent || !parentId) return { References: `<${ownId}>` };
  const ancestors = parent.references.filter(
    (id) => safeId(id) && id !== parentId,
  );
  return {
    "In-Reply-To": `<${parentId}>`,
    References: bracketed(shortened([...ancestors, parentId])),
  };
}

// Whatever shape the service returns, our stored copy gets a usable header. A value
// we can't use falls back to our own id, which threading already works from.
export function storedMessageId(returned: unknown, ownId: string): string {
  const id = typeof returned === "string" ? returned.trim() : "";
  const bare = id.replace(/^<|>$/g, "");
  return bare && bare.length <= 998 && safeId(bare) ? bare : ownId;
}
