import { ToastProvider } from "@cloudysuite/ui";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { ensureMyFiles } from "../functions";
import {
  call,
  retryUnlessRefused,
  StorageFailure,
  storageKeys,
} from "../queries";
import { sendFile } from "./upload-client";
import { UploadQueue } from "./upload-queue";
import { UploadsContext } from "./uploads-context";

// An expired session surfaces here first. The reload reaches the route's sign-in check,
// which sends the person to sign in and back again.
function reloadIfSignedOut(error: Error) {
  if (error instanceof StorageFailure && error.status === 401) {
    window.location.reload();
  }
}

function createStorageQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({ onError: reloadIfSignedOut }),
    mutationCache: new MutationCache({ onError: reloadIfSignedOut }),
    defaultOptions: {
      mutations: { networkMode: "always" },
      queries: {
        networkMode: "always",
        // Only long enough that the first HTML's files aren't fetched again as the page
        // wakes up. Opening a folder after that asks the server.
        staleTime: 2_000,
        retry: retryUnlessRefused,
        refetchOnWindowFocus: true,
      },
    },
  });
}

export function StorageRoot({ children }: { children: ReactNode }) {
  // One client per render root: on the server a shared one would leak one person's
  // files into the next person's page.
  const [client] = useState(createStorageQueryClient);
  const [queue] = useState(
    () =>
      new UploadQueue({
        ensureMyFiles: () => call(() => ensureMyFiles()),
        sendFile,
        onFileSent: () => {
          void client.invalidateQueries({ queryKey: storageKeys.all });
        },
      }),
  );

  // A reload stops a running upload. It can resume, but only if the person picks the
  // file again, so they should know before leaving.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (queue.isBusy()) event.preventDefault();
    };
    // A file dropped just outside a drop zone would otherwise replace this page.
    const keepPage = (event: DragEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    window.addEventListener("dragover", keepPage);
    window.addEventListener("drop", keepPage);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("dragover", keepPage);
      window.removeEventListener("drop", keepPage);
    };
  }, [queue]);

  return (
    <QueryClientProvider client={client}>
      <UploadsContext.Provider value={queue}>
        <ToastProvider>{children}</ToastProvider>
      </UploadsContext.Provider>
    </QueryClientProvider>
  );
}
