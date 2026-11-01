import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { acceptInvite as acceptInviteRow, readInvite } from "../admin/invites";
import { readText } from "../admin/input";
import { completeReset, readResetLink, type ResetView } from "../admin/reset";
import type { Outcome } from "../outcome";
import type { InviteView } from "./invite-view";
import { getAuth } from "../server";

// These run with no session. Holding the token is the proof.

export const getInvite = createServerFn({ method: "GET" })
  .validator((input: { token: string }) => ({
    token: readText(input, "token"),
  }))
  .handler(({ data }): Promise<InviteView> => readInvite(env.DB, data.token));

export const acceptInvite = createServerFn({ method: "POST" })
  .validator((input: { token: string; name: string; password: string }) => ({
    token: readText(input, "token"),
    name: readText(input, "name"),
    password: readText(input, "password"),
  }))
  .handler(async ({ data }): Promise<Outcome<{ signInEmail: string }>> => {
    const { auth } = await getAuth(getRequest());
    return acceptInviteRow(auth, env.DB, data);
  });

export const getResetLink = createServerFn({ method: "GET" })
  .validator((input: { token: string }) => ({
    token: readText(input, "token"),
  }))
  .handler(({ data }): Promise<ResetView> => readResetLink(env.DB, data.token));

export const finishReset = createServerFn({ method: "POST" })
  .validator((input: { token: string; password: string }) => ({
    token: readText(input, "token"),
    password: readText(input, "password"),
  }))
  .handler(async ({ data }): Promise<Outcome<{ email: string }>> => {
    const { auth } = await getAuth(getRequest());
    return completeReset(auth, env.DB, data);
  });
