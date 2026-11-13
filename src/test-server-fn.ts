import { mock } from "bun:test";
import * as start from "@tanstack/react-start";
import * as startServer from "@tanstack/react-start/server";

type Handler = (context: { data?: unknown }) => unknown;

// Outside Vite a server function never reaches its handler, so this runs the validator
// and handler as the compiled server function would.
const createServerFn = () => ({
  validator: (parse: (raw: unknown) => unknown) => ({
    handler:
      (run: Handler) =>
      async ({ data }: { data: unknown }) =>
        run({ data: parse(data) }),
  }),
  handler: (run: Handler) => () => run({}),
});

// Call before importing a module that builds server functions. `request` is the one
// the server function reads its cookies from.
export function runServerFunctions(request: () => Request) {
  mock.module("@tanstack/react-start", () => ({ ...start, createServerFn }));
  mock.module("@tanstack/react-start/server", () => ({
    ...startServer,
    getRequest: request,
  }));
}
