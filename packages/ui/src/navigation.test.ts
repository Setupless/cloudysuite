import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import {
  chosenParam,
  type PageChange,
  type PendingPage,
  pendingSkeleton,
  PROGRESS_DELAY_MS,
  SKELETON_DELAY_MS,
  watchPageChanges,
} from "./navigation";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Every loader and the session check wait while a test holds them.
function app(start = "/") {
  let gate: Promise<void> | undefined;
  const wait = () => gate;
  const root = createRootRoute();
  const signedIn = createRoute({
    getParentRoute: () => root,
    id: "signed-in",
    beforeLoad: wait,
  });
  const view = createRoute({
    getParentRoute: () => root,
    path: "/mail/$mailboxId/$view",
    loader: wait,
  });
  const calendar = createRoute({
    getParentRoute: () => root,
    path: "/calendar",
  });
  const routeTree = root.addChildren([
    createRoute({ getParentRoute: () => root, path: "/", loader: wait }),
    createRoute({
      getParentRoute: () => root,
      path: "/folder/$folderId",
      loader: wait,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/search",
      validateSearch: (search): { q?: string } =>
        typeof search.q === "string" ? { q: search.q } : {},
      loaderDeps: ({ search }) => ({ q: search.q }),
      loader: wait,
    }),
    calendar.addChildren([
      createRoute({ getParentRoute: () => calendar, path: "/", loader: wait }),
      createRoute({
        getParentRoute: () => calendar,
        path: "schedule",
        loader: wait,
      }),
    ]),
    signedIn.addChildren([
      createRoute({ getParentRoute: () => signedIn, path: "/account" }),
    ]),
    createRoute({
      getParentRoute: () => root,
      path: "/mail/device",
      loader: wait,
    }),
    view.addChildren([
      createRoute({ getParentRoute: () => view, path: "/", loader: wait }),
      createRoute({
        getParentRoute: () => view,
        path: "$threadId",
        loader: wait,
      }),
    ]),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [start] }),
    isServer: false,
    origin: "https://storage.example.org",
  });
  const watcher = watchPageChanges(router);
  const seen: PageChange[] = [];
  watcher.listen(() => seen.push(watcher.get()));
  return {
    router,
    seen,
    now: watcher.get,
    // Holds every loader until the returned function runs.
    hold: () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      gate = promise;
      return () => {
        gate = undefined;
        resolve();
      };
    },
  };
}

const shown = (seen: PageChange[]) => ({
  bar: seen.some((state) => state.progress === "slow"),
  skeleton: seen.some((state) => state.skeleton),
});

test("a page that opens quickly shows neither the bar nor a skeleton", async () => {
  const { router, seen, hold } = app();
  await router.load();
  const release = hold();
  setTimeout(release, PROGRESS_DELAY_MS - 60);
  await router.navigate({ href: "/folder/notes" });
  await sleep(SKELETON_DELAY_MS);
  expect(shown(seen)).toEqual({ bar: false, skeleton: false });
});

test("a slow page shows the bar, then its skeleton, over the page on screen until it opens", async () => {
  const { router, now, hold } = app();
  await router.load();
  const release = hold();
  const opening = router.navigate({ href: "/folder/notes" });

  await sleep(PROGRESS_DELAY_MS - 50);
  expect(now()).toMatchObject({ progress: "idle", skeleton: false });
  await sleep(150);
  expect(now()).toMatchObject({ progress: "slow", skeleton: false });
  await sleep(SKELETON_DELAY_MS - PROGRESS_DELAY_MS);
  expect(now()).toMatchObject({ progress: "slow", skeleton: true });
  const onScreen = () => String(router.state.matches.at(-1)?.routeId);
  expect(onScreen()).toBe("/");

  release();
  await opening;
  expect(now()).toMatchObject({ progress: "finishing", skeleton: false });
  expect(onScreen()).toBe("/folder/$folderId");
  await sleep(350);
  expect(now().progress).toBe("idle");
});

test("the skeleton doesn't wait for a slow session check", async () => {
  const { router, now, hold } = app();
  await router.load();
  const release = hold();
  const opening = router.navigate({ href: "/account" });
  await sleep(SKELETON_DELAY_MS + 50);
  expect(now().skeleton).toBe(true);
  release();
  await opening;
});

test("a new search on the same page shows the bar but no skeleton", async () => {
  const { router, seen, hold } = app("/search?q=plans");
  await router.load();
  const release = hold();
  const searching = router.navigate({ href: "/search?q=budget" });
  await sleep(SKELETON_DELAY_MS + 50);
  release();
  await searching;
  expect(shown(seen)).toEqual({ bar: true, skeleton: false });
});

test("reloading the page on screen shows nothing", async () => {
  const { router, seen, hold } = app("/folder/notes");
  await router.load();
  const release = hold();
  const reloading = router.invalidate({ forcePending: true });
  await sleep(SKELETON_DELAY_MS + 50);
  expect(router.state.status).toBe("pending");
  release();
  await reloading;
  expect(shown(seen)).toEqual({ bar: false, skeleton: false });
});

const List = () => null;
const Labels = () => null;
const MAIL: PendingPage[] = [
  { to: "/mail/$mailboxId/labels", skeleton: Labels },
  { to: "/mail/$mailboxId/$view", under: true, skeleton: List },
];

test("the skeleton is the page being opened, and a conversation opening keeps its list", async () => {
  const { router, hold } = app("/mail/m1/inbox/t0");
  await router.load();
  const skeletonFor = async (href: string) => {
    const release = hold();
    const opening = router.navigate({ href });
    await sleep(10);
    expect(router.state.status).toBe("pending");
    const skeleton = pendingSkeleton(router, MAIL);
    release();
    await opening;
    return skeleton;
  };
  expect(await skeletonFor("/mail/m1/inbox/t1")).toBeNull();
  expect(await skeletonFor("/mail/m1/inbox/t2")).toBeNull();
  expect(await skeletonFor("/mail/m1/inbox")).toBeNull();
  expect(await skeletonFor("/mail/m1/sent")).toBe(List);
  expect(await skeletonFor("/mail/m2/inbox")).toBe(List);
  expect(await skeletonFor("/mail/m2/labels")).toBe(Labels);
  expect(await skeletonFor("/mail/device")).toBeNull();
});

test("a page above the one being opened doesn't lend it its skeleton", async () => {
  const Folders = () => null;
  const Folder = () => null;
  const { router, hold } = app();
  await router.load();
  const release = hold();
  const opening = router.navigate({ href: "/folder/notes" });
  await sleep(10);
  expect(
    pendingSkeleton(router, [
      { to: "/folder", skeleton: Folders },
      { to: "/folder/$folderId", skeleton: Folder },
    ]),
  ).toBe(Folder);
  release();
  await opening;
});

test("an app's home page, whose address ends in a slash, has its skeleton", async () => {
  const Overview = () => null;
  const Schedule = () => null;
  const pages = [
    { to: "/calendar", skeleton: Overview },
    { to: "/calendar/schedule", skeleton: Schedule },
  ];
  const { router, hold } = app("/folder/notes");
  await router.load();
  let release = hold();
  // As the app's address rewrite leaves it, with the slash kept.
  router.history.push("/calendar/");
  let opening = router.load();
  await sleep(10);
  expect(router.state.location.pathname).toBe("/calendar/");
  expect(pendingSkeleton(router, pages)).toBe(Overview);
  release();
  await opening;
  release = hold();
  opening = router.navigate({ href: "/calendar/schedule" });
  await sleep(10);
  expect(pendingSkeleton(router, pages)).toBe(Schedule);
  release();
  await opening;
});

test("a sidebar mark follows the click, with the id written as it is", async () => {
  const { router, hold } = app();
  await router.load();
  const release = hold();
  const opening = router.navigate({ href: "/folder/caf%C3%A9%20notes" });
  await sleep(10);
  expect(chosenParam(router, "/folder/$folderId", "folderId")).toBe(
    "café notes",
  );
  release();
  await opening;
  expect(chosenParam(router, "/folder/$folderId", "folderId")).toBe(
    "café notes",
  );
  const leaving = hold();
  setTimeout(leaving, 10);
  await router.navigate({ href: "/mail/device" });
  expect(
    chosenParam(router, "/mail/$mailboxId/$view", "mailboxId"),
  ).toBeUndefined();
});
