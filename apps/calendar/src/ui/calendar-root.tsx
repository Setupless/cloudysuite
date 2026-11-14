import { ToastProvider } from "@cloudysuite/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { calendarQueryClient } from "../queries";

export function CalendarRoot({ children }: { children: ReactNode }) {
  const [client] = useState(calendarQueryClient);
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
