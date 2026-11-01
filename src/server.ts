import { receiveInbound } from "@cloudysuite/mail/ingest";
import handler from "@tanstack/react-start/server-entry";
import { gate, resolveHost } from "./routing";
import { readSettings } from "./settings";

export { Mailbox } from "@cloudysuite/mail/mailbox";

// Pages and server functions carry one person's mail, and the next person on a shared
// computer shares the browser's HTTP cache and its back button.
function withoutStoring(response: Response): Response {
  if (response.headers.has("Cache-Control")) return response;
  const stored = new Response(response.body, response);
  stored.headers.set("Cache-Control", "no-store");
  return stored;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const settings = await readSettings(env.DB);
    const decision = gate(resolveHost(url.hostname, settings), url.pathname);

    switch (decision.action) {
      case "pass":
        return withoutStoring(await handler.fetch(request));
      case "redirect":
        return new Response(null, {
          status: 302,
          headers: { Location: decision.to, "Cache-Control": "no-store" },
        });
      case "notFound":
        return new Response("There is nothing at this address.", {
          status: 404,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
    }
  },

  async email(message, env) {
    await receiveInbound(message, env);
  },
} satisfies ExportedHandler<Env>;
