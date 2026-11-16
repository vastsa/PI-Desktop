import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { ErrorCodes, type ComposerPastedFile } from "@pi-desktop/shared";
import { mimeTypeForPath } from "./composer-paste.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type FileReference = { version: 1; path: string; projectPath: string; sessionId: string };

async function referenceRoot(dataDir: string): Promise<string> {
  const data = await realpath(dataDir);
  const root = join(data, "composer-file-references");
  await mkdir(root, { recursive: true });
  if (await realpath(root) !== root) throw new Error("file reference directory was redirected");
  return root;
}

/** Called only with paths consumed from a sender-bound native selection. */
export async function referenceComposerFiles(
  dataDir: string,
  sessionId: string,
  projectPath: string,
  paths: string[],
): Promise<ComposerPastedFile[]> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("invalid session id");
  if (paths.length > 20) throw new Error("too many referenced files (maximum 20)");
  const project = await realpath(projectPath);
  const prepared = await Promise.all(paths.map(async path => {
    if (!isAbsolute(path)) throw new Error("file reference path must be absolute");
    const canonical = await realpath(path);
    const info = await stat(canonical);
    if (!info.isFile()) throw new Error("selected path is not a file");
    return { path: canonical, size: info.size };
  }));
  const root = await referenceRoot(dataDir);
  return Promise.all(prepared.map(async ({ path, size }) => {
    const localReference = randomUUID();
    const record: FileReference = { version: 1, path, projectPath: project, sessionId };
    await writeFile(join(root, `${localReference}.json`), JSON.stringify(record), { flag: "wx", mode: 0o600 });
    return { path, name: basename(path), kind: "file" as const, mimeType: mimeTypeForPath(path), size, localReference };
  }));
}

/** Refresh metadata only; reading contents still belongs to normal tool admission. */
export async function resolveComposerFileReference(
  dataDir: string,
  projectPath: string | undefined,
  path: string,
  localReference: string,
): Promise<ComposerPastedFile> {
  if (!UUID.test(localReference) || !projectPath) {
    throw Object.assign(new Error("local file reference is unavailable in this project"), { errorCode: ErrorCodes.PATH_OUTSIDE_WORKSPACE });
  }
  const root = await referenceRoot(dataDir);
  const recordPath = join(root, `${localReference}.json`);
  if (await realpath(recordPath) !== recordPath) throw new Error("file reference record was redirected");
  const record: FileReference = JSON.parse(await readFile(recordPath, "utf8"));
  if (record.version !== 1 || record.path !== path || record.projectPath !== await realpath(projectPath)) {
    throw Object.assign(new Error("local file reference does not belong to this project"), { errorCode: ErrorCodes.PATH_OUTSIDE_WORKSPACE });
  }
  try {
    if (await realpath(path) !== path) throw new Error("referenced file was redirected");
    const info = await stat(path);
    if (!info.isFile()) throw new Error("referenced path is not a file");
    return { path, name: basename(path), kind: "file", mimeType: mimeTypeForPath(path), size: info.size, localReference };
  } catch (cause) {
    throw Object.assign(new Error(`Referenced file is unavailable: ${path}`, { cause }), { errorCode: ErrorCodes.NOT_FOUND });
  }
}
