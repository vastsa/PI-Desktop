/**
 * Settings-only channels for importing Chrome cookies into the work browser.
 *
 * Every call is pinned to the trusted main window: plugins, plugin views, and
 * the agent have no route to these handlers. Cookie values never leave Main;
 * the renderer receives profile names and counts only.
 */
import { homedir } from "node:os";
import { session } from "electron";
import {
  IPC,
  validateBrowserCookieImportRequest,
  type BrowserCookieImportResult,
  type BrowserCookieImportStatus,
} from "@pi-desktop/shared";
import { WORK_BROWSER_PARTITION } from "../browser-view";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "../ipc/types";
import { importChromeCookies } from "./import";
import { chromeUserDataDir, listChromeProfiles, readChromeSafeStoragePassword } from "./chrome-source";

export function registerBrowserCookiesIpc({
  registrar,
  getHost,
}: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
}): void {
  const supported = process.platform === "darwin";
  let running = false;

  registrar.handleWithEvent(IPC.invoke.browserCookiesStatus, async (event): Promise<BrowserCookieImportStatus> => {
    registrar.assertMainWindowSender(event);
    if (!supported) return { supported, profiles: [] };
    return { supported, profiles: await listChromeProfiles(chromeUserDataDir(homedir())) };
  });

  registrar.handleWithEvent(IPC.invoke.browserCookiesImport, async (event, input: unknown): Promise<BrowserCookieImportResult> => {
    registrar.assertMainWindowSender(event);
    if (!supported) throw new Error("Importing Chrome cookies is only supported on macOS.");
    const request = validateBrowserCookieImportRequest(input);
    if (running) throw new Error("A cookie import is already running.");
    running = true;
    try {
      const cookies = session.fromPartition(WORK_BROWSER_PARTITION).cookies;
      const result = await importChromeCookies(request, {
        userDataDir: chromeUserDataDir(homedir()),
        readPassword: () => readChromeSafeStoragePassword(getHost()),
        setCookie: (details) => cookies.set(details),
      });
      await cookies.flushStore();
      return result;
    } finally {
      running = false;
    }
  });

  registrar.handleWithEvent(IPC.invoke.browserCookiesClear, async (event) => {
    registrar.assertMainWindowSender(event);
    const target = session.fromPartition(WORK_BROWSER_PARTITION);
    await target.clearStorageData({ storages: ["cookies"] });
    await target.cookies.flushStore();
  });
}
