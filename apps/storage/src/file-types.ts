// Shared with the browser, so nothing here may import server code.
import type { FileItem } from "./types";

type FileTypeRule = {
  extensions: readonly string[];
  // A LIKE pattern for the stored type, used only when the name has no known extension.
  mimePattern: string | null;
};

// One table for the icon a file shows and what `type:` finds, so the two always agree.
// No two patterns overlap.
export const FILE_TYPE_RULES = {
  pdf: { extensions: ["pdf"], mimePattern: "application/pdf" },
  image: {
    extensions: [
      "avif",
      "gif",
      "heic",
      "jpeg",
      "jpg",
      "png",
      "svg",
      "tif",
      "tiff",
      "webp",
    ],
    mimePattern: "image/%",
  },
  document: {
    extensions: ["doc", "docx", "md", "odt", "pages", "rtf", "txt"],
    mimePattern: "text/%",
  },
  spreadsheet: {
    extensions: ["csv", "numbers", "ods", "xls", "xlsx"],
    mimePattern: null,
  },
  presentation: {
    extensions: ["key", "odp", "ppt", "pptx"],
    mimePattern: null,
  },
  video: {
    extensions: ["avi", "m4v", "mkv", "mov", "mp4", "webm"],
    mimePattern: "video/%",
  },
  audio: {
    extensions: ["aac", "flac", "m4a", "mp3", "ogg", "wav"],
    mimePattern: "audio/%",
  },
} as const satisfies Record<string, FileTypeRule>;

export type FileType = keyof typeof FILE_TYPE_RULES;

export const FILE_TYPES = Object.keys(FILE_TYPE_RULES) as FileType[];

const BY_EXTENSION = new Map<string, FileType>(
  FILE_TYPES.flatMap((type) =>
    FILE_TYPE_RULES[type].extensions.map((extension) => [extension, type]),
  ),
);

// SQLite's LIKE folds only ASCII letters, and search must read a name the way the icon does.
const asciiLower = (text: string) =>
  text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

function likeMatches(pattern: string, value: string): boolean {
  const lower = asciiLower(value);
  return pattern.endsWith("%")
    ? lower.startsWith(pattern.slice(0, -1))
    : lower === pattern;
}

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? null : asciiLower(name.slice(dot + 1));
}

export function fileTypeOf(
  file: Pick<FileItem, "name" | "mimeType">,
): FileType | null {
  const extension = extensionOf(file.name);
  const byExtension =
    extension === null ? undefined : BY_EXTENSION.get(extension);
  if (byExtension) return byExtension;
  return (
    FILE_TYPES.find((type) => {
      const pattern = FILE_TYPE_RULES[type].mimePattern;
      return pattern !== null && likeMatches(pattern, file.mimeType);
    }) ?? null
  );
}
