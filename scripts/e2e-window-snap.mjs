#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, copyFile, readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prepare = process.argv.includes("--prepare");
const matrix = process.argv.includes("--matrix");
const run = promisify(execFile);
assert.ok(prepare || process.platform === "win32", "run on an interactive Windows desktop, or use --prepare <directory>");
const output = process.argv[process.argv.indexOf("--prepare") + 1];
const directory = prepare ? resolve(output) : await mkdtemp(join(tmpdir(), "window-snap-"));
await mkdir(directory, { recursive: true });
const require = createRequire(join(root, "apps/desktop/package.json"));
const { build } = require("esbuild");
await build({
  entryPoints: [join(root, "scripts/e2e/fixtures/window-snap/main.cjs")],
  outfile: join(directory, "main.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"],
  banner: { js: 'const __fixtureModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
  define: { "import.meta.url": "__fixtureModuleUrl" },
  alias: {
    SNAP_HOST_HELPER: join(root, "scripts/e2e/host.mjs"),
    SNAP_WINDOW_MODULE: join(root, "apps/desktop/electron/main/window-native-snap.ts"),
    SNAP_CORNERS_MODULE: join(root, "apps/desktop/electron/main/window-native-corners.ts"),
    SNAP_FULLSCREEN_MODULE: join(root, "apps/desktop/electron/main/window-fullscreen.ts"),
    SNAP_SHAPE_MODULE: join(root, "apps/desktop/electron/main/window-shape.ts"),
  },
  plugins: [{ name: "shared-ndjson-source", setup(builder) {
    builder.onResolve({ filter: /packages\/shared\/dist\/ndjson\.js$/ }, () => ({ path: join(root, "packages/shared/src/ndjson.ts") }));
  } }],
});
await copyFile(join(root, "scripts/e2e/probe-window-snap.cs"), join(directory, "probe.cs"));
await copyFile(join(root, "scripts/e2e/run-window-snap.ps1"), join(directory, "run.ps1"));
const git = async (...args) => (await run("git", args, { cwd: root })).stdout.trim();
const files = ["scripts/e2e-window-snap.mjs", "scripts/e2e/run-window-snap.ps1", "scripts/e2e/probe-window-snap.cs",
  "scripts/e2e/fixtures/window-snap/main.cjs", "scripts/e2e/host.mjs", "pnpm-lock.yaml", "Cargo.lock",
  "Cargo.toml", "crates/host-core/Cargo.toml", ".cargo/config.toml",
  "apps/desktop/package.json", "apps/desktop/electron/main/window-native-snap.ts",
  "apps/desktop/electron/main/window-native-corners.ts", "apps/desktop/electron/main/window-native-handle.ts",
  "apps/desktop/electron/main/window-fullscreen.ts", "apps/desktop/electron/main/window-shape.ts",
  "crates/host-core/src/rpc/window_snap_rpc.rs", "crates/host-core/src/rpc/window_owner.rs"];
const hashes = {};
for (const file of files) hashes[file] = createHash("sha256").update(await readFile(join(root, file))).digest("hex");
await writeFile(join(directory, "source.json"), JSON.stringify({
  revision: await git("rev-parse", "HEAD"), tree: await git("rev-parse", "HEAD^{tree}"),
  hostTree: await git("rev-parse", "HEAD:crates/host-core"),
  clean: (await git("status", "--porcelain", "--untracked-files=no")) === "", hashes,
}, null, 2));
await writeFile(join(directory, "options.json"), JSON.stringify({
  hostBinary: process.env.PI_DESKTOP_HOST_BIN || join(root, "target/debug/pi-desktop-host-core.exe"),
  electronBinary: process.env.PI_DESKTOP_SNAP_ELECTRON || (prepare ? "electron/electron.exe" : require("electron")),
  baseline: process.argv.includes("--baseline"),
  externalPointer: process.argv.includes("--external-pointer"),
  legacySurface: process.argv.includes("--legacy-surface"),
  minWidth: Number(process.env.PI_DESKTOP_SNAP_MIN_WIDTH || 800),
  minHeight: Number(process.env.PI_DESKTOP_SNAP_MIN_HEIGHT || 560),
}));
if (prepare) console.log(directory);
else {
  const index = process.argv.indexOf("--artifacts");
  const artifacts = index < 0 ? join(directory, "artifacts") : resolve(process.argv[index + 1]);
  try {
    await run("powershell.exe", ["-NoProfile", "-File", join(directory, "run.ps1"),
      "-ArtifactDirectory", artifacts, ...(matrix ? ["-Matrix"] : [])], { timeout: 660_000 });
  } finally { console.log(`Native snap artifacts: ${artifacts}`); }
  const result = JSON.parse(await readFile(join(artifacts, "summary.json"), "utf8"));
  assert.equal(result.ok, true, JSON.stringify(result));
  console.log(JSON.stringify(result));
}
