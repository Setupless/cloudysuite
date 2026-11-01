import { env } from "cloudflare:workers";
import { readSettings } from "../../../src/settings";
import { createAuth } from "./auth";
import { appOrigins } from "./origins";

export async function getAuth(request: Request) {
  const settings = await readSettings(env.DB);
  const { primaryDomain } = settings;
  // The hostname router sends every request to /setup until a domain is stored.
  if (primaryDomain === null) throw new Error("No primary domain is stored.");
  // The wizard sets this secret, so it can be missing despite its generated type.
  if (!env.BETTER_AUTH_SECRET)
    throw new Error("BETTER_AUTH_SECRET is not set.");

  const origins = appOrigins(primaryDomain, request);
  const auth = createAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    primaryDomain,
    origins,
  });
  return { auth, origins, settings };
}
