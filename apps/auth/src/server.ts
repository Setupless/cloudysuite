import { env } from "cloudflare:workers";
import { settingsFor } from "../../../src/settings";
import { createAuth, readViewer, type Viewer } from "./auth";
import { appOrigins } from "./origins";

export async function getAuth(request: Request) {
  const settings = await settingsFor(request, env.DB);
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

// A page's first HTML runs every loader's server function inside its one request,
// and each one would otherwise read the session again.
const viewers = new WeakMap<Request, Promise<Viewer>>();

export function getViewer(request: Request): Promise<Viewer> {
  let viewer = viewers.get(request);
  if (!viewer) {
    viewer = getAuth(request).then(({ auth, settings }) =>
      readViewer(auth, env.DB, request.headers, settings),
    );
    viewers.set(request, viewer);
  }
  return viewer;
}
