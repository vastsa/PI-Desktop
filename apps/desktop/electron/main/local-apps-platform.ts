/**
 * Per-platform readers for the local application catalog (issue #2085).
 *
 * Each reader turns one registry into `DiscoveredApp` entries and pushes
 * non-fatal I/O problems into `diagnostics` instead of throwing. All
 * filesystem access goes through `LocalAppDeps`, so these readers are
 * unit-testable for every platform from a single host.
 */
import type { DiscoveredApp, LocalAppDeps, ShortcutInfo } from "./local-apps.ts";
import {
  basename,
  desktopExecutable,
  isAbsolutePath,
  isLaunchableDesktopEntry,
  isNoiseShortcut,
  localAppId,
  parseDesktopEntry,
  stripExtension,
  stripFileExtension,
} from "./local-app-parse.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Windows: Start Menu shortcuts (`*.lnk`), resolved through the injected
 * shortcut reader. Shortcuts pointing at missing files, uninstallers, help
 * files or readme files are skipped.
 */
export async function discoverWindowsApps(
  deps: LocalAppDeps,
  diagnostics: string[],
): Promise<DiscoveredApp[]> {
  const apps: DiscoveredApp[] = [];
  for (const directory of deps.startMenuDirs) {
    let shortcuts: string[];
    try {
      shortcuts = await deps.listShortcutTargets(directory);
    } catch (error) {
      diagnostics.push(`start menu scan failed for ${directory}: ${errorMessage(error)}`);
      continue;
    }
    for (const shortcutPath of shortcuts) {
      if (!shortcutPath.toLowerCase().endsWith(".lnk")) continue;
      const name = stripExtension(basename(shortcutPath), ".lnk");
      let shortcut: ShortcutInfo | null;
      try {
        shortcut = deps.readShortcutLink(shortcutPath);
      } catch (error) {
        diagnostics.push(`shortcut read failed for ${shortcutPath}: ${errorMessage(error)}`);
        continue;
      }
      const target = shortcut?.target?.trim() ?? "";
      if (target.length === 0) continue;
      if (isNoiseShortcut(name, target)) continue;
      let present: boolean;
      try {
        present = await deps.pathExists(target);
      } catch (error) {
        diagnostics.push(`shortcut target check failed for ${target}: ${errorMessage(error)}`);
        continue;
      }
      if (!present) continue;
      const executableName = stripFileExtension(basename(target));
      apps.push({
        id: localAppId(executableName, target),
        name,
        executableName,
        source: "start-menu",
        launchTarget: target,
        iconPath: shortcut?.icon || undefined,
      });
    }
  }
  return apps;
}

function isAppBundlePath(target: string): boolean {
  return target.trim().toLowerCase().endsWith(".app");
}

/**
 * macOS: `.app` bundles directly below each bundle root, plus one nesting
 * level so `/Applications/<Vendor>/*.app` is found.
 */
export async function discoverMacApps(
  deps: LocalAppDeps,
  diagnostics: string[],
): Promise<DiscoveredApp[]> {
  const apps: DiscoveredApp[] = [];
  const visited = new Set<string>();
  for (const directory of deps.appDirectories) {
    let children: string[];
    try {
      children = await deps.listFiles(directory);
    } catch (error) {
      diagnostics.push(`bundle scan failed for ${directory}: ${errorMessage(error)}`);
      continue;
    }
    const bundles: string[] = [];
    for (const child of children) {
      if (isAppBundlePath(child)) {
        bundles.push(child);
        continue;
      }
      // Vendor folders hold one extra level of bundles; plain files (disk
      // images, notes) are simply not directories, so skip them quietly.
      let nested: string[] = [];
      try {
        nested = await deps.listFiles(child);
      } catch {
        nested = [];
      }
      for (const candidate of nested) {
        if (isAppBundlePath(candidate)) bundles.push(candidate);
      }
    }
    for (const bundlePath of bundles) {
      if (visited.has(bundlePath)) continue;
      visited.add(bundlePath);
      const name = stripExtension(basename(bundlePath), ".app");
      if (name.length === 0) continue;
      let executableName: string | undefined;
      try {
        executableName = deps.readBundleExecutable(bundlePath) ?? undefined;
      } catch (error) {
        diagnostics.push(`bundle read failed for ${bundlePath}: ${errorMessage(error)}`);
      }
      apps.push({
        id: localAppId(executableName ?? name, bundlePath),
        name,
        executableName,
        source: "app-bundle",
        launchTarget: bundlePath,
        iconPath: bundlePath,
      });
    }
  }
  return apps;
}

/** Linux: freedesktop `.desktop` entries. */
export async function discoverLinuxApps(
  deps: LocalAppDeps,
  diagnostics: string[],
): Promise<DiscoveredApp[]> {
  const apps: DiscoveredApp[] = [];
  for (const directory of deps.appDirectories) {
    let children: string[];
    try {
      children = await deps.listFiles(directory);
    } catch (error) {
      diagnostics.push(`desktop entry scan failed for ${directory}: ${errorMessage(error)}`);
      continue;
    }
    for (const file of children) {
      if (!file.toLowerCase().endsWith(".desktop")) continue;
      let text: string;
      try {
        text = await deps.readText(file);
      } catch (error) {
        diagnostics.push(`desktop entry read failed for ${file}: ${errorMessage(error)}`);
        continue;
      }
      const entry = parseDesktopEntry(text);
      if (!entry || !isLaunchableDesktopEntry(entry)) continue;
      const executable = desktopExecutable(entry.exec);
      if (!executable) continue;
      const absolute = isAbsolutePath(executable);
      if (absolute) {
        let present: boolean;
        try {
          present = await deps.pathExists(executable);
        } catch (error) {
          diagnostics.push(
            `desktop entry target check failed for ${executable}: ${errorMessage(error)}`,
          );
          continue;
        }
        if (!present) continue;
      }
      const executableName = stripFileExtension(basename(executable));
      apps.push({
        id: localAppId(executableName, absolute ? executable : file),
        name: entry.name,
        executableName,
        source: "desktop-entry",
        launchTarget: executable,
      });
    }
  }
  return apps;
}
