import { afterEach, expect, test } from "bun:test";
import { fingerprintOf, sendParts, UploadRefused } from "./send-parts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the same bytes modified at another time are a different file", async () => {
  const bytes = new Uint8Array(4096);
  const first = await fingerprintOf(
    new File([bytes], "disk.img", { lastModified: 1000 }),
  );
  const again = await fingerprintOf(
    new File([bytes], "disk.img", { lastModified: 1000 }),
  );
  const edited = await fingerprintOf(
    new File([bytes], "disk.img", { lastModified: 2000 }),
  );
  expect(again).toBe(first);
  expect(edited).not.toBe(first);
});

test("a file that can no longer be read stops, rather than waiting forever", async () => {
  const file = new File([new Uint8Array(10)], "gone.bin");
  const unreadable = new Blob([new Uint8Array(10)]);
  unreadable.slice = () =>
    ({ arrayBuffer: () => Promise.reject(new Error("NotReadable")) }) as Blob;
  file.slice = () => unreadable;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;

  const sending = sendParts({
    file,
    storedParts: [],
    partPath: () => "/part",
    maxTries: Number.POSITIVE_INFINITY,
    signal: new AbortController().signal,
    onProgress: () => {},
  });
  await expect(sending).rejects.toBeInstanceOf(UploadRefused);
  expect(attempts).toBe(1);
});
