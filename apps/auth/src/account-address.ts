import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { readSettings } from "../../../src/settings";
import { appOrigins } from "./origins";

// For a page with nobody signed in. The domain comes from stored settings, and the
// hostname router only lets a page run once one is stored.
export const readAccountAddress = createServerFn({ method: "GET" }).handler(
  async (): Promise<string> => {
    const { primaryDomain } = await readSettings(env.DB);
    if (primaryDomain === null) throw new Error("No primary domain is stored.");
    return `${appOrigins(primaryDomain, getRequest()).auth}/`;
  },
);
