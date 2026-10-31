import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GEN_UI_SCHEME } from "@pi-desktop/shared";
import { getModuleDirectory } from "./module-path";

/**
 * The visualize kit around a model-written fragment (ADR
 * gen-ui-inline-visualization): the stylesheet, the tooltip and tabs runtime
 * that follows the fragment, and the bundled browser libraries the
 * skill may load. Adapted from the ZCode visualize plugin; see
 * `resources/gen-ui/NOTICE.md`.
 *
 * Bundled libraries are referenced by their pinned CDN URLs in the skill and
 * the kit. The guest has no network, so the shell rewrites exactly those URLs
 * to `pi-genui://assets/<file>`, which this module serves from disk. Any other
 * remote URL stays as written and is blocked by the guest CSP.
 */

/** URL host for bundled kit assets: `pi-genui://assets/<file>`. */
export const GEN_UI_ASSET_HOST = "assets";
export const GEN_UI_ASSET_ORIGIN = `${GEN_UI_SCHEME}://${GEN_UI_ASSET_HOST}`;

/** Marker in `visualize-kit.html` where the fragment once sat; dropped. */
const KIT_FRAGMENT_MARKER = "<!--__INLINE_VISUALIZATION_FRAGMENT__-->";

const ASSET_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.js$/;

export interface GenUiKit {
  /** `visualize.css`, inlined into the shell `<head>`. */
  css: string;
  /** Runtime markup appended after the fragment. */
  runtime: string;
  /**
   * Markup loaded in `<head>` before the fragment: the bundled D3 and the
   * `viz` chart helpers (`visualize-helpers.js`), so fragment scripts can use
   * both without loading them.
   */
  head: string;
  /** Pinned CDN URL → `pi-genui://assets/<file>`. */
  vendorUrls: ReadonlyMap<string, string>;
  /** Bundled file name → absolute path; the only files `assets` serves. */
  vendorFiles: ReadonlyMap<string, string>;
}

interface VendorManifest {
  resources?: Array<{ url?: unknown; file?: unknown }>;
}

/** Parse `vendor/manifest.json` into the URL and file maps. Pure. */
export function parseGenUiVendorManifest(
  manifestJson: string,
  vendorDir: string,
): Pick<GenUiKit, "vendorUrls" | "vendorFiles"> {
  const manifest = JSON.parse(manifestJson) as VendorManifest;
  const vendorUrls = new Map<string, string>();
  const vendorFiles = new Map<string, string>();
  for (const resource of manifest.resources ?? []) {
    const { url, file } = resource;
    if (typeof url !== "string" || typeof file !== "string") continue;
    if (!url.startsWith("https://") || !ASSET_FILE_NAME.test(file)) continue;
    vendorUrls.set(url, `${GEN_UI_ASSET_ORIGIN}/${file}`);
    vendorFiles.set(file, join(vendorDir, file));
  }
  return { vendorUrls, vendorFiles };
}

/** Replace each pinned CDN URL with its bundled `pi-genui:` URL. Pure. */
export function rewriteGenUiVendorUrls(source: string, vendorUrls: ReadonlyMap<string, string>): string {
  let result = source;
  for (const [remote, local] of vendorUrls) result = result.replaceAll(remote, local);
  return result;
}

/** Parse `pi-genui://assets/<file>`; null for anything else. Pure. */
export function genUiAssetFileFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${GEN_UI_SCHEME}:` || parsed.hostname !== GEN_UI_ASSET_HOST) return null;
  if (parsed.search || parsed.hash || parsed.username || parsed.password || parsed.port) return null;
  const segments = parsed.pathname.split("/");
  if (segments.length !== 2 || segments[0] !== "") return null;
  return ASSET_FILE_NAME.test(segments[1]) ? segments[1] : null;
}

/** electron-builder copies `resources/gen-ui` to `<resources>/gen-ui`. */
export function resolveGenUiKitDir(): string | null {
  const moduleDir = getModuleDirectory(import.meta.url);
  const candidates = [
    join(process.resourcesPath || "", "gen-ui"),
    join(moduleDir, "../../resources/gen-ui"),
    join(moduleDir, "../../../resources/gen-ui"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, "visualize.css"))) return candidate;
  }
  return null;
}

/** Load the kit from `dir`. Throws when a file is missing or malformed. */
export async function loadGenUiKit(dir: string): Promise<GenUiKit> {
  const vendorDir = join(dir, "vendor");
  const [css, kitHtml, helpers, manifestJson] = await Promise.all([
    readFile(join(dir, "visualize.css"), "utf8"),
    readFile(join(dir, "visualize-kit.html"), "utf8"),
    readFile(join(dir, "visualize-helpers.js"), "utf8"),
    readFile(join(vendorDir, "manifest.json"), "utf8"),
  ]);
  const vendor = parseGenUiVendorManifest(manifestJson, vendorDir);
  return {
    css,
    head: genUiKitHead(helpers, vendor.vendorUrls),
    runtime: rewriteGenUiVendorUrls(kitHtml.replace(KIT_FRAGMENT_MARKER, ""), vendor.vendorUrls),
    ...vendor,
  };
}

/** Pinned D3 URL the skill used to require in every fragment. */
export const GEN_UI_D3_URL = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js";

/**
 * `<head>` markup: the bundled D3, then the chart helpers that build on it.
 * Throws when the manifest does not bundle D3, since the helpers need it.
 * Pure.
 */
export function genUiKitHead(helpers: string, vendorUrls: ReadonlyMap<string, string>): string {
  const d3 = vendorUrls.get(GEN_UI_D3_URL);
  if (!d3) throw new Error("gen-ui kit manifest does not bundle D3");
  if (/<\/script/i.test(helpers)) throw new Error("gen-ui helpers must not contain a closing script tag");
  return `<script src="${d3}"></script><script>${helpers}</script>`;
}

/**
 * Drop `<script src>` tags for D3 from a fragment: the shell already loads
 * it in `<head>`, and a second copy would replace the `d3` global the helpers
 * were built against. Older fragments written under the previous skill still
 * include the tag. Pure.
 */
export function stripPreloadedGenUiScripts(fragment: string): string {
  return fragment.replace(
    /<script\b[^>]*\bsrc\s*=\s*["']https:\/\/cdn\.jsdelivr\.net\/npm\/d3@7\.9\.0\/dist\/d3\.min\.js["'][^>]*>\s*<\/script>/gi,
    "",
  );
}
