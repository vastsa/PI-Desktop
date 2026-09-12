import { join } from "node:path";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";

export type ScheduledRuntimeDependencies = {
  dataDir: string;
  getHost: () => HostProcess | null;
  logger: Pick<Logger, "app">;
};

export function createScheduledRuntime({
  dataDir,
  getHost,
  logger,
}: ScheduledRuntimeDependencies) {
  const scheduledPath = () => join(dataDir, "scheduled-tasks.json");

  /**
   * Scheduled tasks live in host-core SQLite (schema v2, D086). This one-shot
   * import moves the legacy Electron JSON store into the host, then renames
   * the file so it never imports twice.
   */
  const importLegacyScheduled = async (): Promise<void> => {
    const host = getHost();
    if (!host) return;
    const { readFile, rename } = await import("node:fs/promises");
    const path = scheduledPath();
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const result = await host.call<{ imported: number }>("scheduled.import", {
          tasks: parsed,
        });
        logger.app("persistence", "info", "legacy scheduled tasks imported", {
          data: { imported: result.imported, total: parsed.length },
        });
      }
      await rename(path, path + ".imported.bak");
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        logger.app("persistence", "warn", "legacy scheduled import failed", {
          data: String(error),
        });
      }
    }
  };

  return { scheduledPath, importLegacyScheduled };
}
