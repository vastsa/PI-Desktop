import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = (relativePath) =>
  readFileSync(join(here, "../src", relativePath), "utf8");
const uiSource = source("components/ui.tsx");

function assertLocalizedIconTooltip(relativePath, key) {
  const contents = source(relativePath);
  const ariaLabel = `aria-label={t("${key}"`;
  const sharedAriaLabel = `ariaLabel={t("${key}"`;
  const title = `title={t("${key}"`;
  const sharedTooltip = `tooltip={t("${key}"`;
  const ariaIndex = Math.max(contents.indexOf(ariaLabel), contents.indexOf(sharedAriaLabel));
  const hoverIndex = Math.max(contents.indexOf(title), contents.indexOf(sharedTooltip));
  assert.ok(ariaIndex >= 0, `${relativePath} should expose ${key} as an accessible name`);
  assert.ok(
    Math.abs(hoverIndex - ariaIndex) < 220,
    `${relativePath} should expose ${key} on hover`,
  );
}

test("icon-only actions expose localized hover tooltips", () => {
  for (const [relativePath, key] of [
    ["components/ChatSurface.tsx", "errors.action.dismiss"],
    ["components/ContextUsageInspector.tsx", "chat.usageContextAria"],
    ["components/Toast.tsx", "toast.dismiss"],
    ["components/UpdateBanner.tsx", "updates.dismiss"],
    ["components/ProjectInstructionsDialog.tsx", "settings.cancel"],
    ["components/extensions/McpEditorSheet.tsx", "common.close"],
    ["components/settings/SkillEditorSheet.tsx", "common.close"],
    ["components/settings/SubagentEditorSheet.tsx", "common.close"],
    ["components/extensions/ScopeControl.tsx", "common.close"],
    ["components/settings/AgentCapabilityLayout.tsx", "settings.clearSearch"],
    ["components/Sidebar.tsx", "nav.sessionActions"],
    ["components/Sidebar.tsx", "project.openActions"],
    ["components/Sidebar.tsx", "nav.sortSessions"],
    ["pages/PullRequestsPage.tsx", "pulls.open"],
    ["components/workpanel/FilesTab.tsx", "panel.files.back"],
    ["components/workpanel/FilesTab.tsx", "panel.files.reveal"],
  ]) {
    assertLocalizedIconTooltip(relativePath, key);
  }
  assert.match(uiSource, /const showTimerRef = useRef<number \| null>\(null\)/);
  assert.match(uiSource, /const hideTimerRef = useRef<number \| null>\(null\)/);
  assert.match(uiSource, /\}, \[active, delayMs, hideDelayMs\]\);/);
  assert.doesNotMatch(uiSource, /\}, \[active, delayMs, hideDelayMs, visible\]\);/);
  assert.match(uiSource, /if \(!disabled\) return;[\s\S]*?setHoveredState\(false\);[\s\S]*?setFocused\(false\)/);
  assert.match(uiSource, /const \[dismissed, setDismissed\] = useState\(false\)/);
  assert.match(uiSource, /const dismiss = \(\) => \{[\s\S]*?setDismissed\(true\)/);
  assert.match(uiSource, /onClick=\{\(event\) => \{[\s\S]*?tooltip\.dismiss\(\)/);
});

// A tooltip that survives its trigger is the reported "sometimes it never goes
// away" failure: the anchor unmounts (a row leaves the list, a menu closes),
// the window loses focus, or the pointer leaves the window without a matching
// leave event. Keep every escape hatch in the shared hook, and keep a guarded
// show timer from painting a tooltip after one of them fired.
test("the shared tooltip hook always has an exit path", () => {
  // Every hide cancels a show that has not painted yet — otherwise Escape or a
  // window blur inside the delay still paints a tooltip on an unfocused window.
  assert.match(uiSource, /const hide = \(\) => \{[\s\S]*?window\.clearTimeout\(showTimerRef\.current\)[\s\S]*?releaseTooltipSlot\(slotId\)/);
  // Unmount releases the tooltip and both pending timers.
  assert.match(uiSource, /\}, \[\]\);\n\n\s*\/\/ A disabled trigger[\s\S]*?\n  \}, \[disabled\]\);/);
  assert.match(uiSource, /releaseTooltipSlot\(slotId\);[\s\S]{0,80}\}, \[\]\);/);
  // One shared guard set for the whole window closes what is on screen: window
  // blur, a hidden document, Escape, or a pointer that left its trigger.
  assert.match(uiSource, /window\.addEventListener\("blur", \(\) => visibleTooltip\?\.hide\(\)\)/);
  assert.match(uiSource, /document\.addEventListener\("visibilitychange", \(\) => \{[\s\S]*?document\.hidden[\s\S]*?visibleTooltip\?\.hide\(\)/);
  assert.match(uiSource, /if \(event\.key === "Escape"\) visibleTooltip\?\.hide\(\)/);
  assert.match(uiSource, /if \(!tooltip\?\.hovered \|\| !tooltip\.anchor\) return;/);
  assert.match(uiSource, /if \(!inside\) tooltip\.hide\(\)/);
  // A detached anchor closes it instead of leaving a floating label behind.
  assert.match(uiSource, /if \(!anchor\) \{[\s\S]*?setTooltipVisible\(false\)/);
  assert.match(uiSource, /if \(!wasConnected\) setTooltipVisible\(false\)/);
  assert.match(uiSource, /ANCHOR_RECONNECT_GRACE_MS/);
  // One visible tooltip at a time: claiming the slot hides the previous owner,
  // and a re-created hide callback still owns the same slot.
  assert.match(uiSource, /function claimTooltipSlot\(slot: TooltipSlot\) \{[\s\S]*?visibleTooltip\.hide\(\)/);
  assert.match(uiSource, /function releaseTooltipSlot\(slotId: symbol\) \{[\s\S]*?visibleTooltip = null/);
  assert.match(uiSource, /if \(next\) \{[\s\S]*?claimTooltipSlot\(\{[\s\S]*?\}\)[\s\S]*?else \{[\s\S]*?releaseTooltipSlot\(slotId\)/);
  assert.match(uiSource, /const slotIdRef = useRef<symbol \| null>\(null\)/);
});
