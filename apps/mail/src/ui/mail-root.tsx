import { QueryClientProvider } from "@tanstack/react-query";
import type { SignedIn } from "@cloudysuite/auth/session";
import { type ReactNode, useEffect, useState } from "react";
import { KeptWithoutAccess } from "../compose/ui/kept-without-access";
import { startDevice } from "../pwa/device";
import { mailQueryClient } from "../queries";
import { ToastProvider } from "./toast";

export function MailRoot({
  user,
  children,
}: {
  user: SignedIn;
  children: ReactNode;
}) {
  const [client] = useState(mailQueryClient);
  useEffect(() => startDevice(user, client), [user, client]);
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        {children}
        <KeptWithoutAccess userId={user.id} />
      </ToastProvider>
    </QueryClientProvider>
  );
}
