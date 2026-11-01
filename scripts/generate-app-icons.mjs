// Writes Mail's app icons from the theme's accent colours and the shell's cloud icon, so
// they follow the palette with no image tool or dependency. Run after changing a colour:
//   bun scripts/generate-app-icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

const ROOT = join(import.meta.dirname, "..");
const THEME = join(ROOT, "src/styles/theme.css");
const OUT = join(ROOT, "public/icons");

// @tabler/icons-react's IconCloud, on its 24-unit grid.
const CLOUD =
  "M6.657 18c-2.572 0 -4.657 -2.007 -4.657 -4.483c0 -2.475 2.085 -4.482 4.657 -4.482c.393 -1.762 1.794 -3.2 3.675 -3.773c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.913 0 3.464 1.56 3.464 3.486c0 1.927 -1.551 3.487 -3.465 3.487h-11.878";
const STROKE = 2;

export const ICONS = [
  { file: "icon-192.png", size: 192, glyph: 0.68, rounded: true },
  { file: "icon-512.png", size: 512, glyph: 0.68, rounded: true },
  // Launchers crop a maskable icon to their own shape, so it fills the square and
  // keeps the cloud inside the central safe zone.
  { file: "maskable-512.png", size: 512, glyph: 0.52, rounded: false },
  // Apple adds its own rounded corners and shows any transparency as black.
  { file: "apple-touch-icon.png", size: 180, glyph: 0.68, rounded: false },
];

function lightColour(css, role) {
  const value = new RegExp(
    `--color-${role}:\\s*light-dark\\(\\s*(#[0-9a-f]{6})`,
    "i",
  ).exec(css);
  if (!value)
    throw new Error(`The theme has no light value for --color-${role}.`);
  const hex = value[1];
  return [1, 3, 5].map((start) =>
    Number.parseInt(hex.slice(start, start + 2), 16),
  );
}

// Only the commands the cloud uses, walked into straight segments.
function flatten(path) {
  const tokens = path.match(/[a-zA-Z]|-?\d*\.?\d+/g);
  const segments = [];
  let [x, y] = [0, 0];
  let index = 0;
  const number = () => Number(tokens[index++]);
  let command = "";
  while (index < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[index])) command = tokens[index++];
    if (command === "M") {
      x = number();
      y = number();
    } else if (command === "h") {
      const nextX = x + number();
      segments.push([x, y, nextX, y]);
      x = nextX;
    } else if (command === "c") {
      const [x1, y1, x2, y2, x3, y3] = Array.from({ length: 6 }, number);
      let [lastX, lastY] = [x, y];
      for (let step = 1; step <= 24; step += 1) {
        const t = step / 24;
        const u = 1 - t;
        const pointX =
          3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3 + x;
        const pointY =
          3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3 + y;
        segments.push([lastX, lastY, pointX, pointY]);
        [lastX, lastY] = [pointX, pointY];
      }
      x += x3;
      y += y3;
    } else {
      throw new Error(`The icon path uses an unexpected command: ${command}`);
    }
  }
  return segments;
}

function distanceToSegment(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared),
        );
  return Math.hypot(px - x1 - t * dx, py - y1 - t * dy);
}

const clamp = (value) => Math.max(0, Math.min(1, value));

export function renderIcon({ size, glyph, rounded }, accent, onAccent) {
  const segments = flatten(CLOUD);
  const scale = (size * glyph) / 24;
  const offset = (size - 24 * scale) / 2;
  const radius = rounded ? size * 0.2 : 0;
  const halfStroke = (STROKE / 2) * scale;
  const pixels = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const cx = column + 0.5;
      const cy = row + 0.5;
      const nearestX = Math.max(radius, Math.min(size - radius, cx));
      const nearestY = Math.max(radius, Math.min(size - radius, cy));
      const corner =
        radius === 0
          ? 1
          : clamp(radius - Math.hypot(cx - nearestX, cy - nearestY) + 0.5);
      const gridX = (cx - offset) / scale;
      const gridY = (cy - offset) / scale;
      const nearest = Math.min(
        ...segments.map((segment) => distanceToSegment(gridX, gridY, segment)),
      );
      const ink = clamp(halfStroke - nearest * scale + 0.5);
      const at = (row * size + column) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[at + channel] = Math.round(
          accent[channel] * (1 - ink) + onAccent[channel] * ink,
        );
      }
      pixels[at + 3] = Math.round(corner * 255);
    }
  }
  return encodePng(size, pixels);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row += 1) {
    Buffer.from(pixels.subarray(row * size * 4, (row + 1) * size * 4)).copy(
      rows,
      row * (size * 4 + 1) + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function renderAllIcons() {
  const css = readFileSync(THEME, "utf8");
  const accent = lightColour(css, "accent");
  const onAccent = lightColour(css, "on-accent");
  return ICONS.map((icon) => ({
    path: join(OUT, icon.file),
    bytes: renderIcon(icon, accent, onAccent),
  }));
}

if (import.meta.main) {
  for (const { path, bytes } of renderAllIcons()) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    console.log(`Wrote ${path}`);
  }
}
