/**
 * Electron IPC for plugin-contributed agent extensions (spec 07-plugins/16 §10.2).
 *
 * Three channels: run a registered slash command in a session, answer a
 * pending prompt, and import a pi CLI extension as a development plugin. The
 * import writes a plugin directory the user owns and registers it through
 * the same path as "Load local plugin"; the `agent.extension` permission is
 * what the plugin row shows and what the sidecar loader checks.
 */
import { dialog, type BrowserWindow } from "electron";
import { ErrorCodes, IPC, type TrustedExtensionUiPromptResponse } from "@pi-desktop/shared";
import {
  generateImportedExtensionPlugin,
  installExtensionDependencies,
  type AgentExtensionBridge,
} from "./agent-extensions.js";

export type AgentExtensionIpcDeps = {
  handle: (channel: string, fn: (...args: any[]) => Promise<any>) => void;
  bridge: AgentExtensionBridge;
  window: () => BrowserWindow | null;
  /** Directory the generated plugins live in, e.g. `<dataDir>/plugins/imported`. */
  importRoot: string;
  /** Register the generated directory as a development plugin. */
  loadDevPlugin: (path: string) => Promise<unknown>;
  /** Run a registered command in one session's sidecar Runner. */
  runCommand: (input: { sessionId: string; name: string; args: string }) => Promise<{ handled: boolean }>;
};

export function registerAgentExtensionIpc(deps: AgentExtensionIpcDeps): void {
  const { handle, bridge } = deps;

  handle(
    IPC.invoke.extensionsCommandRun,
    async (input: { sessionId?: unknown; name?: unknown; args?: unknown }) => {
      const sessionId = String(input?.sessionId ?? "").trim();
      const name = String(input?.name ?? "").trim().replace(/^\//, "");
      if (!sessionId || !name) {
        throw Object.assign(new Error("session and command name required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const result = await deps.runCommand({
        sessionId,
        name,
        args: typeof input?.args === "string" ? input.args : "",
      });
      if (!result.handled) {
        throw Object.assign(new Error(`command "/${name}" is not registered in this session`), {
          errorCode: ErrorCodes.NOT_FOUND,
        });
      }
      return { ok: true };
    },
  );

  handle(IPC.invoke.extensionsUiRespond, async (input: TrustedExtensionUiPromptResponse) => {
    const promptId = String(input?.promptId ?? "").trim();
    const value =
      typeof input?.value === "string" || typeof input?.value === "boolean"
        ? input.value
        : undefined;
    return { ok: bridge.respond(promptId, value) };
  });

  // Main opens the picker and owns the chosen path; the renderer never
  // supplies one (D344). The generated plugin is a development plugin the
  // user can inspect, reload, and remove like any other.
  handle(IPC.invoke.pluginImportExtension, async () => {
    const window = deps.window();
    const picked = await dialog.showOpenDialog(window ?? undefined!, {
      properties: ["openFile", "openDirectory"],
      filters: [{ name: "pi extension", extensions: ["ts", "js", "mjs", "mts"] }],
    });
    const source = picked.canceled ? undefined : picked.filePaths[0];
    if (!source) return { canceled: true };
    const generated = generateImportedExtensionPlugin(source, deps.importRoot);
    // Install before registration so the extension's first load already sees
    // its dependencies; a failed install registers anyway and is reported.
    const dependencies = await installExtensionDependencies(generated.path);
    const loaded = await deps.loadDevPlugin(generated.path);
    return { canceled: false, ...generated, loaded, dependencies };
  });
}
