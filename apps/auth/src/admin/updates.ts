const LATEST_RELEASE =
  "https://api.github.com/repos/Setupless/cloudysuite/releases/latest";
const CACHE_MS = 60 * 60 * 1000;

// Bumped with each release tag. A deployment is a copy of one commit, so this
// is the version it runs.
export const RUNNING_VERSION = "0.1.0";

export const UPDATE_STEPS_URL =
  "https://github.com/Setupless/cloudysuite#updates";

export type UpdateNotice =
  { kind: "available"; latest: string; releaseUrl: string } | { kind: "none" };

function parseVersion(raw: string): [number, number, number] | null {
  const match = raw.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewer(candidate: string, running: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(running);
  if (!a || !b) return false;
  for (const i of [0, 1, 2] as const) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

async function fetchNotice(
  running: string,
  fetcher: Fetcher,
): Promise<UpdateNotice> {
  try {
    const response = await fetcher(LATEST_RELEASE, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "CloudySuite",
      },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return { kind: "none" };
    const { tag_name: tag, html_url: releaseUrl } = (await response.json()) as {
      tag_name?: unknown;
      html_url?: unknown;
    };
    if (
      typeof tag !== "string" ||
      typeof releaseUrl !== "string" ||
      !releaseUrl.startsWith("https://github.com/") ||
      !isNewer(tag, running)
    ) {
      return { kind: "none" };
    }
    return { kind: "available", latest: tag.replace(/^v/, ""), releaseUrl };
  } catch {
    return { kind: "none" };
  }
}

export function createUpdateChecker(
  running: string,
  fetcher: Fetcher,
  clock: () => number = Date.now,
) {
  let cached: { at: number; notice: UpdateNotice } | null = null;
  return async (): Promise<UpdateNotice> => {
    if (cached && clock() - cached.at < CACHE_MS) return cached.notice;
    const notice = await fetchNotice(running, fetcher);
    cached = { at: clock(), notice };
    return notice;
  };
}
