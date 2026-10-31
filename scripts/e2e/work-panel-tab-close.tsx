import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { WorkPanel } from "../../apps/desktop/src/components/workpanel/WorkPanel";
import { IPC, type WorkPanelTabMenuAction, type WorkPanelTabMenuRequest } from "@pi-desktop/shared";
import { pluginWorkPanelTab, toolWorkPanelTab } from "../../apps/desktop/src/lib/work-panel-tabs";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

/*
  Renderer-level regression for #1762: the active tab's close control must sit
  inside the tab strip's viewport and be the element the pointer would hit,
  after a narrow panel and after a resize that keeps the same active tab.

  Source assertions cannot prove this — the maintainer asked for actual
  geometry and hit target, and DOM geometry plus `elementFromPoint` is what
  this environment can honestly measure. Native Win32 hit testing stays in
  scripts/e2e-work-panel-drag.mjs for the drag regions.
*/

type CloseGeometry = {
  stage: string;
  tabId: string;
  stripLeft: number;
  stripRight: number;
  stripClientWidth: number;
  closeLeft: number;
  closeRight: number;
  insideStrip: boolean;
  hitIsClose: boolean;
  hitIsDescendant: boolean;
};

type TabContextMenuPathResult = {
  stage: "context-menu-user-path";
  passed: true;
  remainingTabs: number;
  activeTabId: string | null;
};

type PluginViewMenuLayerResult = {
  stage: "plugin-view-menu-layer";
  pageRemainsVisibleWhileMenuOpen: boolean;
  pageRemainsVisibleAfterMenuClose: boolean;
  nativeMenuRequested: boolean;
};
declare global {
  var tabCloseProbe: (stage: string) => Promise<CloseGeometry | TabContextMenuPathResult | PluginViewMenuLayerResult>;
}

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const host = document.createElement("div");
host.style.cssText = "position:absolute;left:0;top:0;height:600px;display:flex";
document.body.append(host);
const root = createRoot(host);
const i18n = createInstance();
const ready = i18n.init({
  lng: "en",
  resources: { en: { translation: catalogs.en } },
  interpolation: { escapeValue: false },
});
const nativeMenuRequests: WorkPanelTabMenuRequest[] = [];
const nativeMenuSelections: (WorkPanelTabMenuAction | null)[] = [];
let deferNextNativeMenu = false;
let finishNativeMenu: (() => void) | null = null;
const pluginViewVisibility: boolean[] = [];
window.piDesktop = {
  channels: IPC,
  platform: "darwin",
  invoke: async (channel, ...args) => {
    if (channel === IPC.invoke.workPanelTabMenu) {
      nativeMenuRequests.push(args[0] as WorkPanelTabMenuRequest);
      if (deferNextNativeMenu) {
        deferNextNativeMenu = false;
        return await new Promise((resolve) => {
          finishNativeMenu = () => resolve({ ok: true, data: null });
        });
      }
      return { ok: true, data: nativeMenuSelections.shift() ?? null };
    }
    if (channel === IPC.invoke.pluginViewSetVisible) {
      const payload = args[0] as { visible?: boolean } | undefined;
      if (typeof payload?.visible === "boolean") pluginViewVisibility.push(payload.visible);
    }
    return { ok: true, data: undefined };
  },
  on: () => () => undefined,
};

function element(selector: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(selector);
  if (!found) throw new Error("Missing " + selector);
  return found;
}

async function rendered() {
  await Promise.all(document.getAnimations().map((a) => a.finished));
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

function renderPanel(containerWidth: number) {
  // The panel's own width comes from the store; `containerWidth` is the shell
  // budget. Resize the host so the strip's box actually changes. Each probe
  // stage starts from the stylesheet width, even when React reuses the strip.
  const existingStrip = host.querySelector<HTMLElement>(".work-panel-tab-strip");
  existingStrip?.style.removeProperty("flex");
  existingStrip?.style.removeProperty("width");
  host.style.width = `${containerWidth}px`;
  flushSync(() => {
    useAppStore.setState({
      activeSessionId: "tab-close-a",
      workPanelWidth: Math.min(300, Math.max(244, containerWidth - 40)),
      pluginViews: [],
    });
    root.render(
      <I18nextProvider i18n={i18n}>
        <WorkPanel containerWidth={containerWidth} sidebarCollapsed />
      </I18nextProvider>,
    );
  });
}

function click(selector: string) {
  flushSync(() => element(selector).click());
}

/** Long labels are what pushes the close control past the overflow edge. */
function openManyLongTabs(count: number) {
  for (let i = 0; i < count; i += 1) click(".work-panel-new-tab");
}

function activeTabId(): string {
  const id = useAppStore.getState().activeWorkPanelTabId;
  assert(id, "no active tab");
  return id!;
}

function measure(stage: string): CloseGeometry {
  const strip = element(".work-panel-tab-strip");
  const stripRect = strip.getBoundingClientRect();
  const tabId = activeTabId();
  const wrapper = host.querySelector<HTMLElement>(
    `[data-work-panel-tab-id="${CSS.escape(tabId)}"]`,
  );
  assert(wrapper, "active tab wrapper missing");
  const close = wrapper!.querySelector<HTMLElement>(".work-panel-tab-close");
  assert(close, "active tab close control missing");
  const closeRect = close!.getBoundingClientRect();

  const centerX = closeRect.x + closeRect.width / 2;
  const centerY = closeRect.y + closeRect.height / 2;
  const hit = document.elementFromPoint(centerX, centerY);

  return {
    stage,
    tabId,
    stripLeft: stripRect.left,
    stripRight: stripRect.right,
    stripClientWidth: strip.clientWidth,
    closeLeft: closeRect.left,
    closeRight: closeRect.right,
    // The control must be fully inside the strip's client box. A sub-pixel
    // tolerance keeps a fractional device pixel ratio from failing the probe.
    insideStrip:
      closeRect.left >= stripRect.left - 0.5 && closeRect.right <= stripRect.right + 0.5,
    hitIsClose: hit === close,
    hitIsDescendant: !!hit && (close!.contains(hit) || hit.contains(close!)),
  };
}

async function runTabContextMenuUserPath(): Promise<TabContextMenuPathResult> {
  useAppStore.setState({
    workPanelOpen: true,
    workPanelTabs: [],
    activeWorkPanelTabId: null,
    workPanelFileRequest: null,
    workPanelContexts: {},
  });
  renderPanel(1000);
  openManyLongTabs(3);
  await rendered();

  const tabIds = () =>
    [...host.querySelectorAll<HTMLElement>(".work-panel-tab")].map(
      (tab) => tab.dataset.workPanelTabId,
    );
  const initialIds = tabIds();
  assert(initialIds.length === 3, "fixture did not create three tabs");
  const firstId = initialIds[0];
  const secondId = initialIds[1];
  if (!firstId || !secondId) throw new Error("fixture tab ids are missing");

  const openTabMenu = async (tabId: string, keyboard = false) => {
    const wrapper = host.querySelector<HTMLElement>(
      `[data-work-panel-tab-id="${CSS.escape(tabId)}"]`,
    );
    assert(wrapper, "target tab wrapper is missing");
    const tabButton = wrapper!.querySelector<HTMLElement>("[role=tab]");
    assert(tabButton, "target tab button is missing");
    window.getSelection()?.removeAllRanges();
    if (keyboard) tabButton!.focus({ preventScroll: true });
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: keyboard ? 0 : 24,
      clientY: keyboard ? 0 : 24,
    });
    flushSync(() => wrapper!.dispatchEvent(event));
    assert(event.defaultPrevented, "tab context menu did not prevent the platform menu");
    await rendered();
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    assert(
      menu,
      `tab context menu did not open (menus=${document.body.querySelectorAll("[role=menu]").length}; tabs=${host.querySelectorAll(".work-panel-tab").length})`,
    );
    assert(
      menu!.getAttribute("aria-label") === "Side panel tabs",
      "tab context menu label was not localized",
    );
    return menu!;
  };
  const menuItem = (menu: HTMLElement, id: string) => {
    const item = menu.querySelector<HTMLButtonElement>(
      `[data-context-menu-item="${id}"]`,
    );
    assert(item, "missing context-menu item " + id);
    return item!;
  };

  let menu = await openTabMenu(firstId, true);
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
  );
  await rendered();
  assert(
    (document.activeElement as HTMLElement | null)?.dataset.contextMenuItem ===
      "close-other-tabs",
    "ArrowDown did not move focus through the tab menu",
  );
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  await rendered();
  assert(!document.body.querySelector('[role="menu"]'), "Escape did not close the tab menu");

  menu = await openTabMenu(firstId);
  flushSync(() => menuItem(menu, "close-tab").click());
  await rendered();
  assert(!tabIds().includes(firstId), "Close Tab left the target tab open");

  menu = await openTabMenu(secondId);
  flushSync(() => menuItem(menu, "close-other-tabs").click());
  await rendered();
  assert(tabIds().length === 1 && tabIds()[0] === secondId, "Close Other Tabs did not retain its target");
  assert(activeTabId() === secondId, "Close Other Tabs did not activate its target");

  menu = await openTabMenu(secondId);
  assert(menuItem(menu, "close-other-tabs").disabled, "Close Other Tabs must be disabled for one tab");
  flushSync(() => menuItem(menu, "close-all-tabs").click());
  await rendered();
  assert(tabIds().length === 0, "Close All Tabs left resources open");
  assert(useAppStore.getState().activeWorkPanelTabId === null, "Close All Tabs retained an active tab");
  assert(useAppStore.getState().workPanelOpen, "Close All Tabs collapsed the work panel");
  assert(host.querySelector('[data-testid="work-panel-empty"]'), "Close All Tabs did not show the New launcher");

  return {
    stage: "context-menu-user-path",
    passed: true,
    remainingTabs: tabIds().length,
    activeTabId: useAppStore.getState().activeWorkPanelTabId,
  };
}

async function runPluginViewMenuLayerPath(): Promise<PluginViewMenuLayerResult> {
  const tab = pluginWorkPanelTab("pi.browser", "browser");
  const reviewTab = toolWorkPanelTab("review");
  nativeMenuRequests.length = 0;
  deferNextNativeMenu = true;
  finishNativeMenu = null;
  host.style.width = "1000px";
  pluginViewVisibility.length = 0;
  flushSync(() => {
    useAppStore.setState({
      activeSessionId: "tab-close-plugin",
      workPanelOpen: true,
      workPanelTabs: [tab, reviewTab],
      activeWorkPanelTabId: tab.id,
      workPanelFileRequest: null,
      workPanelContexts: {},
      pluginViews: [{
        pluginId: "pi.browser",
        viewId: "browser",
        ref: "pi.browser/browser",
        title: "Browser",
        pluginName: "PI-Desktop",
        order: 0,
      }],
    });
    root.render(
      <I18nextProvider i18n={i18n}>
        <WorkPanel containerWidth={1000} sidebarCollapsed />
      </I18nextProvider>,
    );
  });
  await rendered();
  assert(pluginViewVisibility.at(-1) === true, "Browser view did not become visible");

  const reviewTabWrapper = host.querySelector<HTMLElement>(
    `[data-work-panel-tab-id="${CSS.escape(reviewTab.id)}"]`,
  );
  assert(reviewTabWrapper, "Review tab wrapper is missing");
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 32,
    clientY: 32,
  });
  flushSync(() => reviewTabWrapper!.dispatchEvent(event));
  assert(event.defaultPrevented, "Review tab did not invoke the native menu over Browser");
  assert(nativeMenuRequests.length === 1, "Review tab did not request the native menu over Browser");
  const menuRequest = nativeMenuRequests[0];
  assert(menuRequest?.canCloseOthers === true, "native menu request has incorrect close-other state");
  const pageRemainsVisibleWhileMenuOpen = pluginViewVisibility.at(-1) === true;
  assert(pageRemainsVisibleWhileMenuOpen, "Browser page disappeared while its native menu was open");
  assert(!document.body.querySelector('[role="menu"]'), "native tab menu must not render underneath the Browser view");

  const cancelNativeMenu = finishNativeMenu;
  assert(cancelNativeMenu, "native menu test boundary did not open");
  cancelNativeMenu!();
  await rendered();
  const pageRemainsVisibleAfterMenuClose = pluginViewVisibility.at(-1) === true;
  assert(pageRemainsVisibleAfterMenuClose, "Browser page disappeared after cancelling its native menu");
  nativeMenuSelections.push("closeTab");
  const closeEvent = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 32,
    clientY: 32,
  });
  flushSync(() => reviewTabWrapper!.dispatchEvent(closeEvent));
  assert(closeEvent.defaultPrevented, "native menu action could not be reopened");
  await rendered();
  assert(
    useAppStore.getState().workPanelTabs.length === 1 &&
      useAppStore.getState().workPanelTabs[0]?.id === tab.id,
    "native Close Tab action did not close only the clicked tab",
  );
  assert(pluginViewVisibility.at(-1) === true, "Browser page disappeared after closing the other tab");

  const browserTabWrapper = host.querySelector<HTMLElement>(
    `[data-work-panel-tab-id="${CSS.escape(tab.id)}"]`,
  );
  assert(browserTabWrapper, "Browser tab wrapper is missing");
  const singleTabEvent = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 32,
    clientY: 32,
  });
  flushSync(() => browserTabWrapper.dispatchEvent(singleTabEvent));
  assert(singleTabEvent.defaultPrevented, "Browser tab did not invoke the native menu");
  assert(nativeMenuRequests.at(-1)?.canCloseOthers === false, "Close Other Tabs should be disabled for one tab");


  return {
    stage: "plugin-view-menu-layer",
    pageRemainsVisibleWhileMenuOpen,
    pageRemainsVisibleAfterMenuClose,
    nativeMenuRequested: nativeMenuRequests.length === 3,
  };
}

globalThis.tabCloseProbe = async (stage) => {
  await ready;
  if (stage === "context-menu-user-path") {
    await ready;
    return runTabContextMenuUserPath();
  }
  if (stage === "plugin-view-menu-layer") {
    return runPluginViewMenuLayerPath();
  }

  if (stage === "narrow-active") {
    renderPanel(900);
    openManyLongTabs(10);
    await rendered();
    const strip = element(".work-panel-tab-strip");
    assert(strip.scrollWidth > strip.clientWidth, "tabs did not overflow the strip");
    return measure(stage);
  }

  if (stage === "resize-same-tab") {
    // Render wide first so every tab fits, then narrow the panel without
    // changing `activeTabId` or `tabs.length` — the exact case the maintainer
    // flagged: the reveal effect's dependencies do not change.
    renderPanel(1400);
    openManyLongTabs(10);
    await rendered();
    const before = measure("before-resize");
    assert(before.insideStrip, "fixture invalid: close control clipped before the resize");

    // Resize the strip's actual scrollport while leaving the active tab and tab
    // count untouched. The wide fixture above confirms that the close control
    // fits before this resize; 80px forces it out of view until the observer
    // reveals the same active tab again.
    const strip = element(".work-panel-tab-strip");
    strip.style.flex = "0 0 80px";
    strip.style.width = "80px";
    await rendered();
    const after = measure(stage);
    assert(
      after.stripClientWidth < before.stripClientWidth,
      "fixture invalid: the tab strip scrollport did not narrow",
    );
    return after;
  }

  if (stage === "hover-inactive") {
    // Wide enough for a real panel: 560 leaves the panel squeezed to a sliver
    // because MAIN_PANE_MIN_WIDTH (450) eats the budget.
    renderPanel(1000);
    openManyLongTabs(10);
    await rendered();
    // Park the strip mid-list so a tab is clipped by the inline-end edge while
    // the active tab is elsewhere. That is the state the issue describes: a
    // partly visible inactive tab whose close control appears on hover.
    const stripEl = element(".work-panel-tab-strip");
    stripEl.scrollLeft = Math.floor((stripEl.scrollWidth - stripEl.clientWidth) / 2);
    await rendered();
    const stripRect0 = stripEl.getBoundingClientRect();
    const all = [...host.querySelectorAll<HTMLElement>(".work-panel-tab")];
    // Pick the inactive tab nearest the inline-end edge that is still partly
    // inside: its close control is the one at risk of being clipped.
    const candidate = all
      .filter((node) => node.dataset.workPanelTabId !== activeTabId())
      .filter((node) => {
        const r = node.getBoundingClientRect();
        return r.right > stripRect0.left && r.left < stripRect0.right;
      })
      .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];
    assert(candidate, "no partly visible inactive tab to hover");
    const first = candidate!;
    const firstId = first.dataset.workPanelTabId;
    assert(firstId && firstId !== activeTabId(), "fixture invalid: hovered tab is active");
    // React delegates from the root, and `pointerenter` does not bubble, so a
    // synthetic dispatch never reaches the handler. `pointerover` bubbles and
    // is what the platform sends on entering an element.
    flushSync(() => {
      first!.dispatchEvent(
        new PointerEvent("pointerover", { bubbles: true, cancelable: true }),
      );
    });
    await rendered();
    const strip = element(".work-panel-tab-strip");
    const stripRect = strip.getBoundingClientRect();
    const close = first!.querySelector<HTMLElement>(".work-panel-tab-close");
    assert(close, "hovered tab has no close control");
    const rect = close!.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
    );
    return {
      stage,
      tabId: firstId!,
      stripLeft: stripRect.left,
      stripRight: stripRect.right,
      stripClientWidth: strip.clientWidth,
      closeLeft: rect.left,
      closeRight: rect.right,
      insideStrip: rect.left >= stripRect.left - 0.5 && rect.right <= stripRect.right + 0.5,
      hitIsClose: hit === close,
      hitIsDescendant: !!hit && (close!.contains(hit) || hit.contains(close!)),
    };
  }

  throw new Error("Unknown tab-close probe stage: " + stage);
};
