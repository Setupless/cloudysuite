import { ToastProvider } from "@cloudysuite/ui";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { retryUnlessRefused, TasksFailure } from "../queries";

// An expired session surfaces here first. The reload reaches the route's sign-in check,
// which sends the person to sign in and back again.
function reloadIfSignedOut(error: Error) {
  if (error instanceof TasksFailure && error.status === 401) {
    window.location.reload();
  }
}

function createTasksQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({ onError: reloadIfSignedOut }),
    mutationCache: new MutationCache({ onError: reloadIfSignedOut }),
    defaultOptions: {
      mutations: { networkMode: "always" },
      queries: {
        networkMode: "always",
        // Only long enough that the first HTML's data isn't fetched again as the page
        // wakes up.
        staleTime: 2_000,
        retry: retryUnlessRefused,
        refetchOnWindowFocus: true,
      },
    },
  });
}

export function TasksRoot({ children }: { children: ReactNode }) {
  // One client per render root: on the server a shared one would leak one person's
  // tasks into the next person's page.
  const [client] = useState(createTasksQueryClient);
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
