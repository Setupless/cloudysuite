import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  emailFrameDocument,
  emailMeasuringDocument,
  type FramePalette,
} from "../email/frame-document";

const INITIAL_HEIGHT = 96;
// A hostile `height: 100000000px` stops here, and the frame scrolls on its own.
const MAX_HEIGHT = 30_000;
const SCROLLBAR_ALLOWANCE = 18;
const WIDTH_SETTLE_MS = 120;
const MEASURE_POLL_MS = 250;
const MEASURE_GIVE_UP_MS = 10_000;

function subscribeToColorScheme(onChange: () => void) {
  const query = matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => {
    query.removeEventListener("change", onChange);
    observer.disconnect();
  };
}

function readColorScheme(): "light" | "dark" {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === "light" || chosen === "dark") return chosen;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const useColorScheme = () =>
  useSyncExternalStore<"light" | "dark">(
    subscribeToColorScheme,
    readColorScheme,
    () => "light",
  );

// The sanitizer drops URLs on our own hosts, but a sender's server can redirect an
// image to one, and Chromium would send the session cookie with it. Other browsers
// ignore this attribute. TypeScript's React types do not have it yet.
const CREDENTIALLESS = { credentialless: true };

// Nothing can read a sandboxed, scriptless frame's height from outside, so a
// second copy measures it. That copy needs `allow-same-origin` for the parent to
// read its size, and nothing else: no script, the same CSP, no links to click,
// hidden, and gone once measured. The frame a person sees never has either flag.
function MeasuringFrame({
  srcDoc,
  width,
  onMeasure,
  onSettled,
}: {
  srcDoc: string;
  width: number;
  onMeasure: (height: number) => void;
  onSettled: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const read = () => {
    const root = frame.current?.contentDocument?.documentElement;
    if (!root) return;
    const overflowsSideways = root.scrollWidth > root.clientWidth;
    onMeasure(
      root.scrollHeight + (overflowsSideways ? SCROLLBAR_ALLOWANCE : 0),
    );
  };
  const latestRead = useRef(read);
  latestRead.current = read;
  const latestSettled = useRef(onSettled);
  latestSettled.current = onSettled;

  // A remote image can hold `load` back for a long time. Polling keeps the frame
  // close to the right size until then.
  useEffect(() => {
    const poll = setInterval(() => latestRead.current(), MEASURE_POLL_MS);
    const giveUp = setTimeout(
      () => latestSettled.current(),
      MEASURE_GIVE_UP_MS,
    );
    return () => {
      clearInterval(poll);
      clearTimeout(giveUp);
    };
  }, []);

  return (
    <iframe
      ref={frame}
      title="Measuring"
      aria-hidden
      inert
      tabIndex={-1}
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      {...CREDENTIALLESS}
      srcDoc={srcDoc}
      style={{ width }}
      className="pointer-events-none invisible absolute top-0 left-0 h-px border-0"
      onLoad={() => {
        read();
        onSettled();
      }}
    />
  );
}

export function EmailFrame({
  title,
  html,
  designed,
  showRemoteImages,
}: {
  title: string;
  html: string;
  designed: boolean;
  showRemoteImages: boolean;
}) {
  const scheme = useColorScheme();
  // Designed mail chose its colours for a light page, so it keeps one in dark mode.
  const frameScheme = designed ? "light" : scheme;
  const probe = useRef<HTMLSpanElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [palette, setPalette] = useState<FramePalette | null>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const [measuring, setMeasuring] = useState(true);

  useEffect(() => {
    if (!probe.current) return;
    const style = getComputedStyle(probe.current);
    setPalette({
      scheme: frameScheme,
      page: style.backgroundColor,
      text: style.color,
      link: style.borderTopColor,
    });
  }, [frameScheme, scheme]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    setWidth(element.clientWidth);
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setWidth(element.clientWidth), WIDTH_SETTLE_MS);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  const srcDoc = useMemo(
    () => palette && emailFrameDocument(html, showRemoteImages, palette),
    [html, showRemoteImages, palette],
  );

  const measuringDoc = useMemo(
    () => palette && emailMeasuringDocument(html, showRemoteImages, palette),
    [html, showRemoteImages, palette],
  );

  useEffect(() => setMeasuring(true), [srcDoc, width]);

  const onPaper = designed && scheme === "dark";
  return (
    <div className={onPaper ? "rounded bg-mail-paper p-3" : ""}>
      <span
        ref={probe}
        hidden
        className={
          designed
            ? "border-mail-link bg-mail-paper text-mail-ink"
            : "border-accent bg-panel text-text"
        }
      />
      <div ref={container} className="relative overflow-hidden">
        {srcDoc && (
          <iframe
            title={title}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            srcDoc={srcDoc}
            height={Math.min(height, MAX_HEIGHT)}
            className="block w-full border-0"
          />
        )}
        {measuringDoc && width > 0 && measuring && (
          <MeasuringFrame
            key={`${width}:${measuringDoc.length}:${showRemoteImages}:${frameScheme}`}
            srcDoc={measuringDoc}
            width={width}
            onMeasure={setHeight}
            onSettled={() => setMeasuring(false)}
          />
        )}
      </div>
    </div>
  );
}
