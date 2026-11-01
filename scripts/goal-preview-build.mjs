import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "docs/artifacts/goal-preview-compact");
await mkdir(output, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ["scripts/goal-preview.tsx"], outfile: path.join(output, "preview.js"),
  bundle: true, format: "esm", platform: "browser", jsx: "automatic", minify: true,
  nodePaths: [path.join(root, "apps/desktop/node_modules")], define: { "process.env.NODE_ENV": '"production"' } });
const tokens = (await readFile(path.join(root, "apps/desktop/src/styles/tokens.css"), "utf8")).replace(/@theme(?:\s+inline)?\s*\{/g, ":root {");
const ui = await readFile(path.join(root, "apps/desktop/src/styles/ui-kit.css"), "utf8");
await writeFile(path.join(output, "foundation.css"), tokens + "\n" + ui + `
*{box-sizing:border-box}body{margin:0;background:var(--ds-bg-primary);color:var(--ds-text-primary);font-family:var(--font-sans,system-ui,sans-serif)}main{max-width:820px;padding:24px;margin:auto}header{margin-bottom:24px}h1{font-size:var(--text-xl);margin:0 0 8px}header p{font-size:var(--text-sm);color:var(--ds-text-secondary);margin:0}button,input{font:inherit}.btn{padding:6px 12px}label>div{font-size:var(--text-xs)}.goal-status{margin:16px auto}@media(max-width:480px){main{padding:12px}}`);
await writeFile(path.join(output, "preview.html"), `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autonomous Goal · fixture preview</title><link rel="stylesheet" href="foundation.css"><link rel="stylesheet" href="preview.css"></head><body><div id="root"></div><script type="module" src="preview.js"></script></body></html>`);
console.log(path.join(output, "preview.html"));
