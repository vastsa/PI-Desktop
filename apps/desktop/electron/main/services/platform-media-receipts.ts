import { open, realpath, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { mediaError, withinMediaRoot } from "./platform-media-input";

export async function readMediaJson(path: string, maxBytes = 72 * 1024 * 1024): Promise<Record<string, unknown>> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw mediaError("INVALID_RECEIPT", "Receipt is not a bounded regular file.");
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > stat.size) throw mediaError("INVALID_RECEIPT", "Receipt changed while reading.");
    const data: unknown = JSON.parse(bytes.subarray(0, size).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw mediaError("INVALID_RECEIPT", "Invalid receipt object.");
    return data as Record<string, unknown>;
  } finally { await file.close(); }
}

export async function readOwnedMediaReceipt(receipt: string, scratchPath: string, providerId: string) {
  const path = await realpath(resolve(scratchPath, receipt));
  const root = await realpath(join(scratchPath, "platform-media"));
  if (!withinMediaRoot(root, path) || dirname(dirname(path)) !== root || !/\.(request|task)\.json$/.test(path))
    throw mediaError("INVALID_RECEIPT", "Use a PlatformMedia receipt from this session's scratch directory.");
  const markerPath = join(dirname(path), "invocation.json");
  if (await realpath(markerPath) !== markerPath) throw mediaError("INVALID_RECEIPT", "Invalid receipt ownership marker.");
  const marker = await readMediaJson(markerPath, 4096);
  if (marker.providerId !== providerId) throw mediaError("INVALID_RECEIPT", "This receipt belongs to another platform provider row.");
  const journal = await readMediaJson(path);
  if (!["image", "image_batch", "video"].includes(String(journal.kind)))
    throw mediaError("INVALID_RECEIPT", "Unsupported media receipt.");
  return { path, journal };
}

/** Copy only data needed by the CLI into fresh, host-chosen destinations.
 * Receipt JSON is untrusted: embedded paths can never choose our output files.
 */
export async function copyImageReceipt(options: {
  receipt: string;
  scratchPath: string;
  providerId: string;
  directory: string;
}): Promise<string> {
  const { path, journal } = await readOwnedMediaReceipt(options.receipt, options.scratchPath, options.providerId);
  const items = journal.kind === "image_batch" ? journal.items : [{ receipt: path }];
  if (!Array.isArray(items) || !items.length || items.length > 10)
    throw mediaError("INVALID_RECEIPT", "Invalid image batch receipt.");
  const copied: { receipt: string }[] = [];
  for (const [index, item] of items.entries()) {
    if (!item || typeof item.receipt !== "string") throw mediaError("INVALID_RECEIPT", "Invalid child receipt.");
    const child = await readOwnedMediaReceipt(item.receipt, options.scratchPath, options.providerId);
    if (child.journal.kind !== "image" || dirname(child.path) !== dirname(path))
      throw mediaError("INVALID_RECEIPT", "Image child receipt is outside its original invocation.");
    const out = join(options.directory, `image-${index + 1}.png`);
    const receipt = `${out}.request.json`;
    await writeFile(receipt, JSON.stringify({
      kind: "image", model: child.journal.model, count: 1, out,
      state: child.journal.state, response: child.journal.response,
      request_id: child.journal.request_id,
    }), { flag: "wx", mode: 0o600 });
    copied.push({ receipt });
  }
  if (journal.kind === "image") return copied[0].receipt;
  const receipt = join(options.directory, "image.png.request.json");
  await writeFile(receipt, JSON.stringify({
    kind: "image_batch", model: journal.model, count: copied.length, items: copied,
    out: join(options.directory, "image.png"),
  }), { flag: "wx", mode: 0o600 });
  return receipt;
}

export async function mediaRecovery(directory: string): Promise<Record<string, unknown>> {
  const receipts: Record<string, unknown>[] = [];
  for (const name of (await readdir(directory)).filter((name) => /\.(request|task)\.json$/.test(name)).slice(0, 11)) {
    const path = join(directory, name);
    if (await realpath(path) !== path) continue;
    try {
      const data = await readMediaJson(path);
      receipts.push({ receipt: path, kind: data.kind, status: data.status ?? data.state,
        submissionState: data.submission_state, taskId: data.task_id, requestId: data.request_id });
    } catch (error) {
      // A process can die during the initial exclusive reservation. Preserve
      // the location even if that first receipt has incomplete JSON.
      receipts.push({ receipt: path, status: "unknown", message: error instanceof SyntaxError ? "Receipt is incomplete." : "Receipt could not be read." });
    }
  }
  const primary = receipts.find((item) => item.kind === "image_batch") ?? receipts[0];
  return {
    ...primary, receipts,
    invocation: join(directory, "invocation.json"),
    noAutomaticResubmit: true,
    message: "A submitted request may be billed even when interrupted. Recover the saved receipt or query the same task; do not repeat generation automatically.",
  };
}
