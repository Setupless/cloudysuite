export type FramePalette = {
  scheme: "light" | "dark";
  page: string;
  text: string;
  link: string;
};

// The one CSP for every email frame. A `<meta>` is the only place a srcdoc frame
// can carry one, and it comes before any mail content, so mail cannot remove it.
export function emailFramePolicy(showRemoteImages: boolean): string {
  const images = showRemoteImages ? "data: https: http:" : "data:";
  return [
    "default-src 'none'",
    `img-src ${images}`,
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

// `<base target>` sets no URL, so `base-uri 'none'` allows it. The first one in a
// document wins, so a link the sanitizer missed still opens in a new tab. Nothing
// follows the mail: a closing tag here would finish a tag the mail left open.
export function emailFrameDocument(
  html: string,
  showRemoteImages: boolean,
  palette: FramePalette,
): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${emailFramePolicy(showRemoteImages)}"><meta name="referrer" content="no-referrer"><meta http-equiv="x-dns-prefetch-control" content="off"><base target="_blank"><style>:root{color-scheme:${palette.scheme}}html,body{margin:0;padding:0}body{background:${palette.page};color:${palette.text};font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}a{color:${palette.link}}img{max-width:100%;height:auto}pre{white-space:pre-wrap}@media (max-width:640px){table,td{width:auto!important;max-width:100%!important}}</style></head><body>${html}`;
}

// The measuring copy shares Mail's origin, and from there Chromium sends a Referer
// with every CSS load, whatever the `<meta>` or a Referrer-Policy header says. CSS
// images rarely change a message's height, so that copy goes without them. The
// sanitizer has already removed the escapes and comments that could hide these names.
export function emailMeasuringDocument(
  html: string,
  showRemoteImages: boolean,
  palette: FramePalette,
): string {
  return emailFrameDocument(
    html.replace(/(?:-[a-z]+-)?image-set\(|\burl\(/gi, "none("),
    showRemoteImages,
    palette,
  );
}
