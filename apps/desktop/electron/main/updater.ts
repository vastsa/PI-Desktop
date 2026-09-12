/**
 * App auto-update via electron-updater against GitHub Releases.
 *
 * The feed (latest*.yml + installers) is attached to each GitHub Release by
 * .github/workflows/release.yml. Discovery always tracks the latest stable
 * release (`allowPrerelease = false`) so RC installs still graduate to newer
 * stables. Delivery mode per install:
 *  - Windows NSIS / Linux AppImage → full in-app flow: silent background
 *    download, "restart to update" prompt, install-on-quit fallback.
 *  - Windows portable (`PORTABLE_EXECUTABLE_FILE`) → notify + link. The
 *    NSIS installer must not replace a no-install run.
 *  - macOS → manual discovery and a releases-page link. In-app installation
 *    remains disabled pending a separate delivery-policy qualification.
 *  - Linux deb (no $APPIMAGE in env) → notify + link, like macOS.
 *  - Unpackaged dev runs → disabled (no app-update.yml in resources).
 */
import { app, shell } from "electron";
import electronUpdaterPkg from "electron-updater";
import type { UpdateInfo, ProgressInfo } from "electron-updater";
import {
  formatChangelogNotes,
  IPC,
  type UpdateMode,
  type UpdateState,
} from "@pi-desktop/shared";
import type { Logger } from "./logger";
import { parseAllowedExternalUrl } from "./safe-open-external";
import {
  raceWithTimeout,
  UPDATE_CHECK_TIMEOUT_CODE,
} from "./update-timeout";

const { autoUpdater } = electronUpdaterPkg;

export const RELEASES_URL = "https://github.com/vastsa/PI-Desktop/releases/latest";

const AUTO_CHECK_INITIAL_DELAY_MS = 15_000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Auto-check wait. Chromium's GitHub hang is ~60s; do not pin UI on that. */
export const AUTO_CHECK_TIMEOUT_MS = 8_000;
/** Manual check can wait a bit longer; still far below the socket timeout. */
export const MANUAL_CHECK_TIMEOUT_MS = 15_000;

export type UpdaterOptions = {
  logger: Logger;
  send: (channel: string, payload: unknown) => void;
  currentVersion: string;
  /**
   * Active product UI locale for shipped-locale release notes.
   * Called when attaching notes to update state; defaults to English.
   */
  getLocale?: () => string | null | undefined;
  /** Overrides for tests. */
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
};

export function resolveUpdateMode(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
): UpdateMode {
  if (!isPackaged) return "disabled";
  if (platform === "win32") {
    return env.PORTABLE_EXECUTABLE_FILE ? "manual" : "in-app";
  }
  if (platform === "linux" && env.APPIMAGE) return "in-app";
  // darwin (unsigned) and non-AppImage linux installs
  return "manual";
}

export class AppUpdaterController {
  private readonly logger: Logger;
  private readonly send: (channel: string, payload: unknown) => void;
  private readonly getLocale: () => string | null | undefined;
  private state: UpdateState;
  private manualRequested = false;
  private initialTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private listenersAttached = false;

  constructor(options: UpdaterOptions) {
    this.logger = options.logger;
    this.send = options.send;
    this.getLocale = options.getLocale ?? (() => "en");
    const mode = resolveUpdateMode(
      options.platform ?? process.platform,
      options.isPackaged ?? app.isPackaged,
    );
    this.state = {
      mode,
      status: "idle",
      currentVersion: options.currentVersion,
      releasesUrl: RELEASES_URL,
    };
    if (mode !== "disabled") this.attachListeners();
  }

  /** Localized product notes for a discovered version, if catalogued. */
  private notesFor(version: string | undefined): string | undefined {
    if (!version) return undefined;
    return formatChangelogNotes(version, this.getLocale());
  }

  private attachListeners() {
    if (this.listenersAttached) return;
    this.listenersAttached = true;

    autoUpdater.autoDownload = this.state.mode === "in-app";
    // electron-updater defaults allowPrerelease=true when the installed
    // version has a prerelease component (e.g. 0.2.0-rc.6). That pins the
    // GitHub provider to the same custom channel ("rc") and never offers a
    // newer stable release such as 0.2.2. Always track GitHub's latest
    // stable release so RC installs can graduate to stable.
    autoUpdater.allowPrerelease = false;
    // Even if the user ignores the restart prompt, a downloaded update
    // lands on the next normal quit.
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = {
      info: (m: unknown) => this.logger.app("updater", "info", `updater: ${String(m)}`),
      warn: (m: unknown) => this.logger.app("updater", "warn", `updater: ${String(m)}`),
      error: (m: unknown) => this.logger.app("updater", "error", `updater: ${String(m)}`),
      debug: (m: unknown) => this.logger.app("updater", "debug", `updater: ${String(m)}`),
    };

    autoUpdater.on("checking-for-update", () => {
      this.setState({ status: "checking", error: undefined });
    });
    autoUpdater.on("update-available", (info: UpdateInfo) => {
      this.setState({
        status: this.state.mode === "in-app" ? "downloading" : "available",
        availableVersion: info.version,
        releaseNotes: this.notesFor(info.version),
        progressPercent: this.state.mode === "in-app" ? 0 : undefined,
      });
    });
    autoUpdater.on("update-not-available", () => {
      this.setState({
        status: "up-to-date",
        availableVersion: undefined,
        releaseNotes: undefined,
        progressPercent: undefined,
      });
    });
    autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      this.setState({
        status: "downloading",
        // Preserve notes already attached when discovery advanced to download.
        releaseNotes:
          this.state.releaseNotes ?? this.notesFor(this.state.availableVersion),
        progressPercent: Math.round(progress.percent),
      });
    });
    autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      this.setState({
        status: "downloaded",
        availableVersion: info.version,
        releaseNotes: this.notesFor(info.version),
        progressPercent: 100,
      });
    });
    autoUpdater.on("error", (error: Error) => {
      // Auto checks fail quietly (offline, private repo, rate limits);
      // the renderer only surfaces errors when `manual` is set.
      this.logger.app("updater", "warn", "updater error", { data: String(error) });
      this.setState({ status: "error", error: error.message });
    });
  }

  private setState(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch, manual: this.manualRequested };
    this.send(IPC.event.updatesState, this.state);
  }

  getState(): UpdateState {
    return this.state;
  }

  /**
   * Re-resolve release notes after the product UI locale changes so the
   * banner and Settings → Info stay aligned without a new feed check.
   */
  refreshReleaseNotes(): UpdateState {
    if (!this.state.availableVersion) return this.state;
    const next = this.notesFor(this.state.availableVersion);
    if (next === this.state.releaseNotes) return this.state;
    this.setState({ releaseNotes: next });
    return this.state;
  }

  /** User- or schedule-triggered check. Resolves with the settled state. */
  async check(options: { manual?: boolean } = {}): Promise<UpdateState> {
    if (this.state.mode === "disabled") {
      throw new Error("updates are disabled in development builds");
    }
    if (
      this.state.status === "checking" ||
      this.state.status === "downloading" ||
      this.state.status === "downloaded"
    ) {
      return this.state;
    }
    this.manualRequested = Boolean(options.manual);
    const timeoutMs = this.manualRequested
      ? MANUAL_CHECK_TIMEOUT_MS
      : AUTO_CHECK_TIMEOUT_MS;
    try {
      // Fire-and-forget relative to boot: callers must not await this from the
      // first-window path. The race only bounds *our* wait; electron-updater
      // may still finish later and emit available/up-to-date.
      await raceWithTimeout(
        autoUpdater.checkForUpdates(),
        timeoutMs,
        "update check",
      );
    } catch (error) {
      const timedOut =
        (error as { code?: unknown } | null)?.code === UPDATE_CHECK_TIMEOUT_CODE;
      if (timedOut) {
        if (this.manualRequested) {
          this.setState({ status: "error", error: "update check timed out" });
          throw error;
        }
        // Auto checks fail quietly. Drop "checking" so a 60s GitHub hang
        // cannot skip the next interval or freeze Settings on a spinner.
        // Read through getState(): check() already narrowed this.state.status
        // away from "checking", but the checking-for-update listener can set
        // it during the awaited race.
        if (this.getState().status === "checking") {
          this.setState({ status: "idle", error: undefined });
        }
        return this.state;
      }
      // The 'error' listener already recorded state; rethrow for manual
      // callers so the invoke rejects and the UI can toast it.
      if (options.manual) throw error;
    }
    return this.state;
  }

  /** Explicit download for in-app installs when a check was manual-only. */
  async download(): Promise<UpdateState> {
    if (this.state.mode !== "in-app") {
      throw new Error("in-app download is not supported on this install");
    }
    if (this.state.status === "downloading" || this.state.status === "downloaded") {
      return this.state;
    }
    await autoUpdater.downloadUpdate();
    return this.state;
  }

  /** Quit and install a downloaded update (in-app mode). */
  install(): void {
    if (this.state.status !== "downloaded") {
      throw new Error("no downloaded update to install");
    }
    // Fires 'before-quit' first, so host/sidecar shutdown still runs.
    autoUpdater.quitAndInstall(false, true);
  }

  async openReleases(): Promise<void> {
    const url = parseAllowedExternalUrl(RELEASES_URL);
    if (!url) throw new Error("DISALLOWED_EXTERNAL_URL");
    await shell.openExternal(url);
  }

  /**
   * Schedule background GitHub feed checks. Never await this from boot: the
   * first check is delayed and time-bounded so a hung feed cannot block the
   * first window or pin the updater on `checking`.
   */
  startAutoCheck() {
    if (this.state.mode === "disabled" || this.initialTimer || this.intervalTimer) {
      return;
    }
    this.initialTimer = setTimeout(() => {
      void this.check().catch(() => undefined);
    }, AUTO_CHECK_INITIAL_DELAY_MS);
    this.intervalTimer = setInterval(() => {
      void this.check().catch(() => undefined);
    }, AUTO_CHECK_INTERVAL_MS);
  }

  dispose() {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
  }
}
