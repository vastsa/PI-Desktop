import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isKnownWorkPanelTab,
  sanitizeWorkPanelTabsState,
  toolWorkPanelTab,
} from "../src/lib/work-panel-tabs.ts";

const workPanelSource = readFileSync(
  new URL("../src/components/workpanel/WorkPanel.tsx", import.meta.url),
  "utf8",
);
const contextPanelSource = readFileSync(
  new URL("../src/components/workpanel/ContextPanel.tsx", import.meta.url),
  "utf8",
);
const extensionPromptHostSource = readFileSync(
  new URL("../src/components/ExtensionPromptDialog.tsx", import.meta.url),
  "utf8",
);

test("the native Context tool is a retained work-panel tab", () => {
  const context = toolWorkPanelTab("context");
  assert.equal(isKnownWorkPanelTab(context), true);
  assert.deepEqual(
    sanitizeWorkPanelTabsState({ tabs: [context], activeTabId: context.id }),
    { tabs: [context], activeTabId: context.id },
  );
});

test("the work-panel launcher renders the native Context panel", () => {
  assert.match(workPanelSource, /ContextPanel/);
  assert.match(workPanelSource, /toolWorkPanelTab\("context"\)/);
});

test("the Context panel consumes snapshots, falls back to session usage, and runs pack commands", () => {
  assert.match(contextPanelSource, /api\.onExtensionStatus/);
  assert.match(contextPanelSource, /CONTEXT_SNAPSHOT_STATUS_KEY/);
  assert.match(contextPanelSource, /fallbackContextSnapshot/);
  assert.match(contextPanelSource, /context-export/);
  assert.match(contextPanelSource, /context-import/);
  assert.match(contextPanelSource, /context-handoff/);
  assert.doesNotMatch(contextPanelSource, /if \(!snapshot\) \{\s*return \(/);
});

test("structured extension events never render as raw status text", () => {
  assert.match(extensionPromptHostSource, /event\.key\.startsWith\("event:"\)/);
});
