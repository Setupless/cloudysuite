import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build, type Plugin } from "vite";
import { APPLE_ICON, APP_ICONS, appManifest } from "./manifest";

const HERE = import.meta.dirname;
const THEME = resolve(HERE, "../../../../src/styles/theme.css");
const VERSION_MARK = "@@BUILD_VERSION@@";

async function bundleScript(
  entry: string,
  define: Record<string, string>,
): Promise<string> {
  const output = await build({
    configFile: false,
    logLevel: "warn",
    define,
    build: {
      write: false,
      minify: true,
      lib: {
        entry,
        formats: ["iife"],
        name: "script",
        fileName: () => "out.js",
      },
    },
  });
  const { output: chunks } = (Array.isArray(output) ? output[0] : output) as {
    output: { code: string }[];
  };
  const chunk = chunks[0];
  if (!chunk) throw new Error(`Could not build ${entry}.`);
  return chunk.code;
}

// The service worker has to list this build's exact file names and change whenever they
// do, because a byte-identical sw.js is how a browser decides there is nothing new. So
// it is written here, once those names exist. It is served as a plain file, so an update
// reaches browsers even while Mail is turned off, and this is what keeps a page from
// depending on a Worker route to fix a bad service worker.
export function mailPwa(): Plugin {
  return {
    name: "cloudysuite:mail-pwa",
    apply: "build",
    enforce: "post",
    applyToEnvironment: (environment) => environment.name === "client",
    async generateBundle(_, bundle) {
      const assets = Object.keys(bundle)
        .filter((name) => name.startsWith("assets/") && !name.endsWith(".map"))
        .sort()
        .map((name) => `/${name}`);
      const stylesheets = assets.filter((name) => name.endsWith(".css"));
      if (stylesheets.length === 0) {
        throw new Error("The build has no stylesheet for the service worker.");
      }

      const manifest = JSON.stringify(
        appManifest(readFileSync(THEME, "utf8")),
        null,
        2,
      );
      const clearedPage = readFileSync(
        resolve(HERE, "device-cleared.html"),
        "utf8",
      ).replace(
        "<!--stylesheets-->",
        stylesheets
          .map((href) => `<link rel="stylesheet" href="${href}" />`)
          .join("\n    "),
      );
      const publicFiles = [
        "/manifest.webmanifest",
        "/device-cleared",
        "/device-cleared.js",
        APPLE_ICON,
        ...APP_ICONS.map((icon) => icon.path),
      ];

      const [worker, cleared] = await Promise.all([
        bundleScript(resolve(HERE, "service-worker.ts"), {
          __BUILD_VERSION__: JSON.stringify(VERSION_MARK),
          __BUILD_ASSETS__: JSON.stringify(assets),
          __PUBLIC_FILES__: JSON.stringify(publicFiles),
        }),
        bundleScript(resolve(HERE, "device-cleared.ts"), {}),
      ]);
      const version = createHash("sha256")
        .update(worker)
        .update(cleared)
        .update(clearedPage)
        .update(manifest)
        .digest("hex")
        .slice(0, 16);

      for (const [fileName, source] of [
        ["sw.js", worker.replaceAll(VERSION_MARK, version)],
        ["device-cleared.js", cleared],
        ["device-cleared.html", clearedPage],
        ["manifest.webmanifest", manifest],
      ] as const) {
        this.emitFile({ type: "asset", fileName, source });
      }
    },
  };
}
