// What a form shows next. A refusal the person can act on is a value with its
// message, so only an unexpected failure ever throws.
export type Outcome<Result = unknown> =
  ({ ok: true } & Result) | { ok: false; message: string };

export function refuse(message: string): { ok: false; message: string } {
  return { ok: false, message };
}
