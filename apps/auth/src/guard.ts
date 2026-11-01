import { env } from "cloudflare:workers";
import { readViewer, type SessionUser } from "./auth";
import { getAuth } from "./server";

function refusal(status: 401 | 403, message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readRefusingSignedOut(request: Request) {
  const { auth } = await getAuth(request);
  const viewer = await readViewer(auth, env.DB, request.headers);
  if (viewer.status === "signed-out") throw refusal(401, "Sign in first.");
  return viewer;
}

// The enrol page's own calls, which must keep working while the 2FA rule blocks
// everything else.
export async function requireSignedInUser(
  request: Request,
): Promise<SessionUser> {
  return (await readRefusingSignedOut(request)).user;
}

// For a server function such as Mail's. A mailbox access check says who may
// open a mailbox, and this applies the organisation's sign-in rule. Call both.
export async function requireReadyUser(request: Request): Promise<SessionUser> {
  const viewer = await readRefusingSignedOut(request);
  if (viewer.status === "must-enrol") {
    throw refusal(
      403,
      "Your organisation requires a passkey or an authenticator app. Add one first.",
    );
  }
  return viewer.user;
}

export async function requireAdminUser(request: Request): Promise<SessionUser> {
  const user = await requireReadyUser(request);
  if (user.role !== "admin") throw refusal(403, "Only an admin can do this.");
  return user;
}
