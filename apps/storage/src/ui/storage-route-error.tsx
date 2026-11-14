import { SignInCheck } from "@cloudysuite/auth/sign-in-check";
import { GoToOffPage } from "@cloudysuite/ui";
import {
  ErrorComponent,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { isAppOffRefusal } from "../../../../src/routing";

export function StorageRouteError({ error }: ErrorComponentProps) {
  if (isAppOffRefusal(error, "storage")) return <GoToOffPage />;
  return (
    <SignInCheck error={error}>
      <ErrorComponent error={error} />
    </SignInCheck>
  );
}
