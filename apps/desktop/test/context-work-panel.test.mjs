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

test("the Context panel replays session snapshots from the always-mounted listener", () => {
  assert.match(extensionPromptHostSource, /recordContextSnapshot\(event\)/);
  assert.match(contextPanelSource, /useSyncExternalStore/);
  assert.match(contextPanelSource, /getContextSnapshot\(activeSessionId\)/);
  assert.doesNotMatch(contextPanelSource, /api\.onExtensionStatus/);
  assert.match(contextPanelSource, /context-export/);
  assert.match(contextPanelSource, /context-import/);
  assert.match(contextPanelSource, /context-handoff/);
});

test("fallback is labelled as an estimate and detailed rows do not include a Free bar", () => {
  assert.match(contextPanelSource, /contextSnapshotView/);
  assert.match(contextPanelSource, /context-panel-estimate/);
  assert.match(contextPanelSource, /context-panel-breakdown/);
  assert.doesNotMatch(contextPanelSource, /fallbackContextSnapshot/);
});

test("structured extension events never render as raw status text", () => {
  assert.match(extensionPromptHostSource, /event\.key\.startsWith\("event:"\)/);
});
