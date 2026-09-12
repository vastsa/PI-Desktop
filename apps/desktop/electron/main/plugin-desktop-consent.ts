import { type BrowserWindow, type MessageBoxOptions, dialog } from "electron";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import type { PluginDesktopConsentRequest } from "./plugin-runtime";

/**
 * The native consent dialog for a dangerous desktop operation a plugin asked
 * the shared controller to run (session delete, permission-mode change, tool
 * approval). The controller's `confirm` flag is only the caller's
 * acknowledgement; this dialog is where the user decides. It blocks the
 * plugin's call, so there is no window in which the operation happens before
 * the answer arrives.
 *
 * The prompt always names the operation id from the catalog, never text the
 * plugin (or a model behind it) authored, so a prompt-injected transcript
 * cannot relabel `session/delete` as something benign.
 */

/** Largest argument preview the dialog shows; the rest is elided. */
const MAX_ARGS_PREVIEW = 200;

function argsPreview(args: unknown[]): string {
  if (args.length === 0) return "";
  let text: string;
  try {
    text = JSON.stringify(args);
  } catch {
    text = String(args);
  }
  return text.length > MAX_ARGS_PREVIEW ? `${text.slice(0, MAX_ARGS_PREVIEW)}…` : text;
}

/** Buttons in the order Electron receives them; the index is the answer. */
export function desktopConsentDialogOptions(
  request: PluginDesktopConsentRequest,
  locale: string,
): MessageBoxOptions {
  const strings = catalogs[resolveLocale(locale)].pluginDesktopConsent;
  const preview = argsPreview(request.args);
  return {
    type: "warning",
    message: strings.message
      .replace("{name}", request.pluginName)
      .replace("{operation}", request.operation),
    detail: [
      `${request.operation}: ${request.description}`,
      preview ? strings.arguments.replace("{args}", preview) : "",
      strings.detail,
    ]
      .filter(Boolean)
      .join("\n\n"),
    buttons: [strings.deny, strings.allowOnce],
    // Escape and the red-X both land on Deny; a dismissed dialog must never
    // read as permission.
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

/** Anything that is not an explicit allow is a refusal. */
export function desktopConsentGrantedFromResponse(response: number): boolean {
  return response === 1;
}

export function createDesktopConsentService(deps: {
  getWindow: () => BrowserWindow | null;
  getLocale: () => string;
}): (request: PluginDesktopConsentRequest) => Promise<boolean> {
  return async (request) => {
    const options = desktopConsentDialogOptions(request, deps.getLocale());
    const window = deps.getWindow();
    const result =
      window && !window.isDestroyed()
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
    return desktopConsentGrantedFromResponse(result.response);
  };
}
