import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

// Other sites on the same parent domain are same-site, so the session cookie
// alone does not stop them calling a server function.
const sameOriginOnly = createCsrfMiddleware({
  filter: (context) => context.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [sameOriginOnly],
}));
