/** Shared public types grouped by the owning application domain. */
import type { CommandShellId } from "../command-shells.js";
import type { KeybindingOverrides } from "../keyboard-shortcuts.js";
import type { NetworkProxySettings } from "../network-proxy.js";
import type { ContextCompactionSettings } from "./sessions.js";
import type { Mode } from "./common.js";
import type { GlobalPermissionMode } from "./permissions.js";
import type { PluginMarketSource } from "./plugins.js";

export type ThemePreference = "system" | "light" | "dark" | `plugin:${string}`;

/**
 * What closing the main window does on Windows/Linux. macOS keeps the native
 * Dock lifecycle and never consults this preference.
 * - `ask`: transient unset state — the first close prompts once; after a
 *   choice is made it is remembered permanently and cannot be reverted
 * - `tray`: hide to the system tray; the app keeps running in the background
 * - `quit`: close the window and exit the app (legacy behavior)
 */
export type CloseBehavior = "ask" | "tray" | "quit";

export type AppSettings = {
  defaultProviderId?: string;
  defaultModelId?: string;
  defaultMode: Mode;
  /** Configured command shell for the agent Bash protocol tool. */
  defaultCommandShell?: CommandShellId;
  /** Global permission mode default; sessions with `inherit` follow this. */
  defaultPermissionMode?: GlobalPermissionMode;
  theme: ThemePreference;
  /** UI language; `auto` (and absent) follows the OS locale. */
  language?: "auto" | "en" | "zh-CN" | "zh-TW" | "tr" | "de" | "es" | "fr" | "ko";
  /**
   * Global UI font stack (CSS `font-family` value). Absent means the built-in
   * token stack; bundled open-source families and installed system families
   * are offered by the settings picker.
   */
  fontFamily?: string;
  /**
   * Global UI type scale (D343). `1` is the product `--text-*` ramp.
   * Absent means 1. Range 0.8–1.5 in 0.025 steps. Window zoom is independent.
   */
  fontScale?: number;
  /**
   * @deprecated Unreleased D343 px field. Reads migrate into `fontScale`
   * as `px / 14`; new writes persist `fontScale` instead.
   */
  fontSize?: number;
  enterToSend: boolean;
  /** Text length above which a plain-text paste becomes a session file reference. */
  largePasteThreshold?: number;
  /**
   * @deprecated No longer read. Compaction derives its budgets from the model
   * window instead of exposing knobs; persisted values are ignored so a
   * session disabled long ago is not stuck without a switch to re-enable it.
   */
  contextCompaction?: ContextCompactionSettings;
  /** User overrides for the shared application shortcut map. */
  keybindings?: KeybindingOverrides;
  /** Unlocks the devtools console (settings button, F12, macOS View menu). */
  developerMode?: boolean;
  /**
   * Extension marketplace provider. `mirror` targets the cnb.cool copy for
   * networks that cannot reach `raw.githubusercontent.com`; both serve the
   * same catalog and packages.
   */
  pluginMarketSource?: PluginMarketSource;
  /** Catalog URL used when `pluginMarketSource` is `custom`. */
  pluginMarketCustomUrl?: string;
  /**
   * Outbound proxy for app-owned HTTP (D340). Absent means System: Chromium
   * follows the OS proxy; Node sidecar traffic stays direct unless Custom
   * is set. See `network-proxy.ts`.
   */
  networkProxy?: NetworkProxySettings;
  /**
   * Preferred destination when clicking HTTP/HTTPS links in chat messages.
   * `workpanel`: Preview in the Work Panel browser tab (default).
   * `external`: Open directly in the system's default web browser.
   */
  linkOpenTarget?: LinkOpenTarget;
  /**
   * Which context figure the composer ring and its summary lead with (D398).
   * `remaining` (default, absent) counts down from 100%; `used` counts up.
   * Color thresholds always follow remaining capacity, so the warning state
   * does not change meaning with this preference.
   */
  contextUsageDisplay?: ContextUsageDisplay;
  onboardingDismissed: boolean;
};

export type LinkOpenTarget = "workpanel" | "external";

export type ContextUsageDisplay = "remaining" | "used";
