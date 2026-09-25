import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ModelInfo } from "./types.js";

/**
 * Download a model from HuggingFace Hub to targetDir.
 * Yields progress 0–1. Supports abort via signal.
 */
export async function* downloadModel(
  info: ModelInfo,
  targetDir: string,
  signal?: AbortSignal,
): AsyncGenerator<number, void, unknown> {
  await mkdir(targetDir, { recursive: true });

  const targetPath = path.join(targetDir, info.hfFilename);

  // Dynamic import of @huggingface/hub
  const { downloadFile } = await import("@huggingface/hub");

  const blob = await downloadFile({
    repo: info.hfRepo,
    path: info.hfFilename,
  });

  // In Node the hub SDK returns a Response-like object, not a Blob.
  const response = blob as unknown as Response;

  if (!response || !response.body) {
    throw new Error(`Failed to download model: no response body`);
  }

  const contentLength = Number(response.headers.get("content-length") || info.sizeBytes);
  let received = 0;

  const { createWriteStream } = await import("node:fs");
  const writer = createWriteStream(targetPath);

  try {
    const reader = response.body.getReader();

    while (true) {
      if (signal?.aborted) {
        reader.cancel();
        throw new DOMException("Download aborted", "AbortError");
      }

      const { done, value } = await reader.read();
      if (done) break;

      writer.write(Buffer.from(value));
      received += value.byteLength;
      yield contentLength > 0 ? received / contentLength : 0;
    }

    await new Promise<void>((resolve, reject) => {
      writer.end(() => resolve());
      writer.on("error", reject);
    });

    yield 1;
  } catch (error) {
    writer.destroy();
    // Clean up partial file
    const { unlink } = await import("node:fs/promises");
    await unlink(targetPath).catch(() => {});
    throw error;
  }
}
