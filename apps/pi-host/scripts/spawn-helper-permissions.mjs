import { chmodSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** node-pty 1.1.0 builds spawn-helper only on macOS (binding.gyp). */
export function ensureDarwinSpawnHelperExecutable(nodePtyDir, platform, arch) {
  if (platform !== "darwin") return;

  // node-pty tries Release, Debug, then the target prebuild. A helper in an
  // unrelated directory cannot repair the one beside the selected native addon.
  const nativeDirs = [
    join(nodePtyDir, "build", "Release"),
    join(nodePtyDir, "build", "Debug"),
    join(nodePtyDir, "prebuilds", `darwin-${arch}`),
  ];
  const helpers = nativeDirs
    .filter((dir) => existsSync(join(dir, "pty.node")) || existsSync(join(dir, "spawn-helper")))
    .map((dir) => join(dir, "spawn-helper"));
  if (helpers.length === 0) throw new Error(`node-pty spawn-helper is missing for darwin-${arch}`);
  for (const helper of helpers) {
    if (!existsSync(helper) || !statSync(helper).isFile()) {
      throw new Error(`node-pty spawn-helper is missing: ${helper}`);
    }
    chmodSync(helper, 0o755);
  }
}
