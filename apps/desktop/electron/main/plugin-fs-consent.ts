import { type BrowserWindow, type MessageBoxOptions, dialog } from "electron";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import {
  MAX_DELETES_PER_WINDOW,
  type PluginFsConsentAnswer,
  type PluginFsConsentRequest,
} from "./plugin-runtime";

/**
 * The native consent dialog for a file access `manifest.fs` did not cover.
 *
 * It lives in its own module so the shape of the prompt — which buttons exist,
 * which one a dismissal lands on, and how a click becomes an answer — can be
 * asserted without a display attached, and so the real dialog can be driven end
 * to end by `plugin-fs-consent-native.test.mjs`. The dialog is a main-process
 * `showMessageBox` because it has to block the plugin's call: there must be no
 * window in which the access happens before the answer arrives.
 */

/** Buttons in the order Electron receives them; the index is the answer. */
export function fsConsentDialogOptions(
  request: PluginFsConsentRequest,
  locale: string,
): MessageBoxOptions {
  const strings = catalogs[resolveLocale(locale)].pluginFsConsent;
  const rate = request.reason === "rate";
  return {
    type: "warning",
    message: (rate ? strings.rate : strings[request.mode]).replace("{name}", request.pluginName),
    detail: (rate ? strings.rateDetail : strings.detail)
      .replace("{limit}", String(MAX_DELETES_PER_WINDOW))
      .replace("{path}", request.fullPath),
    // A rate-braked prompt is never offered the session answer: the brake exists
    // because a loop is running, and "allow until quit" would switch it off.
    buttons: rate
      ? [strings.deny, strings.allowOnce]
      : [strings.deny, strings.allowOnce, strings.allowSession],
    // Escape and the red-X both land on Deny; a dismissed dialog must never
    // read as permission.
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

/** Anything that is not an explicit allow is a refusal. */
export function fsConsentAnswerFromResponse(response: number): PluginFsConsentAnswer {
  if (response === 1) return "once";
  if (response === 2) return "session";
  return "deny";
}

/**
 * @param deps.getWindow the window to attach the sheet to, so the prompt cannot
 *   be lost behind it. A plugin can act while no window is up, and then the
 *   dialog stands on its own.
 */
export function createFsConsentService(deps: {
  getWindow: () => BrowserWindow | null;
  getLocale: () => string;
}): (request: PluginFsConsentRequest) => Promise<PluginFsConsentAnswer> {
  return async (request) => {
    const options = fsConsentDialogOptions(request, deps.getLocale());
    const window = deps.getWindow();
    const result =
      window && !window.isDestroyed()
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
    return fsConsentAnswerFromResponse(result.response);
  };
}
