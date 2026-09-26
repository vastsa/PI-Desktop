import type { BrowserWindow, Tray } from "electron";
import { nativeTheme } from "electron";
import type {
  AppMenuCommand,
  CloseBehavior,
} from "@pi-desktop/shared";
import {
  emptyWorkPanelReservationState,
  type WindowBounds,
  type WorkPanelReservationState,
} from "../work-panel-window";
import type { WindowLifecycleState } from "./window";
import type { LauncherState } from "./launcher";
import type { RuntimeState } from "../runtime/context";
import type {
  ApplicationAppearanceState,
  ApplicationLifecycleState,
} from "./app-lifecycle";
import type { PlanRuntimeState } from "../runtime/plans";
import type { StartupState } from "./startup";
import type { ShutdownState } from "./shutdown";
import type { HostProcess } from "../host-process";
import type { AgentSidecar } from "../agent-sidecar";
import type { AgentHostBridge } from "../agent-host-bridge";
import type { McpControlController, McpControlServer } from "../mcp-control";
import type { BackendRouter } from "../remote/backend-router";

export type MenuRendererReadyGate = {
  window: BrowserWindow;
  ready: boolean;
  promise: Promise<void>;
  resolve: () => void;
};

export type PluginPanelTheme = "light" | "dark";

/**
 * Encapsulated mutable state container for the Electron main process.
 * Houses shared runtime references and provides bridge interfaces to subsystems.
 */
export class MainProcessState {
  mainWindow: BrowserWindow | null = null;
  tray: Tray | null = null;
  pluginLauncherWindow: BrowserWindow | null = null;
  pluginLauncherCreationPromise: Promise<BrowserWindow> | null = null;
  pluginLauncherAccelerator: string | null = null;
  pluginLauncherBinding: string | null = null;
  toggleWindowAccelerator: string | null = null;

  windowCreationPromise: Promise<void> | null = null;
  applicationBooted = false;
  pendingApplicationMenuCommands: AppMenuCommand[] = [];
  menuRendererReadyGate: MenuRendererReadyGate | null = null;
  appliedMenuSettings: string | null = null;

  requestedWorkPanelReservation = 0;
  workPanelReservation: WorkPanelReservationState = emptyWorkPanelReservationState();
  workPanelDisplayKey: string | null = null;
  workPanelBaseBounds: WindowBounds | null = null;
  workPanelLastAppliedBounds: WindowBounds | null = null;
  expectedWorkPanelBounds: WindowBounds | null = null;
  workPanelUserMovePending = false;
  workPanelNativeResizeActive = false;
  workPanelChatResizeActive = false;
  workPanelChatResizeTimer: NodeJS.Timeout | null = null;
  setWorkPanelChatWidthForWindow: ((width: number) => number) | null = null;

  host: HostProcess | null = null;
  sidecar: AgentSidecar | null = null;
  mcpControl: McpControlServer | null = null;
  agentHostBridge: AgentHostBridge | null = null;
  desktopControl: McpControlController | null = null;
  backendRouter: BackendRouter | null = null;

  quitting = false;
  shutdownComplete = false;
  shutdownPromise: Promise<void> | null = null;
  closeBehavior: CloseBehavior = "ask";
  closePromptOpen = false;
  quitConfirmed = false;
  developerMode = false;

  updaterLocale = "en";
  pluginPanelTheme: PluginPanelTheme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  appThemePreference = "system";
  broadcastAppearanceSignature = "";

  approvedExecutionDrain: Promise<void> | null = null;
  notificationViewingSessionId: string | null = null;
  readonly windowsAllowedToClose = new WeakSet<BrowserWindow>();

  readonly launcherState: LauncherState;
  readonly windowLifecycleState: WindowLifecycleState;
  readonly runtimeState: RuntimeState;
  readonly applicationLifecycleState: ApplicationLifecycleState;
  readonly applicationAppearanceState: ApplicationAppearanceState;
  readonly planRuntimeState: PlanRuntimeState;
  readonly startupState: StartupState;
  readonly shutdownState: ShutdownState;

  constructor() {
    const self = this;

    this.launcherState = {
      get creationPromise() {
        return self.pluginLauncherCreationPromise;
      },
      set creationPromise(value) {
        self.pluginLauncherCreationPromise = value;
      },
      get pluginLauncherAccelerator() {
        return self.pluginLauncherAccelerator;
      },
      set pluginLauncherAccelerator(value) {
        self.pluginLauncherAccelerator = value;
      },
      get toggleWindowAccelerator() {
        return self.toggleWindowAccelerator;
      },
      set toggleWindowAccelerator(value) {
        self.toggleWindowAccelerator = value;
      },
    };

    this.windowLifecycleState = {
      get mainWindow() {
        return self.mainWindow;
      },
      set mainWindow(value) {
        self.mainWindow = value;
      },
      get notificationViewingSessionId() {
        return self.notificationViewingSessionId;
      },
      set notificationViewingSessionId(value) {
        self.notificationViewingSessionId = value;
      },
      get requestedWorkPanelReservation() {
        return self.requestedWorkPanelReservation;
      },
      set requestedWorkPanelReservation(value) {
        self.requestedWorkPanelReservation = value;
      },
      get workPanelReservation() {
        return self.workPanelReservation;
      },
      set workPanelReservation(value) {
        self.workPanelReservation = value;
      },
      get workPanelDisplayKey() {
        return self.workPanelDisplayKey;
      },
      set workPanelDisplayKey(value) {
        self.workPanelDisplayKey = value;
      },
      get workPanelBaseBounds() {
        return self.workPanelBaseBounds;
      },
      set workPanelBaseBounds(value) {
        self.workPanelBaseBounds = value;
      },
      get workPanelLastAppliedBounds() {
        return self.workPanelLastAppliedBounds;
      },
      set workPanelLastAppliedBounds(value) {
        self.workPanelLastAppliedBounds = value;
      },
      get expectedWorkPanelBounds() {
        return self.expectedWorkPanelBounds;
      },
      set expectedWorkPanelBounds(value) {
        self.expectedWorkPanelBounds = value;
      },
      get workPanelUserMovePending() {
        return self.workPanelUserMovePending;
      },
      set workPanelUserMovePending(value) {
        self.workPanelUserMovePending = value;
      },
      get workPanelNativeResizeActive() {
        return self.workPanelNativeResizeActive;
      },
      set workPanelNativeResizeActive(value) {
        self.workPanelNativeResizeActive = value;
      },
      get workPanelChatResizeTimer() {
        return self.workPanelChatResizeTimer;
      },
      set workPanelChatResizeTimer(value) {
        self.workPanelChatResizeTimer = value;
      },
      get workPanelChatResizeActive() {
        return self.workPanelChatResizeActive;
      },
      set workPanelChatResizeActive(value) {
        self.workPanelChatResizeActive = value;
      },
      get setWorkPanelChatWidthForWindow() {
        return self.setWorkPanelChatWidthForWindow;
      },
      set setWorkPanelChatWidthForWindow(value) {
        self.setWorkPanelChatWidthForWindow = value;
      },
      get pluginLauncherBinding() {
        return self.pluginLauncherBinding;
      },
      set pluginLauncherBinding(value) {
        self.pluginLauncherBinding = value;
      },
      get closePromptOpen() {
        return self.closePromptOpen;
      },
      set closePromptOpen(value) {
        self.closePromptOpen = value;
      },
      get quitConfirmed() {
        return self.quitConfirmed;
      },
      set quitConfirmed(value) {
        self.quitConfirmed = value;
      },
      get menuRendererReadyGate() {
        return self.menuRendererReadyGate;
      },
      set menuRendererReadyGate(value) {
        self.menuRendererReadyGate = value;
      },
      get quitting() {
        return self.quitting;
      },
      set quitting(value) {
        self.quitting = value;
      },
      get tray() {
        return self.tray;
      },
      set tray(value) {
        self.tray = value;
      },
      get closeBehavior() {
        return self.closeBehavior;
      },
      set closeBehavior(value) {
        self.closeBehavior = value;
      },
      get developerMode() {
        return self.developerMode;
      },
      set developerMode(value) {
        self.developerMode = value;
      },
      get pluginLauncherWindow() {
        return self.pluginLauncherWindow;
      },
      set pluginLauncherWindow(value) {
        self.pluginLauncherWindow = value;
      },
      get host() {
        return self.host;
      },
      set host(value) {
        self.host = value;
      },
    };

    this.runtimeState = {
      get host() {
        return self.host;
      },
      set host(value) {
        self.host = value;
      },
      get sidecar() {
        return self.sidecar;
      },
      set sidecar(value) {
        self.sidecar = value;
      },
      get agentHostBridge() {
        return self.agentHostBridge;
      },
      set agentHostBridge(value) {
        self.agentHostBridge = value;
      },
    };

    this.applicationLifecycleState = {
      get windowCreationPromise() {
        return self.windowCreationPromise;
      },
      set windowCreationPromise(value) {
        self.windowCreationPromise = value;
      },
      get applicationBooted() {
        return self.applicationBooted;
      },
      set applicationBooted(value) {
        self.applicationBooted = value;
      },
      pendingApplicationMenuCommands: this.pendingApplicationMenuCommands,
      get appliedMenuSettings() {
        return self.appliedMenuSettings;
      },
      set appliedMenuSettings(value) {
        self.appliedMenuSettings = value;
      },
    };

    this.applicationAppearanceState = {
      get updaterLocale() {
        return self.updaterLocale;
      },
      set updaterLocale(value) {
        self.updaterLocale = value;
      },
      get pluginPanelTheme() {
        return self.pluginPanelTheme;
      },
      set pluginPanelTheme(value) {
        self.pluginPanelTheme = value;
      },
      get appThemePreference() {
        return self.appThemePreference;
      },
      set appThemePreference(value) {
        self.appThemePreference = value;
      },
      get broadcastAppearanceSignature() {
        return self.broadcastAppearanceSignature;
      },
      set broadcastAppearanceSignature(value) {
        self.broadcastAppearanceSignature = value;
      },
    };

    this.planRuntimeState = {
      get approvedExecutionDrain() {
        return self.approvedExecutionDrain;
      },
      set approvedExecutionDrain(value) {
        self.approvedExecutionDrain = value;
      },
    };

    this.startupState = {
      get applicationBooted() {
        return self.applicationBooted;
      },
      set applicationBooted(value) {
        self.applicationBooted = value;
      },
      get closeBehavior() {
        return self.closeBehavior;
      },
      set closeBehavior(value) {
        self.closeBehavior = value;
      },
      get agentHostBridge() {
        return self.agentHostBridge;
      },
      set agentHostBridge(value) {
        self.agentHostBridge = value;
      },
      get backendRouter() {
        return self.backendRouter;
      },
      set backendRouter(value) {
        self.backendRouter = value;
      },
      get desktopControl() {
        return self.desktopControl;
      },
      set desktopControl(value) {
        self.desktopControl = value;
      },
      get mcpControl() {
        return self.mcpControl;
      },
      set mcpControl(value) {
        self.mcpControl = value;
      },
    };

    this.shutdownState = {
      get shutdownComplete() {
        return self.shutdownComplete;
      },
      set shutdownComplete(value) {
        self.shutdownComplete = value;
      },
      get shutdownPromise() {
        return self.shutdownPromise;
      },
      set shutdownPromise(value) {
        self.shutdownPromise = value;
      },
      get quitting() {
        return self.quitting;
      },
      set quitting(value) {
        self.quitting = value;
      },
      get quitConfirmed() {
        return self.quitConfirmed;
      },
      set quitConfirmed(value) {
        self.quitConfirmed = value;
      },
      get closeBehavior() {
        return self.closeBehavior;
      },
      set closeBehavior(value) {
        self.closeBehavior = value;
      },
      get tray() {
        return self.tray;
      },
      set tray(value) {
        self.tray = value;
      },
      get pluginLauncherAccelerator() {
        return self.pluginLauncherAccelerator;
      },
      set pluginLauncherAccelerator(value) {
        self.pluginLauncherAccelerator = value;
      },
      get toggleWindowAccelerator() {
        return self.toggleWindowAccelerator;
      },
      set toggleWindowAccelerator(value) {
        self.toggleWindowAccelerator = value;
      },
    };
  }
}
