// Route files import their loaders and guards from here, not from the package root,
// so the code every host loads at start does not pull in all of Storage's screens.
export {
  prefetchDirectory,
  prefetchFile,
  prefetchFolder,
  prefetchHome,
  prefetchRecent,
  prefetchSearch,
  prefetchShared,
  prefetchStarred,
  prefetchTrash,
} from "./queries";
export { redirectToMyDrive } from "./redirect";
