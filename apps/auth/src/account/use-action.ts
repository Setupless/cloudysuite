import { useState } from "react";

const CANNOT_REACH =
  "We couldn't reach CloudySuite. Check your connection and try again.";

// Runs one form's action. It returns a message when the person has something
// to fix, and nothing when the action worked.
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<string | null | void>) {
    setError(null);
    setPending(true);
    try {
      setError((await action()) ?? null);
    } catch {
      setError(CANNOT_REACH);
    } finally {
      setPending(false);
    }
  }

  return { pending, error, run };
}

const TOO_MANY_TRIES = "That's too many tries. Wait a minute, then try again.";

// Refusals CloudySuite writes itself are safe and specific, so they show as they are.
const OWN_CODES = new Set(["LAST_SIGN_IN_METHOD", "PASSKEY_REQUIRED"]);

export function explainFailure(
  failure: { status: number; code?: string; message?: string },
  otherwise: string,
): string {
  if (failure.status === 429) return TOO_MANY_TRIES;
  if (failure.code && OWN_CODES.has(failure.code) && failure.message) {
    return failure.message;
  }
  return otherwise;
}
