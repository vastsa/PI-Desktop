import { createHash } from "node:crypto";
import { mkdir, rename, unlink } from "node:fs/promises";
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
  const partialPath = `${targetPath}.partial`;

  // Dynamic import of @huggingface/hub
  const { downloadFile } = await import("@huggingface/hub");

  const response = await downloadFile({
    repo: info.hfRepo,
    path: info.hfFilename,
    revision: info.hfRevision,
  });

  if (!response) {
    throw new Error(`Failed to download model: file not found`);
  }

  const contentLength = response.size || info.sizeBytes;
  let received = 0;

  const { createWriteStream } = await import("node:fs");
  const writer = createWriteStream(partialPath);
  const hash = createHash("sha256");
  let writerError: Error | undefined;
  writer.on("error", (error) => {
    writerError = error instanceof Error ? error : new Error(String(error));
  });

  const waitForDrain = async (): Promise<void> => {
    if (writerError) throw writerError;
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        writer.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        writer.off("drain", onDrain);
        reject(error);
      };
      writer.once("drain", onDrain);
      writer.once("error", onError);
    });
  };

  const finishWriter = async (): Promise<void> => {
    if (writerError) throw writerError;
    await new Promise<void>((resolve, reject) => {
      const onFinish = () => {
        writer.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        writer.off("finish", onFinish);
        reject(error);
      };
      writer.once("finish", onFinish);
      writer.once("error", onError);
      writer.end();
    });
    if (writerError) throw writerError;
  };

  try {
    const reader = response.stream().getReader();

    while (true) {
      if (signal?.aborted) {
        reader.cancel();
        throw new DOMException("Download aborted", "AbortError");
      }

      const { done, value } = await reader.read();
      if (done) break;

      const buffer = Buffer.from(value);
      hash.update(buffer);
      if (!writer.write(buffer)) await waitForDrain();
      received += value.byteLength;
      yield contentLength > 0 ? received / contentLength : 0;
    }

    await finishWriter();

    const actualSha256 = hash.digest("hex");
    if (!/^[a-f0-9]{64}$/i.test(info.sha256)) {
      throw new Error(`Model ${info.id} has no valid pinned SHA-256 checksum`);
    }
    if (actualSha256 !== info.sha256.toLowerCase()) {
      throw new Error(
        `Model checksum mismatch: expected ${info.sha256}, got ${actualSha256}`,
      );
    }

    await rename(partialPath, targetPath);

    yield 1;
  } catch (error) {
    writer.destroy();
    // Clean up partial file
    await unlink(partialPath).catch(() => {});
    throw error;
  }
}
