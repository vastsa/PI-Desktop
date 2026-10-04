import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import type { SessionThinkingLevel } from "@pi-desktop/shared";
import { ComposerModelPicker } from "../../apps/desktop/src/features/chat/composer/ComposerModelPicker";
import type { useComposerModelMenu } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerModelMenu";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import "./thinking-slider-motion";

const i18n = createInstance();
const levels: SessionThinkingLevel[] = ["omit", "off", "low", "high", "max"];
const noop = () => {};
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);

function Fixture({ width, crowded, model }: { width: number; crowded: boolean; model: string }) {
  const [level, setLevel] = useState<SessionThinkingLevel>("omit");
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"root" | "model">("root");
  const rootMenuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const controller: ReturnType<typeof useComposerModelMenu> = {
    open, setOpen, view, query: "", setQuery: noop,
    modelHighlight: -1, setModelHighlight: noop,
    rootMenuRef, modelSearchRef: searchRef, modelListRef: listRef,
    modelGroups: [], flatModels: [],
    thinkingMenuLevels: levels, showView: setView,
    selectModel: async () => {},
    commitThinkingLevel: async (next) => { setLevel(next); return true; },
    onMenuKeyDown: noop, controlsBlocked: false,
  };
  return <div className="composer-stack" style={{ width, position: "absolute", top: 300, transition: "none" }}>
    <div className="composer-shell"><div className="composer-toolbar">
      {/* Reserve space like other toolbar controls without mocking the picker layout. */}
      <div className="composer-left" style={{ width: crowded ? 400 : 80 }} />
      <div className="composer-right">
        <ComposerModelPicker t={i18n.t} controller={controller} modelLabel={model}
          thinkingLabel={level} thinkingLevel={level} controlsBlocked={false}
          onCloseOtherMenus={noop} />
        <button className="icon-btn icon-btn-square" aria-label="Enhance" />
        <button className="send-btn" aria-label="Send" />
      </div>
    </div></div>
  </div>;
}

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing ${selector}`);
  return result;
}
const settle = () => new Promise<void>((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
);

async function waitForMenuToSettle(menu: HTMLElement): Promise<void> {
  let previousRect: DOMRect | undefined;
  let previousTransform: string | undefined;
  let stableFrames = 0;
  for (let frame = 0; frame < 120; frame++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const rect = menu.getBoundingClientRect();
    const transform = getComputedStyle(menu).transform;
    const animating = menu.getAnimations().some(
      (animation) => animation.pending || animation.playState === "running",
    );
    const untransformed = transform === "none";
    const layoutMatches =
      Math.abs(rect.width - menu.offsetWidth) <= 0.5 &&
      Math.abs(rect.height - menu.offsetHeight) <= 0.5;
    const stable =
      layoutMatches &&
      previousRect !== undefined &&
      Math.abs(rect.left - previousRect.left) < 0.05 &&
      Math.abs(rect.top - previousRect.top) < 0.05 &&
      Math.abs(rect.width - previousRect.width) < 0.05 &&
      Math.abs(rect.height - previousRect.height) < 0.05 &&
      transform === previousTransform;
    stableFrames = menu.classList.contains("is-open") && !animating && untransformed && stable
      ? stableFrames + 1
      : 0;
    if (stableFrames >= 2) return;
    previousRect = rect;
    previousTransform = transform;
  }
  throw new Error("Composer reasoning menu did not settle after opening");
}

declare global {
  var composerThinkingLayoutProbe: () => Promise<unknown>;
  var composerThinkingPointerProbe: {
    mount: () => Promise<void>;
    target: (level?: string) => { x: number; y: number };
    settle: () => Promise<void>;
    frame: () => Promise<void>;
    snapshot: () => { left: number; top: number; anchorRight: number; level: string | null };
    pressed: () => boolean;
    railTarget: (index: number) => { x: number; y: number };
    focusRange: () => void;
    motionState: () => { dragging: boolean; gap: number; animations: number; focused: boolean };
    openModelSettings: () => Promise<{ page: string; tab: string; anchor: string | null; menuClosed: boolean; linkVisible: boolean }>;
  };
}

// Native mouse events in Main exercise :active and its release transition;
// HTMLElement.click() deliberately skips those states and cannot catch this regression.
globalThis.composerThinkingPointerProbe = {
  frame: settle,
  async mount() {
    flushSync(() => root.render(<Fixture key="pointer" width={768} crowded={false} model="aaaa" />));
    await settle();
  },
  target(level) {
    const target = level
      ? [...document.querySelectorAll<HTMLButtonElement>(".composer-thinking-tick")].find((button) => button.textContent === level)
      : element(".composer-model-thinking-chip");
    if (!target) throw new Error(`Missing mouse target ${level}`);
    const rect = target.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  },
  async settle() {
    await settle();
    await Promise.all(document.getAnimations().map((animation) => animation.finished));
    await settle();
  },
  async openModelSettings() {
    useAppStore.getState().setPage("chat");
    useAppStore.getState().setSettingsAnchor("settings.imageModel");
    element<HTMLButtonElement>('.composer-menu-root .composer-menu-entry').click();
    await settle();
    const link = element<HTMLButtonElement>('.composer-model-settings-link');
    const linkVisible = link.getBoundingClientRect().height > 0;
    link.click();
    await settle();
    const state = useAppStore.getState();
    return { page: state.page, tab: state.settingsTab, anchor: state.settingsAnchor,
      menuClosed: !document.querySelector('.composer-model-thinking-menu.is-open'), linkVisible };
  },
  snapshot() {
    const menu = element(".composer-model-thinking-menu").getBoundingClientRect();
    return { left: menu.left, top: menu.top,
      anchorRight: element(".composer-model-thinking-chip").getBoundingClientRect().right,
      level: element(".composer-thinking-range").getAttribute("aria-valuetext") };
  },
  pressed: () => element(".composer-model-thinking-chip").matches(":active"),
  railTarget(index) {
    const dot = document.querySelectorAll(".composer-thinking-dot")[index].getBoundingClientRect();
    const range = element(".composer-thinking-range").getBoundingClientRect();
    return { x: Math.round(dot.left + dot.width / 2), y: Math.round(range.top + range.height / 2) };
  },
  focusRange: () => element(".composer-thinking-range").focus(),
  motionState() {
    const thumb = element(".composer-thinking-thumb");
    const visual = thumb.getBoundingClientRect();
    const dot = element(".composer-thinking-dot.active").getBoundingClientRect();
    return { dragging: element(".composer-thinking-slider").hasAttribute("data-dragging"),
      gap: visual.left + visual.width / 2 - dot.left - dot.width / 2,
      animations: thumb.getAnimations().length,
      focused: document.activeElement === element(".composer-thinking-range") };
  },
};
globalThis.composerThinkingLayoutProbe = async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: {
    chat: { model: "Model", reasoningLevel: "Reasoning level" },
  } } }, interpolation: { escapeValue: false } });
  await document.fonts.ready;
  const cases = [
    { width: 768, crowded: false, model: "aaaa" },
    { width: 570, crowded: true, model: "aaaa" },
    { width: 590, crowded: true, model: "aaaa" },
    { width: 650, crowded: true, model: "a-very-long-model-name-".repeat(8) },
    { width: 450, crowded: false, model: "aaaa" },
  ];
  const measurements: unknown[] = [];
  const failures: string[] = [];
  for (const [index, config] of cases.entries()) {
    flushSync(() => root.render(<Fixture key={index} {...config} />));
    element<HTMLButtonElement>(".composer-model-thinking-chip").click();
    await settle();
    const menu = element(".composer-model-thinking-menu");
    await waitForMenuToSettle(menu);
    const initialMenuRect = menu.getBoundingClientRect();
    const initialLeft = initialMenuRect.left;
    const initialTop = initialMenuRect.top;
    const initialTriggerRect = element<HTMLButtonElement>(".composer-model-thinking-chip").getBoundingClientRect();
    const initialTriggerHeight = initialTriggerRect.height;
    if (Math.abs(initialMenuRect.right - initialTriggerRect.right) > 0.05) {
      failures.push(`${index}: opened menu did not align its right edge to the trigger (${initialMenuRect.right - initialTriggerRect.right}px)`);
    }
    for (const level of ["low", "omit", "high", "max", "off", "low"]) {
      const tick = [...document.querySelectorAll<HTMLButtonElement>(".composer-thinking-tick")]
        .find((button) => button.textContent === level);
      if (!tick) throw new Error(`Missing stop ${level}`);
      tick.click();
      await settle();
      const trigger = element(".composer-model-thinking-chip").getBoundingClientRect();
      const wrapper = element(".composer-model-thinking").getBoundingClientRect();
      const currentMenu = menu.getBoundingClientRect();
      const range = element<HTMLInputElement>(".composer-thinking-range");
      if (range.getAttribute("aria-valuetext") !== level) failures.push(`${index}: selection ${level} did not settle`);
      if (!menu.classList.contains("is-open")) failures.push(`${index}: selection closed the menu`);
      if (Math.abs(currentMenu.left - initialLeft) > 0.05) failures.push(`${index}/${level}: menu moved ${currentMenu.left - initialLeft}px`);
      if (Math.abs(currentMenu.top - initialTop) > 0.05) failures.push(`${index}/${level}: menu moved vertically`);
      if (Math.abs(trigger.height - initialTriggerHeight) > 0.05) failures.push(`${index}/${level}: trigger changed height`);
      if (trigger.right > wrapper.right + 0.05) failures.push(`${index}/${level}: trigger overflows its wrapper`);
      measurements.push({ ...config, level, triggerRight: trigger.right, wrapperRight: wrapper.right, menuLeft: currentMenu.left });
    }
    // A stable menu must still follow a real anchor move, rather than freeze coordinates.
    const beforeMove = menu.getBoundingClientRect().left;
    const beforeAnchor = element(".composer-model-thinking-chip").getBoundingClientRect().right;
    const stack = element(".composer-stack");
    stack.style.left = `${stack.getBoundingClientRect().left + 40}px`;
    window.dispatchEvent(new Event("resize"));
    await settle();
    const anchorMove = element(".composer-model-thinking-chip").getBoundingClientRect().right - beforeAnchor;
    const menuMove = menu.getBoundingClientRect().left - beforeMove;
    if (Math.abs(anchorMove - 40) > 0.05 || Math.abs(menuMove - anchorMove) > 0.05) failures.push(`${index}: menu moved ${menuMove}px for anchor move ${anchorMove}px`);
  }
  return { ok: failures.length === 0, failures, measurements };
};
