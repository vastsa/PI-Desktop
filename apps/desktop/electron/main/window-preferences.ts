/**
 * Small JSON preference files the main process keeps in the data directory:
 * the last main-window bounds and the persisted close behavior. Both are
 * best-effort; a missing or malformed file reads as "unset".
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CloseBehavior } from "@pi-desktop/shared";

export type WindowState = { x: number; y: number; width: number; height: number };

function windowStatePath(dataDir: string) {
  return join(dataDir, "window-state.json");
}

export async function readWindowState(
  dataDir: string,
  minWidth: number,
  minHeight: number,
): Promise<WindowState | null> {
  try {
    const raw = JSON.parse(await readFile(windowStatePath(dataDir), "utf8"));
    const s = {
      x: Number(raw.x),
      y: Number(raw.y),
      width: Number(raw.width),
      height: Number(raw.height),
    };
    if (![s.x, s.y, s.width, s.height].every(Number.isFinite)) return null;
    if (s.width < minWidth || s.height < minHeight) return null;
    return s;
  } catch {
    return null;
  }
}

export function writeWindowState(dataDir: string, state: WindowState) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(windowStatePath(dataDir), JSON.stringify(state), "utf8");
  } catch {
    // best-effort persistence
  }
}

function closeBehaviorPath(dataDir: string) {
  return join(dataDir, "close-behavior.json");
}

export function readCloseBehavior(dataDir: string): CloseBehavior | null {
  try {
    const raw = JSON.parse(readFileSync(closeBehaviorPath(dataDir), "utf8"));
    return raw === "ask" || raw === "tray" || raw === "quit" ? raw : null;
  } catch {
    return null;
  }
}

export function writeCloseBehavior(dataDir: string, behavior: CloseBehavior) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(closeBehaviorPath(dataDir), JSON.stringify(behavior), "utf8");
  } catch {
    // best-effort persistence
  }
}
