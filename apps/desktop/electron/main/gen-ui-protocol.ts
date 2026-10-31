import { protocol, type CustomScheme } from "electron";
import { readFile } from "node:fs/promises";
import {
  GEN_UI_SCHEME,
  genUiLocationFromUrl,
  type GenUiErrorCode,
} from "@pi-desktop/shared";
import { GEN_UI_ASSET_HOST, genUiAssetFileFromUrl, type GenUiKit, loadGenUiKit, resolveGenUiKitDir } from "./gen-ui-kit";
import {
  buildGenUiDocument,
  buildGenUiErrorDocument,
  genUiResponseHeaders,
  isFullHtmlDocument,
} from "./gen-ui-document";
import { createGenUiFragmentReader, type GenUiFragmentHost, type GenUiFragmentReader } from "./gen-ui-files";

/**
 * Serve model-written visualization fragments to transcript cards
 * (ADR gen-ui-inline-visualization).
 *
 * URLs are `pi-genui://session/<sessionId>/<file>.html`. The file is resolved
 * against the *current* data directory on every request, so a reference in
 * an old message keeps working after the data directory moves. The response is
 * the fragment wrapped in the host shell from `gen-ui-document.ts`, which
 * carries the CSP, the Permissions-Policy, and the size/theme runtime.
 */

/**
 * `standard` gives URLs a host and path and lets the iframe document resolve
 * like a page; `secure` keeps the embedding from counting as mixed content.
 * Nothing else: without `supportFetchAPI`/`corsEnabled`, and with no
 * `Access-Control-Allow-Origin` on responses, no other renderer context —
 * including renderer plugins in the main window — can read a visualization's
 * bytes. Only a frame navigation can load it. `bypassCSP` is never set: the
 * guest's own CSP must apply.
 */
export const GEN_UI_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: GEN_UI_SCHEME,
  privileges: {
    standard: true,
    secure: true,
  },
};

export type GenUiResolveResult =
  | { ok: true; document: string }
  | { ok: false; status: 404 | 405 | 413 | 422 | 500; code: GenUiErrorCode };

const NOT_FOUND = { ok: false, status: 404, code: "not-found" } as const;

/**
 * Resolve one request through the native reader and build its shell. The
 * dependency boundary is tested without Electron. Errors carry a fixed
 * code the card localizes; they never echo a path.
 */
export async function resolveGenUiRequest(input: {
  method: string;
  url: string;
  readFragment: GenUiFragmentReader;
  loadKit: () => Promise<GenUiKit>;
}): Promise<GenUiResolveResult> {
  if (input.method !== "GET") {
    return { ok: false, status: 405, code: "not-found" };
  }
  const location = genUiLocationFromUrl(input.url);
  if (!location) return NOT_FOUND;

  const result = await input.readFragment(location);
  if (!result.ok) return result;
  const { fragment } = result;
  if (isFullHtmlDocument(fragment)) {
    return { ok: false, status: 422, code: "not-fragment" };
  }

  let kit: GenUiKit;
  try {
    kit = await input.loadKit();
  } catch {
    // A shell without its kit would look loaded while tooltips, tabs, and
    // icons silently fail; show the unavailable state instead.
    return { ok: false, status: 500, code: "runtime-unavailable" };
  }
  return { ok: true, document: buildGenUiDocument(fragment, { kit }) };
}

export type GenUiAssetResult = { ok: true; body: Buffer } | { ok: false; status: 404 | 405 };

/**
 * Serve one bundled kit library. Only files listed in the vendor manifest are
 * served, by exact name; nothing under the data directory is reachable here.
 */
export async function resolveGenUiAssetRequest(input: {
  method: string;
  url: string;
  loadKit: () => Promise<GenUiKit>;
}): Promise<GenUiAssetResult> {
  if (input.method !== "GET") return { ok: false, status: 405 };
  const file = genUiAssetFileFromUrl(input.url);
  if (!file) return { ok: false, status: 404 };
  try {
    const path = (await input.loadKit()).vendorFiles.get(file);
    if (!path) return { ok: false, status: 404 };
    return { ok: true, body: await readFile(path) };
  } catch {
    return { ok: false, status: 404 };
  }
}

/** Bundled libraries are immutable per app build, so they may be cached. */
export function genUiAssetResponse(result: GenUiAssetResult): Response {
  if (!result.ok) return new Response(null, { status: result.status });
  return new Response(new Uint8Array(result.body), {
    status: 200,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

/** Turn a resolve result into the HTTP response the frame receives. */
export function genUiResponse(result: GenUiResolveResult): Response {
  if (result.ok) {
    return new Response(result.document, { status: 200, headers: genUiResponseHeaders() });
  }
  const headers = genUiResponseHeaders();
  if (result.status === 405) headers.allow = "GET";
  return new Response(buildGenUiErrorDocument(result.code), {
    status: result.status,
    headers,
  });
}

function isGenUiAssetRequest(url: string): boolean {
  try {
    return new URL(url).hostname === GEN_UI_ASSET_HOST;
  } catch {
    return false;
  }
}

let kitPromise: Promise<GenUiKit> | null = null;

/** Load the kit once per process; a failed load is retried on the next request. */
function loadInstalledKit(): Promise<GenUiKit> {
  if (!kitPromise) {
    const dir = resolveGenUiKitDir();
    kitPromise = dir ? loadGenUiKit(dir) : Promise.reject(new Error("gen-ui kit directory not found"));
    kitPromise.catch((error: unknown) => {
      kitPromise = null;
      console.warn("[gen-ui] visualization kit unavailable:", error instanceof Error ? error.message : error);
    });
  }
  return kitPromise;
}

/**
 * Install once after ready. Resolve the current local Host per request so
 * profile relocation and runtime restarts never reuse a stale reader.
 */
export function installGenUiProtocol(input: { getHost: () => GenUiFragmentHost | null }): void {
  const readFragment = createGenUiFragmentReader(input.getHost);
  protocol.handle(GEN_UI_SCHEME, async (request) => {
    if (isGenUiAssetRequest(request.url)) {
      return genUiAssetResponse(
        await resolveGenUiAssetRequest({ method: request.method, url: request.url, loadKit: loadInstalledKit }),
      );
    }
    return genUiResponse(
      await resolveGenUiRequest({
        method: request.method,
        url: request.url,
        readFragment,
        loadKit: loadInstalledKit,
      }),
    );
  });
}
