import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { generatedImageType, MAX_IMAGE_BYTES } from "@pi-desktop/agent-runtime";

/** Session/project roots are captured by the host, never supplied by the model. */
export function imageInputLoader(options: {
  projectPath?: string;
  scratchPath: string;
  dataDir: string;
}) {
  let loadedBytes = 0;
  const cache = new Map<
    string,
    Promise<{ bytes: Uint8Array; mimeType: string; extension: string }>
  >();
  const read = async (ref: string) => {
    const candidate = /^attachments[\\/][a-f0-9]{64}$/.test(ref)
      ? resolve(options.dataDir, ref)
      : isAbsolute(ref)
        ? ref
        : options.projectPath
          ? resolve(options.projectPath, ref)
          : resolve(options.scratchPath, ref);
    const path = await realpath(candidate);
    const roots = await Promise.all(
      [options.projectPath, options.scratchPath, resolve(options.dataDir, "attachments")]
        .filter((root): root is string => !!root)
        .map((root) =>
          realpath(root).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          }),
        ),
    );
    if (
      !roots.some((root) => {
        if (!root) return false;
        const rel = relative(root, path);
        return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
      })
    )
      throw Object.assign(new Error("Image input is outside the session and project roots"), {
        errorCode: "IMAGE_INPUT_OUTSIDE_ROOT",
      });
    const file = await open(path, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES)
        throw Object.assign(new Error("Image input is too large"), {
          errorCode: "IMAGE_INPUT_INVALID",
        });
      // A bounded read still holds if another process grows the file after stat.
      const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_IMAGE_BYTES + 1));
      let size = 0;
      while (size < bytes.length) {
        const read = await file.read(bytes, size, bytes.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      const data = bytes.subarray(0, size);
      if (loadedBytes + size > 64 * 1024 * 1024)
        throw Object.assign(new Error("Batch image inputs exceed 64 MB"), {
          errorCode: "IMAGE_INPUT_TOO_LARGE",
        });
      loadedBytes += size;
      return { bytes: data, ...generatedImageType(data) };
    } finally {
      await file.close();
    }
  };
  return async (refs: string[]) => {
    const images = await Promise.all(
      refs.map((ref) => {
        let image = cache.get(ref);
        if (!image) {
          image = read(ref);
          cache.set(ref, image);
        }
        return image;
      }),
    );
    if (images.reduce((size, image) => size + image.bytes.length, 0) > 32 * 1024 * 1024)
      throw Object.assign(new Error("Image inputs exceed 32 MB"), {
        errorCode: "IMAGE_INPUT_TOO_LARGE",
      });
    return images;
  };
}
