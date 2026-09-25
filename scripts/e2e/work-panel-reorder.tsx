import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { WorkPanel } from "../../apps/desktop/src/components/workpanel/WorkPanel";
import { useCardReorder } from "../../apps/desktop/src/hooks/use-card-reorder";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import type { WorkPanelTab } from "../../apps/desktop/src/lib/work-panel-tabs";

declare global {
  var workPanelReorderProbe: () => Promise<{ ok: true }>;
}

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const launcher: WorkPanelTab = { id: "new:shared", kind: "new" };
const review: WorkPanelTab = { id: "review", kind: "review" };
const file: WorkPanelTab = {
  id: "file:src/a.txt",
  kind: "file",
  resource: "src/a.txt",
};
const tabs = [launcher, review, file];
const cardItems = [{ id: "one" }, { id: "two" }, { id: "three" }];

function CardFixture({ moved }: { moved: (id: string) => void }) {
  const reorder = useCardReorder(cardItems, false, (id) => moved(id));
  return (
    <ul>
      {cardItems.map(({ id }) => (
        <li key={id} ref={reorder.rowRef(id)} {...reorder.rowEvents(id)}>
          {id}
        </li>
      ))}
    </ul>
  );
}

function pointer(type: string, pointerId: number, x: number, y: number) {
  return new PointerEvent(type, {
    pointerId,
    pointerType: "mouse",
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
  });
}

function clickPointer(pointerId: number) {
  return new PointerEvent("click", {
    pointerId,
    detail: 1,
    bubbles: true,
    cancelable: true,
  });
}

function setPanelState(
  sessionId: string,
  currentTabs: WorkPanelTab[],
  reorderCalls: Array<{ source: string; target: string; after: boolean }>,
  activations: string[],
) {
  useAppStore.setState({
    activeSessionId: sessionId,
    workPanelTabs: currentTabs,
    activeWorkPanelTabId: launcher.id,
    pluginViews: [],
    workPanelWidth: 360,
    activateWorkPanelTab: (tabId) => {
      activations.push(tabId);
      useAppStore.setState({ activeWorkPanelTabId: tabId });
    },
    reorderWorkPanelTabs: (source, target, after) => {
      reorderCalls.push({ source, target, after });
    },
  });
}

function CardRows({ host }: { host: HTMLElement }) {
  return [...host.querySelectorAll<HTMLLIElement>("li")];
}

globalThis.workPanelReorderProbe = async () => {
  const previousStore = useAppStore.getState();
  const panelHost = document.createElement("div");
  const cardHost = document.createElement("div");
  panelHost.style.cssText = "width: 900px; height: 400px;";
  cardHost.style.cssText = "width: 400px; height: 200px;";
  document.body.append(panelHost, cardHost);

  const frameCallbacks = new Map<number, FrameRequestCallback>();
  let nextFrameId = 0;
  const nativeRequestFrame = window.requestAnimationFrame;
  const nativeCancelFrame = window.cancelAnimationFrame;
  const originalElementFromPoint = document.elementFromPoint.bind(document);
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: catalogs.en } },
    interpolation: { escapeValue: false },
  });

  const uncaught: unknown[] = [];
  const workPanelRoot = createRoot(panelHost, {
    onUncaughtError: (error) => uncaught.push(error),
  });
  const cardRoot = createRoot(cardHost, {
    onUncaughtError: (error) => uncaught.push(error),
  });
  const reorderCalls: Array<{ source: string; target: string; after: boolean }> = [];
  const activations: string[] = [];
  const cardMoves: string[] = [];
  let targetTabId = review.id;

  try {
    setPanelState("session-a", tabs, reorderCalls, activations);
    flushSync(() =>
      workPanelRoot.render(
        <I18nextProvider i18n={i18n}>
          <WorkPanel containerWidth={900} sidebarCollapsed />
        </I18nextProvider>,
      ),
    );
    flushSync(() => cardRoot.render(<CardFixture moved={(id) => cardMoves.push(id)} />));
    assert(panelHost.querySelector('[role="tab"][aria-selected="true"]'), "active launcher tab did not render");

    window.requestAnimationFrame = (callback) => {
      const id = ++nextFrameId;
      frameCallbacks.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      frameCallbacks.delete(id);
    };

    const configureGeometry = () => {
      const strip = panelHost.querySelector<HTMLDivElement>(".work-panel-tab-strip");
      assert(strip, "work panel tab strip missing");
      strip.getBoundingClientRect = () => new DOMRect(0, 0, 100, 40);
      Object.defineProperty(strip, "scrollWidth", { configurable: true, value: 300 });
      Object.defineProperty(strip, "clientWidth", { configurable: true, value: 100 });
      for (const tab of panelHost.querySelectorAll<HTMLElement>("[data-work-panel-tab-id]")) {
        tab.getBoundingClientRect = () => new DOMRect(0, 0, 100, 40);
      }
      document.elementFromPoint = () =>
        [...panelHost.querySelectorAll<HTMLElement>("[data-work-panel-tab-id]")].find(
          (tab) => tab.dataset.workPanelTabId === targetTabId,
        ) ?? null;
    };
    const buttonFor = (tabId: string) => {
      const tab = [...panelHost.querySelectorAll<HTMLElement>("[data-work-panel-tab-id]")].find(
        (candidate) => candidate.dataset.workPanelTabId === tabId,
      );
      const button = tab?.querySelector<HTMLButtonElement>('[role="tab"]');
      assert(button, `tab button missing: ${tabId}`);
      return button;
    };
    const beginPanelDrag = (pointerId: number, target: string) => {
      targetTabId = target;
      configureGeometry();
      flushSync(() =>
        buttonFor(launcher.id).dispatchEvent(pointer("pointerdown", pointerId, 20, 20)),
      );
      flushSync(() => window.dispatchEvent(pointer("pointermove", pointerId, 99, 20)));
      assert(
        document.documentElement.getAttribute("data-work-panel-tab-reordering") === "true",
        "pointer movement did not arm tab reorder",
      );
      assert(panelHost.querySelector(".work-panel-tab.is-dragging"), "dragging tab state did not render");
      assert(frameCallbacks.size === 1, "edge drag did not schedule exactly one auto-scroll frame");
    };
    const releasePanelDrag = (pointerId: number) => {
      flushSync(() => window.dispatchEvent(pointer("pointerup", pointerId, 99, 20)));
    };

    // Session changes cancel an armed drag even with the same tab ids and order.
    beginPanelDrag(11, review.id);
    flushSync(() => setPanelState("session-b", tabs, reorderCalls, activations));
    assert(!document.documentElement.hasAttribute("data-work-panel-tab-reordering"), "session change left the reorder marker set");
    assert(!panelHost.querySelector(".work-panel-tab.is-dragging"), "session change left the source tab dragging");
    assert(frameCallbacks.size === 0, "session change retained the auto-scroll frame");
    // Neither an unrelated pointerdown nor a keyboard click may clear pointer 11's latch.
    flushSync(() => window.dispatchEvent(pointer("pointerdown", 99, 20, 20)));
    flushSync(() => buttonFor(launcher.id).click());
    releasePanelDrag(11);
    const staleSessionClick = clickPointer(11);
    flushSync(() => buttonFor(review.id).dispatchEvent(staleSessionClick));
    assert(staleSessionClick.defaultPrevented, "session-canceled drag click was not suppressed after unrelated input");
    assert(useAppStore.getState().activeWorkPanelTabId === launcher.id, "stale session click activated the matching tab");
    assert(reorderCalls.length === 0, "stale session drag reordered tabs with matching ids");

    // Even a press that never crosses the drag threshold belongs to the old context.
    flushSync(() => setPanelState("session-a", tabs, reorderCalls, activations));
    flushSync(() => buttonFor(launcher.id).dispatchEvent(pointer("pointerdown", 15, 20, 20)));
    flushSync(() => setPanelState("session-b", tabs, reorderCalls, activations));
    flushSync(() => useAppStore.setState({ activeWorkPanelTabId: file.id }));
    releasePanelDrag(15);
    const staleUnarmedClick = clickPointer(15);
    flushSync(() => buttonFor(launcher.id).dispatchEvent(staleUnarmedClick));
    assert(staleUnarmedClick.defaultPrevented, "unarmed stale pointer click activated a new context tab");
    assert(useAppStore.getState().activeWorkPanelTabId === file.id, "unarmed stale click changed the active tab");

    // A tab-order change cancels the drag but preserves the node under the release target.
    flushSync(() => setPanelState("session-a", tabs, reorderCalls, activations));
    beginPanelDrag(12, review.id);
    flushSync(() => setPanelState("session-a", [launcher, file, review], reorderCalls, activations));
    assert(!document.documentElement.hasAttribute("data-work-panel-tab-reordering"), "tab-order change left the reorder marker set");
    assert(frameCallbacks.size === 0, "tab-order change retained the auto-scroll frame");
    releasePanelDrag(12);
    const staleOrderClick = clickPointer(12);
    flushSync(() => buttonFor(review.id).dispatchEvent(staleOrderClick));
    assert(staleOrderClick.defaultPrevented, "tab-order-canceled drag click was not suppressed");
    assert(useAppStore.getState().activeWorkPanelTabId === launcher.id, "stale tab-order click activated the target");
    assert(reorderCalls.length === 0, "tab-order change allowed a stale reorder");

    // A separate active-tab change also invalidates the gesture and its later click.
    flushSync(() => setPanelState("session-a", tabs, reorderCalls, activations));
    beginPanelDrag(14, review.id);
    flushSync(() => useAppStore.setState({ activeWorkPanelTabId: file.id }));
    assert(!document.documentElement.hasAttribute("data-work-panel-tab-reordering"), "active-tab change left the reorder marker set");
    assert(frameCallbacks.size === 0, "active-tab change retained the auto-scroll frame");
    releasePanelDrag(14);
    const staleActiveTabClick = clickPointer(14);
    flushSync(() => buttonFor(review.id).dispatchEvent(staleActiveTabClick));
    assert(staleActiveTabClick.defaultPrevented, "active-tab-canceled drag click was not suppressed");
    assert(useAppStore.getState().activeWorkPanelTabId === file.id, "stale click reverted the active tab");

    // Window blur cancels the complete interaction lifecycle and only suppresses its pointer click.
    flushSync(() => setPanelState("session-a", tabs, reorderCalls, activations));
    beginPanelDrag(13, review.id);
    flushSync(() => window.dispatchEvent(new Event("blur")));
    assert(!document.documentElement.hasAttribute("data-work-panel-tab-reordering"), "blur left the reorder marker set");
    assert(!panelHost.querySelector(".work-panel-tab.is-dragging"), "blur left the tab visually dragging");
    assert(frameCallbacks.size === 0, "blur retained the auto-scroll frame");
    releasePanelDrag(13);
    assert(reorderCalls.length === 0, "blurred gesture reordered tabs");
    const afterBlurClick = clickPointer(13);
    flushSync(() => buttonFor(review.id).dispatchEvent(afterBlurClick));
    assert(afterBlurClick.defaultPrevented, "blur did not suppress its canceled pointer click");
    assert(useAppStore.getState().activeWorkPanelTabId === launcher.id, "blurred pointer click activated a tab");
    flushSync(() => buttonFor(review.id).click());
    assert(useAppStore.getState().activeWorkPanelTabId === review.id, "keyboard click was swallowed after blur");

    // Only the click generated by the completed drag's own pointer is ignored.
    flushSync(() => setPanelState("session-a", tabs, reorderCalls, activations));
    activations.length = 0;
    beginPanelDrag(21, review.id);
    releasePanelDrag(21);
    assert(reorderCalls.length === 1, "completed drag did not call the tab reorder action");
    assert(frameCallbacks.size === 1, "successful reorder should retain only its source-focus frame");
    for (const [id, callback] of frameCallbacks) callback(performance.now());
    frameCallbacks.clear();
    const dragClick = clickPointer(21);
    flushSync(() => buttonFor(review.id).dispatchEvent(dragClick));
    assert(dragClick.defaultPrevented, "completed drag click was not suppressed");
    assert(activations.length === 0, "completed drag click activated a different tab");
    assert(useAppStore.getState().activeWorkPanelTabId === launcher.id, "completed drag changed the active tab");

    flushSync(() => setPanelState("session-a", tabs, reorderCalls, activations));
    activations.length = 0;
    beginPanelDrag(22, review.id);
    releasePanelDrag(22);
    for (const [id, callback] of frameCallbacks) callback(performance.now());
    frameCallbacks.clear();
    flushSync(() => buttonFor(review.id).click());
    assert(useAppStore.getState().activeWorkPanelTabId === review.id, "keyboard-style activation was swallowed after a drag");

    flushSync(() => setPanelState("session-a", tabs, reorderCalls, activations));
    activations.length = 0;
    beginPanelDrag(23, review.id);
    releasePanelDrag(23);
    for (const [id, callback] of frameCallbacks) callback(performance.now());
    frameCallbacks.clear();
    const unrelatedClick = clickPointer(99);
    flushSync(() => buttonFor(review.id).dispatchEvent(unrelatedClick));
    assert(!unrelatedClick.defaultPrevented, "an unrelated pointer click was suppressed");
    assert(useAppStore.getState().activeWorkPanelTabId === review.id, "unrelated click failed to activate its tab");

    // Exercise useCardReorder with its real React bindings: cancellation by all
    // three supported paths must not leave a pointer-click latch behind.
    const cardRows = () => CardRows({ host: cardHost });
    const cancelCardDrag = (kind: "pointercancel" | "escape" | "blur", pointerId: number) => {
      const source = cardRows()[0];
      flushSync(() => source.dispatchEvent(pointer("pointerdown", pointerId, 10, 10)));
      flushSync(() => window.dispatchEvent(pointer("pointermove", pointerId, 20, 20)));
      assert(frameCallbacks.size === 1, `${kind} test did not arm the card drag`);
      if (kind === "pointercancel") {
        flushSync(() => window.dispatchEvent(pointer("pointercancel", pointerId, 20, 20)));
      } else if (kind === "escape") {
        flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      } else {
        flushSync(() => window.dispatchEvent(new Event("blur")));
      }
      assert(frameCallbacks.size === 0, `${kind} retained the card animation frame`);
      assert(!source.style.transform, `${kind} left a card transform behind`);
      const click = clickPointer(pointerId);
      flushSync(() => source.dispatchEvent(click));
      assert(!click.defaultPrevented, `${kind} cancellation left suppressClick latched`);
    };
    cancelCardDrag("pointercancel", 31);
    cancelCardDrag("escape", 32);
    cancelCardDrag("blur", 33);

    const cardSource = cardRows()[0];
    const secondCard = cardRows()[1];
    flushSync(() => cardSource.dispatchEvent(pointer("pointerdown", 34, 10, 10)));
    flushSync(() => window.dispatchEvent(pointer("pointermove", 34, 20, 20)));
    flushSync(() => window.dispatchEvent(pointer("pointerup", 34, 20, 20)));
    const keyboardCardClick = new PointerEvent("click", { pointerId: 0, detail: 0, bubbles: true, cancelable: true });
    flushSync(() => secondCard.dispatchEvent(keyboardCardClick));
    assert(!keyboardCardClick.defaultPrevented, "keyboard activation was swallowed by card drag suppression");
    const completedCardClick = clickPointer(34);
    flushSync(() => cardSource.dispatchEvent(completedCardClick));
    assert(completedCardClick.defaultPrevented, "keyboard click cleared the completed card drag latch");

    const secondCardSource = cardRows()[1];
    flushSync(() => secondCardSource.dispatchEvent(pointer("pointerdown", 35, 10, 30)));
    flushSync(() => window.dispatchEvent(pointer("pointermove", 35, 20, 40)));
    flushSync(() => window.dispatchEvent(pointer("pointerup", 35, 20, 40)));
    flushSync(() => secondCard.dispatchEvent(pointer("pointerdown", 99, 10, 30)));
    flushSync(() => window.dispatchEvent(pointer("pointercancel", 99, 10, 30)));
    const completedCardClickAfterOtherPointer = clickPointer(35);
    flushSync(() => secondCardSource.dispatchEvent(completedCardClickAfterOtherPointer));
    assert(completedCardClickAfterOtherPointer.defaultPrevented, "another row pointerdown cleared the completed card drag latch");

    assert(uncaught.length === 0, `React render failed: ${uncaught.map(String).join(", ")}`);
    return { ok: true };
  } finally {
    flushSync(() => {
      workPanelRoot.unmount();
      cardRoot.unmount();
    });
    window.requestAnimationFrame = nativeRequestFrame;
    window.cancelAnimationFrame = nativeCancelFrame;
    document.elementFromPoint = originalElementFromPoint;
    frameCallbacks.clear();
    panelHost.remove();
    cardHost.remove();
    useAppStore.setState(previousStore, true);
  }
};
