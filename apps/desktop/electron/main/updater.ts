/**
 * App auto-update via electron-updater against GitHub Releases.
 *
 * The feed (latest*.yml + installers) is attached to each GitHub Release by
 * .github/workflows/release.yml. Discovery always tracks the latest stable
 * release (`allowPrerelease = false`) so RC installs still graduate to newer
 * stables. Delivery mode per install:
 *  - Windows NSIS / Linux AppImage / packaged macOS → full in-app flow: silent
 *    background download, "restart to update" prompt, install-on-quit fallback.
 *  - Windows ZIP / legacy portable (`piDistribution = "zip"` or
 *    `PORTABLE_EXECUTABLE_FILE`) → notify + link. The
 *    NSIS installer must not replace a no-install run.
 *  - Linux deb (no $APPIMAGE in env) → notify + link.
 *  - Unpackaged dev runs → disabled (no app-update.yml in resources).
 *
 * The installer download cache lives in the user cache directory rather than
 * beside the installation; `PI_DESKTOP_UPDATE_CACHE_DIR` relocates it, and
 * `./update-cache` owns what may be reclaimed from it (#1098).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, shell } from "electron";
import electronUpdaterPkg from "electron-updater";
import type { AppUpdater, UpdateInfo, ProgressInfo } from "electron-updater";
import {
  formatChangelogNotes,
  IPC,
  type UpdatePreference,
  type UpdateState,
} from "@pi-desktop/shared";
import type { Logger } from "./logger";
import { parseAllowedExternalUrl } from "./safe-open-external";
import {
  defaultUpdateCacheBasePath,
  relocateUpdateCacheBasePath,
  resolveUpdateCacheOverride,
  UPDATE_CACHE_DIR_ENV,
} from "./update-cache";
import { UpdateCacheMaintenance } from "./update-cache-maintenance";
import {
  raceWithTimeout,
  UPDATE_CHECK_TIMEOUT_CODE,
} from "./update-timeout";
import {
  resolveDefaultUpdatePreference,
  resolveEffectiveUpdatePreference,
  resolveStoredUpdatePreference,
  resolveUpdateMode as resolveUpdateModePolicy,
  supportsAutomaticUpdates,
  type WindowsDistribution,
} from "./update-policy";
import { ManualUpdateReminderTracker } from "./manual-update-reminder";

export { resolveUpdateMode } from "./update-policy";
export type { WindowsDistribution } from "./update-policy";

const { NsisUpdater, autoUpdater } = electronUpdaterPkg;

/** Windows NSIS updater with a caller-selected cache base. */
class RelocatedNsisUpdater extends NsisUpdater {
  constructor(baseCachePath: string) {
    super();
    relocateUpdateCacheBasePath(this.app, baseCachePath);
  }
}

function createRelocatedUpdater(
  platform: NodeJS.Platform,
  baseCachePath: string,
): AppUpdater | null {
  return platform === "win32" ? new RelocatedNsisUpdater(baseCachePath) : null;
}

export const RELEASES_URL = "https://github.com/vastsa/PI-Desktop/releases/latest";

const AUTO_CHECK_INITIAL_DELAY_MS = 15_000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Auto-check wait. Chromium's GitHub hang is ~60s; do not pin UI on that. */
export const AUTO_CHECK_TIMEOUT_MS = 8_000;
/** Manual check can wait a bit longer; still far below the socket timeout. */
export const MANUAL_CHECK_TIMEOUT_MS = 15_000;

export type UpdaterSettings = {
  updatePreference?: unknown;
  lastNotifiedUpdateVersion?: unknown;
};

export type UpdaterOptions = {
  logger: Logger;
  send: (channel: string, payload: unknown) => void;
  currentVersion: string;
  readUpdateSettings?: () => Promise<UpdaterSettings>;
  persistLastNotifiedVersion?: (version: string) => Promise<void>;
  /**
   * Active product UI locale for shipped-locale release notes.
   * Called when attaching notes to update state; defaults to English.
   */
  getLocale?: () => string | null | undefined;
  /**
   * `PI_DESKTOP_UPDATE_CACHE_DIR`; an absolute directory moves the updater's
   * download cache out of the user cache directory. Empty keeps the default.
   */
  updateCacheDirOverride?: string | null;
  /** Overrides for tests. */
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
  distribution?: WindowsDistribution;
};

export class AppUpdaterController {
  private readonly logger: Logger;
  private readonly send: (channel: string, payload: unknown) => void;
  private readonly getLocale: () => string | null | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly isPackaged: boolean;
  private readonly env: NodeJS.ProcessEnv;
  private readonly distribution?: WindowsDistribution;
  private readonly defaultPreference: UpdatePreference;
  private readonly automaticSupported: boolean;
  private readonly readUpdateSettings?: () => Promise<UpdaterSettings>;
  private readonly persistLastNotifiedVersion?: (version: string) => Promise<void>;
  private readonly manualReminderTracker = new ManualUpdateReminderTracker();
  private preference: UpdatePreference;
  private preferenceRevision = 0;
  private settingsReady: Promise<void> | null = null;
  private autoCheckStarted = false;
  private disposed = false;
  private state: UpdateState;
  private manualRequested = false;
  private initialTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private listenersAttached = false;
  /**
   * Set before a downloaded update is handed to the platform installer.
   *
   * electron-updater spawns that installer synchronously and only asks the app
   * to quit afterwards, so the shutdown path must already know that the quit it
   * is about to see is the update restart.
   */
  private installRequested = false;
  private readonly autoUpdater: AppUpdater;
  private readonly cacheMaintenance: UpdateCacheMaintenance;

  private readPackagedDistribution(
    isPackaged: boolean,
  ): WindowsDistribution | undefined {
    if (!isPackaged) return undefined;
    try {
      const packageJson = JSON.parse(
        readFileSync(join(app.getAppPath(), "package.json"), "utf8"),
      ) as unknown;
      if (typeof packageJson !== "object" || packageJson === null) {
        return undefined;
      }
      const distribution = (packageJson as Record<string, unknown>)
        .piDistribution;
      return distribution === "installed" || distribution === "zip"
        ? distribution
        : undefined;
    } catch (error) {
      this.logger.app(
        "updater",
        "warn",
        "packaged distribution metadata unavailable",
        { data: { detail: String(error) } },
      );
      return undefined;
    }
  }

  constructor(options: UpdaterOptions) {
    this.logger = options.logger;
    this.send = options.send;
    this.getLocale = options.getLocale ?? (() => "en");
    const platform = options.platform ?? process.platform;
    const isPackaged = options.isPackaged ?? app.isPackaged;
    const distribution =
      options.distribution ??
      (platform === "win32"
        ? this.readPackagedDistribution(isPackaged)
        : undefined);
    this.platform = platform;
    this.isPackaged = isPackaged;
    this.env = process.env;
    this.distribution = distribution;
    this.defaultPreference = resolveDefaultUpdatePreference(
      platform,
      isPackaged,
      this.env,
      distribution,
    );
    this.preference = this.defaultPreference;
    this.automaticSupported = supportsAutomaticUpdates(
      platform,
      isPackaged,
      this.env,
    );
    this.readUpdateSettings = options.readUpdateSettings;
    this.persistLastNotifiedVersion = options.persistLastNotifiedVersion;
    const mode = resolveUpdateModePolicy(
      platform,
      isPackaged,
      this.env,
      distribution,
      this.preference,
    );
    const defaultCacheBasePath = defaultUpdateCacheBasePath({
      platform,
      env: process.env,
      home: homedir(),
    });
    const requestedCacheBasePath =
      options.updateCacheDirOverride ??
      resolveUpdateCacheOverride(process.env[UPDATE_CACHE_DIR_ENV]);
    const relocated =
      mode !== "in-app" || !requestedCacheBasePath
        ? null
        : createRelocatedUpdater(platform, requestedCacheBasePath);
    const activeBasePath =
      relocated && requestedCacheBasePath
        ? requestedCacheBasePath
        : defaultCacheBasePath;
    const legacyBasePath = relocated ? defaultCacheBasePath : null;
    if (requestedCacheBasePath && !relocated && mode !== "disabled") {
      this.logger.app(
        "updater",
        "warn",
        "update cache relocation is not supported on this target",
        { data: { platform } },
      );
    }
    this.autoUpdater = relocated ?? autoUpdater;
    this.cacheMaintenance = new UpdateCacheMaintenance({
      resourcesPath: process.resourcesPath,
      activeBasePath,
      legacyBasePath,
      logger: this.logger,
    });
    this.state = {
      mode,
      preference: this.preference,
      defaultPreference: this.defaultPreference,
      automaticSupported: this.automaticSupported,
      manualReminder: false,
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

  private ensureSettingsLoaded(): Promise<void> {
    if (this.settingsReady) return this.settingsReady;
    const preferenceRevision = this.preferenceRevision;
    this.settingsReady = (async () => {
      if (!this.readUpdateSettings) {
        this.applyPreference(this.preference, false);
        return;
      }
      try {
        const settings = await this.readUpdateSettings();
        if (this.disposed) return;
        const lastNotifiedVersion = settings.lastNotifiedUpdateVersion;
        if (
          typeof lastNotifiedVersion === "string" &&
          lastNotifiedVersion.length > 0 &&
          lastNotifiedVersion.length <= 128
        ) {
          this.manualReminderTracker.hydrate(lastNotifiedVersion);
        }
        const preference = resolveStoredUpdatePreference(
          settings.updatePreference,
          this.defaultPreference,
        );
        if (preferenceRevision === this.preferenceRevision) {
          this.applyPreference(preference, false);
        }
      } catch (error) {
        this.logger.app("updater", "warn", "update preferences unavailable", {
          data: { detail: String(error) },
        });
        if (preferenceRevision === this.preferenceRevision) {
          this.applyPreference("manual", false);
        }
      }
    })();
    return this.settingsReady;
  }

  private manualReminderFor(version: string): boolean {
    const decision = this.manualReminderTracker.observe(version);
    if (decision.persist && this.persistLastNotifiedVersion) {
      void this.persistLastNotifiedVersion(version).catch((error) => {
        this.logger.app("updater", "warn", "manual update reminder persistence failed", {
          data: { detail: String(error), version },
        });
      });
    }
    return decision.show;
  }

  private applyPreference(
    preference: UpdatePreference,
    checkImmediately: boolean,
  ): void {
    const previousMode = this.state.mode;
    const effectivePreference = resolveEffectiveUpdatePreference(
      preference,
      this.automaticSupported,
    );
    const mode = resolveUpdateModePolicy(
      this.platform,
      this.isPackaged,
      this.env,
      this.distribution,
      effectivePreference,
    );
    const preferenceChanged =
      effectivePreference !== this.preference || mode !== previousMode;
    this.preference = effectivePreference;
    this.autoUpdater.autoDownload = mode === "in-app";
    this.autoUpdater.autoInstallOnAppQuit = mode === "in-app";
    if (!preferenceChanged) return;

    const patch: Partial<UpdateState> = {
      mode,
      preference: effectivePreference,
      manualReminder: false,
    };
    if (mode === "manual") {
      if (
        this.state.status === "downloading" ||
        this.state.status === "downloaded"
      ) {
        patch.status = this.state.availableVersion ? "available" : "idle";
        patch.progressPercent = undefined;
      }
      if (this.state.availableVersion) {
        patch.manualReminder = this.manualReminderFor(
          this.state.availableVersion,
        );
      }
    }
    this.setState(patch);
    if (
      checkImmediately &&
      previousMode === "manual" &&
      mode === "in-app"
    ) {
      void this.check().catch(() => undefined);
    }
  }

  setPreference(preference: UpdatePreference): void {
    if (preference !== "automatic" && preference !== "manual") return;
    this.preferenceRevision += 1;
    this.applyPreference(preference, true);
  }

  private attachListeners() {
    if (this.listenersAttached) return;
    this.listenersAttached = true;

    // Do not let cached updates download or install before Host preferences load.
    this.autoUpdater.autoDownload = false;
    this.autoUpdater.autoInstallOnAppQuit = false;
    // electron-updater defaults allowPrerelease=true when the installed
    // version has a prerelease component (e.g. 0.2.0-rc.6). That pins the
    // GitHub provider to the same custom channel ("rc") and never offers a
    // newer stable release such as 0.2.2. Always track GitHub's latest
    // stable release so RC installs can graduate to stable.
    this.autoUpdater.allowPrerelease = false;
    // Only automatic mode may install on quit; manual mode never hands an
    // installer a no-install/portable directory.
    this.autoUpdater.logger = {
      info: (m: unknown) =>
        this.logger.app("updater", "info", "updater diagnostic", {
          data: { detail: String(m) },
        }),
      warn: (m: unknown) =>
        this.logger.app("updater", "warn", "updater diagnostic", {
          data: { detail: String(m) },
        }),
      error: (m: unknown) =>
        this.logger.app("updater", "error", "updater diagnostic", {
          data: { detail: String(m) },
        }),
      debug: (m: unknown) =>
        this.logger.app("updater", "debug", "updater diagnostic", {
          data: { detail: String(m) },
        }),
    };

    this.autoUpdater.on("checking-for-update", () => {
      this.setState({ status: "checking", error: undefined });
    });
    this.autoUpdater.on("update-available", (info: UpdateInfo) => {
      const automatic = this.state.mode === "in-app";
      this.setState({
        status: automatic ? "downloading" : "available",
        availableVersion: info.version,
        releaseNotes: this.notesFor(info.version),
        progressPercent: automatic ? 0 : undefined,
        manualReminder: automatic
          ? false
          : this.manualReminderFor(info.version),
      });
    });
    this.autoUpdater.on("update-not-available", () => {
      this.setState({
        status: "up-to-date",
        availableVersion: undefined,
        releaseNotes: undefined,
        progressPercent: undefined,
        manualReminder: false,
      });
      // In-app installs have no newer staged installer after the feed reports
      // current. Keep the differential baselines for the next update. Manual
      // delivery modes may share a cache with an installed NSIS copy.
      if (this.state.mode === "in-app") {
        void this.cacheMaintenance.discardDownloadedInstaller();
      }
    });
    this.autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      if (this.state.mode !== "in-app") return;
      this.setState({
        status: "downloading",
        // Preserve notes already attached when discovery advanced to download.
        releaseNotes:
          this.state.releaseNotes ?? this.notesFor(this.state.availableVersion),
        progressPercent: Math.round(progress.percent),
      });
    });
    this.autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      const automatic = this.state.mode === "in-app";
      this.setState({
        status: automatic ? "downloaded" : "available",
        availableVersion: info.version,
        releaseNotes: this.notesFor(info.version),
        progressPercent: automatic ? 100 : undefined,
        manualReminder: automatic
          ? false
          : this.manualReminderFor(info.version),
      });
    });
    this.autoUpdater.on("error", (error: Error) => {
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
    await this.ensureSettingsLoaded();
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
        this.autoUpdater.checkForUpdates(),
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
    await this.autoUpdater.downloadUpdate();
    return this.state;
  }

  /**
   * True once a downloaded update was handed to the platform installer.
   *
   * The NSIS/AppImage installer is spawned before `app.quit()` and gives up
   * after a few seconds when the app is still running, so the quit that follows
   * must not be deferred — including by the explicit-quit confirmation.
   */
  isInstallingUpdate(): boolean {
    return this.installRequested;
  }

  /** Quit and install a downloaded update (in-app mode). */
  install(): void {
    if (this.state.mode !== "in-app" || this.state.status !== "downloaded") {
      throw new Error("no downloaded update to install");
    }
    // Marked before the call: quitAndInstall spawns the installer itself, so
    // the shutdown handler must already know this quit is the update restart.
    this.installRequested = true;
    // Fires 'before-quit' first, so host/sidecar shutdown still runs.
    this.autoUpdater.quitAndInstall(false, true);
  }
  /** Adopt legacy NSIS cache files before the first update check. */
  reclaimRelocatedUpdateCache(): Promise<void> {
    if (this.state.mode === "disabled") return Promise.resolve();
    return this.cacheMaintenance.reclaimLegacyCache();
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
    if (this.autoCheckStarted || this.state.mode === "disabled") return;
    this.autoCheckStarted = true;
    void this.ensureSettingsLoaded().then(() => {
      if (this.disposed || this.state.mode === "disabled") return;
      this.initialTimer = setTimeout(() => {
        void this.check().catch(() => undefined);
      }, AUTO_CHECK_INITIAL_DELAY_MS);
      this.intervalTimer = setInterval(() => {
        void this.check().catch(() => undefined);
      }, AUTO_CHECK_INTERVAL_MS);
    });
  }

  dispose() {
    this.disposed = true;
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
  }
}
