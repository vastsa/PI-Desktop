/** Real Markdown/React in isolated Electron; clipboard and downloads use Chromium. */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const temp = await mkdtemp(join(tmpdir(), "pi-markdown-table-"));
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
await build({
  entryPoints: [join(root, "apps/desktop/test/fixtures/markdown-table.jsx")],
  outfile: join(temp, "fixture.js"), bundle: true, format: "esm", platform: "browser", jsx: "automatic",
  define: { "import.meta.env.DEV": "false", "process.env.NODE_ENV": '"production"' },
  loader: { ".css": "empty" },
});
const renderer = join(root, "apps/desktop/out/renderer");
const appHtml = await readFile(join(renderer, "index.html"), "utf8");
const csp = appHtml.match(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]*>/i)?.[0];
if (!csp) throw new Error("Desktop renderer Content-Security-Policy is missing");
const styles = [...appHtml.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
if (!styles.length) throw new Error("Build the Desktop renderer before running the table test");
await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
await writeFile(join(temp, "index.html"), `<!doctype html><html><head><meta charset="utf-8">${csp}${styles.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}</head><body><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`);
const env = { ...process.env, PI_TABLE_TEST_DIR: temp };
delete env.ELECTRON_RUN_AS_NODE;
const electron = process.env.PI_TABLE_ELECTRON ?? resolveElectronBinary(root).electronBinary;
const child = spawn(electron, [`--user-data-dir=${join(temp, "profile")}`, join(root, "apps/desktop/test/fixtures/markdown-table-runner.cjs")], { env, stdio: "inherit" });
process.exitCode = await new Promise((resolve, reject) => { child.on("exit", (code) => resolve(code ?? 1)); child.on("error", reject); });
console.log(`Table test artifacts: ${temp}`);
