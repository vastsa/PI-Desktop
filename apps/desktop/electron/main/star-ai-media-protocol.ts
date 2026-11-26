import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { protocol, type CustomScheme } from "electron";
import {
  GENERATED_MEDIA_MAX_BYTES,
  GENERATED_MEDIA_SCHEME,
  parseByteRange,
} from "@pi-desktop/shared";

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

export const GENERATED_MEDIA_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: GENERATED_MEDIA_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    stream: true,
  },
};

function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain", "x-content-type-options": "nosniff" },
  });
}

export function installGeneratedMediaProtocol(dataDir: string): void {
  const scratchRoot = resolve(dataDir, "scratch");
  protocol.handle(GENERATED_MEDIA_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }
    if (url.hostname !== "scratch") return notFound();
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return "";
        }
      });
    if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || part.includes("/") || part.includes("\\"))) {
      return notFound();
    }
    const candidate = resolve(scratchRoot, ...parts);
    const mime = MIME_BY_EXT[extname(candidate).toLowerCase()];
    if (!mime) return notFound();
    let realRoot: string;
    let realTarget: string;
    let size: number;
    try {
      realRoot = await realpath(scratchRoot);
      realTarget = await realpath(candidate);
      const rel = relative(realRoot, realTarget);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) return notFound();
      const stats = await stat(realTarget);
      if (!stats.isFile() || stats.size <= 0 || stats.size > GENERATED_MEDIA_MAX_BYTES) return notFound();
      size = stats.size;
    } catch {
      return notFound();
    }
    const range = parseByteRange(request.headers.get("range"), size);
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    const stream = Readable.toWeb(
      createReadStream(realTarget, { start, end }),
    ) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: range ? 206 : 200,
      headers: {
        "content-type": mime,
        "content-length": String(end - start + 1),
        "accept-ranges": "bytes",
        ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
