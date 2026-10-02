import { app, BrowserWindow, dialog } from "electron";
import { mkdirSync, existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import type { StorageProgress } from "@pi-desktop/shared";
import { resolveHostBinary } from "../host-process";
import { clearCaches, migrateFiles, removeBackups } from "./files";
import { readStoragePreferences, STORAGE_PREFERENCE_FILE, writeStoragePreferences, type StoragePreferences } from "./preferences";

export type StorageBootstrap = { file: string; anchor: string; managed: boolean; preferences: StoragePreferences };
let current: StorageBootstrap | null = null;
export function getStorageBootstrap(): StorageBootstrap {
  if (!current) throw new Error("Storage bootstrap is not initialized.");
  return current;
}
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);

/** Runs before creating any application service or writer. userData remains the stable lock anchor. */
export async function prepareStorage(defaultData: string, overridden: boolean): Promise<StorageBootstrap> {
  const anchor = app.getPath("userData");
  mkdirSync(anchor, { recursive: true });
  const file = join(anchor, STORAGE_PREFERENCE_FILE);
  const defaults = { data: defaultData, browser: anchor };
  let preferences: StoragePreferences;
  try {
    preferences = overridden ? { version: 1, roots: defaults, backups: [] }
      : readStoragePreferences(file, defaults);
    if (!overridden && preferences.roots.data !== defaults.data
      && (!existsSync(preferences.roots.data) || !existsSync(preferences.roots.browser))) {
      throw new Error("The selected storage directory is unavailable. Reconnect its drive before starting PI-Desktop.");
    }
  } catch (error) {
    await app.whenReady();
    const copy = catalogs[resolveLocale(app.getLocale())].settings.storage;
    await dialog.showMessageBox({ type: "error", title: copy.failedTitle,
      message: copy.unavailableHint, detail: error instanceof Error ? error.message : String(error) });
    app.exit(1);
    return new Promise<StorageBootstrap>(() => {});
  }
  current = { file, anchor, managed: !overridden, preferences };
  // Chromium data follows the selected location while installation identity and its lock stay stable.
  if (!preferences.pending) {
    mkdirSync(preferences.roots.browser, { recursive: true });
    app.setPath("sessionData", preferences.roots.browser);
    return current;
  }
  const job = preferences.pending;
  // Never open a persistent session against a source being copied/cleaned.
  await app.whenReady();
  const copy = catalogs[resolveLocale(job.language)].settings.storage;
  const window = new BrowserWindow({ width: 560, height: 330, resizable: false, closable: false,
    title: copy.progressTitle, webPreferences: { sandbox: true, contextIsolation: true,
      nodeIntegration: false, partition: `storage-maintenance-${job.id}` } });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font:15px system-ui;margin:36px;background:#17191d;color:#f0f1f3}h1{font-size:21px}p{line-height:1.6;color:#b8bdc7}progress{width:100%;height:12px;accent-color:#a3bffa}#detail{font-variant-numeric:tabular-nums}</style></head><body><h1>${escapeHtml(copy.progressTitle)}</h1><p>${escapeHtml(copy.progressHint)}</p><p id="stage" role="status" aria-live="polite"></p><progress aria-label="${escapeHtml(copy.progressTitle)}"></progress><p id="detail"></p></body></html>`)}`);
  let lastPaint = 0;
  let paint: Promise<unknown> = Promise.resolve();
  const report = (value: StorageProgress) => {
    if (Date.now() - lastPaint < 100 && !["complete", "failed", "relocating", "cleaning"].includes(value.stage)) return;
    lastPaint = Date.now();
    const label = copy.stages[value.stage];
    const detail = `${value.completedFiles} / ${value.totalFiles} · ${(value.completedBytes / 1048576).toFixed(1)} / ${(value.totalBytes / 1048576).toFixed(1)} MB`;
    paint = paint.then(() => {
      if (window.isDestroyed()) return;
      const measurable = value.totalBytes > 0 && ["copying", "verifying"].includes(value.stage);
      return window.webContents.executeJavaScript(`document.getElementById('stage').textContent=${JSON.stringify(label)};document.getElementById('detail').textContent=${JSON.stringify(detail)};${measurable ? `document.querySelector('progress').max=${value.totalBytes};document.querySelector('progress').value=${value.completedBytes};` : "document.querySelector('progress').removeAttribute('value');"}`);
    }).catch(() => { /* A closed maintenance surface cannot invalidate the safe on-disk job. */ });
  };
  try {
    if (job.kind === "migrate") {
      if (!job.target) throw new Error("Missing migration destination.");
      const next = await migrateFiles({ source: preferences.roots, target: job.target, anchor, id: job.id, progress: report,
        relocate: async (oldRoot, newRoot) => {
          await promisify(execFile)(resolveHostBinary(), ["--relocate-data", oldRoot, newRoot], { timeout: 30 * 60_000, maxBuffer: 1024 * 1024 });
        } });
      writeStoragePreferences(file, { version: 1, roots: next,
        backups: [...preferences.backups, {
          data: existsSync(preferences.roots.data) ? await realpath(preferences.roots.data) : preferences.roots.data,
          browser: await realpath(preferences.roots.browser),
        }] });
    } else {
      report({ stage: "cleaning", completedBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0 });
      if (job.kind === "cache") await clearCaches(preferences.roots);
      else await removeBackups(preferences.backups, preferences.roots, anchor);
      writeStoragePreferences(file, { ...preferences, pending: undefined, lastError: undefined,
        backups: job.kind === "backup" ? [] : preferences.backups });
    }
    await paint;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // No pointer change took place. Leave partial destination data for a claimed-job retry.
    writeStoragePreferences(file, { ...preferences, pending: undefined, lastError: message, failedMigration: job.kind === "migrate" ? job : preferences.failedMigration });
    await dialog.showMessageBox(window, { type: "error", title: copy.failedTitle,
      message: copy.failedHint, detail: message, buttons: [copy.continueOriginal] });
  }
  app.relaunch();
  app.exit(0);
  // app.exit terminates the process; do not initialize writers even if a test double returns.
  return new Promise<StorageBootstrap>(() => {});
}
