import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveSidecarEntry(
  moduleUrl,
  resourcesPath,
  pathExists = existsSync,
) {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    join(resourcesPath || "", "agent-runtime/sidecar.js"),
    join(moduleDirectory, "../../../agent-runtime/dist/sidecar.js"),
    join(moduleDirectory, "../../../../packages/agent-runtime/dist/sidecar.js"),
    // electron-vite may put this code in out/main/chunks, one level deeper
    // than the main entry and the original source module.
    join(moduleDirectory, "../../../../../packages/agent-runtime/dist/sidecar.js"),
  ];

  for (const candidate of candidates) {
    if (pathExists(candidate)) return candidate;
  }

  throw new Error(
    `Unable to locate agent sidecar entry. Checked: ${candidates.join(", ")}`,
  );
}
