#!/usr/bin/env node
// Focused production-component browser regression; no Electron/native host needed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const temp = await mkdtemp(join(tmpdir(), "pi-bidi-"));
try {
  await build({
    stdin: { contents: `import { bidiDirectionProbe } from './scripts/e2e/bidi-direction';
      import { createInstance } from 'i18next';
      import { en } from '@pi-desktop/i18n';
      const i18n = createInstance();
      i18n.init({lng:'en',resources:{en:{translation:en}},interpolation:{escapeValue:false}})
        .then(() => bidiDirectionProbe(i18n))
        .then(result => document.body.textContent = 'BIDI_RESULT ' + JSON.stringify(result))
        .catch(error => document.body.textContent = 'BIDI_ERROR ' + error.stack);`, resolveDir: root, loader: "tsx" },
    outfile: join(temp, "probe.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"DEV":false,"MODE":"production"}' },
    loader: { ".css": "empty" },
    alias: { "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"), react: join(root, "apps/desktop/node_modules/react"), "react-dom": join(root, "apps/desktop/node_modules/react-dom") },
    nodePaths: [join(root, "apps/desktop/node_modules")],
    plugins: [{ name: "local-url-assets", setup(builder) {
      builder.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({ path: resolve(resolveDir, path.slice(0, -4)), namespace: "asset" }));
      builder.onLoad({ filter: /.*/, namespace: "asset" }, async ({ path }) => ({ contents: await readFile(path), loader: "file" }));
    } }],
  });
  const renderer = join(root, "apps/desktop/out/renderer");
  const html = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...html.matchAll(/href="([^" ]+\.css)"/g)].map(match => match[1]);
  assert(css.length, "build desktop first");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  await writeFile(join(temp, "index.html"), `<!doctype html><meta charset="utf-8">${css.map(path => `<link rel="stylesheet" href="${path}">`).join("")}<body><script src="probe.js"></script>`);
  const binary = process.env.CHROMIUM_BINARY;
  assert(binary, "set CHROMIUM_BINARY to an installed Chromium/headless-shell binary");
  const child = spawn(binary, ["--no-sandbox", "--headless", "--disable-gpu", "--allow-file-access-from-files", "--dump-dom", "--virtual-time-budget=10000", `file://${join(temp, "index.html")}`], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", chunk => output += chunk);
  child.stderr.on("data", chunk => errors += chunk);
  const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
  const code = await new Promise((done, reject) => { child.on("error", reject); child.on("close", done); }).finally(() => clearTimeout(timer));
  assert.equal(code, 0, errors);
  const match = output.match(/BIDI_RESULT (\{[^<]+\})/);
  assert(match, output + errors);
  const result = JSON.parse(match[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
  assert.equal(result.ok, true);
  console.log("BIDI_RESULT " + JSON.stringify(result));
} finally {
  await rm(temp, { recursive: true, force: true });
}
