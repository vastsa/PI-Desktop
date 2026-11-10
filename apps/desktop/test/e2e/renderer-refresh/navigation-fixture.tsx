import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { useAppStore } from "../../../src/stores/app-store";
import { RendererRefreshButton } from "../../../src/features/app/RendererRefreshButton";
import { restoreRendererRefreshDrafts, restoreRendererRefreshView } from "../../../src/features/app/renderer-refresh";
import { readComposerDraft, writeComposerDraft } from "../../../src/lib/composer-draft-cache";
import { readSubagentControlDraft, writeSubagentControlDraft } from "../../../src/features/subagents/control-drafts";
import { RENDERER_REFRESH_KEY } from "../../../src/features/app/renderer-refresh-checkpoint";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
const boot = Number(sessionStorage.getItem("fixture-boots") ?? 0) + 1;
sessionStorage.setItem("fixture-boots", String(boot));
const address = { sessionId: "fictional-session", delegationId: "fictional-child" };
const stamp = "2026-11-03T00:00:00Z";
Object.assign(window, { piDesktop: { platform: "win32", on: () => () => {}, invoke: async () => {
  throw new Error("Refresh must not call Host or providers");
} } });
useAppStore.setState({ ready: true, activeSessionId: address.sessionId, page: "chat", messages: [],
  sessions: [{ id: address.sessionId, title: "Fixture", mode: "agent", createdAt: stamp, updatedAt: stamp }],
  runningSessions: { [address.sessionId]: true }, workPanelOpen: false, workPanelTabs: [],
  workPanelContexts: {}, activeWorkPanelTabId: null, workPanelFileRequest: null });
if (boot === 1) {
  writeComposerDraft(address.sessionId, { text: "UNSENT-MAIN-DRAFT", fileReferences: [] });
  writeSubagentControlDraft(address, { text: "UNSENT-CHILD-DRAFT", model: "Fixture/child-model" });
  useAppStore.setState({ workPanelOpen: true, workPanelTabs: [{ id: "subagents", kind: "subagents" }],
    activeWorkPanelTabId: "subagents" });
}
restoreRendererRefreshDrafts();
await restoreRendererRefreshView();
const root = createRoot(document.getElementById("root")!);
flushSync(() => root.render(<><RendererRefreshButton />
  <div data-testid="restored-draft">{readComposerDraft(address.sessionId)?.text}</div></>));
Object.assign(window, { refreshNavigationProbe: {
  boot, mainDraft: readComposerDraft(address.sessionId)?.text,
  childDraft: readSubagentControlDraft(address).text, childModel: readSubagentControlDraft(address).model,
  panel: useAppStore.getState().activeWorkPanelTabId,
  running: useAppStore.getState().runningSessions[address.sessionId],
  checkpointConsumed: !sessionStorage.getItem(RENDERER_REFRESH_KEY),
  click: () => document.querySelector<HTMLButtonElement>("button")!.click(),
} });
