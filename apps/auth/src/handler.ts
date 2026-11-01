import { getAuth } from "./server";

export async function handleAuthRequest(request: Request): Promise<Response> {
  const { auth } = await getAuth(request);
  return auth.handler(request);
}
