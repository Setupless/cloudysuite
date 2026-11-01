import { createContext, useContext } from "react";
import type { UploadQueue } from "./upload-queue";

export const UploadsContext = createContext<UploadQueue | null>(null);

export function useUploads(): UploadQueue {
  const queue = useContext(UploadsContext);
  if (!queue) throw new Error("useUploads needs StorageRoot above it.");
  return queue;
}
