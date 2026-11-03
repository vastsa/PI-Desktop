import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { protocol, type CustomScheme } from "electron";
import {
  parseByteRange,
  STARTUP_ANIMATION_MAX_BYTES,
  STARTUP_ANIMATION_MIME_TYPES,
  STARTUP_ANIMATION_SCHEME,
} from "@pi-desktop/shared";
import type { ResolvedStartupAnimation } from "./startup-animation";

/**
 * Serve the user's boot animation over a host-owned scheme (ADR 0338).
 *
 * The renderer is sandboxed and its CSP admits no `file:` source, so the video
 * cannot be referenced by path — and should not be: a path in the page would
 * disclose the data directory to anything that later runs there. This handler
 * is the narrowest shape that solves it. There is exactly one URL, it carries
 * no path, host, or query the caller controls, and the bytes come from the
 * single file the main process resolved at boot. Nothing the renderer sends can
 * select a different file, so there is no traversal surface to confine.
 *
 * Media playback is range-driven, so the handler answers `Range` as well; a
 * `<video>` that cannot get a 206 falls back to buffering the whole response.
 */

/**
 * Privileges reserved before the app is ready, by `registerPluginSchemes`.
 *
 * `stream` is the one that matters for media: without it the response is
 * buffered whole before the first frame decodes, which is the opposite of what
 * a boot surface needs. `standard` and `secure` keep the URL parseable and
 * free of mixed-content treatment; no CORS privileges, because a `<video>`
 * `src` is a no-cors fetch and nothing else may read these bytes.
 */
export const STARTUP_ANIMATION_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: STARTUP_ANIMATION_SCHEME,
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

/**
 * Install the request handler. Call once, after the app is ready.
 *
 * The resolution is read per request rather than captured, so a window created
 * later in the process life answers from whatever the current launch resolved,
 * and a cleared resolution stops serving immediately.
 */
export function installStartupAnimationProtocol(
  current: () => ResolvedStartupAnimation | null,
): void {
  protocol.handle(STARTUP_ANIMATION_SCHEME, async (request) => {
    const resolved = current();
    if (!resolved) return notFound();
    const mime = STARTUP_ANIMATION_MIME_TYPES[resolved.descriptor.extension];
    if (!mime) return notFound();
    // Re-stat instead of trusting the boot-time size: the user may have
    // replaced the file while the app was running, and the range math has to
    // match the bytes this read will actually see.
    let size: number;
    try {
      const stats = await stat(resolved.filePath);
      if (!stats.isFile() || stats.size <= 0) return notFound();
      size = stats.size;
    } catch {
      return notFound();
    }
    if (size > STARTUP_ANIMATION_MAX_BYTES) return notFound();
    const range = parseByteRange(request.headers.get("range"), size);
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    const stream = Readable.toWeb(
      createReadStream(resolved.filePath, { start, end }),
    ) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: range ? 206 : 200,
      headers: {
        "content-type": mime,
        "content-length": String(end - start + 1),
        "accept-ranges": "bytes",
        ...(range
          ? { "content-range": `bytes ${start}-${end}/${size}` }
          : {}),
        // The user can swap the file between launches, so a cached copy would
        // outlive the animation it came from.
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
