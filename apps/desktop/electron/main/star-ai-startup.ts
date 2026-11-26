import { app, type BrowserWindow } from "electron";
import type { StarAiCatalog } from "@pi-desktop/shared";
import type { StarAiAccount } from "./star-ai-account";

/** Called only for a main window whose shell has installed its event listeners. */
export function watchStarAiStartup(
  window: BrowserWindow,
  account: StarAiAccount,
  isRendererReady: () => boolean,
  openSetup: (catalog: StarAiCatalog | null) => void,
  reportFailure: () => void,
) {
  if (app.commandLine.hasSwitch("headless") || process.env.PI_DESKTOP_BOOT_PROBE === "1" ||
      process.env.PI_DESKTOP_SUPERVISION_PROBE === "1" || process.env.PI_DESKTOP_CAPTURE === "1" ||
      process.env.PI_DESKTOP_PLAN_UI_PROBE === "1") return () => {};

  let offered = false;
  let checking = false;
  const visible = () => isRendererReady() && !window.isDestroyed() && window.isVisible() && !window.isMinimized();
  const foreground = () => visible() && window.isFocused();
  const check = () => {
    if (offered || checking || !foreground()) return;
    offered = true;
    checking = true;
    void account.setupOnOpen(foreground).then((catalog) => {
      if (catalog && visible()) openSetup(catalog);
    }).catch((error: unknown) => {
      const code = (error as { errorCode?: string } | null)?.errorCode;
      if (code === "STARAI_LOGIN_CANCELLED") return;
      if (code === "STARAI_LOGIN_DEFERRED") {
        offered = false;
        return;
      }
      reportFailure();
      if (visible()) openSetup(null);
    }).finally(() => {
      checking = false;
      if (!visible()) offered = false;
      else if (!offered) check();
    });
  };
  const reset = () => { offered = false; };
  const reopen = () => {
    if (!checking) reset();
    check();
  };
  window.on("show", check);
  window.on("focus", check);
  window.on("restore", check);
  window.on("hide", reset);
  window.on("minimize", reset);
  // Clicking the Dock icon or launching the existing instance again can leave
  // an already-visible window in place without another show event.
  app.on("activate", reopen);
  app.on("second-instance", reopen);
  window.once("closed", () => {
    app.off("activate", reopen);
    app.off("second-instance", reopen);
  });
  return check;
}
