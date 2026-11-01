import { env } from "cloudflare:workers";
import { cloudflareApiBase } from "./cloudflare";
import { handleSetupRequest } from "./handler";

export function handleSetupRoute(request: Request): Promise<Response> {
  const { CLOUDYSUITE_LOCAL_CLOUDFLARE_API: override } = env as {
    CLOUDYSUITE_LOCAL_CLOUDFLARE_API?: string;
  };
  return handleSetupRequest(request, {
    database: env.DB,
    versionId: env.CF_VERSION_METADATA.id,
    // The wizard sets this secret, so it can be missing despite its generated type.
    secret: env.BETTER_AUTH_SECRET || undefined,
    apiBase: cloudflareApiBase(override),
    fetch: (input, init) => fetch(input, init),
  });
}
