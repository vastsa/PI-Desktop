import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import type { SessionSummary } from "@pi-desktop/shared";
import { Composer } from "../../apps/desktop/src/components/Composer";
import { Sidebar } from "../../apps/desktop/src/components/Sidebar";
import { CollapsedTitlebarActions } from "../../apps/desktop/src/features/app/chrome";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

type Scenario = "send" | "paste" | "cancel-send" | "cancel-paste";
const noop = () => {};
const frame = () => new Promise(requestAnimationFrame);
const prompt = "First message while creation is pending";

async function until(condition: () => unknown, message: string) {
  const deadline = performance.now() + 3_000;
  while (!condition() && performance.now() < deadline) await frame();
  if (!condition()) throw new Error(message);
}

function element<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error("Missing element: " + selector);
  return node;
}

declare global {
  var startComposerDraftRace: (scenario: Scenario, existing: SessionSummary) => Promise<void>;
  var finishComposerDraftRace: () => Promise<{ selected?: string; rows: string[]; attachment: boolean }>;
}

globalThis.startComposerDraftRace = async (scenario, existing) => {
  await i18n.use(initReactI18next).init({ lng: "en", resources: { en: { translation: en } } });
  const provider = {
    id: "fixture", name: "Fixture", vendorKey: "custom", type: "openai_compatible",
    protocol: "openai_compatible", enabled: true, authKind: "none", hasSecret: false,
    models: [{ id: "fixture-model", contextWindow: 32_000, maxTokens: 4_000, thinkingLevels: [], defaultThinkingLevel: null }],
    supportsReasoning: false, supportedThinkingLevels: [],
    createdAt: existing.createdAt, updatedAt: existing.updatedAt,
  } as const;
  useAppStore.setState({
    page: "chat", ready: true, healthOk: true, activeSessionId: existing.id,
    workspace: null, sessions: [existing], providers: [{ ...provider, models: [...provider.models] }],
  });
  let creation: Promise<void> | undefined;
  function Fixture() {
    const activeSessionId = useAppStore((state) => state.activeSessionId);
    return <>
      <CollapsedTitlebarActions onToggleSidebar={noop} sidebarToggleShortcut=""
        onNewTask={() => { creation = useAppStore.getState().newSession(); }} />
      <Sidebar onToggleSidebar={noop} sidebarToggleShortcut="" sidebarWidth={260}
        onWidthChange={noop} onWidthCommit={noop} onResizeCollapse={noop} />
      <Composer variant={activeSessionId ? "docked" : "home"} />
    </>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  let renderError: unknown;
  const root = createRoot(container, { onUncaughtError: (error) => {
    renderError = error;
    console.error(error instanceof Error ? error.stack : error);
  } });
  flushSync(() => root.render(<Fixture />));
  if (renderError) throw renderError;
  element('[data-nav="new-task"]').click();
  await until(() => document.querySelector('[data-composer-dock="home"]'), "New Task did not reveal the home composer");
  const editor = element<HTMLElement>(".composer-input");
  editor.focus();
  const paste = scenario.endsWith("paste");
  const cancelled = scenario.startsWith("cancel");
  if (paste) {
    const data = new DataTransfer();
    data.setData("text/plain", "Synthetic oversized paste. ".repeat(60));
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  } else {
    if (!document.execCommand("insertText", false, prompt)) throw new Error("Could not type in the composer");
    await until(() => !element<HTMLButtonElement>(".send-btn").disabled, "First Send stayed disabled");
    element(".send-btn").click();
  }
  await frame();
  if (cancelled) {
    element('[data-sidebar-session-row="existing"] .thread-item-main').click();
    await until(() => useAppStore.getState().activeSessionId === existing.id, "Could not return to the existing session");
  }
  globalThis.finishComposerDraftRace = async () => {
    await creation;
    if (scenario === "paste") {
      await until(() => document.querySelector(".composer-chip"), "Paste did not attach to the created session");
    }
    if (scenario === "send") {
      await until(() => useAppStore.getState().messages.some((message) => message.content === prompt),
        "First prompt did not appear in the new session");
    }
    await frame();
    await frame();
    const selected = useAppStore.getState().activeSessionId;
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-sidebar-session-row]"),
      (row) => row.dataset.sidebarSessionRow!);
    return { selected, rows, attachment: !!document.querySelector(".composer-chip") };
  };
};
