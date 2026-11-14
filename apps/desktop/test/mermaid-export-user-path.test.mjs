import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

test("Mermaid preview copies standalone SVG and downloads the same diagram", {
  timeout: 90_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.mermaid-export-"));
  try {
    await build({
      entryPoints: [join(root, "apps/desktop/test/fixtures/mermaid-export.jsx")],
      outfile: join(temp, "renderer.js"), bundle: true, format: "esm", platform: "browser", jsx: "automatic",
      define: { "import.meta.env.DEV": "false", "process.env.NODE_ENV": '"production"' },
      loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; frame-src blob:"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    const env = { ...process.env, PI_MERMAID_TEST_DIR: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary,
      [join(root, "apps/desktop/test/fixtures/mermaid-export-runner.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 0, output);
    assert.match(output, /Mermaid SVG user path passed/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
