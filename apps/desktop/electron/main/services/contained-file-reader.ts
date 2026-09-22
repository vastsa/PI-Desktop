import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/** Roots a session owns. The host captures them; a caller never supplies them. */
export type ContainedFileRoots = { projectPath?: string; scratchPath: string; dataDir: string };

export type ContainedFileReaderOptions = {
  roots: ContainedFileRoots;
  /** Per-file cap. */
  maxFileBytes: number;
  /** Per-call total cap across the refs of one call. */
  maxSetBytes: number;
  /** Lifetime cap across every read this reader performs. */
  maxBudgetBytes: number;
  /**
   * Error codes the caller wants distinct. When `notFound` is absent, a missing
   * file keeps today's behavior and the raw filesystem error propagates.
   */
  codes: {
    outside: string;
    /** The file does not exist. */
    notFound?: string;
    /** The path exists but is not a regular file. */
    invalid: string;
    /** A single file over `maxFileBytes`. Separate from the aggregate caps,
     * because the shipped image path reports it with its own code. */
    fileTooLarge: string;
    /** The per-call total or the lifetime budget. */
    setTooLarge: string;
  };
};

/** `attachments/<sha256>` is the opaque reference form used by the attachment store. */
const ATTACHMENT_REF = /^attachments[\\/][a-f0-9]{64}$/;

function rejected(errorCode: string, message: string) {
  return Object.assign(new Error(message), { errorCode });
}

/**
 * One containment rule for host-side file reads on behalf of a caller.
 *
 * Resolution is symlink-aware: the candidate and every candidate root are
 * `realpath`'d, and the resolved file must sit strictly inside one resolved root,
 * so `..`, absolute escapes, and an `attachments/<sha256>` reference pointing out
 * of the store are all refused. The read is bounded and re-checked while it
 * happens, so a file that grows after `stat` cannot overrun its cap.
 *
 * The reader decides access and size only. Content type is the caller's
 * business: it never sniffs bytes, lists directories, or resolves recursively.
 */
export function createContainedFileReader(
  options: ContainedFileReaderOptions,
): (refs: string[]) => Promise<Uint8Array[]> {
  const { roots, codes } = options;
  const { notFound } = codes;
  let loadedBytes = 0;
  const cache = new Map<string, Promise<Uint8Array>>();

  const read = async (ref: string) => {
    const candidate = ATTACHMENT_REF.test(ref)
      ? resolve(roots.dataDir, ref)
      : isAbsolute(ref)
        ? ref
        : roots.projectPath
          ? resolve(roots.projectPath, ref)
          : resolve(roots.scratchPath, ref);
    const path = await realpath(candidate).catch((error: NodeJS.ErrnoException) => {
      if (notFound && error.code === "ENOENT")
        throw rejected(notFound, "Contained file does not exist");
      throw error;
    });
    // A root that does not exist cannot contain anything, so ENOENT drops it
    // instead of failing the read; every other root error still surfaces.
    const resolved = await Promise.all(
      [roots.projectPath, roots.scratchPath, resolve(roots.dataDir, "attachments")]
        .filter((root): root is string => !!root)
        .map((root) =>
          realpath(root).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          }),
        ),
    );
    if (
      !resolved.some((root) => {
        if (!root) return false;
        const rel = relative(root, path);
        return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
      })
    )
      throw rejected(codes.outside, "Contained file is outside the session and project roots");
    const file = await open(path, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw rejected(codes.invalid, "Contained file is not a regular file");
      if (stat.size > options.maxFileBytes)
        throw rejected(codes.fileTooLarge, "Contained file exceeds the per-file size cap");
      // A bounded read still holds if another process grows the file after stat.
      const bytes = Buffer.alloc(Math.min(stat.size + 1, options.maxFileBytes + 1));
      let size = 0;
      while (size < bytes.length) {
        const read = await file.read(bytes, size, bytes.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      const data = bytes.subarray(0, size);
      if (loadedBytes + size > options.maxBudgetBytes)
        throw rejected(codes.setTooLarge, "Contained file reads exceed the loader budget");
      loadedBytes += size;
      return data;
    } finally {
      await file.close();
    }
  };
  return async (refs: string[]) => {
    const files = await Promise.all(
      refs.map((ref) => {
        let file = cache.get(ref);
        if (!file) {
          file = read(ref);
          cache.set(ref, file);
        }
        return file;
      }),
    );
    if (files.reduce((size, file) => size + file.length, 0) > options.maxSetBytes)
      throw rejected(codes.setTooLarge, "Contained files exceed the per-call size cap");
    return files;
  };
}
