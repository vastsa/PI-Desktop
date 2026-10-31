import type { WebContents } from "electron";

/**
 * A full main-frame navigation replaces the React tree that owns native-view
 * visibility. Detach the visible plugin page before that tree disappears;
 * same-document and child-frame navigations leave its owner intact.
 */
export function detachPluginViewOnRendererReload(
  webContents: WebContents,
  hideVisibleView: () => void,
): void {
  webContents.on(
    "did-start-navigation",
    (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) hideVisibleView();
    },
  );
}
