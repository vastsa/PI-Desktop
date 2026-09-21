import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "../../packages/i18n/src/index";
import { MessageRow } from "../../apps/desktop/src/features/chat/transcript/MessageRow";
import { TranscriptMenuProvider } from "../../apps/desktop/src/features/chat/transcript/TranscriptMenu";

const check = (ok: boolean, label: string) => { if (!ok) throw new Error(label); };
const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const find = <T extends HTMLElement>(selector: string) => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
};
const click = async (selector: string) => {
  flushSync(() => find(selector).click());
  await settle();
};
const menu = async (node: HTMLElement) => {
  flushSync(() => node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
  await settle();
};

Object.assign(globalThis, { messageEditCopyProbe: async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  let copied = "";
  // Mock only the external clipboard write, keeping native textarea selection.
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { copied = text; } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(<I18nextProvider i18n={i18n}><TranscriptMenuProvider>
    <MessageRow message={{ id: "message", role: "user", content: "Original saved message", createdAt: "2026-09-21T00:00:00Z" }} isRunning={false} />
  </TranscriptMenuProvider></I18nextProvider>));
  await menu(find('[role="article"]'));
  await click('[data-context-menu-item="edit"]');
  const editor = find<HTMLTextAreaElement>("textarea");
  editor.focus();
  editor.select();
  document.execCommand("insertText", false, "Fresh draft: ORANGE-927");
  await settle();
  editor.setSelectionRange(13, 23);
  await menu(editor);
  await click('[data-context-menu-item="copy"]');
  check(copied === "ORANGE-927", `Selected draft copy returned ${JSON.stringify(copied)}`);
  editor.focus();
  editor.setSelectionRange(0, 0);
  await menu(editor);
  check(!document.querySelector('[data-context-menu-item="edit"]'), "Editing menu can reset the unsaved draft");
  check(!document.querySelector('[data-context-menu-item="delete"]'), "Editing menu exposes saved-message deletion");
  await click('[data-context-menu-item="copy"]');
  check(copied === editor.value, "Collapsed selection copied the saved message instead of the draft");
  await menu(editor);
  await click('[data-context-menu-item="select-text"]');
  check(editor.selectionStart === 0 && editor.selectionEnd === editor.value.length, "Select text did not select the draft");
  await menu(editor);
  await click('[data-context-menu-item="copy"]');
  check(copied === "Fresh draft: ORANGE-927", "Select text then Copy lost draft content");
  await click(".message-edit-cancel");
  await menu(find('[role="article"]'));
  check(!!document.querySelector('[data-context-menu-item="edit"]'), "Normal message lost Edit");
  check(!!document.querySelector('[data-context-menu-item="delete"]'), "Normal message lost Delete");
  await click('[data-context-menu-item="copy"]');
  check(copied === "Original saved message", "Cancel changed the saved message");
  root.unmount();
  return "PASS: partial draft copy, whole draft copy, select text, editing actions, cancel and saved-message copy";
} });
