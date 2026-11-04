import { useState } from "react";

const CANNOT_REACH =
  "We couldn't reach CloudySuite. Check your connection and try again.";

// Runs a form's actions one at a time. `pending` names the action that is
// running, so its control can spin while the others wait. An action returns a
// message when the person has something to fix, and nothing when it worked.
export function useAction<Key extends string = string>() {
  const [pending, setPending] = useState<Key | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: Key, action: () => Promise<string | null | void>) {
    setError(null);
    setPending(key);
    try {
      setError((await action()) ?? null);
    } catch {
      setError(CANNOT_REACH);
    } finally {
      setPending(null);
    }
  }

  return { pending, error, run };
}

export type Action<Key extends string> = ReturnType<typeof useAction<Key>>;

// Loads another page. The promise never settles, so an action that awaits it
// stays pending until the page is gone.
export function leave(href: string): Promise<never> {
  window.location.assign(href);
  return new Promise(() => {});
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
