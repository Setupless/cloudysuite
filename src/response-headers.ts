// Pages and server functions carry one person's mail, and the next person on a shared
// computer shares the browser's HTTP cache and its back button. A site on the same
// parent domain gets the session cookie, so a page it frames is signed in.
export function withResponseHeaders(response: Response): Response {
  const sent = new Response(response.body, response);
  if (!sent.headers.has("Cache-Control")) {
    sent.headers.set("Cache-Control", "no-store");
  }
  // Appended as its own policy, so a download's sandbox policy still holds.
  sent.headers.append("Content-Security-Policy", "frame-ancestors 'none'");
  sent.headers.set("X-Frame-Options", "DENY");
  return sent;
}
