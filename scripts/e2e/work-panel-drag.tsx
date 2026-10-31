import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { WorkPanel } from "../../apps/desktop/src/components/workpanel/WorkPanel";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { switchWorkPanelSession } from "../../apps/desktop/src/stores/slices/work-panel-slice";

type HitPoint = { label: string; x: number; y: number; expected: number };
declare global {
  var workPanelDragProbe: (stage: string) => Promise<HitPoint[]>;
}
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const host = document.createElement("div");
host.style.cssText = "position:absolute;inset:0 0 0 640px;display:flex";
const neighbor = document.createElement("div");
neighbor.className = "drag";
neighbor.style.cssText = "position:absolute;left:0;top:0;width:640px;height:46px";
document.body.append(neighbor, host);
document.documentElement.dataset.platform = "win32";
const root = createRoot(host);
const i18n = createInstance();
const ready = i18n.init({
  lng: "en",
  resources: { en: { translation: catalogs.en } },
  interpolation: { escapeValue: false },
});

function switchSession(id: string) {
  flushSync(() => useAppStore.setState((state) => ({
    ...switchWorkPanelSession(state, id),
    activeSessionId: id,
  })));
}
function element(selector: string): HTMLElement {
  const result = host.querySelector<HTMLElement>(selector);
  if (!result) throw new Error("Missing " + selector);
  return result;
}
function currentTabs() {
  return useAppStore.getState().workPanelTabs;
}
function click(selector: string) {
  flushSync(() => element(selector).click());
}
async function rendered() {
  await Promise.all(document.getAnimations().map((animation) => animation.finished));
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

globalThis.workPanelDragProbe = async (stage) => {
  if (stage === "active-close") {
    await ready;
    const longFileTab = {
      id: "file:/workspace/very-long-folder-name/another-folder/README.md",
      kind: "file" as const,
      resource: "/workspace/very-long-folder-name/another-folder/README.md",
    };
    flushSync(() => {
      useAppStore.setState({
        activeSessionId: "drag-a",
        workPanelOpen: true,
        workPanelWidth: 244,
        workPanelTabs: [longFileTab],
        activeWorkPanelTabId: longFileTab.id,
        pluginViews: [],
      });
      root.render(<I18nextProvider i18n={i18n}><WorkPanel containerWidth={1000} sidebarCollapsed /></I18nextProvider>);
    });
    await rendered();
    const strip = element(".work-panel-tab-strip").getBoundingClientRect();
    const close = element(".work-panel-tab-close").getBoundingClientRect();
    assert(close.left >= strip.left && close.right <= strip.right, "active tab close button is clipped from the strip viewport");
  } else if (stage === "overflow-end") {
    await ready;
    flushSync(() => {
      useAppStore.setState({ activeSessionId: "drag-a", workPanelWidth: 360, pluginViews: [] });
      root.render(<I18nextProvider i18n={i18n}><WorkPanel containerWidth={1000} sidebarCollapsed /></I18nextProvider>);
    });
    // Enter through the real header action rather than replacing store methods.
    for (let i = 0; i < 12; i++) click(".work-panel-new-tab");
    await rendered();
    const strip = element(".work-panel-tab-strip");
    assert(strip.scrollWidth > strip.clientWidth, "tabs did not overflow");
    assert(strip.scrollLeft > 0, "active tab did not scroll into view");
    assert(element(".work-panel-tab").getBoundingClientRect().x < 640, "fixture did not reproduce clipped tabs crossing the neighboring titlebar");
  } else if (stage === "switch-back") {
    const ids = currentTabs().map((tab) => tab.id).join(",");
    switchSession("drag-b");
    click(".work-panel-new-tab");
    switchSession("drag-a");
    assert(currentTabs().map((tab) => tab.id).join(",") === ids, "switching back lost the session tab context");
  } else if (stage === "overflow-start") {
    click(".work-panel-tab-button");
  } else if (stage === "keyboard-reorder") {
    const first = currentTabs()[0].id;
    flushSync(() => element(".work-panel-tab-button").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true, cancelable: true })));
    assert(currentTabs()[1].id === first, "keyboard reorder did not reach the store action");
    assert(useAppStore.getState().activeWorkPanelTabId === first, "reorder changed the active resource");
  } else if (stage === "one-tab") {
    while (currentTabs().length > 1) click(".work-panel-tab-close");
  } else if (stage === "no-tabs") {
    click(".work-panel-tab-close");
    assert(currentTabs().length === 0, "last tab did not close");
  } else {
    throw new Error("Unknown drag probe stage: " + stage);
  }
  await rendered();
  const strip = element(".work-panel-tab-strip");
  const viewport = strip.getBoundingClientRect();
  const points: HitPoint[] = [
    { label: "sidebar titlebar", x: 180, y: 23, expected: 2 },
    { label: "conversation titlebar", x: 450, y: 23, expected: 2 },
  ];
  for (const selector of [".work-panel-new-tab", ".work-panel-maximize"]) {
    const rect = element(selector).getBoundingClientRect();
    points.push({ label: selector, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, expected: 1 });
  }
  if (currentTabs().length) {
    points.push({ label: "visible tab", x: viewport.x + Math.min(40, viewport.width / 2), y: 23, expected: 1 });
  }
  if (stage === "one-tab" || stage === "no-tabs") {
    const wrap = element(".work-panel-tab-strip-wrap").getBoundingClientRect();
    assert(wrap.right - viewport.right > 20, "sparse tabs consume empty draggable header space");
    points.push({ label: "unused panel header", x: (viewport.right + wrap.right) / 2, y: 23, expected: 2 });
  }
  return points;
};
