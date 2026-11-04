// Route files import their loaders, guards and head from here, not from the package
// root, so the code every host loads at start does not pull in all of Mail's screens.
// Chromium offers to install the app once, soon after load, so the listener in
// install.ts must load with the routes rather than with the device page.
import "./pwa/install";

export { mailHead } from "./pwa/head";
export {
  prefetchMailboxes,
  prefetchRules,
  prefetchSenders,
  prefetchThreads,
} from "./queries";
export { redirectToFirstMailbox } from "./redirect";
export { requireMailUser } from "./ui/session";
