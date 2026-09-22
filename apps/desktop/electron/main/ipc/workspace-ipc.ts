import { BrowserWindow, dialog, shell, type OpenDialogOptions } from "electron";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  ErrorCodes,
  IPC,
  type ComposerCommand,
  type ComposerPasteFile,
  type FsChatRefProjectRoot,
  type FsChatRefResolveResult,
  type ProjectGroupRecord,
} from "@pi-desktop/shared";
import {
  loadComposerTemplates,
  type ComposerTemplate,
} from "@pi-desktop/agent-runtime";
import { cloneGitRepository } from "../git-clone";
import {
  importComposerFiles,
  saveComposerPasteFiles,
} from "../composer-paste";
import {
  consumeComposerPickerSelection,
  rememberComposerPickerSelection,
} from "../composer-picker";
import { collectWorkspaceDiff } from "@pi-desktop/host-runtime";
import { parseAllowedExternalUrl } from "../safe-open-external";
import {
  isAttachmentBlobRef,
  listDir,
  readOpenableFile,
  readOpenableImage,
  resolveOpenablePath,
  resolveRealOpenablePath,
} from "@pi-desktop/host-runtime";
import { resolveChatFileRef } from "../chat-ref-resolve";
import { getWorkspaceFileIndex } from "../fs-index";
import {
  projectFolderPaths,
  refreshProjectGroups,
  rememberProjectGroups,
  workspaceRootsFor,
} from "../workspace-roots";
import { BROWSER_PLUGIN_ID, type BrowserHost } from "../browser-host";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { ClipboardHistory } from "../clipboard-history";
import type { PluginRuntime } from "../plugin-runtime";
import type { IpcRegistrar } from "./types";

type WorkspaceRecord = { path: string; name: string };

export function createComposerTemplateLoader(
  logger: Pick<Logger, "app">,
): (root: string | null) => Promise<ComposerTemplate[]> {
  let cache: { key: string; at: number; templates: ComposerTemplate[] } | null = null;
  return async (root) => {
    const key = root ?? "";
    const now = Date.now();
    if (cache && cache.key === key && now - cache.at < 5000) {
      return cache.templates;
    }
    const { templates, diagnostics } = await loadComposerTemplates(root);
    for (const diagnostic of diagnostics) {
      logger.app("diagnostics", "warn", "composer template diagnostic", { data: diagnostic });
    }
    cache = { key, at: now, templates };
    return templates;
  };
}

export type WorkspaceIpcDependencies = {
  registrar: IpcRegistrar;
  getMainWindow: () => Electron.BrowserWindow | null;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  dataDir: string;
  isDevelopmentBuild: boolean;
  plugins: PluginRuntime;
  browserHost: BrowserHost;
  clipboardHistory: ClipboardHistory;
  logger: Pick<Logger, "app">;
  recordPastedClipboardFiles: (files: ComposerPasteFile[]) => void;
  currentWorkspacePath: () => string | null;
  setCurrentWorkspacePath: (path: string | null) => void;
  withGitBranch: (workspace: WorkspaceRecord | null) => Promise<unknown>;
  stripWinLongPrefix: (path: string) => string;
};

export function registerWorkspaceIpc({
  registrar,
  getMainWindow,
  getHost,
  getSidecar,
  dataDir,
  isDevelopmentBuild,
  plugins,
  browserHost,
  clipboardHistory,
  logger,
  recordPastedClipboardFiles,
  currentWorkspacePath,
  setCurrentWorkspacePath,
  withGitBranch,
  stripWinLongPrefix,
}: WorkspaceIpcDependencies): void {
  let host: HostProcess | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      getSidecar();
      return fn(...args);
    });
  };
  const handleWithEvent = (
    channel: string,
    fn: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => Promise<any>,
  ) => {
    registrar.handleWithEvent(channel, async (event, ...args) => {
      host = getHost();
      getSidecar();
      return fn(event, ...args);
    });
  };
  const assertMainWindowSender = registrar.assertMainWindowSender;
  let composerPickerActive = false;
  let projectPickerActive = false;

  // Native composer dialogs are process-wide; reject duplicate requests while
  // one is open instead of queueing another dialog behind it.
  const openComposerPicker = async (
    event: Electron.IpcMainInvokeEvent,
    options: OpenDialogOptions,
  ): Promise<{ token: string | null; canceled: boolean }> => {
    if (composerPickerActive) return { token: null, canceled: true };
    composerPickerActive = true;
    try {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return { token: null, canceled: true };
      }
      return {
        token: rememberComposerPickerSelection(result.filePaths, event.sender.id),
        canceled: false,
      };
    } finally {
      composerPickerActive = false;
    }
  };

  const openProjectPicker = async (options: OpenDialogOptions) => {
    if (projectPickerActive) return null;
    projectPickerActive = true;
    try {
      const owner = getMainWindow();
      return owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
    } finally {
      projectPickerActive = false;
    }
  };

  const managedProjectPath = async (input: unknown): Promise<string> => {
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

  handle(IPC.invoke.projectGet, async () => {
    if (!host) throw new Error("host unavailable");
    let res = (await host.call("workspace.get")) as {
      workspace: { path: string; name: string } | null;
    };
    // Dev convenience only: never auto-open the app bundle directory as the
    // workspace in a packaged build.
    const seed =
      process.env.PI_DESKTOP_SEED_WORKSPACE ||
      process.env.PI_DESKTOP_WORKSPACE ||
      (isDevelopmentBuild ? join(__dirname, "../../..") : "");
    if (!res.workspace && seed) {
      try {
        res = (await host.call("workspace.set", { path: seed })) as {
          workspace: { path: string; name: string } | null;
        };
      } catch {
        // ignore seed failures
      }
    }
    return { workspace: await withGitBranch(res.workspace) };
  });
  handle(IPC.invoke.projectList, async () => {
    if (!host) throw new Error("host unavailable");
    return host.call("projects.list");
  });
  handle(IPC.invoke.projectGroupList, async () => {
    if (!host) throw new Error("host unavailable");
    const result = (await host.call("project.groups.list")) as {
      groups?: ProjectGroupRecord[];
    };
    // Main answers the plugin-facing workspace payload from this snapshot, so
    // the one authoritative list call is what keeps it warm.
    rememberProjectGroups(result?.groups ?? null);
    return result;
  });
  handle(
    IPC.invoke.projectGroupCreate,
    async (input: { name?: unknown; folders?: unknown } = {}) => {
      if (!host) throw new Error("host unavailable");
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const folders = Array.isArray(input.folders)
        ? input.folders.filter((path): path is string => typeof path === "string")
        : [];
      if (!name || folders.length === 0) {
        throw Object.assign(new Error("project group name and folders required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const safeFolders = [
        ...new Set(
          folders
            .map((path) => path.trim())
            .filter((path) => path.length > 0)
            .map((path) => resolve(path)),
        ),
      ];
      if (safeFolders.some((path) => !existsSync(path) || !statSync(path).isDirectory())) {
        throw Object.assign(new Error("project group folders must be directories"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const created = await host.call("project.group.create", {
        name,
        folders: safeFolders,
      });
      void refreshProjectGroups(host);
      return created;
    },
  );
  handle(
    IPC.invoke.projectGroupUpdate,
    async (input: { groupId?: unknown; name?: unknown; folders?: unknown } = {}) => {
      if (!host) throw new Error("host unavailable");
      const groupId = typeof input.groupId === "string" ? input.groupId.trim() : "";
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const folders = Array.isArray(input.folders)
        ? input.folders.filter((path): path is string => typeof path === "string")
        : [];
      if (!groupId || !name || folders.length === 0) {
        throw Object.assign(new Error("project group id, name and folders required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const safeFolders = [
        ...new Set(
          folders
            .map((path) => path.trim())
            .filter((path) => path.length > 0)
            .map((path) => resolve(path)),
        ),
      ];
      if (safeFolders.some((path) => !existsSync(path) || !statSync(path).isDirectory())) {
        throw Object.assign(new Error("project group folders must be directories"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const updated = await host.call("project.group.update", {
        groupId,
        name,
        folders: safeFolders,
      });
      void refreshProjectGroups(host);
      return updated;
    },
  );
  handle(
    IPC.invoke.projectGroupRename,
    async (input: { groupId?: unknown; name?: unknown } = {}) => {
      if (!host) throw new Error("host unavailable");
      const groupId = typeof input.groupId === "string" ? input.groupId.trim() : "";
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!groupId || !name) {
        throw Object.assign(new Error("project group id and name required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const renamed = await host.call("project.group.rename", { groupId, name });
      void refreshProjectGroups(host);
      return renamed;
    },
  );
  handle(IPC.invoke.projectGroupMemoryGet, async (input: { groupId?: unknown } = {}) => {
    if (!host) throw new Error("host unavailable");
    const groupId = typeof input.groupId === "string" ? input.groupId.trim() : "";
    if (!groupId) throw new Error("project group id required");
    return host.call("project.group.memory.get", { groupId });
  });
  handle(
    IPC.invoke.projectGroupMemorySave,
    async (input: { groupId?: unknown; entries?: unknown } = {}) => {
      if (!host) throw new Error("host unavailable");
      const groupId = typeof input.groupId === "string" ? input.groupId.trim() : "";
      if (!groupId || !Array.isArray(input.entries)) {
        throw new Error("project group id and entries required");
      }
      return host.call("project.group.memory.set", {
        groupId,
        entries: input.entries,
      });
    },
  );
  handle(
    IPC.invoke.projectGroupInstructionsGet,
    async (input: { groupId?: unknown } = {}) => {
      if (!host) throw new Error("host unavailable");
      const groupId = typeof input.groupId === "string" ? input.groupId.trim() : "";
      if (!groupId) throw new Error("project group id required");
      return host.call("project.group.instructions.get", { groupId });
    },
  );
  handle(
    IPC.invoke.projectGroupInstructionsSave,
    async (input: { groupId?: unknown; content?: unknown } = {}) => {
      if (!host) throw new Error("host unavailable");
      const groupId = typeof input.groupId === "string" ? input.groupId.trim() : "";
      const content = typeof input.content === "string" ? input.content : "";
      if (!groupId) throw new Error("project group id required");
      return host.call("project.group.instructions.set", { groupId, content });
    },
  );
  handle(IPC.invoke.projectOpenFolder, async (path: string) => {
    if (!host) throw new Error("host unavailable");
    const requestedPath = String(path ?? "").trim();
    if (!requestedPath) {
      throw Object.assign(new Error("project path required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    // Open only known project records so the renderer cannot probe arbitrary
    // filesystem paths through this channel.
    const listed = (await host.call("projects.list")) as {
      projects?: Array<{ path?: string }>;
    };
    const projectPath = resolve(requestedPath);
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
      throw Object.assign(new Error("folder not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const openError = await shell.openPath(stripWinLongPrefix(projectPath));
    if (openError) throw new Error(openError);
    return { ok: true, path: projectPath };
  });
  handle(IPC.invoke.projectOpen, async () => {
    if (!host) throw new Error("host unavailable");
    const result = await openProjectPicker({
      properties: ["openDirectory", "createDirectory"],
    });
    if (!result || result.canceled || !result.filePaths[0]) {
      return { workspace: null, canceled: true };
    }
    const res = (await host.call("workspace.set", {
      path: result.filePaths[0],
    })) as { workspace: { path: string; name: string } | null };
    setCurrentWorkspacePath(res.workspace?.path ?? result.filePaths[0]);
    return { workspace: await withGitBranch(res.workspace), canceled: false };
  });
  handle(IPC.invoke.projectPickFolders, async () => {
    const result = await openProjectPicker({
      properties: ["openDirectory", "multiSelections", "createDirectory"],
    });
    if (!result || result.canceled || result.filePaths.length === 0) {
      return { folders: [], canceled: true };
    }
    return { folders: result.filePaths, canceled: false };
  });
  handle(IPC.invoke.projectClone, async (input: { url?: string } = {}) => {
    const parentDefault = currentWorkspacePath()
      ? dirname(currentWorkspacePath()!)
      : homedir();
    const picked = await openProjectPicker({
      defaultPath: parentDefault,
      properties: ["openDirectory", "createDirectory"],
    });
    if (!picked || picked.canceled || !picked.filePaths[0]) {
      return { workspace: null, canceled: true };
    }
    const dest = await cloneGitRepository({
      url: input.url ?? "",
      parentPath: picked.filePaths[0],
    });
    const workspace = await withGitBranch({
      path: dest,
      name: dest.split(/[\\/]/).filter(Boolean).at(-1) || dest,
    });
    return { workspace, canceled: false };
  });

  handle(
    IPC.invoke.projectCloneCheckout,
    async (input: { url?: unknown; parentPath?: unknown } = {}) => {
      const url = typeof input.url === "string" ? input.url.trim() : "";
      const parentPath =
        typeof input.parentPath === "string" ? input.parentPath.trim() : "";
      if (!url || !parentPath) {
        throw Object.assign(
          new Error("repository URL and parent folder required"),
          { errorCode: ErrorCodes.INVALID_ARGUMENT },
        );
      }
      // Clone only. The renderer still creates the logical project group, so
      // the active host workspace stays untouched until activation.
      const dest = await cloneGitRepository({ url, parentPath });
      return {
        path: dest,
        name: dest.split(/[\\/]/).filter(Boolean).at(-1) || dest,
      };
    },
  );
  handle(IPC.invoke.projectSet, async (path: string) => {
    if (!host) throw new Error("host unavailable");
    setCurrentWorkspacePath(path);
    const res = (await host.call("workspace.set", { path })) as {
      workspace: { path: string; name: string } | null;
    };
    return { workspace: await withGitBranch(res.workspace) };
  });
  handle(IPC.invoke.projectClear, async () => {
    setCurrentWorkspacePath(null);
    if (!host) throw new Error("host unavailable");
    return host.call("workspace.clear");
  });
  handle(IPC.invoke.projectRemove, async (input: { path?: unknown } = {}) => {
    const requestedPath =
      typeof input.path === "string" ? input.path.trim() : "";
    if (!requestedPath) {
      throw Object.assign(new Error("project path required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    if (!host) throw new Error("host unavailable");
    // Deletion only touches host records, so a project whose folder was moved
    // or deleted on disk stays deletable: deliberately no existence check.
    const projectPath = resolve(requestedPath);
    const result = (await host.call("projects.remove", {
      path: projectPath,
    })) as { removed?: boolean; sessionsRemoved?: number };
    const removed = Boolean(result?.removed);
    const workspacePath = currentWorkspacePath();
    if (removed && workspacePath && resolve(workspacePath) === projectPath) {
      // Leaving the host bound to a deleted project would re-create it on boot.
      setCurrentWorkspacePath(null);
      await host.call("workspace.clear");
    }
    return {
      removed,
      sessionsRemoved: Number(result?.sessionsRemoved ?? 0),
    };
  });

  handle(
    IPC.invoke.projectMemoryGet,
    async (input: { projectPath?: unknown } = {}) => {
      const projectPath = await managedProjectPath(input.projectPath);
      if (!host) throw new Error("host unavailable");
      return host.call("project.memory.get", { path: projectPath });
    },
  );

  handle(
    IPC.invoke.projectMemorySave,
    async (input: {
      projectPath?: unknown;
      content?: unknown;
      entries?: unknown;
    } = {}) => {
      const projectPath = await managedProjectPath(input.projectPath);
      if (!host) throw new Error("host unavailable");
      if (Array.isArray(input.entries)) {
        return host.call("project.memory.set", {
          path: projectPath,
          entries: input.entries,
        });
      }
      const content = typeof input.content === "string" ? input.content : "";
      return host.call("project.memory.set", { path: projectPath, content });
    },
  );

  handleWithEvent(IPC.invoke.composerPickFiles, async (event) =>
    openComposerPicker(event, {
      properties: ["openFile", "multiSelections"],
    }),
  );

  handleWithEvent(IPC.invoke.composerPickPhotos, async (event) =>
    openComposerPicker(event, {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff"] },
      ],
    }),
  );

  handleWithEvent(
    IPC.invoke.composerImportFiles,
    async (
      event,
      input: { sessionId?: unknown; token?: unknown } = {},
    ) => {
      if (!host) throw new Error("host unavailable");
      const sessionId =
        typeof input.sessionId === "string" ? input.sessionId.trim() : "";
      if (!sessionId) {
        throw Object.assign(new Error("session required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const session = (await host.call("session.get", { id: sessionId })) as {
        session?: unknown;
      };
      if (!session.session) {
        throw Object.assign(new Error("session not found"), {
          errorCode: ErrorCodes.NOT_FOUND,
        });
      }
      const paths = consumeComposerPickerSelection(input.token, event.sender.id);
      return {
        files: await importComposerFiles(
          dataDir,
          sessionId,
          paths,
        ),
      };
    },
  );

  handleWithEvent(
    IPC.invoke.clipboardRecordPaste,
    async (event, input: { text?: unknown } = {}) => {
      assertMainWindowSender(event);
      if (typeof input.text !== "string") {
        throw Object.assign(new Error("text must be a string"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      clipboardHistory.recordText(input.text);
      return { ok: true };
    },
  );

  handleWithEvent(
    IPC.invoke.composerPasteFiles,
    async (event, input: { sessionId?: unknown; files?: unknown } = {}) => {
      assertMainWindowSender(event);
      if (!host) throw new Error("host unavailable");
      const sessionId =
        typeof input.sessionId === "string" ? input.sessionId.trim() : "";
      if (!sessionId) {
        throw Object.assign(new Error("session required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const session = (await host.call("session.get", { id: sessionId })) as {
        session?: unknown;
      };
      if (!session.session) {
        throw Object.assign(new Error("session not found"), {
          errorCode: ErrorCodes.NOT_FOUND,
        });
      }
      if (!Array.isArray(input.files)) {
        throw Object.assign(new Error("files must be an array"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const files = input.files as ComposerPasteFile[];
      const saved = await saveComposerPasteFiles(dataDir, sessionId, files);
      recordPastedClipboardFiles(files);
      return { files: saved };
    },
  );

  handle(IPC.invoke.workspaceDiff, async () => {
    if (!host) throw new Error("host unavailable");
    const res = (await host.call("workspace.get")) as {
      workspace: { path: string } | null;
    };
    const cwd = res.workspace?.path;
    if (!cwd) {
      return { repo: false, clean: true, files: [] };
    }
    return collectWorkspaceDiff(cwd);
  });
  handle(
    IPC.invoke.workspaceReviewRollback,
    async (input: { sessionId: string; snapshotId: string }) => {
      if (!host) throw new Error("host unavailable");
      return host.call("review.rollback", input);
    },
  );

  handle(
    IPC.invoke.statsGetTokenUsageHistory,
    async (input?: { startDate?: number; endDate?: number; bucket?: string }) => {
      if (!host) throw new Error("host unavailable");
      return host.call("stats.getTokenUsageHistory", input ?? {});
    },
  );

  handle(
    IPC.invoke.browserNavigate,
    async (input: { url?: string; sessionId?: string } = {}) => {
      if (!plugins.getLoaded(BROWSER_PLUGIN_ID)) {
        throw Object.assign(new Error("Browser plugin is disabled"), {
          errorCode: "UNAVAILABLE",
        });
      }
      return browserHost.navigate(
        { url: String(input.url ?? "") },
        input.sessionId,
      );
    },
  );

  handle(IPC.invoke.browserAction, async (input: { action?: string } = {}) => {
    if (!plugins.getLoaded(BROWSER_PLUGIN_ID)) {
      throw Object.assign(new Error("Browser plugin is disabled"), {
        errorCode: "UNAVAILABLE",
      });
    }
    const action = String(input.action ?? "");
    if (
      action === "back" ||
      action === "forward" ||
      action === "reload" ||
      action === "stop"
    ) {
      browserHost.action(action);
    }
    return { ok: true };
  });

  handle(
    IPC.invoke.browserSetBounds,
    async () => {
      // Plugin chrome owns the clamped hole. Unclamped renderer bounds must
      // not place the guest over chat/composer.
      return { ok: true };
    },
  );

  handle(IPC.invoke.browserSetVisible, async (input: { visible?: boolean } = {}) => {
    if (!plugins.getLoaded(BROWSER_PLUGIN_ID) || input.visible !== true) {
      browserHost.setGuestVisible(BROWSER_PLUGIN_ID, false);
      return { ok: true };
    }
    browserHost.setGuestVisible(BROWSER_PLUGIN_ID, true);
    return { ok: true };
  });

  handle(IPC.invoke.browserOpenExternal, async (input: { url?: string } = {}) => {
    const raw = String(input.url ?? "").trim();
    if (raw) {
      const allowed = parseAllowedExternalUrl(raw);
      if (allowed) await shell.openExternal(allowed);
      return { ok: true };
    }
    browserHost.openExternal();
    return { ok: true };
  });

  handle(IPC.invoke.browserGetState, async () => {
    return browserHost.getState();
  });

  const requireWorkspaceRoot = async () => {
    if (!host) throw new Error("host unavailable");
    const res = (await host.call("workspace.get")) as {
      workspace: { path: string } | null;
    };
    const root = res.workspace?.path;
    if (!root) {
      throw Object.assign(new Error("workspace required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    return root;
  };

  handle(IPC.invoke.fsList, async (input: { path?: string } = {}) => {
    const root = await requireWorkspaceRoot();
    return { entries: await listDir(root, String(input.path ?? "")) };
  });

  /**
   * Roots the host file tab may read besides the workspace: the session stores,
   * plus every *other* folder of the project group. ADR 0249 §5 makes a
   * registered group root a valid containment base, so a chat reference that
   * resolves in a sibling folder still opens instead of failing containment —
   * which is what a user without the file view would otherwise see.
   *
   * Both the spelling of the root and its `realpath` are returned: a producer
   * that canonicalizes what it records (image generation realpaths its output
   * directory) would otherwise write a path that no listed root contains when
   * `dataDir` or a project folder sits behind a link (`/var` on macOS, a linked
   * or synced folder). The two entries name the same directory, and every
   * candidate is still re-checked through `realpath` before a read is allowed.
   */
  const fsExtraRoots = async (workspaceRoot: string | null): Promise<string[]> => {
    const roots = [
      join(dataDir, "scratch"),
      join(dataDir, "attachments"),
      ...projectFolderPaths(workspaceRoot).filter((path) => path !== workspaceRoot),
    ];
    const canonical = await Promise.all(
      roots.map(async (root) => {
        try {
          return await realpath(root);
        } catch {
          return null;
        }
      }),
    );
    return [
      ...new Set([
        ...roots,
        ...canonical.filter((root): root is string => typeof root === "string"),
      ]),
    ];
  };

  /**
   * The session's own scratch directory (ADR 0124), or null when the session
   * is not known. host-core owns that layout, so it is asked rather than
   * re-derived here.
   */
  const sessionScratchRoot = async (
    sessionId: string | undefined,
  ): Promise<string | null> => {
    const id = String(sessionId ?? "").trim();
    if (!id || !host) return null;
    try {
      const result = await host.call<{ path: string }>("session.getScratchPath", {
        sessionId: id,
      });
      const path = String(result?.path ?? "").trim();
      return path || null;
    } catch {
      return null;
    }
  };

  /**
   * The open project as a whole, for completion and containment: its group's
   * folders primary-first, or just the workspace when no group resolves. A
   * single-folder project is a one-element list, so callers never special-case.
   */
  const projectRootsFor = (
    workspaceRoot: string | null,
  ): FsChatRefProjectRoot[] => {
    const { roots } = workspaceRootsFor(workspaceRoot);
    if (roots && roots.length > 0) return roots;
    if (!workspaceRoot) return [];
    const name =
      workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? workspaceRoot;
    return [{ path: workspaceRoot, name, primary: true }];
  };

  const optionalWorkspaceRoot = async (): Promise<string | null> => {
    try {
      return await requireWorkspaceRoot();
    } catch {
      return null;
    }
  };

  handle(
    IPC.invoke.fsRead,
    async (input: { path?: string; mimeType?: string } = {}) => {
      const requested = String(input.path ?? "").trim();
      let workspaceRoot: string | null = null;
      try {
        workspaceRoot = await requireWorkspaceRoot();
      } catch (error) {
        if (!isAbsolute(requested) && !isAttachmentBlobRef(requested)) {
          throw error;
        }
      }
      return readOpenableFile(
        requested,
        workspaceRoot,
        await fsExtraRoots(workspaceRoot),
        input.mimeType,
      );
    },
  );

  handle(
    IPC.invoke.fsReadImageDataUrl,
    async (input: { ref?: string; mimeType?: string } = {}) => {
      const workspaceRoot = await optionalWorkspaceRoot();
      const requested = String(input.ref ?? "").trim();
      return readOpenableImage(
        requested,
        workspaceRoot,
        await fsExtraRoots(workspaceRoot),
        input.mimeType,
      );
    },
  );

  handle(IPC.invoke.fsReveal, async (input: { path?: string } = {}) => {
    const requested = String(input.path ?? "").trim();
    let workspaceRoot: string | null = null;
    try {
      workspaceRoot = await requireWorkspaceRoot();
    } catch (error) {
      if (!isAbsolute(requested) && !isAttachmentBlobRef(requested)) {
        throw error;
      }
    }
    const target = await resolveRealOpenablePath(
      requested,
      workspaceRoot,
      await fsExtraRoots(workspaceRoot),
    );
    if (!target) {
      throw Object.assign(new Error("path outside allowed roots"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    shell.showItemInFolder(stripWinLongPrefix(target));
    return { ok: true };
  });

  handle(IPC.invoke.fsOpen, async (input: { path?: string } = {}) => {
    const workspaceRoot = await optionalWorkspaceRoot();
    const target = resolveOpenablePath(
      String(input.path ?? ""),
      workspaceRoot,
      await fsExtraRoots(workspaceRoot),
    );
    if (!target) {
      throw Object.assign(new Error("path is not openable"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const openError = await shell.openPath(stripWinLongPrefix(target));
    if (openError) throw new Error(openError);
    return { ok: true };
  });

  handle(IPC.invoke.fsIndex, async () => {
    const root = await optionalWorkspaceRoot();
    if (!root) return { entries: [], truncated: false };
    return getWorkspaceFileIndex(root);
  });

  /**
   * Resolve a file reference from chat to a real file (D320 follow-up).
   * The renderer knows the workspace but not where a session keeps its scratch
   * files, and completion needs a filesystem walk, so every root is resolved
   * here. Root order is the product contract inside `resolveChatFileRef`: the
   * whole project first — its group's folders, primary first — session scratch
   * second, attachments last.
   */
  handle(
    IPC.invoke.fsResolveRef,
    async (
      input: { ref?: string; sessionId?: string } = {},
    ): Promise<FsChatRefResolveResult> => {
      const ref = String(input.ref ?? "").trim();
      if (!ref) return { match: null };
      const workspaceRoot = await optionalWorkspaceRoot();
      return {
        match: await resolveChatFileRef(ref, {
          project: projectRootsFor(workspaceRoot),
          scratch: await sessionScratchRoot(input.sessionId),
          attachments: join(dataDir, "attachments"),
        }),
      };
    },
  );

}
