import { homedir } from "node:os";
import { dirname } from "node:path";
import type { BrowserWindow, Dialog, MessageBoxOptions, OpenDialogOptions } from "electron";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import { installExtensionDependencies, type ExtensionDependencyInstallResult } from "./npm-installer";
import { NPM_VALIDATION_BUDGET_MS, validateNpmExecutable } from "./npm-executable";

export type NpmRecoveryDependencies = {
  dialogs: Pick<Dialog, "showMessageBox" | "showOpenDialog">;
  window: () => BrowserWindow | null;
  getLocale: () => string;
  getNpmPath: () => string | undefined;
  setNpmPath: (path: string) => void;
  /** Test seam at the dependency-install service boundary; production uses the restricted installer. */
  installDependencies?: typeof installExtensionDependencies;
};

/** Recover missing tools inside the original import, without generating another plugin. */
export async function installDependenciesWithNpmRecovery(
  pluginDir: string,
  deps: NpmRecoveryDependencies,
): Promise<ExtensionDependencyInstallResult> {
  const install = deps.installDependencies ?? installExtensionDependencies;
  let npmPath = deps.getNpmPath();
  let result = await install(pluginDir, { npmPath });
  let invalidSelection = Boolean(npmPath);
  const parent = () => {
    const window = deps.window();
    return window && !window.isDestroyed() ? window : undefined;
  };
  const message = (options: MessageBoxOptions) => {
    const window = parent();
    return window
      ? deps.dialogs.showMessageBox(window, options)
      : deps.dialogs.showMessageBox(options);
  };

  while (result.state === "failed" && result.reason === "npm-unavailable") {
    const labels = catalogs[resolveLocale(deps.getLocale())];
    const title = invalidSelection ? labels.plugins.npmInvalidTitle : labels.plugins.npmMissingTitle;
    const body = invalidSelection ? labels.plugins.npmInvalidBody : labels.plugins.npmMissingBody;
    const { response } = await message({
      type: "warning",
      title,
      message: title,
      detail: `${body}\n\n${result.error}`,
      buttons: [labels.common.cancel, labels.plugins.npmChoose],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    if (response !== 1) return result;

    const options: OpenDialogOptions = {
      title: labels.plugins.npmPickerTitle,
      defaultPath: npmPath ? dirname(npmPath) : homedir(),
      // Keep nvm/Homebrew's bin/npm symlink so its sibling node remains on PATH.
      properties: ["openFile", "showHiddenFiles", "noResolveAliases"],
    };
    const window = parent();
    const picked = window
      ? await deps.dialogs.showOpenDialog(window, options)
      : await deps.dialogs.showOpenDialog(options);
    const selected = picked.canceled ? undefined : picked.filePaths[0];
    if (!selected) return result;

    // A picked executable gets the full validation ceiling: rejecting a working
    // npm because process startup was slow would loop the user through the picker.
    const validation = await validateNpmExecutable(selected, NPM_VALIDATION_BUDGET_MS);
    if (!validation.ok) {
      result = { state: "failed", reason: "npm-unavailable", error: validation.error };
      invalidSelection = true;
      continue;
    }
    npmPath = selected;
    try {
      deps.setNpmPath(selected);
    } catch {
      await message({
        type: "warning",
        title: labels.plugins.npmSaveFailedTitle,
        message: labels.plugins.npmSaveFailedBody,
      });
    }
    result = await install(pluginDir, { npmPath: selected });
    invalidSelection = true;
  }
  return result;
}
