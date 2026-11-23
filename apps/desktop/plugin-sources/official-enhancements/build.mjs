/**
 * Build the plugin's one distributable surface.
 *
 * PI-Desktop installs plugins without compiling anything, so the artifact this
 * produces is committed-ready:
 *
 * - `views/index.html`: the configuration view, a React page bundled with
 *   Tailwind's compiled CSS inlined (the sandboxed page may not load a
 *   stylesheet from a CDN).
 *
 * There is no renderer bundle: the plugin's only renderer surface was the
 * changed-files card, which is host-native now, so the plugin renders nothing
 * inside the app window and declares no `renderer` entry.
 *
 * Run from this directory: `node build.mjs`.
 */

import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const views = join(here, "../../resources/plugins/pi.official-enhancements/views");

async function buildView() {
  const result = await build({
    entryPoints: [join(here, "src/view/App.jsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    jsx: "transform",
    minify: true,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '\"production\"' },
  });
  const js = result.outputFiles[0].text;
  // The view is a sandboxed page with no CDN reach, so the compiled stylesheet
  // is inlined next to the script.
  const css = readFileSync(join(here, "dist/view.css"), "utf8");
  const html = readFileSync(join(here, "src/view/index.html"), "utf8")
    // Replacer functions preserve literal $&, $$, and other bundle tokens.
    .replace("<!--VIEW_STYLE-->", () => css)
    .replace("<!--VIEW_SCRIPT-->", () => js);
  mkdirSync(views, { recursive: true });
  writeFileSync(join(views, "index.html"), html, "utf8");
  return { bytes: html.length, file: "views/index.html" };
}

const view = await buildView();
console.log(`${view.file}  ${(view.bytes / 1024).toFixed(1)} KB`);
