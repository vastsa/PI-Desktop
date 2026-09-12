/**
 * Normalize native file-system drops before the Composer decides whether to
 * materialize bytes or keep a directory as a literal path reference.
 */

export type ComposerDropItem = {
  file: File;
  path: string | null;
  isDirectory: boolean;
};

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => FileSystemEntry | null;
};

function isDirectoryItem(item: DataTransferItemWithEntry, file: File): boolean {
  const entry = item.webkitGetAsEntry?.();
  return entry?.isDirectory === true || file.type === "application/x-directory";
}

/** True when the data transfer contains native files or directories. */
export function hasComposerFileDrag(data: DataTransfer): boolean {
  return (
    data.files.length > 0 ||
    Array.from(data.items).some((item) => item.kind === "file")
  );
}

/**
 * Return real dropped items in OS order. Electron's preload resolves the
 * source path; ordinary files can still be saved from their bytes when a
 * non-Electron browser/test surface has no path bridge.
 */
export function composerDropItems(
  data: DataTransfer,
  resolvePath: (file: File) => string | null,
): ComposerDropItem[] {
  const result: ComposerDropItem[] = [];
  const seen = new Set<File>();
  const seenPaths = new Set<string>();
  const transferFiles = Array.from(data.files);
  const transferItems = Array.from(data.items).filter(
    (item) => item.kind === "file",
  ) as DataTransferItemWithEntry[];

  const add = (file: File, item?: DataTransferItemWithEntry) => {
    if (seen.has(file)) return;
    seen.add(file);
    const isDirectory = item
      ? isDirectoryItem(item, file)
      : file.type === "application/x-directory";
    const path = resolvePath(file);
    if (path && seenPaths.has(path)) return;
    // A directory without a native path cannot be displayed or acted on.
    if (isDirectory && !path) return;
    if (path) seenPaths.add(path);
    result.push({ file, path, isDirectory });
  };

  for (const [index, item] of transferItems.entries()) {
    const file = item.getAsFile() ?? transferFiles[index];
    if (file) add(file, item);
  }
  // Some synthetic/browser transfers expose files without DataTransferItems.
  if (transferItems.length === 0) {
    for (const file of transferFiles) add(file);
  }

  return result;
}
