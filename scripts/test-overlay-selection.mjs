/** Native selection/dismissal regressions with production React surfaces in isolated Electron. */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary, assertDesktopBuild } from "./e2e/boot.mjs";

const root = repositoryRoot();
assertDesktopBuild(root);
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "pi-overlay-selection-"));
try {
  const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
  await build({
    entryPoints: [join(root, "apps/desktop/test/fixtures/overlay-selection.jsx")],
    outfile: join(temp, "fixture.js"), bundle: true, format: "esm", platform: "browser", jsx: "automatic",
    define: { "import.meta.env.DEV": "false", "process.env.NODE_ENV": '"production"' },
  });
  const renderer = join(root, "apps/desktop/out/renderer");
  const html = await readFile(join(renderer, "index.html"), "utf8");
  const csp = html.match(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]*>/i)?.[0];
  const styles = [...html.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  if (!csp || !styles.length) throw new Error("Built renderer CSP/styles missing");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  await writeFile(join(temp, "index.html"), `<!doctype html><html><head><meta charset="utf-8">${csp}${styles.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}<link rel="stylesheet" href="./fixture.css"></head><body><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`);
  const env = { ...process.env, PI_OVERLAY_TEST_DIR: temp };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolveElectronBinary(root).electronBinary, [
    `--user-data-dir=${join(temp, "profile")}`,
    join(root, "apps/desktop/test/fixtures/overlay-selection-runner.cjs"),
  ], { env, windowsHide: true, stdio: "inherit" });
  process.exitCode = await new Promise((resolve, reject) => {
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", reject);
  });
} finally {
  await rm(temp, { recursive: true, force: true });
}
