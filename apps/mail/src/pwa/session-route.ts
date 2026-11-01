import { requireSignedInUser } from "@cloudysuite/auth/guard";

// The one question the service worker asks: who is signed in on this browser now. It
// answers with an id only, and nothing but a page on this host can read the answer.
export async function deviceSessionResponse(
  request: Request,
): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  try {
    const user = await requireSignedInUser(request);
    return Response.json({ userId: user.id }, { headers });
  } catch (thrown) {
    if (thrown instanceof Response) {
      return new Response(null, { status: thrown.status, headers });
    }
    throw thrown;
  }
}
