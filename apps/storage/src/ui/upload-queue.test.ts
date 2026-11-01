import { expect, test } from "bun:test";
import type { DriveId } from "@cloudysuite/access";
import { UploadRefused } from "@cloudysuite/transfer";
import {
  batchProgress,
  type Destination,
  type SendFile,
  timeLeftText,
  UploadQueue,
} from "./upload-queue";

const place: Destination = {
  kind: "folder",
  driveId: "drive-1" as DriveId,
  folderId: null,
  name: "Roadmap",
};
const fileOf = (name: string, size = 10) =>
  new File([new Uint8Array(size)], name);

function kit(sendFile: SendFile) {
  const sent: string[] = [];
  const queue = new UploadQueue({
    ensureMyFiles: async () => "my-drive" as DriveId,
    sendFile: async (input) => {
      await sendFile(input);
      sent.push(input.file.name);
    },
    onFileSent: () => {},
  });
  return { queue, sent };
}

const settled = () => Bun.sleep(5);

test("files go one at a time, and the tray names where they're going", async () => {
  const seen: string[] = [];
  const { queue, sent } = kit(async ({ file }) => {
    seen.push(file.name);
  });
  queue.add(place, [fileOf("a"), fileOf("b")]);
  expect(queue.isBusy()).toBe(true);
  expect(queue.snapshot()[0]?.name).toBe("Roadmap");
  await settled();
  expect(sent).toEqual(["a", "b"]);
  expect(seen).toEqual(["a", "b"]);
  expect(queue.isBusy()).toBe(false);
  expect(batchProgress(queue.snapshot()[0]!).finished).toBe(true);
});

test("Home's uploads make My files first and name it", async () => {
  const targets: unknown[] = [];
  const { queue } = kit(async ({ driveId, folderId }) => {
    targets.push([driveId, folderId]);
  });
  queue.add({ kind: "myFiles" }, [fileOf("a")]);
  expect(queue.snapshot()[0]?.name).toBe("My files");
  await settled();
  expect(targets).toEqual([["my-drive", null]]);
});

test("a refused file says why and doesn't stop the others", async () => {
  const { queue, sent } = kit(async ({ file }) => {
    if (file.name === "bad") throw new UploadRefused("That name won't do.");
  });
  queue.add(place, [fileOf("bad"), fileOf("good")]);
  await settled();
  expect(sent).toEqual(["good"]);
  const progress = batchProgress(queue.snapshot()[0]!);
  expect(progress.sent).toBe(1);
  expect(progress.refused[0]?.message).toBe("That name won't do.");
});

test("while a connection is out the batch waits, and carries on when bytes move", async () => {
  let wait!: () => void;
  let move!: (bytes: number) => void;
  let finish!: () => void;
  const { queue } = kit(
    ({ onWaiting, onSentBytes }) =>
      new Promise<void>((resolve) => {
        wait = onWaiting;
        move = onSentBytes;
        finish = resolve;
      }),
  );
  queue.add(place, [fileOf("a", 100)]);
  await settled();
  wait();
  expect(queue.snapshot()[0]?.waiting).toBe(true);
  move(50);
  expect(queue.snapshot()[0]?.waiting).toBe(false);
  expect(batchProgress(queue.snapshot()[0]!).sentBytes).toBe(50);
  finish();
  await settled();
});

test("closing stops the send and the next queued file in that batch", async () => {
  let aborted = false;
  const { queue, sent } = kit(
    ({ signal }) =>
      new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("stopped"));
        });
      }),
  );
  queue.add(place, [fileOf("a"), fileOf("b")]);
  await settled();
  queue.close(queue.snapshot()[0]!.id);
  await settled();
  expect(aborted).toBe(true);
  expect(sent).toEqual([]);
  expect(queue.snapshot()).toEqual([]);
  expect(queue.isBusy()).toBe(false);
});

test("the time left counts only what moved in this visit", async () => {
  let move!: (bytes: number) => void;
  const { queue } = kit(
    ({ onSentBytes }) =>
      new Promise<void>(() => {
        move = onSentBytes;
      }),
  );
  queue.add(place, [fileOf("a", 1000)]);
  await settled();
  const start = Date.now();
  expect(timeLeftText(queue.snapshot()[0]!, start)).toBe(
    "Working out the time left.",
  );
  // An earlier visit stored half, so the first report isn't this visit's speed.
  move(500);
  expect(timeLeftText(queue.snapshot()[0]!, start + 1000)).toBe(
    "Working out the time left.",
  );
  move(600);
  expect(timeLeftText(queue.snapshot()[0]!, start + 100_000)).toBe(
    "7 minutes left.",
  );
});

test("more files for the same place join its line, and a finished line gives way", async () => {
  let release!: () => void;
  const { queue } = kit(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  queue.add(place, [fileOf("a")]);
  queue.add(place, [fileOf("b")]);
  expect(queue.snapshot()).toHaveLength(1);
  expect(queue.snapshot()[0]?.files).toHaveLength(2);
  release();
  await settled();
  release();
  await settled();
  expect(batchProgress(queue.snapshot()[0]!).finished).toBe(true);

  const firstId = queue.snapshot()[0]!.id;
  queue.add(place, [fileOf("c")]);
  expect(queue.snapshot()).toHaveLength(1);
  expect(queue.snapshot()[0]!.id).not.toBe(firstId);
  expect(queue.snapshot()[0]?.files).toHaveLength(1);
  release();
  await settled();
});

test("files for two places get a line each", () => {
  const { queue } = kit(() => new Promise<void>(() => {}));
  queue.add(place, [fileOf("a")]);
  queue.add({ kind: "myFiles" }, [fileOf("b")]);
  expect(queue.snapshot().map((batch) => batch.name)).toEqual([
    "Roadmap",
    "My files",
  ]);
});
