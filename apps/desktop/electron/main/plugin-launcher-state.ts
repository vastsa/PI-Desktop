/**
 * Persisted size and position of the plugin launcher window.
 *
 * The launcher is app-shell chrome, not user data: it follows the same rule as
 * `window-state.json` (ADR 0090) and lives as a small JSON file in the app data
 * directory, written best-effort by the main process only. Nothing here touches
 * host-core, so no schema or migration is involved.
 *
 * All geometry logic is pure and unit-tested: the window code only wires the
 * read on show and the debounced write on move/resize.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PLUGIN_LAUNCHER_STATE_FILE = "plugin-launcher-state.json";

/**
 * The launcher opens wide enough for a 48px icon and a readable name in every
 * one of its eight columns. Below this floor a tile is about 90px wide and the
 * longest names start losing characters, so the window refuses to go narrower
 * rather than let the grid squeeze.
 */
export const PLUGIN_LAUNCHER_MIN_WIDTH = 800;
/**
 * Height is not a user preference any more: the renderer measures what it
 * renders and asks for exactly that height through
 * `IPC.invoke.pluginLauncherContentHeight`. This floor only keeps the window
 * from collapsing while the measurement is still on its way.
 */
export const PLUGIN_LAUNCHER_MIN_CONTENT_HEIGHT = 120;
/** Wider than this the eight tiles stop being scannable. */
export const PLUGIN_LAUNCHER_MAX_WIDTH = 1280;
export const PLUGIN_LAUNCHER_MAX_HEIGHT = 940;
export const PLUGIN_LAUNCHER_DEFAULT_WIDTH = 900;
/** Initial height before the panel has measured itself. */
export const PLUGIN_LAUNCHER_DEFAULT_HEIGHT = 440;

export type LauncherWindowState = {
  width: number;
  height: number;
  /** Absent until the user has dragged the panel at least once. */
  x?: number;
  y?: number;
};

export type LauncherBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LauncherWorkArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clampDimension(value: unknown, min: number, max: number, fallback: number): number {
  if (!isFiniteNumber(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Accept a measured content height from the launcher renderer.
 *
 * The value crosses an IPC boundary, so anything that is not a finite positive
 * number is refused, and an accepted height is clamped into the supported range
 * — a compromised or buggy renderer can therefore ask for a different height,
 * never for a window the user cannot recover.
 */
export function clampLauncherContentHeight(value: unknown): number | null {
  if (!isFiniteNumber(value) || value <= 0) return null;
  return Math.min(
    PLUGIN_LAUNCHER_MAX_HEIGHT,
    Math.max(PLUGIN_LAUNCHER_MIN_CONTENT_HEIGHT, Math.round(value)),
  );
}

/**
 * Read a persisted state defensively: another version's payload, a truncated
 * write, or a hand-edited file must all degrade to "no remembered size" rather
 * than to a window the user cannot see.
 */
export function parseLauncherWindowState(raw: unknown): LauncherWindowState | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (!isFiniteNumber(record.width) || !isFiniteNumber(record.height)) return null;
  const state: LauncherWindowState = {
    width: clampDimension(
      record.width,
      PLUGIN_LAUNCHER_MIN_WIDTH,
      PLUGIN_LAUNCHER_MAX_WIDTH,
      PLUGIN_LAUNCHER_DEFAULT_WIDTH,
    ),
    height: clampDimension(
      record.height,
      PLUGIN_LAUNCHER_MIN_CONTENT_HEIGHT,
      PLUGIN_LAUNCHER_MAX_HEIGHT,
      PLUGIN_LAUNCHER_DEFAULT_HEIGHT,
    ),
  };
  if (isFiniteNumber(record.x) && isFiniteNumber(record.y)) {
    state.x = Math.round(record.x);
    state.y = Math.round(record.y);
  }
  return state;
}

/**
 * Resolve the bounds to apply on show.
 *
 * A remembered position is kept only when it still falls inside the work area it
 * is asked to fit — after a display is unplugged or a resolution changes, the
 * saved point would otherwise place the panel off-screen with no way back.
 * Without a usable position the panel is centred on that work area.
 */
export function resolveLauncherBounds(
  state: LauncherWindowState | null,
  workArea: LauncherWorkArea,
): LauncherBounds {
  const width = clampDimension(
    state?.width,
    PLUGIN_LAUNCHER_MIN_WIDTH,
    Math.max(PLUGIN_LAUNCHER_MIN_WIDTH, Math.min(PLUGIN_LAUNCHER_MAX_WIDTH, workArea.width)),
    Math.min(PLUGIN_LAUNCHER_DEFAULT_WIDTH, workArea.width),
  );
  const height = clampDimension(
    state?.height,
    PLUGIN_LAUNCHER_MIN_CONTENT_HEIGHT,
    Math.max(PLUGIN_LAUNCHER_MIN_CONTENT_HEIGHT, Math.min(PLUGIN_LAUNCHER_MAX_HEIGHT, workArea.height)),
    Math.min(PLUGIN_LAUNCHER_DEFAULT_HEIGHT, workArea.height),
  );
  const centeredX = Math.round(workArea.x + (workArea.width - width) / 2);
  const centeredY = Math.round(workArea.y + (workArea.height - height) / 2);
  const candidateX = state?.x;
  const candidateY = state?.y;
  const inside =
    isFiniteNumber(candidateX) &&
    isFiniteNumber(candidateY) &&
    candidateX >= workArea.x &&
    candidateY >= workArea.y &&
    candidateX + width <= workArea.x + workArea.width &&
    candidateY + height <= workArea.y + workArea.height;
  return {
    x: inside && isFiniteNumber(candidateX) ? candidateX : centeredX,
    y: inside && isFiniteNumber(candidateY) ? candidateY : centeredY,
    width,
    height,
  };
}

export function readLauncherWindowState(dataDir: string): LauncherWindowState | null {
  try {
    const raw = readFileSync(join(dataDir, PLUGIN_LAUNCHER_STATE_FILE), "utf8");
    return parseLauncherWindowState(JSON.parse(raw) as unknown);
  } catch {
    // Missing, unreadable, or invalid: the panel opens at its default size.
    return null;
  }
}

export function writeLauncherWindowState(
  dataDir: string,
  bounds: LauncherBounds | LauncherWindowState,
): void {
  const state = parseLauncherWindowState(bounds);
  if (!state) return;
  try {
    writeFileSync(
      join(dataDir, PLUGIN_LAUNCHER_STATE_FILE),
      `${JSON.stringify(state)}\n`,
      "utf8",
    );
  } catch {
    // Best-effort persistence, like the main window's bounds.
  }
}
