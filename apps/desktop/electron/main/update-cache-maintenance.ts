import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  adoptRelocatedUpdateCache,
  discardDownloadedUpdate,
  readUpdaterCacheDirName,
  updateCacheDirFor,
} from "./update-cache";
import type { Logger } from "./logger";

export type UpdateCacheMaintenanceOptions = {
  resourcesPath: string;
  activeBasePath: string;
  legacyBasePath: string | null;
  logger: Logger;
};

/**
 * Operations that reclaim update download staging and adopt a relocated cache.
 * The controller owns the updater state; this service owns cache filesystem work.
 */
export class UpdateCacheMaintenance {
  private readonly resourcesPath: string;
  private readonly activeBasePath: string;
  private readonly legacyBasePath: string | null;
  private readonly logger: Logger;

  constructor(options: UpdateCacheMaintenanceOptions) {
    this.resourcesPath = options.resourcesPath;
    this.activeBasePath = options.activeBasePath;
    this.legacyBasePath = options.legacyBasePath;
    this.logger = options.logger;
  }

  /** Remove the staged installer after the feed confirms the running version is current. */
  async discardDownloadedInstaller(): Promise<void> {
    const dirs = this.cacheDirs();
    if (!dirs) return;
    try {
      await discardDownloadedUpdate(dirs.active);
    } catch (error) {
      this.logger.app(
        "updater",
        "warn",
        "failed to discard the downloaded update",
        { data: { detail: String(error) } },
      );
    }
  }

  /** Adopt legacy delta baselines and pending update staging after relocation. */
  async reclaimLegacyCache(): Promise<void> {
    const dirs = this.cacheDirs();
    if (!dirs?.legacy) return;
    try {
      await adoptRelocatedUpdateCache(dirs.active, dirs.legacy);
      this.logger.app(
        "updater",
        "info",
        "adopted the relocated update cache",
        { data: { cacheDir: dirs.active } },
      );
    } catch (error) {
      this.logger.app(
        "updater",
        "warn",
        "failed to adopt the relocated update cache",
        { data: { detail: String(error) } },
      );
    }
  }

  private cacheDirs(): { active: string; legacy: string | null } | null {
    let feedConfig: string;
    try {
      feedConfig = readFileSync(
        join(this.resourcesPath, "app-update.yml"),
        "utf8",
      );
    } catch (error) {
      this.logger.app(
        "updater",
        "warn",
        "update feed configuration unavailable",
        { data: { detail: String(error) } },
      );
      return null;
    }
    const dirName = readUpdaterCacheDirName(feedConfig);
    if (!dirName) return null;
    return {
      active: updateCacheDirFor(this.activeBasePath, dirName),
      legacy: this.legacyBasePath
        ? updateCacheDirFor(this.legacyBasePath, dirName)
        : null,
    };
  }
}
