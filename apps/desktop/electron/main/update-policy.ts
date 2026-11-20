import type { UpdateMode, UpdatePreference } from "@pi-desktop/shared";

/**
 * How a packaged build was produced, stamped into its `package.json` as
 * `piDistribution`. `unsigned` marks a build with no Developer ID signature:
 * the platform updater cannot install over it, so it is never offered in-app
 * delivery, whatever preference the profile stores.
 */
export type PackagedDistribution = "installed" | "zip" | "portable" | "unsigned";

/** Kept for callers that predate the `unsigned` marker. */
export type WindowsDistribution = PackagedDistribution;

const PACKAGED_DISTRIBUTIONS: readonly string[] = ["installed", "zip", "portable", "unsigned"];

/** Unknown or malformed metadata reads as "no marker", never as an error. */
export function parsePackagedDistribution(value: unknown): PackagedDistribution | undefined {
  return typeof value === "string" && PACKAGED_DISTRIBUTIONS.includes(value)
    ? (value as PackagedDistribution)
    : undefined;
}

export function supportsAutomaticUpdates(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
  distribution?: PackagedDistribution,
): boolean {
  if (!isPackaged) return false;
  if (distribution === "unsigned") return false;
  if (platform === "win32" || platform === "darwin") return true;
  return platform === "linux" && Boolean(env.APPIMAGE);
}

export function resolveDefaultUpdatePreference(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
  distribution?: PackagedDistribution,
): UpdatePreference {
  if (!supportsAutomaticUpdates(platform, isPackaged, env, distribution)) return "manual";
  if (
    platform === "win32" &&
    (Boolean(env.PORTABLE_EXECUTABLE_FILE) || distribution === "zip" || distribution === "portable")
  ) {
    return "manual";
  }
  return "automatic";
}

export function resolveStoredUpdatePreference(
  value: unknown,
  fallback: UpdatePreference,
): UpdatePreference {
  return value === "automatic" || value === "manual" ? value : fallback;
}

export function resolveEffectiveUpdatePreference(
  preference: UpdatePreference,
  automaticSupported: boolean,
): UpdatePreference {
  return automaticSupported ? preference : "manual";
}

export function resolveUpdateMode(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
  distribution?: PackagedDistribution,
  preference?: UpdatePreference,
): UpdateMode {
  if (!isPackaged) return "disabled";
  if (!supportsAutomaticUpdates(platform, isPackaged, env, distribution)) return "manual";
  const selected =
    preference ??
    resolveDefaultUpdatePreference(platform, isPackaged, env, distribution);
  return selected === "automatic" ? "in-app" : "manual";
}
