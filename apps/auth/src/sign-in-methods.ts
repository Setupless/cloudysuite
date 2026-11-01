export type SignInMethods = {
  passkeys: number;
  password: boolean;
  authenticator: boolean;
};

export type Removal = "passkey" | "authenticator";

// An authenticator code only ever accompanies a password, so it is a second
// factor and not a way in by itself. A passkey is both.
export function isEnrolled(methods: SignInMethods): boolean {
  return methods.passkeys > 0 || methods.authenticator;
}

const AFTER_REMOVAL: Record<Removal, (m: SignInMethods) => SignInMethods> = {
  passkey: (m) => ({ ...m, passkeys: m.passkeys - 1 }),
  authenticator: (m) => ({ ...m, authenticator: false }),
};

export function removalRefusal(
  methods: SignInMethods,
  removal: Removal,
  require2fa: boolean,
): string | null {
  const after = AFTER_REMOVAL[removal](methods);
  if (after.passkeys < 1 && !after.password) {
    return "This is your only way to sign in, so it can't be removed. Add another passkey first.";
  }
  if (require2fa && !isEnrolled(after)) {
    return "Your organisation requires a passkey or an authenticator app, so this can't be removed. Add another one first.";
  }
  return null;
}
