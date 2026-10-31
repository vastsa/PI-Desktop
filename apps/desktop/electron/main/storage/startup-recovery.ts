import { app, dialog } from "electron";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import type { StorageRoots } from "./preferences";
import { writeStoragePreferences, type StoragePreferences } from "./preferences";

/** Compare persisted Windows paths independently of slash spelling and case. */
export function sameStoragePath(left: string, right: string, platform: string = process.platform): boolean {
  const path = platform === "win32" ? win32 : posix;
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function sameStorageRoots(left: StorageRoots, right: StorageRoots): boolean {
  return sameStoragePath(left.data, right.data) && sameStoragePath(left.browser, right.browser);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    throw error;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    throw error;
  }
}

async function rootsAtExistingProfile(selectedPath: string, fallbackBrowser: string): Promise<StorageRoots | null> {
  if (!isDirectory(selectedPath)) return null;
  const selectedRoot = await realpath(selectedPath);
  const nestedData = join(selectedRoot, "data");
  const isStorageRoot = isDirectory(nestedData) && isFile(join(nestedData, "pi.sqlite"));
  const isDataRoot = isFile(join(selectedRoot, "pi.sqlite"));
  if (!isStorageRoot && !isDataRoot) return null;

  const data = isStorageRoot ? nestedData : selectedRoot;
  const browserCandidate = isStorageRoot
    ? join(selectedRoot, "browser")
    : join(dirname(selectedRoot), "browser");
  if (existsSync(browserCandidate) && !isDirectory(browserCandidate)) return null;
  const browser = existsSync(browserCandidate) ? await realpath(browserCandidate) : fallbackBrowser;
  return { data: await realpath(data), browser };
}

/**
 * A missing default profile is ambiguous: the user may want a fresh profile,
 * or may want to reconnect an existing storage root. Resolve that choice before
 * the app imports services that can create writers or open the Host.
 */
export async function recoverMissingDefaultStorage(
  file: string,
  defaults: StorageRoots,
  preferences: StoragePreferences,
): Promise<StoragePreferences | null> {
  await app.whenReady();
  const copy = catalogs[resolveLocale(app.getLocale())].settings.storage;
  while (true) {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: copy.recoveryTitle,
      message: copy.recoveryMessage,
      detail: defaults.data,
      buttons: [copy.recoveryCreateDefault, copy.recoverySelectExisting, copy.recoveryQuit],
      defaultId: 2,
      cancelId: 2,
    });
    if (response === 0) {
      mkdirSync(defaults.data, { recursive: true });
      const recovered = { ...preferences, roots: defaults, pending: undefined, lastError: undefined };
      writeStoragePreferences(file, recovered);
      return recovered;
    }
    if (response !== 1) return null;

    const selection = await dialog.showOpenDialog({
      title: copy.recoveryPickerTitle,
      buttonLabel: copy.recoverySelectExisting,
      defaultPath: dirname(defaults.data),
      properties: ["openDirectory"],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;

    const roots = await rootsAtExistingProfile(selection.filePaths[0], defaults.browser);
    if (!roots) {
      const retry = await dialog.showMessageBox({
        type: "error",
        title: copy.failedTitle,
        message: copy.recoveryInvalid,
        buttons: [copy.recoveryPickAgain, copy.recoveryQuit],
        defaultId: 1,
        cancelId: 1,
      });
      if (retry.response === 0) continue;
      return null;
    }

    const recovered = { ...preferences, roots, pending: undefined, lastError: undefined };
    writeStoragePreferences(file, recovered);
    return recovered;
  }
}
