import { homedir } from "node:os";
import { join } from "node:path";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import { ErrorCodes, IPC } from "@pi-desktop/shared";
import type { AgentExtensionIpcDeps } from "./agent-extensions-ipc";
import { generateImportedExtensionPlugin } from "./agent-extensions";
import { installDependenciesWithNpmRecovery } from "./npm-install-recovery";
import { discoverPiSkillPackages } from "./pi-skill-discovery";

/** Native confirmation binds consent to a freshly discovered, main-owned path. */
export function registerPiSkillDiscoveryIpc(
  deps: AgentExtensionIpcDeps,
  modules = join(homedir(), ".pi", "agent", "npm", "node_modules"),
): void {
  let importing = false;
  const discover = async () => discoverPiSkillPackages(modules, await deps.getImportedDescriptions?.() ?? []);
  deps.handle(IPC.invoke.piSkillDiscover, discover);
  deps.handle(IPC.invoke.piSkillImport, async (input: { id?: unknown }) => {
    if (typeof input?.id !== "string" || !/^[a-f0-9]{64}$/.test(input.id)) {
      throw Object.assign(new Error("Invalid pi skill candidate"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
    }
    if (importing) throw new Error("A pi skill import is already in progress");
    importing = true;
    try {
      const candidate = (await discover()).candidates.find(item => item.id === input.id);
      if (!candidate || candidate.imported) throw new Error("Candidate changed or was already imported; refresh the list");
      const labels = catalogs[resolveLocale(deps.getLocale())].plugins;
      const options = {
        type: "warning" as const,
        title: labels.piSkillsTitle,
        message: labels.piSkillsConfirm,
        detail: `${candidate.name}\n${candidate.path}\n\n${candidate.skills.join("\n")}\n\n${candidate.hasExtensions ? labels.piSkillsExecutable : labels.piSkillsPromptOnly}`,
        buttons: [catalogs[resolveLocale(deps.getLocale())].common.cancel, labels.piSkillsImport],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const window = deps.window();
      const { response } = window && !window.isDestroyed()
        ? await deps.dialogs.showMessageBox(window, options)
        : await deps.dialogs.showMessageBox(options);
      if (response !== 1) return { canceled: true };
      const current = (await discover()).candidates.find(item => item.id === candidate.id);
      if (!current || current.imported) throw new Error("Candidate changed during confirmation; refresh the list");
      const generated = generateImportedExtensionPlugin(current.path, deps.importRoot);
      const dependencies = await installDependenciesWithNpmRecovery(generated.path, deps);
      await deps.loadDevPlugin(generated.path);
      return { canceled: false, ...generated, dependencies };
    } finally {
      importing = false;
    }
  });
}
