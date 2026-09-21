import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "../../packages/i18n/src/index";
import { ChatTranscript } from "../../apps/desktop/src/features/chat/transcript/ChatTranscript";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import type { UiMessage } from "../../packages/shared/src/index";

const check = (ok: boolean, label: string) => { if (!ok) throw new Error(label); };
const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const find = <T extends HTMLElement>(selector: string) => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
};

Object.assign(globalThis, { copyConversationProbe: async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const messages: UiMessage[] = Array.from({ length: 140 }, (_, index) => ({
    id: `m${index}`, role: index % 2 ? "assistant" : "user",
    content: `HISTORY-${String(index + 1).padStart(3, "0")}`,
    createdAt: new Date(1700000000000 + index * 1000).toISOString(), status: "complete",
  }));
  let copied: string[] = [];
  let requested: string[] = [];
  let failRead = false;
  // Only the persistence/clipboard boundaries are replaced; the menu and transcript are real.
  api.getSession = async (id, options) => {
    check(options === undefined, "Copy still requests a bounded history page");
    requested.push(id);
    if (failRead) throw new Error("Read unavailable");
    return { session: { id, title: "History", mode: "agent", createdAt: messages[0].createdAt,
      updatedAt: messages.at(-1)!.createdAt, messageCount: messages.length,
      thinkingLevel: "off", permissionMode: "inherit", messages } };
  };
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { copied.push(text); } } });
  const container = document.createElement("div");
  container.style.cssText = "width:900px;height:600px";
  document.body.append(container);
  const root = createRoot(container);
  const render = async (visible: UiMessage[], more: boolean, reading = false) => {
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><ChatTranscript
      sessionId="history" messages={visible} hasMoreBefore={more} hasMoreAfter={reading}
      readingWindow={reading} isRunning={false} paneVisible={true}
    /></I18nextProvider>));
    await settle();
  };
  const copy = async () => {
    flushSync(() => find(".thread-scroll").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
    await settle();
    const button = find<HTMLButtonElement>('[data-context-menu-item="copy-conversation"]');
    check(!button.disabled, "Copy disabled despite older conversation history");
    flushSync(() => button.click());
    await settle();
  };
  const assertComplete = () => {
    const ids = copied.at(-1)?.match(/HISTORY-\d{3}/g) ?? [];
    check(ids.length === 140 && ids[0] === "HISTORY-001" && ids.at(-1) === "HISTORY-140",
      `Copy returned ${ids.length} messages, starting with ${ids[0]}`);
  };
  await render(messages.slice(-100), true);
  check(requested.length === 0, "Opening a transcript eagerly loads full history");
  await copy(); assertComplete();
  check(requested[0] === "history", "Copy read another session");
  await render(messages.slice(50, 60), true, true);
  await copy(); assertComplete();
  await render([{ ...messages[139], role: "tool", content: "tool output" }], true);
  await copy(); assertComplete();
  // A bounded UI text preview must not replace the complete stored text.
  const fullText = messages[139].content + " full stored text";
  messages[139] = { ...messages[139], content: fullText };
  await render([{ ...messages[139], content: "truncated preview" }], false);
  await copy();
  check(copied.at(-1)!.includes(fullText), "Copy used truncated preview text");
  // Preserve a visible streaming tail that has not reached persistence yet.
  await render([...messages.slice(-2), { id: "live", role: "assistant", content: "LIVE TAIL", status: "streaming", createdAt: "2030-01-01T00:00:00Z" }], true);
  await copy();
  check(copied.at(-1)!.endsWith("LIVE TAIL"), "Copy lost the visible in-flight tail");
  const beforeFailure = copied.length;
  failRead = true;
  await copy();
  check(copied.length === beforeFailure, "A failed read wrote partial history to the clipboard");
  check(useAppStore.getState().toasts.some(toast => toast.variant === "error"), "A failed read gave no error feedback");
  root.unmount();
  return "PASS: full history, search window, tool-only page, full text, live tail and read failure";
} });
