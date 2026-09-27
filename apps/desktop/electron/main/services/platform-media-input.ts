import { open, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";

export type PlatformMediaOperation = "image" | "image-download" | "video-create" | "video-status" | "video-download" | "billing";
export type PlatformMediaInput = {
  operation: PlatformMediaOperation;
  prompt?: string;
  model?: string;
  count?: number;
  images?: string[];
  videos?: string[];
  audios?: string[];
  seconds?: number;
  resolution?: "768P" | "2K";
  ratio?: string;
  taskId?: string;
  receipt?: string;
};

export function mediaError(errorCode: string, message: string): Error & { errorCode: string } {
  return Object.assign(new Error(message), { errorCode });
}

export function withinMediaRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !!rel && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

export function parsePlatformMediaInput(value: unknown): PlatformMediaInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw mediaError("INVALID_ARGUMENT", "PlatformMedia requires an object.");
  const input = value as Record<string, unknown>;
  const fields: Record<PlatformMediaOperation, string[]> = {
    image: ["prompt", "model", "count", "images", "ratio"],
    "image-download": ["receipt"],
    "video-create": ["prompt", "model", "images", "videos", "audios", "seconds", "resolution", "ratio"],
    "video-status": ["taskId", "receipt"],
    "video-download": ["taskId", "receipt"],
    billing: ["taskId", "receipt"],
  };
  if (typeof input.operation !== "string" || !Object.hasOwn(fields, input.operation))
    throw mediaError("INVALID_ARGUMENT", "Unknown PlatformMedia operation.");
  const operation = input.operation as PlatformMediaOperation;
  for (const key of Object.keys(input)) {
    if (key !== "operation" && !fields[operation].includes(key))
      throw mediaError("INVALID_ARGUMENT", `Unsupported field for ${operation}: ${key}`);
  }
  const creating = operation === "image" || operation === "video-create";
  for (const key of ["prompt", "model", "ratio", "resolution", "taskId", "receipt"]) {
    const item = input[key];
    if (item !== undefined && (typeof item !== "string" || !item.trim() || item.includes("\0") || item.length > (key === "prompt" ? 32_768 : key === "receipt" ? 4096 : 200)))
      throw mediaError("INVALID_ARGUMENT", `Invalid ${key}.`);
  }
  if (creating && !input.prompt) throw mediaError("INVALID_ARGUMENT", "A prompt is required.");
  if (input.count !== undefined && (!Number.isInteger(input.count) || Number(input.count) < 1 || Number(input.count) > 10))
    throw mediaError("INVALID_ARGUMENT", "count must be an integer from 1 to 10; each image is billed separately.");
  if (input.seconds !== undefined && (!Number.isInteger(input.seconds) || Number(input.seconds) < 4 || Number(input.seconds) > 15))
    throw mediaError("INVALID_ARGUMENT", "seconds must be an integer from 4 to 15.");
  if (operation === "video-create" && input.model !== undefined && input.model !== "MiniMax-H3")
    throw mediaError("INVALID_ARGUMENT", "Video generation supports MiniMax-H3 only.");
  if (input.resolution !== undefined && !["768P", "2K"].includes(String(input.resolution)))
    throw mediaError("INVALID_ARGUMENT", "resolution must be 768P or 2K.");
  const ratios = operation === "image" ? ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"] : ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
  if (input.ratio !== undefined && !ratios.includes(String(input.ratio)))
    throw mediaError("INVALID_ARGUMENT", "Unsupported aspect ratio.");
  let references = 0;
  let referenceBytes = 0;
  for (const key of ["images", "videos", "audios"]) {
    const refs = input[key];
    if (refs === undefined) continue;
    if (!Array.isArray(refs) || refs.length > 16 || refs.some((ref) => typeof ref !== "string" || !ref || ref.includes("\0")))
      throw mediaError("INVALID_ARGUMENT", "References must be arrays of at most 16 nonempty strings.");
    references += refs.length;
    for (const ref of refs as string[]) referenceBytes += Buffer.byteLength(ref);
  }
  if (references > 16 || referenceBytes > 240 * 1024 * 1024)
    throw mediaError("INVALID_ARGUMENT", "Too many or oversized media references.");
  if (input.taskId !== undefined && !/^[A-Za-z0-9_-]{1,160}$/.test(String(input.taskId)))
    throw mediaError("INVALID_ARGUMENT", "Invalid taskId.");
  if (operation === "image-download" && !input.receipt)
    throw mediaError("INVALID_ARGUMENT", "image-download requires a receipt.");
  if (!creating && !input.taskId && !input.receipt)
    throw mediaError("INVALID_ARGUMENT", "A taskId or receipt is required.");
  return input as PlatformMediaInput;
}

/** Snapshot local references before passing them to a separately scheduled process. */
export async function prepareMediaReferences(input: PlatformMediaInput, options: {
  projectPath?: string;
  scratchPath: string;
  dataDir: string;
  directory: string;
  signal: AbortSignal;
}): Promise<Pick<PlatformMediaInput, "images" | "videos" | "audios">> {
  const roots = await Promise.all([options.projectPath, options.scratchPath, resolve(options.dataDir, "attachments")]
    .filter((root): root is string => !!root).map((root) => realpath(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    })));
  const output: Pick<PlatformMediaInput, "images" | "videos" | "audios"> = {};
  let totalBytes = 0;
  for (const [field, limit] of [["images", 30], ["videos", 50], ["audios", 15]] as const) {
    const refs: string[] = [];
    for (const [index, ref] of (input[field] ?? []).entries()) {
      options.signal.throwIfAborted();
      if (ref.startsWith("data:")) {
        // Type, base64 and format checks are shared with the standalone CLI.
        const bytes = Buffer.byteLength(ref);
        if (bytes > Math.ceil(limit * 1024 * 1024 * 4 / 3) + 256)
          throw mediaError("INVALID_ARGUMENT", "A data URL exceeds its media size limit.");
        totalBytes += Math.ceil(bytes * 3 / 4);
        refs.push(ref);
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^[a-z]:[\\/]/i.test(ref)) {
        let url: URL;
        try { url = new URL(ref); } catch { throw mediaError("INVALID_ARGUMENT", "Invalid media URL."); }
        if (url.protocol !== "https:" || !url.hostname || url.username || url.password || ref.length > 8192)
          throw mediaError("INVALID_ARGUMENT", "Remote references require HTTPS without URL credentials.");
        refs.push(url.href);
        continue;
      }
      const candidate = /^attachments[\\/][a-f0-9]{64}$/.test(ref) ? resolve(options.dataDir, ref)
        : resolve(options.projectPath ?? options.scratchPath, ref);
      const path = await realpath(candidate);
      if (!roots.some((root) => root && withinMediaRoot(root, path)))
        throw mediaError("MEDIA_INPUT_OUTSIDE_ROOT", "Media input must be inside this session's project, scratch or attachments.");
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat();
        const max = limit * 1024 * 1024;
        if (!stat.isFile() || stat.size === 0 || stat.size > max || totalBytes + stat.size > 180 * 1024 * 1024)
          throw mediaError("INVALID_ARGUMENT", "Media input is empty, is not a regular file, or exceeds the size limit.");
        const data = Buffer.alloc(stat.size + 1);
        let size = 0;
        while (size < data.length) {
          const read = await file.read(data, size, data.length - size, null);
          if (!read.bytesRead) break;
          size += read.bytesRead;
        }
        if (size !== stat.size || await realpath(candidate) !== path)
          throw mediaError("INVALID_ARGUMENT", "Media input changed while it was being read.");
        const target = resolve(options.directory, `${field}-${index}${extname(path).slice(0, 16)}`);
        await writeFile(target, data.subarray(0, size), { flag: "wx", mode: 0o600 });
        totalBytes += size;
        refs.push(target);
      } finally { await file.close(); }
    }
    output[field] = refs;
  }
  if (totalBytes > 180 * 1024 * 1024) throw mediaError("INVALID_ARGUMENT", "Media references exceed 180 MiB.");
  return output;
}
