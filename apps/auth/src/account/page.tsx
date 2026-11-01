import { Section } from "@cloudysuite/ui";
import { IconCheck, IconX } from "@tabler/icons-react";
import { AuthenticatorSection } from "./authenticator";
import type { AccountView } from "./functions";
import { PasskeysSection } from "./passkeys";
import { PasswordSection } from "./password";

function Way({ on, children }: { on: boolean; children: string }) {
  const Mark = on ? IconCheck : IconX;
  return (
    <li className="flex items-center gap-2 text-sm">
      <Mark
        size={18}
        stroke={2}
        className={on ? "text-success" : "text-secondary"}
        aria-hidden
      />
      {children}
    </li>
  );
}

export function AccountPage({
  person,
  account,
}: {
  person: { name: string; email: string };
  account: AccountView;
}) {
  const { passkeys, password, authenticator } = account.methods;
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold">{person.name}</h1>
        <p className="text-secondary">{person.email}</p>
      </header>
      <Section title="How you can sign in">
        <ul className="flex flex-col gap-1.5">
          <Way on={passkeys > 0}>
            {passkeys === 0
              ? "No passkeys"
              : passkeys === 1
                ? "1 passkey"
                : `${passkeys} passkeys`}
          </Way>
          <Way on={password}>
            {!password
              ? "No password"
              : authenticator
                ? "Password and a code from your authenticator app"
                : "Password"}
          </Way>
        </ul>
      </Section>
      <PasskeysSection account={account} />
      <AuthenticatorSection account={account} />
      <PasswordSection />
    </div>
  );
}
