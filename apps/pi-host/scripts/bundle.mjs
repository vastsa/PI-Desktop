#!/usr/bin/env node
/**
 * Assemble the self-contained `pi-host` bundle for one Linux target:
 *
 *   dist-bundle/pi-host-<version>-<platform>-<arch>/
 *     pi-host.js                 the CLI, esbuild-bundled with every workspace package
 *     agent-runtime/sidecar.js   the same sidecar bundle the desktop ships
 *     bin/pi-desktop-host-core   the platform host-core binary
 *     node_modules/node-pty      optional; terminals are disabled without it
 *     package.json               { type: module, version }
 *     install.sh                 copies the bundle under ~/.pi-desktop/pi-host/<version>
 *
 * Usage: node scripts/bundle.mjs [--host-core <path>] [--platform linux] [--arch x64|arm64] [--out <dir>]
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ensureUnixSpawnHelperExecutable } from "./spawn-helper-permissions.mjs";

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
const sidecar = join(root, "packages/agent-runtime/dist-bundle/sidecar.js");
const out = resolve(String(args.out ?? join(app, "dist-bundle", `pi-host-${version}-${platform}-${arch}`)));

for (const [label, path] of [["host-core binary", hostCore], ["sidecar bundle", sidecar]]) {
  if (!existsSync(path)) {
    console.error(`${label} missing: ${path}`);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "bin"), { recursive: true });
mkdirSync(join(out, "agent-runtime"), { recursive: true });

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
cpSync(sidecar, join(out, "agent-runtime/sidecar.js"));
writeFileSync(join(out, "agent-runtime/package.json"), '{ "type": "module" }\n');
cpSync(hostCore, join(out, `bin/pi-desktop-host-core${exe}`));
chmodSync(join(out, `bin/pi-desktop-host-core${exe}`), 0o755);
let ptyPackageDir;
try {
  ptyPackageDir = dirname(require.resolve("node-pty/package.json"));
} catch {
  ptyPackageDir = null;
}
if (ptyPackageDir) {
  const bundledPty = join(out, "node_modules/node-pty");
  cpSync(ptyPackageDir, bundledPty, { recursive: true, dereference: true });
  ensureUnixSpawnHelperExecutable(bundledPty, platform, arch);
} else {
  console.warn("node-pty not installed; the bundle ships without terminals");
}
writeFileSync(join(out, "package.json"), `${JSON.stringify({ name: "pi-host", version, type: "module", bin: { "pi-host": "./pi-host.js" } }, null, 2)}\n`);
writeFileSync(
  join(out, "install.sh"),
  `#!/bin/sh
# Install this pi-host bundle under the user's home (D375 bootstrap).
set -eu
target="\${PI_HOST_INSTALL_DIR:-$HOME/.pi-desktop/pi-host}/${version}"
mkdir -p "$target"
cp -R "$(dirname "$0")"/. "$target"/
chmod 755 "$target/bin/pi-desktop-host-core${exe}"
ln -sfn "$target" "$(dirname "$target")/current"
echo "PI_HOST_INSTALLED $target"
`,
);
chmodSync(join(out, "install.sh"), 0o755);
console.log(`bundled ${out}`);
