import { ToastProvider } from "@cloudysuite/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { ensureMyFiles } from "../functions";
import { call, refreshStorage, storageQueryClient } from "../queries";
import { sendFile } from "./upload-client";
import { UploadQueue } from "./upload-queue";
import { UploadsContext } from "./uploads-context";

export function StorageRoot({ children }: { children: ReactNode }) {
  const [client] = useState(storageQueryClient);
  const [queue] = useState(
    () =>
      new UploadQueue({
        ensureMyFiles: () => call(() => ensureMyFiles()),
        sendFile,
        onFileSent: () => {
          void refreshStorage(client);
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
