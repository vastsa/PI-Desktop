import type { WebContents } from "electron";

/** A plugin document, rather than its reusable WebContents, owns each call. */
export function createPluginCallLifetime(page: Pick<WebContents, "on" | "removeListener" | "isDestroyed">) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const navigate = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame && !inPlace) abort();
  };
  page.on("destroyed", abort);
  page.on("render-process-gone", abort);
  page.on("did-start-navigation", navigate);
  if (page.isDestroyed()) abort();
  return {
    signal: controller.signal,
    dispose() {
      page.removeListener("destroyed", abort);
      page.removeListener("render-process-gone", abort);
      page.removeListener("did-start-navigation", navigate);
    },
  };
}
