import { GoToOffPage } from "@cloudysuite/ui";
import {
  ErrorComponent,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { isAppOffRefusal } from "../../../../src/routing";

export function TasksRouteError({ error }: ErrorComponentProps) {
  if (isAppOffRefusal(error, "tasks")) return <GoToOffPage />;
  return <ErrorComponent error={error} />;
}
