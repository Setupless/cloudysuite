import { SetupWizard } from "@cloudysuite/auth/setup";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/setup")({ component: SetupWizard });
