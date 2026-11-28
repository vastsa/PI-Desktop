import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { RefObject } from "react";
import type { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { paintEditorValue, readEditorValue } from "../../apps/desktop/src/features/chat/composer/editor";
import { ComposerInput } from "../../apps/desktop/src/features/chat/composer/ComposerInput";
import { ChatTranscript } from "../../apps/desktop/src/features/chat/transcript/ChatTranscript";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const message = (id: string, role: UiMessage["role"], content: string): UiMessage => ({
  id, role, content, createdAt: "2026-09-13T00:00:00.000Z",
});

/** Exercise the production bubble, Markdown and composer in a real browser DOM. */
export async function bidiDirectionProbe(i18n: ReturnType<typeof createInstance>) {
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:0;top:0;width:900px";
  document.body.append(host);
  const root = createRoot(host);
  const initialStore = useAppStore.getState();
  const sessionId = "bidi-direction-probe";
  const messages = [
    message("bidi-user", "user", "hello English paragraph 123!\n\nپژگچ این پاراگراف فارسی است ؟"),
    message("bidi-assistant", "assistant", "English **paragraph** 123!\n\nپژگچ **پاسخ** فارسی ؟ ؛\n\n- English item\n- پژگچ فارسی\n\n# عنوان عربي\n\n- عنصر واحد\n- عنصر اثنان\n\n1. First item\n2. Second item"),
  ];
  try {
    useAppStore.setState({ activeSessionId: sessionId, page: "chat" });
    flushSync(() => root.render(
      <I18nextProvider i18n={i18n}>
        <ChatTranscript sessionId={sessionId} messages={messages} isRunning={false} />
      </I18nextProvider>,
    ));
    const bubble = host.querySelector<HTMLElement>(".message-user-text");
    assert(bubble, "production user message bubble did not render");
    const bubbleDirections = [...bubble.querySelectorAll<HTMLElement>("span[dir]")]
      .map((element) => element.getAttribute("dir"));
    assert(
      bubbleDirections.includes("ltr") && bubbleDirections.includes("rtl"),
      `user message paragraphs did not get independent directions: ${bubbleDirections.join(",")}`,
    );
    const markdownParagraphs = [...host.querySelectorAll<HTMLElement>(".prose-chat p")];
    assert(markdownParagraphs.length >= 2, "production Markdown paragraphs did not render");
    assert(
      markdownParagraphs[0]?.dir === "ltr" && markdownParagraphs[1]?.dir === "rtl",
      `Markdown paragraph directions were ${markdownParagraphs.map((p) => p.dir).join(",")}`,
    );

    const composerHost = document.createElement("div");
    host.append(composerHost);
    const composerRoot = createRoot(composerHost);
    const inputRef = { current: null } as RefObject<HTMLDivElement | null>;
    flushSync(() => composerRoot.render(
      <ComposerInput
        inputRef={inputRef}
        value={"hello\n\nپژگچ"}
        placeholderText=""
        placeholderKey=""
        inputBlocked={false}
        pasting={false}
        enterToSend={true}
        runActive={false}
        composerAc={{ close() {}, open: false, hasItems: false, items: [], highlight: 0, setHighlight() {} } as never}
        onPaste={() => {}}
        onAcceptCompletion={() => {}}
        onSubmit={() => {}}
        onInsertNewline={() => {}}
        onInput={() => {}}
        onHistoryNavigate={() => false}
        onCompositionStart={() => {}}
        onCompositionEnd={() => {}}
        onSettledInput={() => {}}
        onFocus={() => {}}
        onBlur={() => {}}
      />
    ));
    const editor = composerHost.querySelector<HTMLElement>(".composer-input");
    assert(editor, "production composer did not render");
    const draft = "hello 123!\nپژگچ فارسی ؟";
    paintEditorValue(editor, draft, new Map(), () => "", () => {}, () => {}, () => {}, () => {});
    assert(readEditorValue(editor) === draft, "production editor changed the mixed draft");
    // Range geometry verifies visual order, not merely attributes or source text.
    const glyph = (element: Element, character: string) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const offset = node.textContent?.indexOf(character) ?? -1;
        if (offset < 0) continue;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + character.length);
        const rect = range.getBoundingClientRect();
        assert(rect.width > 0, `glyph ${character} has no rendered geometry`);
        return rect.x;
      }
      throw new Error(`glyph ${character} missing`);
    };
    const composerOrder = {
      english: glyph(editor, "!") > glyph(editor, "h"),
      persian: glyph(editor, "؟") < glyph(editor, "پ"),
    };
    assert(composerOrder.english && composerOrder.persian, "composer punctuation order is wrong");
    const rtlBubble = bubble.querySelector<HTMLElement>('span[dir="rtl"]');
    assert(rtlBubble && getComputedStyle(rtlBubble).direction === "rtl", "bubble RTL paragraph has no RTL layout");
    assert(glyph(rtlBubble, "؟") < glyph(rtlBubble, "پ"), "bubble punctuation order is wrong");
    const lists = [...host.querySelectorAll<HTMLElement>(".prose-chat ul, .prose-chat ol")];
    const mixedList = lists.find((list) => /English item/.test(list.textContent ?? "") && /پژگچ/.test(list.textContent ?? ""));
    const arabicList = lists.find((list) => list.tagName === "UL" && /عنصر واحد/.test(list.textContent ?? "") && !/First item/.test(list.textContent ?? ""));
    const latinList = lists.find((list) => list.tagName === "OL" && /First item/.test(list.textContent ?? ""));
    const mixedDirs = [...(mixedList?.querySelectorAll<HTMLElement>(":scope > li") ?? [])].map((item) => item.dir);
    assert(mixedDirs.join(",") === "ltr,rtl", `Markdown list directions: ${mixedDirs.join(",")}`);
    const emphasis = host.querySelector(".prose-chat strong");
    assert(emphasis && getComputedStyle(emphasis).unicodeBidi === "isolate", "inline Markdown is not isolated");
    assert(bubble.textContent === messages[0].content, "paragraph splitting changed user text");
    const rtlMarkdown = markdownParagraphs[1];
    assert(rtlMarkdown && glyph(rtlMarkdown, "؟") < glyph(rtlMarkdown, "پ"), "Markdown punctuation order is wrong");
    const ltrMarkdown = markdownParagraphs[0];
    // A Windows-only default was not independently reproduced. The confirmed
    // inheritance path is an ancestor with a physical `text-align: left`.
    const inheritHost = rtlMarkdown.closest<HTMLElement>(".prose-chat")?.parentElement ?? rtlMarkdown.parentElement;
    assert(inheritHost, "Markdown ancestor for inherited alignment is missing");
    inheritHost.style.textAlign = "left";
    const rtlAlign = getComputedStyle(rtlMarkdown).textAlign;
    assert(
      rtlAlign === "start" || rtlAlign === "right",
      `RTL Markdown paragraph text-align was ${rtlAlign} under inherited left`,
    );
    const rtlBox = rtlMarkdown.getBoundingClientRect();
    assert(
      glyph(rtlMarkdown, "پ") > rtlBox.left + rtlBox.width / 2,
      "Arabic paragraph glyphs stayed on the left under inherited text-align:left",
    );
    const ltrBox = ltrMarkdown.getBoundingClientRect();
    assert(
      ltrMarkdown && glyph(ltrMarkdown, "E") < ltrBox.left + ltrBox.width / 2,
      "English paragraph glyphs did not stay on the left under inherited text-align:left",
    );
    const rtlItem = [...host.querySelectorAll<HTMLElement>(".prose-chat li")]
      .find((item) => item.dir === "rtl" && /پژگچ/.test(item.textContent ?? ""));
    const itemAlign = rtlItem && getComputedStyle(rtlItem).textAlign;
    assert(
      itemAlign === "start" || itemAlign === "right",
      `RTL Markdown list item text-align was ${itemAlign}`,
    );
    const heading = host.querySelector<HTMLElement>(".prose-chat h1");
    assert(heading?.dir === "rtl", `Markdown heading dir was ${heading?.dir}`);
    const headingAlign = heading && getComputedStyle(heading).textAlign;
    assert(
      headingAlign === "start" || headingAlign === "right",
      `RTL Markdown heading text-align was ${headingAlign}`,
    );
    const padding = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      return {
        direction: style.direction,
        paddingLeft: parseFloat(style.paddingLeft),
        paddingRight: parseFloat(style.paddingRight),
      };
    };
    assert(arabicList, "pure RTL list did not render");
    assert(arabicList.dir === "rtl", `pure RTL list dir was ${arabicList.dir}`);
    const rtlGutter = padding(arabicList);
    assert(rtlGutter.direction === "rtl", `pure RTL list computed direction was ${rtlGutter.direction}`);
    assert(
      rtlGutter.paddingRight > 10 && rtlGutter.paddingRight > rtlGutter.paddingLeft + 8,
      `pure RTL list gutter was padding-left ${rtlGutter.paddingLeft}px / padding-right ${rtlGutter.paddingRight}px`,
    );
    assert(latinList, "ordinary LTR list did not render");
    assert(latinList.dir === "ltr", `ordinary LTR list dir was ${latinList.dir}`);
    const ltrGutter = padding(latinList);
    assert(ltrGutter.direction === "ltr", `ordinary LTR list computed direction was ${ltrGutter.direction}`);
    assert(
      ltrGutter.paddingLeft > 10 && ltrGutter.paddingLeft > ltrGutter.paddingRight + 8,
      `ordinary LTR list gutter was padding-left ${ltrGutter.paddingLeft}px / padding-right ${ltrGutter.paddingRight}px`,
    );
    assert(
      getComputedStyle(editor).unicodeBidi === "plaintext",
      `composer unicode-bidi was ${getComputedStyle(editor).unicodeBidi}`,
    );
    assert(editor.getAttribute("contenteditable") === "true", "composer is not editable");
    const composerUnicodeBidi = getComputedStyle(editor).unicodeBidi;
    composerRoot.unmount();
    composerHost.remove();
    return { ok: true, bubbleDirections, markdownDirections: markdownParagraphs.map((p) => p.dir), composerUnicodeBidi, composerOrder };
  } finally {
    root.unmount();
    host.remove();
    useAppStore.setState({ activeSessionId: initialStore.activeSessionId, page: initialStore.page });
  }
}
