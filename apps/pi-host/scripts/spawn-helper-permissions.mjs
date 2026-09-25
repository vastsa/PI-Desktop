import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Ensure the platform-specific node-pty helper can be executed from a release
 * bundle. Package managers may preserve the prebuild bytes but drop this mode.
 */
export function ensureUnixSpawnHelperExecutable(nodePtyDir, platform, arch) {
  if (platform === "win32") return null;

  const helperCandidates = [join(nodePtyDir, "prebuilds", `${platform}-${arch}`, "spawn-helper")];
  if (platform === process.platform && arch === process.arch) {
    helperCandidates.push(
      join(nodePtyDir, "build", "Release", "spawn-helper"),
      join(nodePtyDir, "build", "Debug", "spawn-helper"),
    );
  }
  const helperPath = helperCandidates.find((candidate) => existsSync(candidate));
  if (!helperPath) {
    throw new Error(`node-pty spawn-helper is missing for ${platform}-${arch}`);
  }

  chmodSync(helperPath, 0o755);
  return helperPath;
}
