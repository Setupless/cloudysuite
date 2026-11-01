import { appOrigins } from "@cloudysuite/auth/origins";

// The session cookie reaches every subdomain of the app domain, so a request from a
// sibling site carries it too. Only the page Mail itself serves may change an import,
// so the browser's Origin must be Mail's exact origin: scheme, host, and port.
export function isFromMailApp(
  request: Request,
  primaryDomain: string,
): boolean {
  return (
    request.headers.get("Origin") === appOrigins(primaryDomain, request).mail
  );
}
