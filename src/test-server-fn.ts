// bunfig.toml preloads this file, so every test run replaces `createServerFn` before any
// test file loads a module that builds a server function. Bun shares one module registry
// across files, so a file that built the real ones first would leave every later file
// with server functions that need Vite's request context.
import { afterAll, mock } from "bun:test";
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
  handler: (run: Handler) => async () => run({}),
});

const noRequest = (): Request => {
  throw new Error(
    "No request for this server function to read. Call readRequestFrom(() => request) in the test file.",
  );
};

let currentRequest = noRequest;

mock.module("@tanstack/react-start", () => ({ ...start, createServerFn }));
mock.module("@tanstack/react-start/server", () => ({
  ...startServer,
  getRequest: () => currentRequest(),
}));

// `request` is the one the server functions read their cookies from.
// Call this at the top level of a test file. Files share this module in one run, so the
// request is dropped when the file that set it ends, and a later file that forgets to set
// its own fails instead of reading this file's cookies. Inside a describe the request is
// dropped when that describe ends, and inside a hook it is dropped at once.
export function readRequestFrom(request: () => Request) {
  currentRequest = request;
  afterAll(() => {
    currentRequest = noRequest;
  });
}
