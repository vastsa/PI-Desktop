import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

export const PROMPT_ENHANCEMENT_PLUGIN_ID = "pi.prompt-enhancement";

export type LegacyPromptEnhancementSettings = {
  promptEnhancementProviderId?: unknown;
  promptEnhancementModelId?: unknown;
  promptEnhancementThinkingLevel?: unknown;
  promptEnhancementCustomTemplate?: unknown;
  promptEnhancementUserTemplate?: unknown;
};

const MIGRATION_MARKER = "host-settings-migration-v1.json";
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "max"]);

/**
 * Copy the former host-owned preferences into the optional plugin's private
 * settings once. Existing plugin values win, and the old host settings remain
 * untouched so uninstalling or rolling back cannot lose user data.
 */
export function migrateLegacyPromptEnhancementSettings(
  pluginDataPath: string,
  legacy: LegacyPromptEnhancementSettings | null | undefined,
): { migrated: string[]; alreadyMigrated: boolean } {
  if (!legacy) return { migrated: [], alreadyMigrated: false };

  mkdirSync(pluginDataPath, { recursive: true });
  const markerPath = join(pluginDataPath, MIGRATION_MARKER);
  if (existsSync(markerPath)) {
    return { migrated: [], alreadyMigrated: true };
  }

  const settingsPath = join(pluginDataPath, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const stored: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      throw new Error("plugin settings must be a JSON object");
    }
    settings = stored as Record<string, unknown>;
  }

  const next = { ...settings };
  const migrated: string[] = [];
  const providerId = nonEmptyString(legacy.promptEnhancementProviderId);
  const modelId = nonEmptyString(legacy.promptEnhancementModelId);
  if (
    !Object.hasOwn(settings, "modelKey") &&
    providerId &&
    modelId
  ) {
    next.modelKey = `${providerId}/${modelId}`;
    migrated.push("modelKey");
  }

  const thinkingLevel = nonEmptyString(legacy.promptEnhancementThinkingLevel);
  if (
    !Object.hasOwn(settings, "thinkingLevel") &&
    thinkingLevel &&
    THINKING_LEVELS.has(thinkingLevel)
  ) {
    next.thinkingLevel = thinkingLevel;
    migrated.push("thinkingLevel");
  }

  const userTemplate = legacy.promptEnhancementUserTemplate;
  if (
    !Object.hasOwn(settings, "userTemplate") &&
    legacy.promptEnhancementCustomTemplate === true &&
    typeof userTemplate === "string" &&
    userTemplate.trim().length > 0 &&
    userTemplate.length <= 8000 &&
    userTemplate.includes("{{draft}}")
  ) {
    next.userTemplate = userTemplate;
    migrated.push("userTemplate");
  }

  if (migrated.length > 0) {
    atomicWrite(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  }
  atomicWrite(
    markerPath,
    `${JSON.stringify({ version: 1, migrated, completedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return { migrated, alreadyMigrated: false };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function atomicWrite(path: string, contents: string): void {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      // A failed rename can leave a private partial file behind.
      unlinkSync(temporaryPath);
    } catch {
      // The original error is more useful; cleanup is best effort.
    }
    throw error;
  }
}
