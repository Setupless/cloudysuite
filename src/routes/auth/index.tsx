import { AuthHome } from "@cloudysuite/auth";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/")({ component: AuthHome });
