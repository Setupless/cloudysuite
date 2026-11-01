import { ingest } from "@cloudysuite/mail/ingest";
import handler from "@tanstack/react-start/server-entry";
import { gate, resolveHost } from "./routing";
import { readSettings } from "./settings";

export { Mailbox } from "@cloudysuite/mail/mailbox";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const settings = await readSettings(env.DB);
    const decision = gate(resolveHost(url.hostname, settings), url.pathname);

    switch (decision.action) {
      case "pass":
        return handler.fetch(request);
      case "redirect":
        return new Response(null, {
          status: 302,
          headers: { Location: decision.to },
        });
      case "notFound":
        return new Response("There is nothing at this address.", {
          status: 404,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
    }
  },

  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    await ingest(env, { to: message.to, raw });
  },
} satisfies ExportedHandler<Env>;
