import { BrowserWindow } from "electron";
import { dirname, join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { listInstalledFonts } from "../system-fonts";
import {
  APP_NAME,
  APP_VERSION,
  ErrorCodes,
  IPC,
  PROTOCOL_VERSION,
  assertFeedbackIssueUrl,
  buildBugReportUrl,
} from "@pi-desktop/shared";
import { globalInstructionPath } from "@pi-desktop/agent-runtime";
import type { HostProcess } from "../host-process";
import type { AppUpdaterController } from "../updater";
import type { IpcRegistrar } from "./types";

export type AppIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getPluginLauncherWindow: () => BrowserWindow | null;
  togglePluginLauncher: () => Promise<void>;
  safeOpenExternal: (url: unknown) => Promise<void>;
  updater: AppUpdaterController;
};

/** Register app, instruction, launcher and update channels. */
export function registerAppIpc({
  registrar,
  getHost,
  getPluginLauncherWindow,
  togglePluginLauncher,
  safeOpenExternal,
  updater,
}: AppIpcDependencies): void {
  const { handle, handleWithEvent } = registrar;

  handle(IPC.invoke.pluginLauncherToggle, async () => {
    await togglePluginLauncher();
    return { visible: getPluginLauncherWindow()?.isVisible() ?? false };
  });

  handleWithEvent(IPC.invoke.pluginLauncherDismiss, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const launcher = getPluginLauncherWindow();
    if (window && window === launcher && !window.isDestroyed()) {
      window.hide();
    }
    return { visible: false };
  });

  handle(IPC.invoke.appOpenFeedback, async () => {
    const host = getHost();
    const hostVersion = host
      ? await host
          .call<{ version: string }>("app.getVersion")
          .then((info) => info.version)
          .catch(() => undefined)
      : undefined;
    const url = buildBugReportUrl({
      version: APP_VERSION,
      platform: process.platform,
      arch: process.arch,
      protocolVersion: PROTOCOL_VERSION,
      hostVersion,
    });
    assertFeedbackIssueUrl(url);
    await safeOpenExternal(url);
    return { ok: true };
  });

  handle(IPC.invoke.appGetVersion, async () => {
    const host = getHost();
    const hostVersion = host
      ? await host.call<{ version: string; protocolVersion: number }>(
          "app.getVersion",
        )
      : undefined;
    return {
      name: APP_NAME,
      version: APP_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      hostProtocolVersion: hostVersion?.protocolVersion,
      hostVersion: hostVersion?.version,
      platform: process.platform,
      arch: process.arch,
    };
  });

  handle(IPC.invoke.appHealth, async () => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return host.call("app.health");
  });

  handle(IPC.invoke.appGetOnboarding, async () => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return host.call("app.getOnboarding");
  });

  handle(IPC.invoke.appDismissOnboarding, async () => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const settings = await host.call<any>("settings.get");
    await host.call("settings.set", { ...settings, onboardingDismissed: true });
    return { ok: true };
  });

  let systemFontsCache: { at: number; fonts: string[] } | null = null;
  handle(IPC.invoke.systemFontsList, async () => {
    const now = Date.now();
    if (systemFontsCache && now - systemFontsCache.at < 60_000) {
      return systemFontsCache.fonts;
    }
    const families = await listInstalledFonts().catch(() => []);
    systemFontsCache = { at: now, fonts: families };
    return families;
  });

  const instructionFile = async (
    scope: "global" | "project",
    projectPath?: string | null,
  ) => {
    const path =
      scope === "global"
        ? globalInstructionPath()
        : projectPath
          ? join(projectPath, "AGENTS.md")
          : null;
    if (!path) {
      throw Object.assign(new Error("workspace required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const { readFile } = await import("node:fs/promises");
    try {
      return { scope, path, content: await readFile(path, "utf8"), exists: true };
    } catch {
      return { scope, path, content: "", exists: false };
    }
  };

  const managedProjectPath = async (input: unknown): Promise<string> => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const requestedPath = typeof input === "string" ? input.trim() : "";
    if (!requestedPath) {
      throw Object.assign(new Error("project path required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const projectPath = resolve(requestedPath);
    const listed = (await host.call("projects.list")) as {
      projects?: Array<{ path?: string }>;
    };
    const known = (listed.projects ?? []).some((project) => {
      const candidate = String(project?.path ?? "").trim();
      return candidate && resolve(candidate) === projectPath;
    });
    if (!known) {
      throw Object.assign(new Error("project not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
      throw Object.assign(new Error("project folder not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    return projectPath;
  };

  handle(
    IPC.invoke.agentInstructionsGet,
    async (input: { projectPath?: unknown } = {}) => {
      const projectPath =
        input.projectPath === undefined
          ? null
          : await managedProjectPath(input.projectPath);
      return {
        global: await instructionFile("global"),
        ...(projectPath
          ? { project: await instructionFile("project", projectPath) }
          : {}),
      };
    },
  );

  handle(
    IPC.invoke.agentInstructionsSave,
    async (input: {
      scope?: "global" | "project";
      content?: unknown;
      projectPath?: unknown;
    } = {}) => {
      if (input.scope !== "global" && input.scope !== "project") {
        throw Object.assign(new Error("instruction scope required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const scope = input.scope;
      const projectPath =
        scope === "project" ? await managedProjectPath(input.projectPath) : null;
      const file = await instructionFile(scope, projectPath);
      const content = typeof input.content === "string" ? input.content : "";
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, content, "utf8");
      return { file: { ...file, content, exists: true } };
    },
  );

  handle(IPC.invoke.updatesGetState, async () => updater.getState());
  handle(IPC.invoke.updatesCheck, async () => updater.check({ manual: true }));
  handle(IPC.invoke.updatesDownload, async () => updater.download());
  handle(IPC.invoke.updatesInstall, async () => {
    updater.install();
    return { ok: true };
  });
  handle(IPC.invoke.updatesOpenReleases, async () => {
    await updater.openReleases();
    return { ok: true };
  });
}
