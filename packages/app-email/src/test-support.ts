// A stand-in for the EMAIL binding that keeps every message it was handed, and can be
// told how its next sends end, as the real service can.

export type SentEmail = { from: string; to: string; raw: string };

export type SendEnding =
  | { kind: "accepted" }
  // A coded refusal, such as E_RATE_LIMIT_EXCEEDED or E_RECIPIENT_SUPPRESSED.
  | { kind: "refused"; code: string }
  // A lost connection, with no telling whether it went.
  | { kind: "unclear" };

export function createFakeEmail() {
  const sent: SentEmail[] = [];
  const attempts: SentEmail[] = [];
  const endings: SendEnding[] = [];
  return {
    sent,
    attempts,
    // The next sends end these ways, in order. After that, every send is accepted.
    willEnd: (...next: SendEnding[]) => endings.push(...next),
    binding: {
      send: async (message: SentEmail) => {
        const copy = { from: message.from, to: message.to, raw: message.raw };
        attempts.push(copy);
        const ending = endings.shift() ?? { kind: "accepted" };
        if (ending.kind === "refused") {
          throw Object.assign(new Error(ending.code), { code: ending.code });
        }
        if (ending.kind === "unclear")
          throw new Error("Network connection lost");
        sent.push(copy);
        return { messageId: `${sent.length}@test` };
      },
    },
  };
}

export type ReadPart = { headers: Map<string, string>; body: string };

function headersOf(text: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of text.replace(/\r\n[ \t]/g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers.set(
        line.slice(0, colon).toLowerCase(),
        line.slice(colon + 1).trim(),
      );
    }
  }
  return headers;
}

const decodeWords = (value: string) =>
  value.replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/g, (_, encoded: string) =>
    new TextDecoder().decode(Uint8Array.fromBase64(encoded)),
  );

// Splits a raw message into its leaf parts, decoded, so a test reads what a mail app
// would show.
export function readEmail(raw: string): {
  headers: Map<string, string>;
  subject: string;
  parts: ReadPart[];
} {
  const split = raw.indexOf("\r\n\r\n");
  const headers = headersOf(raw.slice(0, split));
  const leaves = (head: Map<string, string>, body: string): ReadPart[] => {
    const type = head.get("content-type") ?? "";
    const boundary = /boundary="([^"]+)"/.exec(type)?.[1];
    if (!boundary) {
      const text =
        head.get("content-transfer-encoding") === "base64"
          ? new TextDecoder().decode(
              Uint8Array.fromBase64(body.replace(/\s+/g, "")),
            )
          : body;
      return [{ headers: head, body: text }];
    }
    return body
      .split(`--${boundary}`)
      .slice(1, -1)
      .flatMap((chunk) => {
        const part = chunk.replace(/^\r\n/, "");
        const end = part.indexOf("\r\n\r\n");
        return leaves(headersOf(part.slice(0, end)), part.slice(end + 4));
      });
  };
  return {
    headers,
    subject: decodeWords(headers.get("subject") ?? ""),
    parts: leaves(headers, raw.slice(split + 4)),
  };
}

export const partOfType = (
  email: ReturnType<typeof readEmail>,
  type: string,
) => {
  const part = email.parts.find((one) =>
    (one.headers.get("content-type") ?? "").startsWith(type),
  );
  if (!part) throw new Error(`expected a ${type} part`);
  return part;
};
