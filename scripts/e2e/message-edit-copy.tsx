import React, { useRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "../../packages/i18n/src/index";
import { MessageRow } from "../../apps/desktop/src/features/chat/transcript/MessageRow";
import { TranscriptMenuProvider } from "../../apps/desktop/src/features/chat/transcript/TranscriptMenu";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { TranscriptSelectionAction } from "../../apps/desktop/src/features/chat/transcript/TranscriptSelectionAction";
import { readComposerDraft, resetComposerDraftCache } from "../../apps/desktop/src/lib/composer-draft-cache";

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

function SelectionFixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div className="thread-scroll" ref={scrollRef}>
        <MessageRow message={{ id: "message", role: "user", content: "Original saved message", createdAt: "2026-09-21T00:00:00Z" }} isRunning={false} />
        <div data-row-role="assistant" role="article">
          <div className="assistant-turn-fragment"><div className="prose-chat">A second answer</div></div>
          <div className="tool-output">Tool output is excluded</div>
        </div>
      </div>
      <TranscriptSelectionAction scrollRef={scrollRef} sessionId="message-session" visible />
    </>
  );
}

Object.assign(globalThis, { messageEditCopyProbe: async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  let copied = "";
  // Mock only the external clipboard write, keeping native textarea selection.
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { copied = text; } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  useAppStore.setState({
    activeSessionId: "message-session",
    composerPrefill: null,
    prepareUserMessageEdit: async () => ({
      id: "message",
      role: "user",
      content: "Original saved message",
      createdAt: "2026-09-21T00:00:00Z",
    }),
  });
  resetComposerDraftCache();
  flushSync(() => root.render(<I18nextProvider i18n={i18n}><TranscriptMenuProvider>
    <SelectionFixture />
  </TranscriptMenuProvider></I18nextProvider>));
  const bubble = find(".message-bubble");
  const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
  let textNode: Node | null = null;
  while ((textNode = walker.nextNode())) {
    if (textNode.textContent?.includes("Original saved message")) break;
  }
  check(!!textNode, "Could not find the rendered message text");
  const range = document.createRange();
  range.setStart(textNode!, 9);
  range.setEnd(textNode!, 14);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  await settle();
  await settle();
  check(!!document.querySelector('[data-selection-action="add-to-conversation"]'),
    "Selecting message text did not reveal the inline action");
  await click('[data-selection-action="add-to-conversation"]');
  check(readComposerDraft("message-session")?.excerpts?.[0]?.text === "saved",
    "Inline action did not attach only the selected text");
  selection.removeAllRanges();
  await settle();
  check(!document.querySelector('[data-selection-action="add-to-conversation"]'),
    "Inline action remained after the selection was cleared");
  const assistantText = find(".prose-chat").firstChild!;
  range.setStart(assistantText, 2);
  range.setEnd(assistantText, 8);
  selection.addRange(range);
  await settle();
  await settle();
  check(!!document.querySelector('[data-selection-action="add-to-conversation"]'),
    "Selecting assistant prose did not reveal the inline action");
  selection.removeAllRanges();
  const toolText = find(".tool-output").firstChild!;
  range.setStart(toolText, 0);
  range.setEnd(toolText, 4);
  selection.addRange(range);
  await settle();
  check(!document.querySelector('[data-selection-action="add-to-conversation"]'),
    "Selecting tool output exposed the inline action");
  selection.removeAllRanges();
  range.setStart(textNode!, 0);
  range.setEnd(assistantText, 4);
  selection.addRange(range);
  await settle();
  check(!document.querySelector('[data-selection-action="add-to-conversation"]'),
    "Selecting across turns exposed the inline action");
  selection.removeAllRanges();
  await menu(find('[role="article"]'));
  await click('[data-context-menu-item="edit"]');
  const editor = find<HTMLTextAreaElement>("textarea");
  editor.focus();
  editor.select();
  document.execCommand("insertText", false, "Fresh draft: ORANGE-927");
  await settle();
  editor.setSelectionRange(13, 23);
  await menu(editor);
  await click('[data-context-menu-item="add-to-conversation"]');
  check(
    readComposerDraft("message-session")?.excerpts?.[1]?.text === "ORANGE-927",
    "Add to conversation did not attach the selected draft text",
  );
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
  return "PASS: selection action appears without a menu for speaking-turn text only, selected text attaches to the draft, partial draft copy, whole draft copy, select text, editing actions, cancel and saved-message copy";
} });
