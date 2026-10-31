#!/usr/bin/env node
/**
 * Assemble the self-contained `pi-host` bundle for one native POSIX target:
 *
 *   dist-bundle/pi-host-<version>-<platform>-<arch>/
 *     pi-host.js                 the CLI, esbuild-bundled with every workspace package
 *     agent-runtime/            the complete sidecar bundle (entry, chunks, manifest)
 *     bin/pi-desktop-host-core   the platform host-core binary
 *     bin/node, bin/pi-host      matching Node runtime and launcher
 *     node_modules/node-pty      optional; terminals are disabled without it
 *     package.json               { type: module, version }
 *     install.sh, SHA256SUMS     verified content-addressed installation
 *
 * Usage: node scripts/bundle.mjs [--node <path>] [--host-core <path>] [--platform linux|darwin] [--arch x64|arm64] [--out <dir>]
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { copyAgentRuntimeBundle } from "./runtime-bundle.mjs";
import { ensureDarwinSpawnHelperExecutable } from "./spawn-helper-permissions.mjs";
import { writePackageManifest } from "./package-integrity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const root = resolve(app, "../..");
const require = createRequire(import.meta.url);
const { version } = require(join(app, "package.json"));

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((arg, index, all) => (arg.startsWith("--") && arg.length > 2 ? [[arg.slice(2), all[index + 1] && !all[index + 1].startsWith("--") ? all[index + 1] : true]] : [])),
);
const platform = String(args.platform ?? process.platform);
const arch = String(args.arch ?? process.arch);
const exe = platform === "win32" ? ".exe" : "";
const hostCore = resolve(String(args["host-core"] ?? join(root, `target/release/pi-desktop-host-core${exe}`)));
const runtimeBundle = join(root, "packages/agent-runtime/dist-bundle");
const out = resolve(String(args.out ?? join(app, "dist-bundle", `pi-host-${version}-${platform}-${arch}`)));

// Probe the actual selected executable before removing or writing output. Native
// addons and host-core are built on this runner, so cross-target labels are unsafe.
const nodeRuntime = resolve(String(args.node ?? process.execPath));
const runtime = JSON.parse(execFileSync(nodeRuntime, ["-p", "JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})"], {
  encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
}));
if (!['linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)
    || platform !== process.platform || arch !== process.arch
    || runtime.platform !== platform || runtime.arch !== arch
    || !/^\d+\./.test(runtime.version) || Number(runtime.version.split('.')[0]) < 22) {
  throw new Error(`Node runtime >=22 and native platform/arch must match bundle target ${platform}/${arch}; got ${JSON.stringify(runtime)}`);
}
for (const [label, path] of [["host-core binary", hostCore], ["sidecar bundle", join(runtimeBundle, "sidecar.js")]]) {
  if (!existsSync(path)) {
    console.error(`${label} missing: ${path}`);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "bin"), { recursive: true });
await copyAgentRuntimeBundle(runtimeBundle, join(out, "agent-runtime"));

execFileSync(
  require.resolve("esbuild/bin/esbuild"),
  [
    join(app, "src/cli.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    "--external:node-pty",
    "--external:bufferutil",
    "--external:utf-8-validate",
    `--outfile=${join(out, "pi-host.js")}`,
    "--banner:js=import { createRequire as __piCreateRequire } from 'node:module'; const require = __piCreateRequire(import.meta.url);",
  ],
  { stdio: "inherit", cwd: app },
);
cpSync(hostCore, join(out, `bin/pi-desktop-host-core${exe}`));
chmodSync(join(out, `bin/pi-desktop-host-core${exe}`), 0o755);
let ptyPackageDir;
try {
  ptyPackageDir = dirname(require.resolve("node-pty/package.json"));
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}
if (ptyPackageDir) {
  const bundledPty = join(out, "node_modules/node-pty");
  cpSync(ptyPackageDir, bundledPty, { recursive: true, dereference: true });
  ensureDarwinSpawnHelperExecutable(bundledPty, platform, arch);
} else {
  console.warn("node-pty not installed; the bundle ships without terminals");
}
cpSync(nodeRuntime, join(out, "bin/node"));
chmodSync(join(out, "bin/node"), 0o755);
writeFileSync(join(out, "bin/pi-host"), `#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec "$here/node" "$here/../pi-host.js" "$@"
`);
chmodSync(join(out, "bin/pi-host"), 0o755);
writeFileSync(join(out, "package.json"), `${JSON.stringify({ name: "pi-host", version, type: "module", bin: { "pi-host": "./bin/pi-host" } }, null, 2)}\n`);
cpSync(join(here, "install.sh"), join(out, "install.sh"));
chmodSync(join(out, "install.sh"), 0o755);
writePackageManifest(out);
console.log(`bundled ${out}`);
