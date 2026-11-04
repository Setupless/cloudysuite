import type { DriveId } from "@cloudysuite/access";
import {
  IconFile,
  IconFileSpreadsheet,
  IconFileText,
  IconFileTypePdf,
  IconMovie,
  IconMusic,
  IconPhoto,
  IconPresentationAnalytics,
} from "@tabler/icons-react";
import type { Icon } from "@tabler/icons-react";
import { useState } from "react";
import { type FileType, fileTypeOf } from "../file-types";
import { canPreview, type FileItem } from "../types";

const TYPE_ICONS: Record<FileType, Icon> = {
  pdf: IconFileTypePdf,
  image: IconPhoto,
  document: IconFileText,
  spreadsheet: IconFileSpreadsheet,
  presentation: IconPresentationAnalytics,
  video: IconMovie,
  audio: IconMusic,
};

function fileIcon(file: Pick<FileItem, "name" | "mimeType">): Icon {
  const type = fileTypeOf(file);
  return type === null ? IconFile : TYPE_ICONS[type];
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
