import { MailHome } from "@cloudysuite/mail";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/mail/")({ component: MailHome });
