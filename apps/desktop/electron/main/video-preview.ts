import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FsVideoSource } from "@pi-desktop/shared";

export const VIDEO_SCHEME = "pi-video";

/** Native-file capabilities, never arbitrary file:// access or base64 video IPC. */
export class VideoPreviewService {
  private readonly sources = new Map<string, string>();
  private epoch = 0;

  private readonly resolvePath: (ref: string) => Promise<string | null>;
  private readonly chooseSavePath: (name: string) => Promise<string | null>;

  constructor(
    resolvePath: (ref: string) => Promise<string | null>,
    chooseSavePath: (name: string) => Promise<string | null>,
  ) { this.resolvePath = resolvePath; this.chooseSavePath = chooseSavePath; }

  private async openVideo(ref: string): Promise<{ file: FileHandle; path: string; size: number; mime: string }> {
    const path = await this.resolvePath(ref);
    if (!path) throw new Error("Video is outside allowed roots or missing");
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error("Not a video file");
      const header = Buffer.alloc(12);
      await file.read(header, 0, header.length, 0);
      const extension = extname(path).toLowerCase();
      let mime: string | null = null;
      if ([".mp4", ".m4v", ".mov"].includes(extension) && header.toString("ascii", 4, 8) === "ftyp") {
        mime = extension === ".mov" ? "video/quicktime" : "video/mp4";
      } else if (extension === ".webm" && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
        mime = "video/webm";
      } else if (extension === ".ogv" && header.toString("ascii", 0, 4) === "OggS") {
        mime = "video/ogg";
      }
      if (!mime) throw new Error("Unsupported video container");
      return { file, path, size: info.size, mime };
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  async acquire(ref: string): Promise<FsVideoSource> {
    const epoch = this.epoch;
    const video = await this.openVideo(ref);
    await video.file.close();
    if (epoch !== this.epoch) throw new Error("Video preview canceled");
    // Bound abandoned leases after a renderer reload. Normal unmount releases immediately.
    if (this.sources.size >= 512) throw new Error("Too many active video previews");
    const url = `${VIDEO_SCHEME}://preview/${randomUUID()}`;
    this.sources.set(url, video.path);
    return { url, name: basename(video.path), mimeType: video.mime };
  }

  release(url: string): void { this.sources.delete(url); }
  clear(): void { this.epoch++; this.sources.clear(); }

  async respond(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
    const path = this.sources.get(request.url);
    if (!path) return new Response(null, { status: 404 });
    let video: Awaited<ReturnType<VideoPreviewService["openVideo"]>>;
    try { video = await this.openVideo(path); }
    catch { return new Response(null, { status: 404 }); }
    const { file, size, mime } = video;
    const headers = new Headers({
      "content-type": mime, "accept-ranges": "bytes",
      "cache-control": "no-store", "x-content-type-options": "nosniff",
    });
    let start = 0;
    let end = size - 1;
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
      } else { start = size; }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
        await file.close();
        headers.set("content-range", `bytes */${size}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set("content-range", `bytes ${start}-${end}/${size}`);
    }
    headers.set("content-length", String(end - start + 1));
    if (request.method === "HEAD") {
      await file.close();
      return new Response(null, { status: range ? 206 : 200, headers });
    }
    const stream = file.createReadStream({ start, end, autoClose: true });
    const abort = () => stream.destroy();
    request.signal.addEventListener("abort", abort, { once: true });
    stream.once("close", () => request.signal.removeEventListener("abort", abort));
    if (request.signal.aborted) stream.destroy();
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
  }

  async save(url: string): Promise<{ canceled: boolean }> {
    const path = this.sources.get(url);
    if (!path) throw new Error("Video preview expired");
    const destination = await this.chooseSavePath(basename(path));
    if (!destination) return { canceled: true };
    // Recheck containment after the dialog: the project or file may have changed.
    const video = await this.openVideo(path);
    try {
      if (resolve(destination) === resolve(video.path)) return { canceled: false };
      const output = await open(destination, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const [sourceInfo, outputInfo] = await Promise.all([video.file.stat(), output.stat()]);
        if (sourceInfo.dev === outputInfo.dev && sourceInfo.ino === outputInfo.ino) return { canceled: false };
        await output.truncate(0);
        await pipeline(video.file.createReadStream({ start: 0, autoClose: true }), output.createWriteStream({ autoClose: true }));
      } finally { await output.close(); }
    } finally { await video.file.close(); }
    return { canceled: false };
  }
}
