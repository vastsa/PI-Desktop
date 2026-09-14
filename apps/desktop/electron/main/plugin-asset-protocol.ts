import { protocol } from "electron";
import { readFileSync } from "node:fs";
import { THEME_ASSET_SCHEME } from "@pi-desktop/plugin-sdk";

/**
 * Serve a plugin's declared theme assets over a host-owned scheme.
 *
 * A theme that wants a photographic background cannot express one as a `data:`
 * URI: the sheet is capped at 256 KB and base64 inflates by a third. Instead a
 * theme declares its assets in the manifest, the host rewrites the matching
 * `url()` references to `plugin-asset://<pluginId>/<path>`, and this handler
 * hands back the bytes (ADR 0248).
 *
 * The allowlist is not computed here. `resolve` answers only for paths a loaded
 * plugin actually declared, already resolved inside that plugin's package, so a
 * path that was never declared — or that escapes the package — has no URL to
 * begin with. Nothing on disk outside a plugin package is reachable.
 */
export type PluginAssetResolver = (pluginId: string, assetPath: string) => string | null;

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  woff2: "font/woff2",
};

function mimeTypeFor(assetPath: string): string | null {
  const extension = assetPath.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[extension] ?? null;
}

function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain", "x-content-type-options": "nosniff" },
  });
}

/**
 * Reserve the scheme before the app is ready — Electron refuses to register
 * privileges afterwards.
 *
 * `standard` gives the URL a host and a path, `secure` keeps a `https:` shell
 * from treating the reference as mixed content, and the fetch/CORS pair is what
 * a stylesheet `url()` and a cross-origin webfont need.
 */
export function registerPluginAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: THEME_ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** Install the request handler. Call once, after the app is ready. */
export function installPluginAssetProtocol(resolve: PluginAssetResolver): void {
  protocol.handle(THEME_ASSET_SCHEME, (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }
    // Plugin ids are `[a-z0-9]` dotted namespaces, so the host survives the URL
    // parser's lowercasing unchanged.
    const pluginId = url.hostname;
    let assetPath: string;
    try {
      assetPath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    } catch {
      return notFound();
    }
    if (!pluginId || !assetPath) return notFound();
    const mime = mimeTypeFor(assetPath);
    if (!mime) return notFound();
    const absolute = resolve(pluginId, assetPath);
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
        // A theme asset is replaced when the plugin changes, so caching it
        // would outlive the plugin that owns it.
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        // Webfonts are fetched in CORS mode even from a stylesheet.
        "access-control-allow-origin": "*",
      },
    });
  });
}
