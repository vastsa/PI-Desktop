export const FILE_LINES_CLIPBOARD_TYPE = "application/x-pi-desktop-file-lines";
export const FILE_LINES_ADD_CHANNEL = "composer.addFileLines";
export const MAX_FILE_LINE_REFERENCES = 4;

export type FileLineRange = { start: number; end: number };
export type FileLineReference = FileLineRange & { path: string; workspace: string };

export function parseFileLineRange(value: unknown): FileLineRange | undefined {
  if (!value || typeof value !== "object") return;
  const { start, end } = value as Partial<FileLineRange>;
  if (typeof start !== "number" || typeof end !== "number" ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 1 || end < start) return;
  return { start, end };
}

export function parseFileLineReference(value: unknown): FileLineReference | undefined {
  const range = parseFileLineRange(value);
  if (!range) return;
  const { path, workspace } = value as Partial<FileLineReference>;
  if (typeof path !== "string" || typeof workspace !== "string" ||
      !path || !workspace || path.length > 4096 || workspace.length > 4096 ||
      /[\0\r\n]/.test(path) || /[\0\r\n]/.test(workspace)) return;
  return { path, workspace, ...range };
}

export function fileLineLabel(name: string, { start, end }: FileLineRange): string {
  return `${name} (${start === end ? start : `${start}:${end}`})`;
}
