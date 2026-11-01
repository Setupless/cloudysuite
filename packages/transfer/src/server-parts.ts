export type Refused = { ok: false; status: number; message: string };
export type Accepted<Value> = { ok: true; value: Value };
export type Outcome<Value> = Accepted<Value> | Refused;

export const refuse = (status: number, message: string): Refused => ({
  ok: false,
  status,
  message,
});

// R2 ends an error's message with its code, and 10024 means the multipart upload no
// longer exists. An upload that was finished, aborted, or expired by R2 all look alike.
export const isUploadGone = (error: unknown) =>
  String(error).includes("(10024)");

export type PartBody = {
  // From the request's headers, so a wrong size is refused before it is read.
  declaredBytes: number | null;
  // Null when the body is longer than the limit.
  read: (limit: number) => Promise<ArrayBuffer | null>;
};

export function declaredBytes(request: Request): number | null {
  const header = request.headers.get("Content-Length");
  return header !== null && /^\d{1,12}$/.test(header) ? Number(header) : null;
}

// Stops at the first byte past the limit, so a client that declares one size and
// sends another cannot make the Worker hold more than a part.
export async function readUpTo(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<ArrayBuffer | null> {
  const bytes = new Uint8Array(limit);
  let length = 0;
  if (body) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  }
  return length === limit ? bytes.buffer : bytes.buffer.slice(0, length);
}

// A refusal sent while the browser is still sending a 10 MB part reaches it as a
// dropped connection, and the person sees "check your connection" instead of the
// reason. Reading to the end costs little, because nothing keeps the bytes and the
// platform caps a request's size.
export async function drain(request: Request): Promise<void> {
  if (request.body && !request.bodyUsed) {
    await request.body.pipeTo(new WritableStream());
  }
}
