import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_ID, APP_NAME } from "@pi-desktop/shared";
import { applyDevelopmentUserData, desktopDataDir } from "./data-paths";
import { ignoreBrokenStdio } from "./logger";
import { installMainProcessErrorHandlers } from "./main-process-errors";

// Complete identity and locking synchronously, before the ready promise or any writer.
ignoreBrokenStdio();
installMainProcessErrorHandlers();
export const isDevelopmentBuild = process.env.PI_DESKTOP_DEV === "1" || !app.isPackaged;
// Electron initially reads productName from the packaged application metadata.
export const isStarAiPreview = app.isPackaged && app.getName() === "StarAI Desktop";
app.setName(APP_NAME);
if (isStarAiPreview && !app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", join(app.getPath("appData"), "StarAI Desktop"));
}
applyDevelopmentUserData(app, isDevelopmentBuild);
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

// A managed restart inherits the root published for children, not an explicit profile override.
if (process.argv.includes("--pi-managed-storage")) delete process.env.PI_DESKTOP_DATA_DIR;
export const singleInstanceRequired = !process.env.PI_DESKTOP_DATA_DIR;
export const hasSingleInstanceLock = singleInstanceRequired ? app.requestSingleInstanceLock() : true;
export const defaultDataDir = isStarAiPreview && !process.env.PI_DESKTOP_DATA_DIR?.trim()
  ? join(homedir(), ".starai-desktop")
  : desktopDataDir(isDevelopmentBuild);
if (!hasSingleInstanceLock) app.quit();

// Preserve the existing Chromium accessibility crash workaround before ready.
app.commandLine.appendSwitch("disable-renderer-accessibility");
