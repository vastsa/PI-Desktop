import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const here = new URL(".", import.meta.url);
register(pathToFileURL(new URL("helpers/ts-import-hooks.mjs", here).pathname));
const { migrateLegacyPromptEnhancementSettings } = await import(
  "../electron/main/plugin-prompt-enhancement-migration.ts"
);

function makePluginData(settings) {
  const dir = mkdtempSync(join(tmpdir(), "pi-prompt-enhancement-migration-"));
  if (settings !== undefined) {
    writeFileSync(join(dir, "settings.json"), JSON.stringify(settings), "utf8");
  }
  return dir;
}

const legacySettings = {
  promptEnhancementProviderId: "provider-a",
  promptEnhancementModelId: "model-b",
  promptEnhancementThinkingLevel: "high",
  promptEnhancementCustomTemplate: true,
  promptEnhancementUserTemplate: "Rewrite this: {{draft}}",
};

test("first plugin load migrates legacy preferences without replacing plugin values", () => {
  const dir = makePluginData({ modelKey: "", userTemplate: "plugin template {{draft}}" });

  const result = migrateLegacyPromptEnhancementSettings(dir, legacySettings);

  assert.deepEqual(result, {
    migrated: ["thinkingLevel"],
    alreadyMigrated: false,
  });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")), {
    modelKey: "",
    userTemplate: "plugin template {{draft}}",
    thinkingLevel: "high",
  });
  assert.equal(existsSync(join(dir, "host-settings-migration-v1.json")), true);
});

test("migration marker prevents later imports from restoring a cleared plugin value", () => {
  const dir = makePluginData();
  migrateLegacyPromptEnhancementSettings(dir, legacySettings);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ modelKey: "" }), "utf8");

  const result = migrateLegacyPromptEnhancementSettings(dir, legacySettings);

  assert.deepEqual(result, { migrated: [], alreadyMigrated: true });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")), {
    modelKey: "",
  });
});

test("migration skips inactive or invalid legacy custom templates", () => {
  const dir = makePluginData();
  const result = migrateLegacyPromptEnhancementSettings(dir, {
    ...legacySettings,
    promptEnhancementCustomTemplate: false,
    promptEnhancementUserTemplate: "No draft token",
  });

  assert.deepEqual(result, {
    migrated: ["modelKey", "thinkingLevel"],
    alreadyMigrated: false,
  });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")), {
    modelKey: "provider-a/model-b",
    thinkingLevel: "high",
  });
});

test("corrupt plugin settings are preserved and leave migration retryable", () => {
  const dir = makePluginData();
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, "{broken", "utf8");

  assert.throws(() => migrateLegacyPromptEnhancementSettings(dir, legacySettings));
  assert.equal(readFileSync(settingsPath, "utf8"), "{broken");
  assert.equal(existsSync(join(dir, "host-settings-migration-v1.json")), false);
});
