import { createFileRoute } from "@tanstack/react-router";

// Renders nothing on the server, so the service worker can save this page and hold no
// one's mail. Opened at any Mail address, the client finds no server-rendered match and
// loads that address's routes itself.
export const Route = createFileRoute("/offline-shell")({
  ssr: false,
  component: () => null,
});
