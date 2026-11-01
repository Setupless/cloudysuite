import { encodeQr } from "./qr";

const QUIET_ZONE = 4;

export function QrCode({ text, label }: { text: string; label: string }) {
  const modules = encodeQr(text);
  const size = modules.length + QUIET_ZONE * 2;
  let path = "";
  modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
    });
  });
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      className="size-52 rounded bg-qr-paper"
      shapeRendering="crispEdges"
    >
      <path d={path} className="fill-qr-ink" />
    </svg>
  );
}
