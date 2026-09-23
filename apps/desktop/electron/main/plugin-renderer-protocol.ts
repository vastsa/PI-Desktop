import { protocol, type CustomScheme } from "electron";
import { readFileSync } from "node:fs";
import { PLUGIN_RENDERER_SCHEME } from "@pi-desktop/plugin-sdk";

/**
 * Serve a plugin's renderer entry modules over a host-owned scheme.
 *
 * The renderer host evaluates plugin code inside the app's own window, so the
 * bytes have to come from somewhere the host controls: `plugin-renderer://`
 * answers only for plugins the runtime has already loaded AND that declared
 * `manifest.renderer` AND that hold the `renderer.extension` permission. The
 * allowlist is not computed here — `resolve` owns it, exactly as it does for
 * theme assets — so a path that escapes the package, or a plugin that never
 * declared the entry, has no URL to begin with.
 *
 * This is why the scheme is separate from `plugin-asset`: that allowlist is
 * images and webfonts on purpose, and adding `js` to it would turn every theme
 * asset URL into a script URL.
 */
export type PluginRendererSourceResolver = (
  pluginId: string,
  requestPath: string,
) => string | null;

/**
 * Only files a module graph can consume. `json` and `map` are here so a plugin
 * may ship data and source maps; everything else is answered with 404 rather
 * than an empty body a loader would have to interpret.
 */
const MIME_TYPES: Record<string, string> = {
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  map: "application/json",
};

function mimeTypeFor(requestPath: string): string | null {
  const extension = requestPath.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[extension] ?? null;
}

function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain", "x-content-type-options": "nosniff" },
  });
}

/**
 * Privileges the scheme is reserved with, before the app is ready, by
 * `registerPluginSchemes`.
 *
 * `standard` gives the URL a host (the plugin id) and a path, `secure` keeps a
 * `https:` shell from treating the reference as mixed content, and fetch/CORS
 * are what a renderer-side module import from a `file://` origin needs.
 */
export const PLUGIN_RENDERER_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: PLUGIN_RENDERER_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
};

/** Install the request handler. Call once, after the app is ready. */
export function installPluginRendererProtocol(resolve: PluginRendererSourceResolver): void {
  protocol.handle(PLUGIN_RENDERER_SCHEME, (request) => {
    // A renderer module is fetched, never posted to; anything but a read is a
    // caller that has gone wrong rather than a plugin that needs the verb.
    if (request.method !== "GET") return notFound();
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }
    // Plugin ids are `[a-z0-9]` dotted namespaces, so the host survives the URL
    // parser's lowercasing unchanged.
    const pluginId = url.hostname;
    let requestPath: string;
    try {
      requestPath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    } catch {
      return notFound();
    }
    if (!pluginId || !requestPath) return notFound();
    const mime = mimeTypeFor(requestPath);
    if (!mime) return notFound();
    const absolute = resolve(pluginId, requestPath);
    if (!absolute) return notFound();
    let body: Buffer;
    try {
      body = readFileSync(absolute);
    } catch {
      return notFound();
    }
    // Copy into a plain view: `Buffer` is a `Uint8Array` subtype that the DOM
    // `BodyInit` union does not accept, and this tsconfig loads both libs.
    const bytes = new Uint8Array(body);
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": mime,
        "content-length": String(body.byteLength),
        // A plugin module is replaced whenever the plugin reloads, so caching
        // it would outlive the code that produced it.
        "cache-control": "no-store",
        // A renderer module must never be sniffed into an executable type.
        "x-content-type-options": "nosniff",
        // The requesting origin is the app's own document, which is
        // cross-origin to any scheme; the resolver above, not this header, is
        // what keeps other plugins' files out of reach.
        "access-control-allow-origin": "*",
      },
    });
  });
}
