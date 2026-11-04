import { createFileRoute, redirect } from "@tanstack/react-router";

// Only routing. Each admin server function checks the role on the server.
export const Route = createFileRoute("/auth/_shell/admin")({
  beforeLoad: ({ context }) => {
    if (context.user.role !== "admin") throw redirect({ href: "/" });
  },
});
