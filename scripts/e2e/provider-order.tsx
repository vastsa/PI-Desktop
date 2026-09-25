import { cardReorderPerformance } from "./card-reorder-performance";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider, useTranslation } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { ModelConfigPage } from "../../apps/desktop/src/components/settings/ModelConfigPage";
import { ComposerModelPicker } from "../../apps/desktop/src/features/chat/composer/ComposerModelPicker";
import { useComposerModelMenu } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerModelMenu";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";
import "../../apps/desktop/src/styles/model-config.css";
import "../../apps/desktop/src/styles/composer.css";

declare global { var cardReorderPerformance: () => ReturnType<typeof import("./card-reorder-performance").cardReorderPerformance>; var providerOrderProbe: (restart?: boolean) => Promise<unknown>; }
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const painted = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(condition: () => boolean, message: string | (() => string)) {
  const deadline = performance.now() + 5000;
  while (!condition() && performance.now() < deadline) await painted();
  assert(condition(), typeof message === "function" ? message() : message);
}

function ModelMenu() {
  const { t } = useTranslation();
  const provider = useAppStore((state) => state.providers.find((item) => item.enabled));
  const controller = useComposerModelMenu({
    mode: "agent", activeSessionId: null, provider, modelId: provider?.defaultModelId,
    thinkingProvider: provider, thinkingLevel: "off", controlsBlocked: false,
  });
  return <ComposerModelPicker t={t} controller={controller} modelLabel="Fixture"
    thinkingLabel="off" thinkingLevel="off" controlsBlocked={false} onCloseOtherMenus={() => {}} />;
}

globalThis.providerOrderProbe = async (restart = false) => {
  const previous = useAppStore.getState();
  const host = document.createElement("div");
  host.style.cssText = "width: 850px; margin: 24px;";
  document.body.append(host);
  const errors: unknown[] = [];
  const root = createRoot(host, { onUncaughtError: (error) => errors.push(error) });
  const i18n = createInstance();
  await i18n.init({ lng: "en", fallbackLng: "en", resources: {
    en: { translation: catalogs.en }, "zh-CN": { translation: catalogs["zh-CN"] },
  }, interpolation: { escapeValue: false } });
  const rows = () => Array.from(host.querySelectorAll<HTMLElement>(".model-provider-row"));
  const names = () => rows().map((row) => row.querySelector(".model-provider-row-name")?.textContent).join(",");
  const row = (name: string) => rows().find((row) => row.querySelector(".model-provider-row-name")?.textContent === name)!;
  const settled = (expected: string) => until(() => names() === expected && row(expected.split(",")[0]).getAttribute("aria-disabled") !== "true",
    `provider order did not settle at ${expected}: ${names()}`);
  const drag = async (from: string, to: string, after: boolean, drop = true) => {
    const source = row(from);
    const initial = source.getBoundingClientRect();
    const target = row(to);
    const rect = target.getBoundingClientRect();
    const x = initial.left + initial.width / 2;
    const y = initial.top + initial.height / 2;
    const clientY = after ? rect.bottom - 1 : rect.top + 1;
    flushSync(() => source.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: x, clientY: y, bubbles: true })));
    flushSync(() => window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: x + 12, clientY, bubbles: true, cancelable: true })));
    await painted();
    assert(source.style.transform.includes("translate("), "the whole card must follow the pointer");
    assert(target.style.transform.includes("translateY"), "surrounding cards must make room before dropping");
    assert(names() === useAppStore.getState().providers.map((item) => item.name).join(","), "drag preview must not persist before release");
    flushSync(() => window.dispatchEvent(new PointerEvent(drop ? "pointerup" : "pointercancel", { pointerId: 1, clientX: x + 12, clientY, bubbles: true })));
    await painted();
  };
  const key = (name: string, key: string) => flushSync(() => row(name).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
  const realReorder = api.reorderProviders;
  const realList = api.listProviders;
  try {
    await useAppStore.getState().refreshProviders();
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><ModelConfigPage /><ModelMenu /></I18nextProvider>));
    await until(() => rows().length === 3, "configured provider rows missing");
    assert(errors.length === 0, `render failed: ${errors.map(String)}`);
    if (restart) {
      assert(names() === "B,C,A", "saved provider order did not survive host and renderer restart");
      return { ok: true, restart: true };
    }
    assert(names() === "A,B,C", "legacy providers should retain creation order");
    assert(!host.querySelector(".model-provider-reorder"), "cards should not display a separate drag handle");
    const original = useAppStore.getState().providers;
    const start = row("A").getBoundingClientRect();
    flushSync(() => row("A").dispatchEvent(new PointerEvent("pointerdown", { pointerId: 3, button: 0, clientX: start.left + 50, clientY: start.top + 10, bubbles: true })));
    flushSync(() => window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, clientX: start.left + 52, clientY: start.top + 12, bubbles: true })));
    assert(!host.querySelector(".is-dragging"), "small click movement must not start dragging");
    flushSync(() => window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 3, bubbles: true })));

    const action = row("B").querySelector<HTMLButtonElement>(".model-provider-row-actions button")!;
    flushSync(() => action.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 2, button: 0, bubbles: true })));
    flushSync(() => window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 2, clientX: 100, clientY: 100, bubbles: true })));
    assert(!host.querySelector(".is-dragging"), "action buttons must not start card dragging");
    flushSync(() => window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2, bubbles: true })));

    const defaultProviderId = useAppStore.getState().settings?.defaultProviderId;
    await drag("C", "A", false, false);
    assert(names() === "A,B,C" && !host.querySelector(".is-dragging"), "cancelled drag changed order or left an indicator");
    await drag("C", "A", false);
    await settled("C,A,B");
    await drag("C", "B", true);
    await settled("A,B,C");
    key("C", "ArrowUp");
    await settled("A,C,B");
    for (const provider of useAppStore.getState().providers) {
      assert(JSON.stringify(provider) === JSON.stringify(original.find((item) => item.id === provider.id)), "sorting changed a provider configuration");
    }
    assert(useAppStore.getState().settings?.defaultProviderId === defaultProviderId, "sorting changed the default provider");

    // An older catalog read cannot undo the refresh following an accepted move.
    let releaseOld: (() => void) | undefined;
    const staleList = await realList();
    api.listProviders = () => new Promise((resolve) => { releaseOld = () => resolve(staleList); });
    const oldRefresh = useAppStore.getState().refreshProviders();
    api.listProviders = realList;
    await drag("B", "A", false);
    await settled("B,A,C");
    releaseOld!();
    await oldRefresh;
    assert(names() === "B,A,C", "late catalog response reverted a saved order");

    api.reorderProviders = async () => { throw new Error("fixture write failed"); };
    const toastCount = useAppStore.getState().toasts.length;
    await drag("C", "B", false);
    await until(() => useAppStore.getState().toasts.length > toastCount, "failed save must show an error");
    await settled("B,A,C");
    api.reorderProviders = realReorder;
    await settled("B,A,C");

    let release: (() => void) | undefined;
    let calls = 0;
    api.reorderProviders = async (input) => {
      calls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return realReorder(input);
    };
    key("A", "ArrowDown");
    key("B", "ArrowDown");
    assert(calls === 1, "overlapping moves must be blocked until saving finishes");
    release!();
    await settled("B,C,A");
    api.reorderProviders = realReorder;

    const scrollTail = document.createElement("div");
    scrollTail.style.height = "300px";
    host.append(scrollTail);
    host.style.height = "220px";
    host.style.overflowY = "auto";
    host.scrollTop += row("C").getBoundingClientRect().top - host.getBoundingClientRect().top;
    await painted();
    const bounds = host.getBoundingClientRect();
    const scrollBefore = host.scrollTop;
    flushSync(() => row("C").dispatchEvent(new PointerEvent("pointerdown", { pointerId: 4, button: 0, clientX: bounds.left + 50, clientY: bounds.top + 20, bubbles: true })));
    flushSync(() => window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 4, clientX: bounds.left + 50, clientY: bounds.bottom - 2, bubbles: true, cancelable: true })));
    await until(() => host.scrollTop > scrollBefore, () => `edge scroll did not advance: ${scrollBefore} -> ${host.scrollTop}`);
    flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert(!host.querySelector(".is-dragging") && names() === "B,C,A", "Escape must restore the accepted layout");
    const stoppedAt = host.scrollTop;
    await painted();
    await painted();
    assert(host.scrollTop === stoppedAt, "cancelling must stop automatic scrolling");
    scrollTail.remove();
    host.style.height = "";
    host.style.overflowY = "";
    host.scrollTop = 0;
    await painted();

    // Saving a provider must preserve the exact app default picked by the user.
    const click = (element: HTMLElement | null) => {
      assert(element, "missing provider action");
      flushSync(() => {
        element!.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 5, button: 0, bubbles: true }));
        element!.click();
      });
    };
    click(host.querySelector(".model-default-row button"));
    await until(() => !!document.querySelector('[aria-label="A · deepseek-reasoner"]'), "second model missing from default picker");
    click(document.querySelector('[aria-label="A · deepseek-reasoner"]'));
    await until(() => useAppStore.getState().settings?.defaultModelId === "deepseek-reasoner",
      "default picker did not select the second model");
    // The row itself opens its editor (D625).
    const edit = async (name: string) => {
      await until(() => row(name).getAttribute("aria-disabled") !== "true", "provider is still saving");
      click(row(name));
      await until(() => !!document.querySelector(".provider-setup-dialog"), "provider editor did not open");
    };
    const save = async () => {
      click([...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === i18n.t("settings.saveProvider"))!);
      await until(() => !document.querySelector(".provider-setup-dialog"), "provider editor did not close");
      await useAppStore.getState().refreshProviders();
    };
    await edit("A");
    await save();
    assert(useAppStore.getState().settings?.defaultModelId === "deepseek-reasoner",
      "unchanged provider save reset the selected default model");
    assert(host.querySelector(".model-default-model")?.textContent === "deepseek-reasoner",
      "saved default model summary changed");
    await edit("B");
    await save();
    assert(useAppStore.getState().settings?.defaultModelId === "deepseek-reasoner",
      "editing another provider changed the app default");
    await edit("A");
    click([...document.querySelectorAll<HTMLElement>(".provider-chosen-row")]
      .find((entry) => entry.querySelector(".provider-chosen-row-id")?.textContent === "deepseek-reasoner")!
      .querySelector(".provider-chosen-remove"));
    await save();
    assert(useAppStore.getState().settings?.defaultModelId === "deepseek-chat",
      "removing the selected default must fall back to the first remaining model");

    await i18n.changeLanguage("zh-CN");
    await until(() => !!row("B").getAttribute("aria-label")?.includes("拖动"), "card reorder instruction must follow the interface language");
    flushSync(() => host.querySelector<HTMLButtonElement>(".composer-model-thinking-chip")!.click());
    flushSync(() => document.querySelector<HTMLButtonElement>(".composer-menu-entry")!.click());
    await until(() => document.querySelectorAll(".composer-model-group").length === 3, "model menu groups missing");
    const groups = Array.from(document.querySelectorAll(".composer-model-group"), (group) => group.getAttribute("aria-label"));
    assert(groups.join(",") === "B,C,A", `composer model menu did not follow provider order: ${groups}`);
    assert(errors.length === 0, `render errors: ${errors.map(String)}`);
    return { ok: true, drag: true, keyboard: true, cancelledDrag: true, failedSave: true, staleRefresh: true, modelMenu: true, defaultModelPreserved: true, removedDefaultFallback: true };
  } finally {
    api.reorderProviders = realReorder;
    api.listProviders = realList;
    flushSync(() => root.unmount());
    host.remove();
    useAppStore.setState(previous, true);
  }
};

globalThis.cardReorderPerformance = cardReorderPerformance;
