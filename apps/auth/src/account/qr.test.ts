import { expect, test } from "bun:test";
import { encodeQr } from "./qr";

// Decoded by jsQR, an independent decoder, when this was written.
const CLOUDYSUITE = [
  "#######...#.#.#######",
  "#.....#..##.#.#.....#",
  "#.###.#...#.#.#.###.#",
  "#.###.#..#.##.#.###.#",
  "#.###.#..##.#.#.###.#",
  "#.....#.#####.#.....#",
  "#######.#.#.#.#######",
  ".........#.##........",
  "#..#.##.#....#.#.....",
  ".##......#......#.###",
  "#..#..#.#.#.#.##..#.#",
  "###.##.#####..#.##...",
  "...##.#.##..#...#...#",
  "........##.#..#.#.#..",
  "#######...#..#.##..#.",
  "#.....#.##.##.......#",
  "#.###.#..###....##.#.",
  "#.###.#.##....#.##.##",
  "#.###.#..##.#.#####.#",
  "#.....#..#...#.##....",
  "#######.##..#.####.#.",
];

const picture = (modules: boolean[][]) =>
  modules.map((row) => row.map((dark) => (dark ? "#" : ".")).join(""));

test("a known text produces the code a scanner read", () => {
  expect(picture(encodeQr("CloudySuite"))).toEqual(CLOUDYSUITE);
});

test("the code grows with the text, and every size is square with its corner markers", () => {
  for (const length of [1, 100, 200, 400, 660]) {
    const modules = encodeQr("x".repeat(length));
    expect(modules.length % 4).toBe(1);
    for (const row of modules) expect(row).toHaveLength(modules.length);
    const size = modules.length;
    const corners = [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ] as const;
    for (const [x, y] of corners) {
      expect(modules[y]?.slice(x, x + 7)).toEqual(Array(7).fill(true));
    }
  }
});

test("text too long for a code is refused rather than cut short", () => {
  expect(() => encodeQr("x".repeat(700))).toThrow();
});
