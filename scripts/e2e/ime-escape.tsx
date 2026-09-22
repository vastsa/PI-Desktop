import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "../../packages/i18n/src/index";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { MessageRow } from "../../apps/desktop/src/features/chat/transcript/MessageRow";
import { SearchDialog } from "../../apps/desktop/src/components/SearchDialog";
import { useSessionSearchState } from "../../apps/desktop/src/hooks/use-session-search";

const check = (ok: unknown, label: string) => { if (!ok) throw new Error(label); };
const key = (node: Element, init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  flushSync(() => node.dispatchEvent(event));
  return event;
};
Object.assign(globalThis, { imeEscapeProbe: async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const sent: string[] = [];
  useAppStore.setState({ refreshSessions: async () => {}, editUserMessage: async (_id, text) => { sent.push(text); return true; } });
  Object.assign(api, { searchSessions: async () => ({ hits: [] }), searchCommands: async () => ({ commands: [] }) });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const render = (child: React.ReactNode) => flushSync(() => root.render(<I18nextProvider i18n={i18n}>{child}</I18nextProvider>));
  render(<MessageRow message={{ id: "ime-test", role: "user", content: "Original message", createdAt: "2026-09-21T00:00:00Z", status: "complete" }} isRunning={false} />);
  const edit = () => flushSync(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("chat.editMessage")}"]`)!.click());
  edit();
  const input = container.querySelector<HTMLTextAreaElement>("textarea")!;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Edited draft ni");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
    check(!key(input, { key: "Escape", ...composing }).defaultPrevented, "IME Escape was consumed");
    check(container.contains(input) && input.value === "Edited draft ni", "IME Escape discarded message edit");
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      key(input, { key: "Enter", ...modifier, ...composing });
      check(sent.length === 0, "IME Enter submitted message edit");
    }
  }
  key(input, { key: "Escape" });
  check(!container.querySelector("textarea"), "Normal Escape did not cancel editing");
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    edit();
    key(container.querySelector("textarea")!, { key: "Enter", ...modifier });
    for (let frame = 0; frame < 120 && container.querySelector("textarea"); frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    check(!container.querySelector("textarea"), "Successful retry did not finish editing");
  }
  check(sent.length === 2 && sent.every((text) => text === "Original message"), "Normal retry shortcuts changed");
  let closed = false;
  useSessionSearchState.setState({ query: "draft ni" });
  const openSearch = () => { closed = false; render(<SearchDialog open onClose={() => { closed = true; }} />); };
  openSearch();
  const search = container.querySelector<HTMLInputElement>(".search-input")!;
  check(search, "Search input missing");
  for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
    check(!key(search, { key: "Escape", ...composing }).defaultPrevented, "Search consumed IME Escape");
    check(!closed && search.value === "draft ni", "Bubbled IME Escape closed search");
  }
  key(search, { key: "Escape" });
  check(closed, "Normal Escape did not close search");
  openSearch();
  key(container.querySelector('[role="dialog"]')!, { key: "Escape" });
  check(closed, "Escape outside search input did not close dialog");
  root.unmount(); container.remove();
  return "PASS: composing Escape preserves editing/search; composing retry ignored; normal Escape and retry work";
} });
