import { receiveInbound } from "@cloudysuite/mail/ingest";
import { drain } from "@cloudysuite/transfer";
import { X_TSS_RAW_RESPONSE } from "@tanstack/react-start";
import handler from "@tanstack/react-start/server-entry";
import { appOffRefusal } from "./app-on";
import { withResponseHeaders } from "./response-headers";
import { gate, isLocalHost, resolveHost, type ToggleableApp } from "./routing";
import { settingsFor } from "./settings";

export { Mailbox } from "@cloudysuite/mail/mailbox";
export { Drive } from "@cloudysuite/storage/drive";

async function refuseWhileOff(request: Request, app: ToggleableApp) {
  await drain(request);
  const refusal = appOffRefusal(app);
  // Without this, a server function's caller would take the refusal as its result.
  refusal.headers.set(X_TSS_RAW_RESPONSE, "thrown");
  return refusal;
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const settings = await settingsFor(request, env.DB);
  const decision = gate(resolveHost(url.hostname, settings), request);

  switch (decision.action) {
    case "pass":
      return handler.fetch(request);
    case "redirect":
      return new Response(null, {
        status: 302,
        headers: { Location: decision.to },
      });
    case "refuse":
      return refuseWhileOff(request, decision.app);
    case "notFound":
      return new Response("There is nothing at this address.", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
      url.protocol = "https:";
      // The apps serve https on the default port only, as appOrigins assumes.
      url.port = "";
      // 308, so a form posted over http is resent as a POST and not turned into a GET.
      return new Response(null, {
        status: 308,
        headers: { Location: url.href },
      });
    }
    return withResponseHeaders(await route(request, env), url);
  },

  async email(message, env) {
    await receiveInbound(message, env);
  },
} satisfies ExportedHandler<Env>;
