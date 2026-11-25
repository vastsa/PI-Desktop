import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Crash-loop breaker marker (issue #2595): a renderer that crashes
 * deterministically at startup turns the automatic recovery reload into an
 * infinite loop — the window never finishes loading, so the user sees a
 * black screen and a flashing taskbar icon forever. The first trip
 * relaunches once with `--disable-gpu` (the classic GPU-corruption
 * mitigation; a plain reinstall never clears the cached GPU state in
 * userData). The marker records that the fallback was already spent, so a
 * loop that survives it surfaces a dialog instead of relaunching forever.
 *
 * Boot reads the marker to start without hardware acceleration, so manual
 * launches are safe too; a run that stays loaded clears it again, so a
 * machine whose driver was fixed (or whose corruption was transient) goes
 * back to normal on a later boot.
 */

export function gpuFallbackMarkerPath(dataDir: string): string {
  return join(dataDir, "renderer-crash-loop.json");
}

/** Whether this install already spent its one GPU-fallback relaunch. */
export function hasGpuFallbackMarker(dataDir: string): boolean {
  const path = gpuFallbackMarkerPath(dataDir);
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { gpuFallbackAt?: unknown };
    return typeof parsed.gpuFallbackAt === "string";
  } catch {
    // A corrupt marker still means "the fallback was spent"; rewrite it.
    writeGpuFallbackMarker(dataDir);
    return true;
  }
}

export function writeGpuFallbackMarker(dataDir: string): void {
  const path = gpuFallbackMarkerPath(dataDir);
  mkdirSync(join(dataDir), { recursive: true });
  writeFileSync(path, JSON.stringify({ gpuFallbackAt: new Date().toISOString() }), "utf8");
}

export function clearGpuFallbackMarker(dataDir: string): void {
  try {
    rmSync(gpuFallbackMarkerPath(dataDir), { force: true });
  } catch {
    // Best effort; a stale marker only costs one dialog instead of a relaunch.
  }
}
