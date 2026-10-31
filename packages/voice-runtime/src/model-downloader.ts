import { mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { ModelInfo } from "./types.js";

/**
 * Download a model from HuggingFace Hub to targetDir.
 * Yields progress 0–1. Supports abort via signal.
 *
 * Bytes land at `<target>.part` and are renamed into place only after the
 * stream completed, so an interrupted download never leaves a truncated
 * file behind for `ModelManager` to mistake for a finished one.
 */
export async function* downloadModel(
  info: ModelInfo,
  targetDir: string,
  signal?: AbortSignal,
): AsyncGenerator<number, void, unknown> {
  await mkdir(targetDir, { recursive: true });

  const targetPath = path.join(targetDir, info.hfFilename);
  const partPath = `${targetPath}.part`;

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
  const writer = createWriteStream(partPath);
  // A write error (ENOSPC, EIO) must surface as a failed download, not as
  // an unhandled 'error' event — downloads run in the Electron main
  // process, where that is an app crash. The rejection races the source
  // reads below; the pre-attached catch keeps a rejection nobody is
  // awaiting from turning into an unhandledRejection.
  let streamError: unknown = null;
  let rejectStreamFailure: ((error: unknown) => void) | null = null;
  const streamFailure = new Promise<never>((_, reject) => {
    rejectStreamFailure = reject;
  });
  streamFailure.catch(() => {});
  writer.on("error", (error: unknown) => {
    streamError = error;
    rejectStreamFailure?.(error);
  });
  // 'close' fires on every terminal path (end, destroy, autoClose on
  // error) and means the file handle is released — awaited before the
  // rename and before unlinking a failed download, both of which fail
  // with EBUSY/EPERM on Windows while the handle is still open.
  const writerClosed = new Promise<void>((resolve) => {
    writer.once("close", () => resolve());
  });

  const reader = response.body.getReader();

  try {
    while (true) {
      if (signal?.aborted) {
        reader.cancel();
        throw new DOMException("Download aborted", "AbortError");
      }

      const { done, value } = await Promise.race([reader.read(), streamFailure]);
      if (done) break;

      writer.write(Buffer.from(value));
      received += value.byteLength;
      yield contentLength > 0 ? received / contentLength : 0;
    }

    await new Promise<void>((resolve, reject) => {
      writer.end(() => resolve());
      writer.on("error", reject);
    });
    if (streamError) throw streamError;

    await writerClosed;
    await rename(partPath, targetPath);
    yield 1;
  } catch (error) {
    // A sink error can win the race while reader.read() is still waiting.
    // Cancel the response so a failed disk write does not keep downloading.
    await reader.cancel(error).catch(() => {});
    writer.destroy();
    await writerClosed;
    // Clean up the partial download; the final path is never touched.
    await unlink(partPath).catch(() => {});
    throw error;
  }
}
