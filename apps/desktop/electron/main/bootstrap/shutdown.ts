import { app, globalShortcut, type Tray } from "electron";
import type { CloseBehavior } from "@pi-desktop/shared";
import type { AgentSidecar } from "../agent-sidecar";
import type { BrowserPane } from "../browser-view";
import type { HostProcess } from "../host-process";
import type { InflightCheckpointer } from "../inflight-checkpoint";
import type { Logger } from "../logger";
import type { PersistenceOutbox } from "../persistence-outbox";
import type { PluginPanelHost } from "../plugin-panel-host";
import type { PluginRuntime } from "../plugin-runtime";
import type { PluginViewHost } from "../plugin-view-host";
import type { AppUpdaterController } from "../updater";
import type { UserMcpRuntime } from "../user-mcp";
import type { McpControlServer } from "../mcp-control";

const QUIT_TURN_SETTLE_BUDGET_MS = 2_000;

export type ShutdownState = {
  shutdownComplete: boolean;
  shutdownPromise: Promise<void> | null;
  quitting: boolean;
  quitConfirmed: boolean;
  closeBehavior: CloseBehavior;
  tray: Tray | null;
  pluginLauncherAccelerator: string | null;
  summonWindowAccelerator: string | null;
};

export type ShutdownDependencies = {
  hasSingleInstanceLock: boolean;
  state: ShutdownState;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  getMcpControl: () => McpControlServer | null;
  activeTurns: Map<string, string>;
  persistenceOutbox: PersistenceOutbox;
  inflightCheckpointer: InflightCheckpointer;
  pluginPanels: Pick<PluginPanelHost, "closeAll">;
  plugins: Pick<PluginRuntime, "disposeAll">;
  userMcp: Pick<UserMcpRuntime, "disposeAll">;
  browserPane: Pick<BrowserPane, "dispose">;
  pluginViews: Pick<PluginViewHost, "dispose">;
  updater: Pick<AppUpdaterController, "dispose">;
  logger: Pick<Logger, "app">;
  confirmQuitDialog: () => Promise<boolean>;
};

/** Register the last-window and before-quit resource lifecycle handlers. */
export function registerShutdownHandlers({
  hasSingleInstanceLock,
  state,
  getHost,
  getSidecar,
  getMcpControl,
  activeTurns,
  persistenceOutbox,
  inflightCheckpointer,
  pluginPanels,
  plugins,
  userMcp,
  browserPane,
  pluginViews,
  updater,
  logger,
  confirmQuitDialog,
}: ShutdownDependencies): void {
  app.on("window-all-closed", () => {
    // The D216 tray is resident on every platform, so its presence says nothing
    // about whether the app should survive a closed window — the user's close
    // behavior does. Under "tray" a window destroyed for any reason must not
    // take the app down (the tray click recreates it); otherwise closing the
    // last window on Windows/Linux exits the app as before.
    if (process.platform === "darwin") return;
    if (state.closeBehavior === "tray" && state.tray) return;
    app.quit();
  });

  app.on("before-quit", (event) => {
    // A duplicate launch has no host, sidecar, panel, or outbox of its own, and
    // the shutdown sequence below would write into the running instance's data
    // directory. Let it exit straight away.
    if (!hasSingleInstanceLock) return;
    if (state.shutdownComplete) return;
    event.preventDefault();
    if (state.shutdownPromise) return;

    // Show a confirmation dialog on the first explicit quit (Cmd+Q, tray quit,
    // application-menu Quit). The data-saving shutdown runs after confirmation.
    // Skip confirmation in automated probe/capture modes where no human is
    // present to interact with the dialog.
    const isAutomatedMode =
      process.env.PI_DESKTOP_BOOT_PROBE === "1" ||
      process.env.PI_DESKTOP_SUPERVISION_PROBE === "1" ||
      process.env.PI_DESKTOP_CAPTURE === "1";
    if (!state.quitConfirmed && !isAutomatedMode) {
      state.quitConfirmed = true;
      void confirmQuitDialog().then((confirmed) => {
        if (confirmed) {
          app.quit();
        } else {
          // User cancelled: allow future quit requests to prompt again.
          state.quitConfirmed = false;
        }
      });
      return;
    }

    state.quitting = true;
    state.tray?.destroy();
    state.tray = null;
    if (state.pluginLauncherAccelerator) {
      globalShortcut.unregister(state.pluginLauncherAccelerator);
      state.pluginLauncherAccelerator = null;
    }
    if (state.summonWindowAccelerator) {
      globalShortcut.unregister(state.summonWindowAccelerator);
      state.summonWindowAccelerator = null;
    }
    state.shutdownPromise = (async () => {
      // Replies still streaming are stopped through the sidecar first so their
      // aborted final rows can reach the transcript while host-core is alive;
      // whatever does not make it in time is covered by the last checkpoint
      // (D299). Bounded: a quit must not hang on an unresponsive provider.
      await settleRunningTurnsForQuit({
        activeTurns,
        getHost,
        getSidecar,
        inflightCheckpointer,
        persistenceOutbox,
        logger,
      });
      const hostShutdown = getHost()?.dispose();
      const mcpShutdown = getMcpControl()?.stop();
      const pluginPanelShutdown = pluginPanels.closeAll();
      updater.dispose();
      logger.app("lifecycle", "info", "app shutdown");
      // Plugin hosts are stopped as a shutdown, not left for the process teardown
      // to kill: an unannounced exit is indistinguishable from a crash, and would
      // end every quit in error logs, toasts, and restarts into a closing app.
      const pluginShutdown = plugins.disposeAll();
      userMcp.disposeAll();
      browserPane.dispose();
      pluginViews.dispose();
      inflightCheckpointer.dispose();
      const sidecarShutdown = getSidecar()?.dispose();

      try {
        await hostShutdown;
      } catch (error) {
        logger.app("lifecycle", "warn", "host shutdown failed", { data: String(error) });
      }
      await Promise.allSettled([
        pluginPanelShutdown,
        pluginShutdown,
        sidecarShutdown,
        mcpShutdown,
      ]);
    })();

    const releaseQuit = () => {
      state.shutdownComplete = true;
      app.quit();
    };
    void state.shutdownPromise.then(releaseQuit, releaseQuit);
  });
}

type TurnSettlementDependencies = {
  activeTurns: Map<string, string>;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  inflightCheckpointer: InflightCheckpointer;
  persistenceOutbox: PersistenceOutbox;
  logger: Pick<Logger, "app">;
};

async function settleRunningTurnsForQuit({
  activeTurns,
  getHost,
  getSidecar,
  inflightCheckpointer,
  persistenceOutbox,
  logger,
}: TurnSettlementDependencies): Promise<void> {
  const sessions = [...activeTurns.keys()];
  const deadline = Date.now() + QUIT_TURN_SETTLE_BUDGET_MS;
  // The newest snapshot of every streaming reply lands first: it is the
  // fallback if the abort below does not produce a final row in time.
  await inflightCheckpointer.flushAll();
  if (sessions.length === 0) {
    await persistenceOutbox.flush(getHost);
    return;
  }
  const sidecar = getSidecar();
  if (sidecar) {
    await Promise.allSettled(
      sessions.map((sessionId) =>
        Promise.race([
          sidecar.call("agent.abort", { sessionId }),
          new Promise((resolve) => setTimeout(resolve, 800)),
        ]),
      ),
    );
  }
  // The abort surfaces as message_end + error/agent_end, which finishTurn
  // turns into a settled turn and an outbox append. Wait for that, bounded.
  while (Date.now() < deadline) {
    await persistenceOutbox.flush(getHost);
    if (activeTurns.size === 0 && persistenceOutbox.size() === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await persistenceOutbox.flush(getHost);
  if (activeTurns.size > 0 || persistenceOutbox.size() > 0) {
    logger.app("lifecycle", "warn", "quit before streaming replies settled", {
      data: { running: activeTurns.size, pendingAppends: persistenceOutbox.size() },
    });
  }
}
