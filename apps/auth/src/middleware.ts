import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireAdminUser, requireSignedInUser } from "./guard";

export const signedInOnly = createMiddleware({ type: "function" }).server(
  async ({ next }) =>
    next({ context: { user: await requireSignedInUser(getRequest()) } }),
);

export const adminOnly = createMiddleware({ type: "function" }).server(
  async ({ next }) =>
    next({ context: { admin: await requireAdminUser(getRequest()) } }),
);
