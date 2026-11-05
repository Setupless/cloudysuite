import type { UserId } from "@cloudysuite/access";
import { createContext, type ReactNode, use } from "react";

const Me = createContext<UserId | null>(null);

// The signed-in person, so a screen can say "you" and keep what's theirs apart.
export function MeProvider({
  id,
  children,
}: {
  id: UserId;
  children: ReactNode;
}) {
  return <Me value={id}>{children}</Me>;
}

export function useMe(): UserId {
  const id = use(Me);
  if (!id) throw new Error("useMe() needs a MeProvider above it.");
  return id;
}
