// Runs after `vite build`. A service worker that lists a missing file fails its whole
// install, which a passing build would not reveal, and the page that sign-out passes
// through must link a stylesheet that exists.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CLIENT = "dist/client";
const errors = [];
const read = (path) => readFileSync(join(CLIENT, path), "utf8");
const exists = (path) => existsSync(join(CLIENT, path));

for (const file of [
  "sw.js",
  "device-cleared.html",
  "device-cleared.js",
  "manifest.webmanifest",
  "_headers",
]) {
  if (!exists(file)) errors.push(`${file}: the build did not write it`);
}

if (errors.length === 0) {
  const worker = read("sw.js");
  // The minifier may join the list into one string, so look for the names themselves.
  const listed = [...worker.matchAll(/\/(?:assets|icons)\/[\w.-]+/g)].map(
    (match) => match[0],
  );
  if (!listed.some((file) => file.endsWith(".css"))) {
    errors.push("sw.js: lists no stylesheet");
  }
  for (const file of new Set(listed)) {
    if (!exists(file)) errors.push(`sw.js: lists ${file}, which is missing`);
  }
  if (worker.includes("@@BUILD_VERSION@@")) {
    errors.push("sw.js: its version was never written in");
  }

  const links = [
    ...read("device-cleared.html").matchAll(/href="(\/assets\/[^"]+\.css)"/g),
  ].map((match) => match[1]);
  if (links.length === 0) {
    errors.push("device-cleared.html: links no stylesheet");
  }
  for (const href of links) {
    if (!exists(href)) errors.push(`device-cleared.html: ${href} is missing`);
  }

  const manifest = JSON.parse(read("manifest.webmanifest"));
  for (const icon of manifest.icons) {
    if (!exists(icon.src) || statSync(join(CLIENT, icon.src)).size === 0) {
      errors.push(`manifest.webmanifest: icon ${icon.src} is missing`);
    }
  }
  if (!/^#[0-9a-f]{6}$/i.test(manifest.theme_color)) {
    errors.push(
      "manifest.webmanifest: its theme colour was not read from the theme",
    );
  }

  const rules = new Map(
    read("_headers")
      .split(/\n(?=\S)/)
      .map((block) => [block.split("\n")[0].trim(), block]),
  );
  if (!rules.has("/assets/*")) {
    errors.push("_headers: does not cover /assets/*");
  }
  // Static files skip the Worker, so only _headers stops another site framing them.
  for (const file of readdirSync(CLIENT).filter((f) => f.endsWith(".html"))) {
    const rule = rules.get(`/${file.replace(/\.html$/, "")}`) ?? "";
    if (
      !rule.includes("frame-ancestors 'none'") ||
      !rule.includes("X-Frame-Options: DENY")
    ) {
      errors.push(`_headers: ${file} can be framed by another site`);
    }
  }
  // _headers tells browsers to keep /assets for a year, so a file there without a
  // content hash in its name would never update.
  for (const file of readdirSync(join(CLIENT, "assets"))) {
    if (!/-[\w-]{8}\.\w+$/.test(file)) {
      errors.push(`assets/${file}: its name has no content hash`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  console.error(`\nApp build check failed with ${errors.length} problem(s).`);
  process.exit(1);
}
console.log("App build check passed.");
