import { GoToOffPage } from "@cloudysuite/ui";
import {
  ErrorComponent,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { isAppOffRefusal } from "../../../../src/routing";

export function CalendarRouteError({ error }: ErrorComponentProps) {
  if (isAppOffRefusal(error, "calendar")) return <GoToOffPage />;
  return <ErrorComponent error={error} />;
}
