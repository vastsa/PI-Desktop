import {
  GEN_UI_ERROR_MESSAGE,
  GEN_UI_KEY_MESSAGE,
  GEN_UI_READY_MESSAGE,
  GEN_UI_SIZE_MESSAGE,
  GEN_UI_THEME_MESSAGE,
  GEN_UI_VIEW_MESSAGE,
  GEN_UI_WHEEL_MESSAGE,
  isGenUiErrorCode,
  type GenUiErrorCode,
} from "@pi-desktop/shared";
import {
  GEN_UI_ASSET_ORIGIN,
  type GenUiKit,
  rewriteGenUiVendorUrls,
  stripPreloadedGenUiScripts,
} from "./gen-ui-kit";

/**
 * Host shell around a model-written visualization fragment
 * (ADR gen-ui-inline-visualization).
 *
 * The fragment runs in a sandboxed, opaque-origin iframe. Everything the guest
 * is allowed to do is decided here: the CSP blocks every network fetch, form,
 * frame, and `<base>` change, and the Permissions-Policy denies device and
 * clipboard features. The only host contact is the `postMessage` shapes in the
 * inline runtime: the guest announces it is ready, reports its content height,
 * wheel input, and Escape presses, and accepts theme variables and the view
 * mode from its parent. An error shell additionally reports its error code.
 *
 * This module is pure so the policy strings and the shell are testable without
 * Electron.
 */

/** Sent both as a response header and as a `<meta>` so a saved copy keeps it. */
export const GEN_UI_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  // Bundled kit libraries only (see gen-ui-kit.ts); never a remote origin.
  `script-src 'unsafe-inline' ${GEN_UI_ASSET_ORIGIN}`,
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  // connect-src does not cover WebRTC ICE (STUN/TURN), which could carry
  // data out; block it where the directive is supported.
  "webrtc 'block'",
].join("; ");

export const GEN_UI_PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "clipboard-read=()",
  "clipboard-write=()",
  "display-capture=()",
  "usb=()",
  "serial=()",
  "hid=()",
  "payment=()",
  "fullscreen=()",
].join(", ");

/**
 * Headers for every `pi-genui:` response, success or error. There is
 * deliberately no `Access-Control-Allow-Origin`: no other renderer context may
 * read a visualization's bytes.
 */
export function genUiResponseHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    // Response-level sandbox also protects callers that omit iframe sandbox.
    // Unlike the fetch restrictions, this forces a distinct opaque origin.
    // CSP sandbox is not supported in meta elements, so keep it header-only.
    "content-security-policy": `${GEN_UI_CONTENT_SECURITY_POLICY}; sandbox allow-scripts`,
    "permissions-policy": GEN_UI_PERMISSIONS_POLICY,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  };
}

/**
 * Shell rules layered over the kit stylesheet: a paint gutter so focus rings
 * and shadows at the edge are not clipped, hidden root scrollbars (the card
 * follows content height, so a transient overflow must not leave a bar), and
 * centering in the expanded view.
 */
const SHELL_CSS = `:root { --visualize-paint-gutter: 12px; }
html, body { scrollbar-width: none !important; }
html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }
svg, canvas, img, video { max-width: 100%; }
html[data-pi-genui-view="expanded"] body {
  display: flex;
  min-height: 100vh;
  flex-direction: column;
  justify-content: safe center;
  align-items: safe center;
}`;

/** Minimal styling for the error page, which does not load the kit. */
const ERROR_CSS = `:root { color-scheme: light dark; }
html, body { margin: 0; background: transparent; }
body { padding: 12px; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }`;

/**
 * The guest runtime. It announces itself as soon as it runs (from `<head>`, so
 * the parent can post the theme before the fragment paints), reports height,
 * wheel input, and Escape presses to the parent, and applies theme variables
 * the parent posts. Theme input is untrusted in shape: only
 * `--custom-property` names with short string values are applied, capped in
 * count, and messages from anything but the parent frame are ignored.
 */
const THEME_VAR_NAME = /^--[A-Za-z0-9_-]{1,64}$/;
const MAX_THEME_VARS = 128;
const MAX_THEME_VALUE_LENGTH = 256;

const RUNTIME_SCRIPT = `(() => {
  const SIZE = ${JSON.stringify(GEN_UI_SIZE_MESSAGE)};
  const THEME = ${JSON.stringify(GEN_UI_THEME_MESSAGE)};
  const WHEEL = ${JSON.stringify(GEN_UI_WHEEL_MESSAGE)};
  const VIEW = ${JSON.stringify(GEN_UI_VIEW_MESSAGE)};
  const READY = ${JSON.stringify(GEN_UI_READY_MESSAGE)};
  const KEY = ${JSON.stringify(GEN_UI_KEY_MESSAGE)};
  const NAME = ${THEME_VAR_NAME.toString()};
  const MAX_VARS = ${MAX_THEME_VARS};
  const MAX_VALUE = ${MAX_THEME_VALUE_LENGTH};
  const root = document.documentElement;
  let frame = 0;
  let last = -1;
  const report = () => {
    frame = 0;
    const height = Math.ceil(root.getBoundingClientRect().height);
    if (height === last) return;
    last = height;
    parent.postMessage({ type: SIZE, height }, "*");
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(report); };
  new ResizeObserver(schedule).observe(root);
  addEventListener("load", schedule);
  addEventListener("wheel", (event) => {
    parent.postMessage(
      { type: WHEEL, deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode },
      "*",
    );
  }, { passive: true });
  // Keys typed in the guest never reach the host window; the expanded view
  // still has to close on Escape. No other key leaves the guest.
  addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    parent.postMessage({ type: KEY, key: "Escape" }, "*");
  });
  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const data = event.data;
    if (data && data.type === VIEW) {
      if (data.view === "inline" || data.view === "expanded") root.dataset.piGenuiView = data.view;
      return;
    }
    if (!data || data.type !== THEME) return;
    const vars = data.vars;
    if (!vars || typeof vars !== "object" || Array.isArray(vars)) return;
    let applied = 0;
    for (const [name, value] of Object.entries(vars)) {
      if (applied >= MAX_VARS) break;
      if (!NAME.test(name) || typeof value !== "string" || value.length > MAX_VALUE) continue;
      root.style.setProperty(name, value);
      applied += 1;
    }
    if (data.colorScheme === "light" || data.colorScheme === "dark") {
      root.style.colorScheme = data.colorScheme;
    }
  });
  parent.postMessage({ type: READY }, "*");
})();`;

/**
 * The runtime's theme filter as a host-side function, used for initial theme
 * variables baked into the shell. Same name pattern and caps as the runtime.
 */
export function sanitizeGenUiThemeVars(vars: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) return result;
  let applied = 0;
  for (const [name, value] of Object.entries(vars)) {
    if (applied >= MAX_THEME_VARS) break;
    if (!THEME_VAR_NAME.test(name) || typeof value !== "string" || value.length > MAX_THEME_VALUE_LENGTH) continue;
    // A value is written into a <style> block, so it must not close it or
    // start another declaration.
    if (/[<>{};\\]/.test(value)) continue;
    result[name] = value;
    applied += 1;
  }
  return result;
}

const LEADING_TRIVIA = /^(?:\uFEFF|\s|<!--[\s\S]*?-->)*/;
const DOCUMENT_START = /^<(?:!doctype|html|head|body)(?=[\s>/])/i;

/**
 * A fragment must not bring its own document: the shell's `<head>` is where
 * the CSP and runtime live, and a second `<html>` would let the guest's
 * markup decide what comes first.
 */
export function isFullHtmlDocument(source: string): boolean {
  const rest = source.replace(LEADING_TRIVIA, "");
  return DOCUMENT_START.test(rest);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shell(styles: string, head: string, body: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(GEN_UI_CONTENT_SECURITY_POLICY)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${styles}</style>
${head}
</head>
<body>
${body}
</body>
</html>
`;
}

export interface GenUiDocumentOptions {
  /** Kit stylesheet and runtime; see `gen-ui-kit.ts`. */
  kit: Pick<GenUiKit, "css" | "head" | "runtime" | "vendorUrls">;
  /** Initial theme variables; filtered with `sanitizeGenUiThemeVars`. */
  themeVars?: Record<string, string>;
}

function themeStyle(themeVars: Record<string, string> | undefined): string {
  const vars = sanitizeGenUiThemeVars(themeVars);
  const entries = Object.entries(vars);
  if (entries.length === 0) return "";
  return `<style>:root{${entries.map(([name, value]) => `${name}:${value};`).join("")}}</style>`;
}

/**
 * Wrap a validated fragment in the host shell: kit stylesheet and host runtime
 * in `<head>`, then the fragment, then the kit runtime so its tooltip and tab
 * scripts see the fragment's markup. Pinned library URLs in the fragment
 * are rewritten to bundled copies.
 */
export function buildGenUiDocument(fragment: string, options: GenUiDocumentOptions): string {
  const { kit } = options;
  return shell(
    `${kit.css}\n${SHELL_CSS}`,
    `${themeStyle(options.themeVars)}<script>${RUNTIME_SCRIPT}</script>${kit.head}`,
    `${rewriteGenUiVendorUrls(stripPreloadedGenUiScripts(fragment), kit.vendorUrls)}\n${kit.runtime}`,
  );
}

/**
 * Fallback text per error code. The renderer replaces the card with its own
 * localized "unavailable" state when it receives the code, so this text only
 * shows if that message is lost.
 */
const ERROR_FALLBACK_TEXT: Record<GenUiErrorCode, string> = {
  "not-found": "Visualization not found.",
  "too-large": "Visualization is too large to display.",
  "not-fragment": "Visualization must be an HTML fragment, not a full document.",
  "runtime-unavailable": "Visualization runtime is unavailable.",
};

/**
 * A fixed error shell for `code`. It says nothing about the filesystem and
 * embeds no caller text; an unknown code degrades to `not-found`. It runs the
 * runtime so the card sizes itself, then posts `GEN_UI_ERROR_MESSAGE` with the
 * code so the renderer can show a localized reason.
 */
export function buildGenUiErrorDocument(code: GenUiErrorCode): string {
  const known: GenUiErrorCode = isGenUiErrorCode(code) ? code : "not-found";
  const report = JSON.stringify({ type: GEN_UI_ERROR_MESSAGE, code: known });
  return shell(
    ERROR_CSS,
    `<script>${RUNTIME_SCRIPT}</script><script>parent.postMessage(${report}, "*");</script>`,
    `<p style="margin:0;opacity:0.7">${escapeHtml(ERROR_FALLBACK_TEXT[known])}</p>`,
  );
}
