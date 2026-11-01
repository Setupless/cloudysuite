import { SignOut } from "@cloudysuite/auth";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/sign-out")({ component: SignOut });
