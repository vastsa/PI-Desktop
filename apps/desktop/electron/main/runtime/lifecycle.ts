import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  APP_NAME,
  APP_VERSION,
  ErrorCodes,
  IPC,
  PROTOCOL_VERSION,
  type ActivationScope,
  type HostStatusEvent,
} from "@pi-desktop/shared";
import { isGlibcUnsupportedError, GLIBC_UNSUPPORTED_STATUS } from "../linux-glibc";
import {
  DB_SCHEMA_TOO_NEW_STATUS,
  detectRuntimeArch,
  schemaTooNewOf,
} from "../host-boot-diagnostics";
import type { Logger } from "../logger";
import type { PluginRuntime } from "../plugin-runtime";
import type { RuntimeState } from "./context";

type RestartKind = "host" | "sidecar";

export type RuntimeLifecycleDependencies = {
  runtimeState: RuntimeState;
  dataDir: string;
  logger: Logger;
  sendToRenderer: (channel: string, payload: unknown) => void;
  startHost: () => Promise<void>;
  startSidecar: () => Promise<void>;
  drainApprovedPlanExecutions: () => Promise<void>;
  applyNetworkProxyFromAppSettings: (settings: unknown) => Promise<unknown>;
  plugins: PluginRuntime;
  setCurrentWorkspacePath: (path: string | null) => void;
  rememberPluginScopes: (
    list: Array<{ id?: string; scope?: ActivationScope }>,
  ) => void;
  refreshUserMcp: () => Promise<unknown>;
  isQuitting: () => boolean;
};

export function createRuntimeLifecycle({
  runtimeState,
  dataDir,
  logger,
  sendToRenderer,
  startHost,
  startSidecar,
  drainApprovedPlanExecutions,
  applyNetworkProxyFromAppSettings,
  plugins,
  setCurrentWorkspacePath,
  rememberPluginScopes,
  refreshUserMcp,
  isQuitting,
}: RuntimeLifecycleDependencies): {
  superviseRestart: (kind: RestartKind) => Promise<void>;
  bootHostStatus: (bootError: unknown) => HostStatusEvent;
  runtimeArch: () => ReturnType<typeof detectRuntimeArch>;
  bootBackends: () => Promise<void>;
} {
  const restartState = {
    host: { count: 0, windowStart: 0 },
    sidecar: { count: 0, windowStart: 0 },
  };
  const restartInFlight: Record<RestartKind, Promise<void> | null> = {
    host: null,
    sidecar: null,
  };
  let runtimeArchCache: ReturnType<typeof detectRuntimeArch> | null = null;

  const superviseRestart = (kind: RestartKind): Promise<void> => {
    const existing = restartInFlight[kind];
    if (existing) return existing;
    const run = superviseRestartLoop(kind).finally(() => {
      if (restartInFlight[kind] === run) restartInFlight[kind] = null;
    });
    restartInFlight[kind] = run;
    return run;
  };

  async function superviseRestartLoop(kind: RestartKind): Promise<void> {
    const state = restartState[kind];
    while (!isQuitting()) {
      const now = Date.now();
      if (now - state.windowStart > 120_000) {
        state.windowStart = now;
        state.count = 0;
      }
      state.count += 1;
      if (state.count > 3) {
        logger.app(
          "runtime",
          "error",
          kind + " restart limit reached; giving up",
          { code: ErrorCodes.HOST_UNAVAILABLE },
        );
        sendToRenderer(IPC.event.hostStatus, {
          ok: false,
          component: kind,
          fatal: true,
        });
        return;
      }
      const delay = Math.min(500 * 2 ** (state.count - 1), 4000);
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (isQuitting()) return;
      try {
        if (kind === "host") {
          await startHost();
          const sidecar = runtimeState.sidecar;
          const host = runtimeState.host;
          if (sidecar && host) sidecar.setHost(host);
        } else {
          await startSidecar();
        }
        await drainApprovedPlanExecutions();
        logger.app("runtime", "warn", kind + " restarted after crash");
        sendToRenderer(IPC.event.hostStatus, {
          ok: true,
          component: kind,
          restarted: true,
        });
        return;
      } catch (error) {
        const schema = schemaTooNewOf(error);
        if (schema) {
          logger.app("runtime", "error", "local data schema is newer than this build", {
            code: ErrorCodes.HOST_UNAVAILABLE,
            data: schema,
          });
          sendToRenderer(IPC.event.hostStatus, {
            ok: false,
            component: kind,
            fatal: true,
            message: DB_SCHEMA_TOO_NEW_STATUS,
            schema,
          });
          return;
        }
        if (isGlibcUnsupportedError(error)) {
          logger.app("runtime", "error", "linux glibc is below the packaged host floor", {
            code: ErrorCodes.HOST_UNAVAILABLE,
            data: String(error),
          });
          sendToRenderer(IPC.event.hostStatus, {
            ok: false,
            component: kind,
            fatal: true,
            message: GLIBC_UNSUPPORTED_STATUS,
          });
          return;
        }
        logger.app("runtime", "error", kind + " restart failed", {
          data: String(error),
        });
      }
    }
  }

  /**
   * Boot outcome pushed once the renderer has mounted. Known unrecoverable
   * failures travel as status tokens the UI can phrase; anything else is the
   * raw error. The architecture check rides along even on success so an Intel
   * build under Rosetta gets a hint instead of silently running slower.
   */
  const bootHostStatus = (bootError: unknown): HostStatusEvent => {
    const status: HostStatusEvent = { ok: !bootError };
    if (bootError) {
      status.component = "host";
      status.fatal = true;
      const schema = schemaTooNewOf(bootError);
      if (schema) {
        status.message = DB_SCHEMA_TOO_NEW_STATUS;
        status.schema = schema;
      } else if (isGlibcUnsupportedError(bootError)) {
        status.message = GLIBC_UNSUPPORTED_STATUS;
      } else {
        status.message = String(bootError);
      }
    }
    const arch = runtimeArch();
    if (arch.mismatch) {
      status.archMismatch = {
        platform: arch.platform,
        processArch: arch.processArch,
        machineArch: arch.machineArch,
      };
    }
    return status;
  };

  const runtimeArch = (): ReturnType<typeof detectRuntimeArch> => {
    if (!runtimeArchCache) {
      runtimeArchCache = detectRuntimeArch();
      if (runtimeArchCache.mismatch) {
        logger.app("lifecycle", "warn", "build is not native to this cpu", {
          data: runtimeArchCache,
        });
      }
    }
    return runtimeArchCache;
  };

  const bootBackends = async (): Promise<void> => {
    mkdirSync(join(dataDir, "logs"), { recursive: true });
    logger.app("lifecycle", "info", "app boot " + APP_NAME + " " + APP_VERSION, {
      data: { protocolVersion: PROTOCOL_VERSION },
    });
    await startHost();
    try {
      const stored = await runtimeState.host!.call("settings.get");
      await applyNetworkProxyFromAppSettings(stored);
    } catch {
      await applyNetworkProxyFromAppSettings({ mode: "system" });
    }
    await startSidecar();

    // Keep plugin host services wired to live workspace / app metadata.
    plugins.setServices({
      getWorkspacePath: () => {
        try {
          // Best-effort sync cache; refreshed on demand by callers that await host.
          return (globalThis as any).__piWorkspacePath ?? null;
        } catch {
          return null;
        }
      },
      getAppVersion: () => APP_VERSION,
    });
    try {
      const workspace = await runtimeState.host!.call<{
        workspace: { path?: string } | null;
      }>("workspace.get");
      setCurrentWorkspacePath(workspace.workspace?.path ?? null);
    } catch {
      setCurrentWorkspacePath(null);
    }

    // Restore enabled plugins.
    try {
      const listed = await runtimeState.host!.call<{ plugins: any[] }>("plugins.list");
      rememberPluginScopes(listed.plugins ?? []);
      for (const plugin of listed.plugins ?? []) {
        if (plugin.enabled && plugin.path) {
          try {
            await plugins.loadFromPath(plugin.path, plugin.permissions ?? [], {
              development: plugin.source === "dev",
            });
            // Dev plugins keep hot reload across restarts: the folder was picked
            // once, and the edit loop should not have to pick it again.
            if (plugin.source === "dev") plugins.watchDevPlugin(plugin.id);
            logger.app("plugin", "info", "plugin restored", {
              pluginId: plugin.id,
            });
          } catch (error) {
            logger.app("plugin", "error", "plugin restore failed", {
              pluginId: plugin.id,
              data: String(error),
            });
          }
        }
      }
    } catch (error) {
      logger.app("plugin", "error", "plugin list failed", {
        data: String(error),
      });
    }

    // The user's MCP servers are only registered here; each one connects the
    // first time a session that can see it is assembled.
    await refreshUserMcp();
    await drainApprovedPlanExecutions().catch((error) =>
      logger.app("runtime", "warn", "queued approved plan drain failed", {
        data: String(error),
      }),
    );
  };

  return { superviseRestart, bootHostStatus, runtimeArch, bootBackends };
}
