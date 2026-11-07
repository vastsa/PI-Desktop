import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const result = await build({
  stdin: { resolveDir: root, contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import i18n from 'i18next';
    import { initReactI18next } from 'react-i18next';
    import { AgentBehaviorSettings } from './apps/desktop/src/features/settings/pages/AgentBehaviorSettings';
    import { autonomousGoalEn } from './packages/i18n/src/autonomous-goal';
    export async function render() {
      await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { autonomousGoal: autonomousGoalEn } } } });
      return renderToStaticMarkup(React.createElement(AgentBehaviorSettings, {
        settings: { defaultMode: 'agent', defaultGoalBudget: { maxTurns: 7 }, computerUseEnabled: false },
        saveSettings: async () => {},
      }));
    }
  ` },
  bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
  loader: { ".css": "empty" },
  nodePaths: [path.join(root, "apps/desktop/node_modules")],
  alias: { "@pi-desktop/shared": path.join(root, "packages/shared/src/index.ts") },
});
const module = { exports: {} };
new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);

test("Agent behavior retains one working Goal budget row after the settings split", async () => {
  const markup = await module.exports.render();
  assert.equal((markup.match(/data-testid="goal-budget-settings"/g) ?? []).length, 1);
  assert.match(markup, /value="7"/);
  assert.match(markup, /aria-label="Turns"/);
});
