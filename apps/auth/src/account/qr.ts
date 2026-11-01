// QR Code Model 2 in byte mode at error correction level M. The README's stack
// has no QR library, and a setup key must not leave the browser for an image
// service. Versions stop at 20, which holds 666 bytes, far more than a TOTP URI.

const ECC_PER_BLOCK = [
  10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26,
  26,
];
const BLOCKS = [
  1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
];
const MAX_VERSION = ECC_PER_BLOCK.length;
const FORMAT_BITS_M = 0;

const eccPerBlock = (version: number) => ECC_PER_BLOCK[version - 1] as number;
const blockCount = (version: number) => BLOCKS[version - 1] as number;

function totalCodewords(version: number): number {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    modules -= (25 * align - 10) * align - 55;
    if (version >= 7) modules -= 36;
  }
  return Math.floor(modules / 8);
}

function dataCodewords(version: number): number {
  return totalCodewords(version) - eccPerBlock(version) * blockCount(version);
}

function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const countBits = version <= 9 ? 8 : 16;
    const needed = Math.ceil((4 + countBits + byteLength * 8) / 8);
    if (needed <= dataCodewords(version)) return version;
  }
  throw new Error("Too much text for a QR code.");
}

function encodeData(bytes: Uint8Array, version: number): Uint8Array {
  const capacity = dataCodewords(version);
  const countBits = version <= 9 ? 8 : 16;
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let bit = length - 1; bit >= 0; bit--) bits.push((value >>> bit) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);

  const words = new Uint8Array(capacity);
  for (let i = 0; i < bits.length; i++) {
    (words[i >>> 3] as number) |= (bits[i] as number) << (7 - (i & 7));
  }
  for (let i = bits.length >>> 3, pad = 0xec; i < capacity; i++) {
    words[i] = pad;
    pad = pad === 0xec ? 0x11 : 0xec;
  }
  return words;
}

function gfMultiply(a: number, b: number): number {
  let result = 0;
  for (let bit = 7; bit >= 0; bit--) {
    result = (result << 1) ^ ((result >>> 7) * 0x11d);
    result ^= ((b >>> bit) & 1) * a;
  }
  return result;
}

function reedSolomonDivisor(degree: number): number[] {
  const divisor = Array.from({ length: degree }, () => 0);
  divisor[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      divisor[j] = gfMultiply(divisor[j] as number, root);
      if (j + 1 < degree) (divisor[j] as number) ^= divisor[j + 1] as number;
    }
    root = gfMultiply(root, 2);
  }
  return divisor;
}

function reedSolomonRemainder(data: Uint8Array, divisor: number[]): number[] {
  const remainder = Array.from(divisor, () => 0);
  for (const byte of data) {
    const factor = byte ^ (remainder.shift() as number);
    remainder.push(0);
    divisor.forEach((coefficient, i) => {
      (remainder[i] as number) ^= gfMultiply(coefficient, factor);
    });
  }
  return remainder;
}

function interleaveWithEcc(data: Uint8Array, version: number): number[] {
  const blocks = blockCount(version);
  const ecc = eccPerBlock(version);
  const total = totalCodewords(version);
  const shortBlocks = blocks - (total % blocks);
  const shortLength = Math.floor(total / blocks) - ecc;
  const divisor = reedSolomonDivisor(ecc);

  const dataParts: Uint8Array[] = [];
  const eccParts: number[][] = [];
  for (let block = 0, at = 0; block < blocks; block++) {
    const length = shortLength + (block < shortBlocks ? 0 : 1);
    const part = data.slice(at, at + length);
    at += length;
    dataParts.push(part);
    eccParts.push(reedSolomonRemainder(part, divisor));
  }

  const result: number[] = [];
  for (let i = 0; i <= shortLength; i++) {
    for (const part of dataParts) {
      if (i < part.length) result.push(part[i] as number);
    }
  }
  for (let i = 0; i < ecc; i++) {
    for (const part of eccParts) result.push(part[i] as number);
  }
  return result;
}

function alignmentCentres(version: number, size: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const centres = [6];
  for (let i = 0, at = size - 7; i < count - 1; i++, at -= step) {
    centres.splice(1, 0, at);
  }
  return centres;
}

type Grid = { size: number; dark: boolean[][]; fixed: boolean[][] };

function setFixed(grid: Grid, x: number, y: number, dark: boolean) {
  (grid.dark[y] as boolean[])[x] = dark;
  (grid.fixed[y] as boolean[])[x] = true;
}

function drawFormatBits(grid: Grid, mask: number) {
  const data = (FORMAT_BITS_M << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  const bits = ((data << 10) | remainder) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const { size } = grid;
  for (let i = 0; i <= 5; i++) setFixed(grid, 8, i, bit(i));
  setFixed(grid, 8, 7, bit(6));
  setFixed(grid, 8, 8, bit(7));
  setFixed(grid, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFixed(grid, 14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) setFixed(grid, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFixed(grid, 8, size - 15 + i, bit(i));
  setFixed(grid, 8, size - 8, true);
}

function drawFunctionPatterns(grid: Grid, version: number) {
  const { size } = grid;
  for (let i = 0; i < size; i++) {
    setFixed(grid, 6, i, i % 2 === 0);
    setFixed(grid, i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          setFixed(grid, x, y, distance !== 2 && distance !== 4);
        }
      }
    }
  }
  const centres = alignmentCentres(version, size);
  const last = centres.length - 1;
  centres.forEach((cy, row) => {
    centres.forEach((cx, column) => {
      const overlapsFinder =
        (row === 0 && column === 0) ||
        (row === 0 && column === last) ||
        (row === last && column === 0);
      if (overlapsFinder) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFixed(
            grid,
            cx + dx,
            cy + dy,
            Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
          );
        }
      }
    });
  });
  drawFormatBits(grid, 0);
  if (version >= 7) {
    let remainder = version;
    for (let i = 0; i < 12; i++) {
      remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    }
    const bits = (version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const near = size - 11 + (i % 3);
      const far = Math.floor(i / 3);
      setFixed(grid, near, far, dark);
      setFixed(grid, far, near, dark);
    }
  }
}

function drawCodewords(grid: Grid, codewords: number[]) {
  const { size, dark, fixed } = grid;
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      for (let offset = 0; offset < 2; offset++) {
        const x = right - offset;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - step : step;
        if (!(fixed[y] as boolean[])[x] && index < codewords.length * 8) {
          const word = codewords[index >>> 3] as number;
          (dark[y] as boolean[])[x] = ((word >>> (7 - (index & 7))) & 1) === 1;
          index++;
        }
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(grid: Grid, mask: number) {
  const pattern = MASKS[mask] as (x: number, y: number) => boolean;
  grid.dark.forEach((row, y) => {
    row.forEach((value, x) => {
      if (!(grid.fixed[y] as boolean[])[x] && pattern(x, y)) row[x] = !value;
    });
  });
}

// The penalty from the standard. Any mask decodes, and a low score just keeps
// large blocks and finder lookalikes out of the code.
function penalty({ size, dark }: Grid): number {
  const lines = dark.map((row) => row.map(Number).join(""));
  for (let x = 0; x < size; x++) {
    lines.push(dark.map((row) => Number(row[x])).join(""));
  }
  let score = 0;
  for (const line of lines) {
    for (const run of line.match(/0{5,}|1{5,}/g) ?? []) score += run.length - 2;
    for (const finder of ["10111010000", "00001011101"]) {
      for (
        let at = line.indexOf(finder);
        at !== -1;
        at = line.indexOf(finder, at + 1)
      ) {
        score += 40;
      }
    }
  }
  let darkCount = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = (dark[y] as boolean[])[x];
      if (value) darkCount++;
      if (
        x + 1 < size &&
        y + 1 < size &&
        value === (dark[y] as boolean[])[x + 1] &&
        value === (dark[y + 1] as boolean[])[x] &&
        value === (dark[y + 1] as boolean[])[x + 1]
      ) {
        score += 3;
      }
    }
  }
  const percent = (darkCount * 100) / (size * size);
  return score + Math.floor(Math.abs(percent - 50) / 5) * 10;
}

export function encodeQr(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const size = version * 4 + 17;
  const blank = () =>
    Array.from({ length: size }, () =>
      Array.from({ length: size }, () => false),
    );
  const grid: Grid = { size, dark: blank(), fixed: blank() };

  drawFunctionPatterns(grid, version);
  drawCodewords(grid, interleaveWithEcc(encodeData(bytes, version), version));

  let best = 0;
  let lowest = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < MASKS.length; mask++) {
    applyMask(grid, mask);
    drawFormatBits(grid, mask);
    const score = penalty(grid);
    if (score < lowest) {
      lowest = score;
      best = mask;
    }
    applyMask(grid, mask);
  }
  applyMask(grid, best);
  drawFormatBits(grid, best);
  return grid.dark;
}
