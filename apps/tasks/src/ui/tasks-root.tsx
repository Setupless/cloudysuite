import { ToastProvider } from "@cloudysuite/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { tasksQueryClient } from "../queries";

export function TasksRoot({ children }: { children: ReactNode }) {
  const [client] = useState(tasksQueryClient);
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
