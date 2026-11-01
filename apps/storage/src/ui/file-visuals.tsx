import type { DriveId } from "@cloudysuite/access";
import {
  IconFile,
  IconFileSpreadsheet,
  IconFileText,
  IconFileTypePdf,
  IconPhoto,
  IconPresentationAnalytics,
} from "@tabler/icons-react";
import type { Icon } from "@tabler/icons-react";
import { useState } from "react";
import { canPreview, type FileItem } from "../types";

const EXTENSION_ICONS: Record<string, Icon> = {
  pdf: IconFileTypePdf,
  csv: IconFileSpreadsheet,
  numbers: IconFileSpreadsheet,
  ods: IconFileSpreadsheet,
  xls: IconFileSpreadsheet,
  xlsx: IconFileSpreadsheet,
  key: IconPresentationAnalytics,
  odp: IconPresentationAnalytics,
  ppt: IconPresentationAnalytics,
  pptx: IconPresentationAnalytics,
  doc: IconFileText,
  docx: IconFileText,
  md: IconFileText,
  odt: IconFileText,
  pages: IconFileText,
  rtf: IconFileText,
  txt: IconFileText,
  avif: IconPhoto,
  gif: IconPhoto,
  heic: IconPhoto,
  jpeg: IconPhoto,
  jpg: IconPhoto,
  png: IconPhoto,
  svg: IconPhoto,
  tif: IconPhoto,
  tiff: IconPhoto,
  webp: IconPhoto,
};

function fileIcon(file: Pick<FileItem, "name" | "mimeType">): Icon {
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const byExtension = Object.hasOwn(EXTENSION_ICONS, extension)
    ? EXTENSION_ICONS[extension]
    : undefined;
  if (byExtension) return byExtension;
  if (file.mimeType === "application/pdf") return IconFileTypePdf;
  if (file.mimeType.startsWith("image/")) return IconPhoto;
  if (file.mimeType.startsWith("text/")) return IconFileText;
  return IconFile;
}

export function FileIcon({
  file,
  size = 18,
}: {
  file: Pick<FileItem, "name" | "mimeType">;
  size?: number;
}) {
  const Glyph = fileIcon(file);
  return <Glyph size={size} stroke={1.75} aria-hidden />;
}

// A stored type can lie. If a "PNG" won't decode, the icon stands in for it.
export function FilePreview({
  driveId,
  file,
}: {
  driveId: DriveId;
  file: FileItem;
}) {
  const [broken, setBroken] = useState(false);
  if (!canPreview(file) || broken) return <FileIcon file={file} size={30} />;
  return (
    <img
      src={`/preview/${driveId}/${file.id}`}
      alt=""
      loading="lazy"
      className="size-full object-cover"
      onError={() => setBroken(true)}
    />
  );
}
