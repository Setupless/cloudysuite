import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { MailFailure, retryUnlessRefused } from "../queries";
import { ToastProvider } from "./toast";

// An expired session surfaces here first. The reload reaches the route's sign-in
// check, which sends the person to sign in and back again.
function reloadIfSignedOut(error: Error) {
  if (error instanceof MailFailure && error.status === 401) {
    window.location.reload();
  }
}

function createMailQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({ onError: reloadIfSignedOut }),
    mutationCache: new MutationCache({ onError: reloadIfSignedOut }),
    defaultOptions: {
      queries: {
        staleTime: 20_000,
        retry: retryUnlessRefused,
        refetchOnWindowFocus: true,
      },
    },
  });
}

export function MailRoot({ children }: { children: ReactNode }) {
  // One client per render root: on the server a shared one would leak one
  // person's mail into the next person's page.
  const [client] = useState(createMailQueryClient);
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
