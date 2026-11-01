import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { SignedIn } from "@cloudysuite/auth/session";
import { type ReactNode, useEffect, useState } from "react";
import { isPageHidden } from "../pwa/connectivity";
import { clearDevice, startDevice } from "../pwa/device";
import { MailFailure, retryUnlessRefused } from "../queries";
import { ToastProvider } from "./toast";

// An expired session surfaces here first. What was saved for this person goes first,
// because the next person to use this browser may be someone else. The reload reaches
// the route's sign-in check, which sends the person to sign in and back again.
function reloadIfSignedOut(error: Error) {
  if (error instanceof MailFailure && error.status === 401) {
    void clearDevice().finally(() => window.location.reload());
  }
}

function createMailQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({ onError: reloadIfSignedOut }),
    mutationCache: new MutationCache({ onError: reloadIfSignedOut }),
    defaultOptions: {
      // Offline, a read goes to this device's saved mail and an action is refused
      // out loud. Query's default would quietly pause both, and run the actions later.
      mutations: { networkMode: "always" },
      queries: {
        networkMode: "always",
        staleTime: 20_000,
        retry: retryUnlessRefused,
        refetchOnWindowFocus: true,
        // Query only stops its timed refresh while hidden. A request from a tab nobody
        // is looking at would renew the session, so reconnecting waits for their return.
        refetchOnReconnect: () => !isPageHidden(),
      },
    },
  });
}

export function MailRoot({
  user,
  children,
}: {
  user: SignedIn;
  children: ReactNode;
}) {
  // One client per render root: on the server a shared one would leak one
  // person's mail into the next person's page.
  const [client] = useState(createMailQueryClient);
  useEffect(() => startDevice(user, client), [user, client]);
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
