// Compatibility entry point for the actual built-page Goal acceptance runner.
// It launches an isolated Desktop, never attaches to the user's running app.
const { spawnSync } = require("node:child_process");
const path = require("node:path");
if (process.versions.electron) {
  throw new Error("Use node scripts/goal-preview-check.cjs with PI_DESKTOP_HOST_BIN; do not launch this compatibility entry with Electron.");
}
const result = spawnSync(process.execPath, [path.join(__dirname, "render-goal-pages.mjs")], { stdio: "inherit", env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
