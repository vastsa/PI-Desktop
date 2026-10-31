/**
 * Session references in the transcript (issue #1324): the chip a user message
 * shows for `pi-desktop://session/<id>`, and the two prompt paths that must not
 * hand a referenced conversation to the file-attachment resolver.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { catalogs } from "@pi-desktop/i18n";
import { formatSessionLink, isRenderableAttachment } from "@pi-desktop/shared";
import { splitChatText } from "../src/lib/chat-links.ts";
import { getExtraMessageAttachments } from "../src/features/chat/transcript/extra-attachments.ts";
import { isRemoteSession, safeSessionSummary, sessionAllows } from "../src/lib/remote-session-safety.ts";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

/** The shipped catalogs answer `t`, so the assertions read real wording. */
let locale = "en";
const t = (key, values) => {
  const raw = key
    .split(".")
    .reduce(
      (node, part) => (node && typeof node === "object" ? node[part] : undefined),
      catalogs[locale],
    );
  if (typeof raw !== "string") return key;
  return values
    ? raw.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values[name] ?? ""))
    : raw;
};

/** The chip reads the live conversation title from the store, like the app. */
const store = { selectSession: async () => {}, sessions: [] };
const useAppStore = (selector) => selector(store);

const Icon = () => React.createElement("svg", { "aria-hidden": true });

/**
 * The modules below render through the repository's own transpile-and-stub
 * pattern: the real component source, with its surroundings replaced.
 */
function load(file, imports) {
  const source = readFileSync(file, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unmocked dependency ${id} of ${file.pathname}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const shared = load(new URL("../src/features/chat/transcript/shared.tsx", import.meta.url), {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "react-i18next": { useTranslation: () => ({ t, i18n: { language: locale } }) },
  "@pi-desktop/shared": await import("@pi-desktop/shared"),
  "./disclosure": {},
  "./TextShimmer": {
    TextShimmer: ({ text }) => React.createElement("span", null, text),
  },
  // The usage capsule has its own render contract; this fixture only proves
  // the session-chip graph still loads and renders.
  "./TurnUsageCapsule": { TurnUsageCapsule: () => null },
  "../../../hooks/use-preview-target": {
    useOpenChatFileRef: () => () => {},
    useOpenPreviewTarget: () => undefined,
  },
  "../../../hooks/use-chat-file-menu": { useChatFileMenu: () => ({}) },
  "../../../hooks/use-verified-chat-text": {
    // The real segmentation, so a session link in the body reaches its chip.
    useVerifiedChatText: (text) => splitChatText(String(text ?? ""), undefined),
  },
  "../../../components/ContextMenu": { ContextMenu: () => null },
  "../../../components/ImageHoverCard": { ImageHoverCard: () => null },
  "../../../components/Markdown": {
    Markdown: ({ source }) => source,
    useCopy: () => ({ copied: false, copy: () => {} }),
  },
  "../../../components/icons": new Proxy({}, { get: () => Icon }),
  "../../../components/ui": {
    TooltipButton: ({ ariaLabel, tooltip, ...props }) =>
      React.createElement("button", { ...props, "aria-label": ariaLabel ?? tooltip }),
  },
  "../../../lib/disclosure-anchor-context": { useDisclosureAnchorNotifier: () => {} },
  "../../../lib/turn-process": { isThinkingActive: () => false },
  "../../../lib/thinking-visibility": { resolveShowThinking: () => true },
  "../../../lib/transcript-search-context": { TranscriptSearchContext: React.createContext(null) },
  "../../../lib/assistant-turns": { messageThinking: () => "" },
  "../../../lib/use-referenced-image-data-url": { useReferencedImageDataUrl: () => undefined },
  "../../../lib/chat-links": { isHtmlFilePath: () => false },
  "../../../lib/context-usage": {
    calculateTokenRate: () => 0,
    turnUsageBreakdown: () => ({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    }),
  },
  "../../../stores/app-store": { useAppStore },
});

const { MessageRow } = load(new URL("../src/features/chat/transcript/MessageRow.tsx", import.meta.url), {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "react-i18next": { useTranslation: () => ({ t, i18n: { language: locale } }) },
  "@pi-desktop/shared": await import("@pi-desktop/shared"),
  "../../../hooks/use-preview-target": { useOpenChatFileRef: () => () => {} },
  "../../../lib/chat-links": { splitChatText: () => [] },
  "../../../components/Markdown": { Markdown: ({ source }) => source },
  "../../../components/icons": new Proxy({}, { get: () => Icon }),
  "../../../components/ui": {
    TooltipButton: ({ ariaLabel, tooltip, ...props }) =>
      React.createElement("button", { ...props, "aria-label": ariaLabel ?? tooltip }),
  },
  "../../../stores/app-store": { useAppStore },
  "../../../lib/remote-session-safety": {
    isRemoteSession,
    safeSessionSummary,
    sessionAllows,
  },
  "../../../plugins/renderer-slots/use-slots": { useSlotSessionId: () => "local-session" },
  "../../../plugins/renderer-slots/slot-message": { slotMessage: () => undefined },
  "./menu-items": { userMessageMenuItems: () => [] },
  "./ActionBarSlots": { ActionSlotSide: () => null },
  "./SessionMessageOrigin": { SessionMessageOrigin: () => null },
  "./extra-attachments": { getExtraMessageAttachments },
  "./TranscriptMenu": {
    useTranscriptMenu: () => () => {},
    useChatTextActions: () => ({ copyText: () => {}, selectText: () => {} }),
  },
  "./shared": shared,
});

const referenced = {
  kind: "session",
  name: "Nightly review",
  ref: "session-a",
  text: 'Referenced conversation "Nightly review" (session-a).\n\nuser: ship it',
};

const userMessage = {
  id: "user-row",
  role: "user",
  content: `continue from ${formatSessionLink("session-a")}`,
  status: "complete",
  createdAt: "2026-09-26T10:00:00.000Z",
  attachments: [referenced],
};

const renderChip = () =>
  renderToStaticMarkup(React.createElement(shared.SessionLinkChip, { sessionId: "session-a" }));
const renderRow = (message) =>
  renderToStaticMarkup(React.createElement(MessageRow, { message, isRunning: false }));

test("a referenced conversation renders as a chip naming its own target", () => {
  locale = "en";
  store.sessions = [{ id: "session-a", title: "Nightly review" }];
  const html = renderChip();
  assert.match(html, /data-action="open-session-reference"/);
  assert.match(html, /data-session-id="session-a"/);
  assert.match(
    read("../src/features/chat/transcript/shared.tsx"),
    /const open = \(\) => void selectSession\(sessionId\)\.catch\(\(\) => undefined\)/,
    "activating the chip opens the referenced conversation",
  );
  // The chip is a span, not a <button>, because Chromium never fragments a
  // button across lines and an atomic chip leaves the line it left blank.
  assert.match(html, /role="button"/, "the chip is announced as a button");
  assert.match(html, /tabindex="0"/, "the chip is reachable from the keyboard");
  assert.match(
    read("../src/features/chat/transcript/shared.tsx"),
    /if \(event\.key !== "Enter" && event\.key !== " "\) return;\s*\n\s*event\.preventDefault\(\);\s*\n\s*open\(\);/,
    "Enter and Space activate the chip, the way a button does",
  );
  assert.ok(
    html.includes(`${catalogs.en.chat.sessionReference} · Nightly review`),
    "the chip names the reference from the catalog",
  );
  assert.ok(
    html.includes(`title="${catalogs.en.chat.sessionReferenceOpen.replace("{{title}}", "Nightly review")}"`),
    "the tooltip says what opening it does",
  );
  assert.doesNotMatch(html, /pi-desktop:\/\/session\//, "the raw link is the message's, not the chip's");
});

test("the chip speaks the reader's language", () => {
  locale = "zh-CN";
  store.sessions = [{ id: "session-a", title: "Nightly review" }];
  const html = renderChip();
  assert.match(html, /会话引用 · Nightly review/);
  assert.match(html, /title="打开会话 Nightly review"/);
  assert.match(html, /aria-label="会话引用 · Nightly review"/);
});

test("a renamed conversation follows through to every message that references it", () => {
  locale = "zh-CN";
  store.sessions = [{ id: "session-a", title: "依赖清理顺序（改名后）" }];
  const renamed = renderChip();
  assert.match(renamed, /会话引用 · 依赖清理顺序（改名后）/);
  assert.match(renamed, /title="打开会话 依赖清理顺序（改名后）"/);
  assert.doesNotMatch(renamed, /Nightly review/, "the pasted name does not survive a rename");

  store.sessions = [{ id: "session-b", title: "另一段对话" }];
  assert.match(
    renderChip(),
    /会话引用 · session-/,
    "an unlisted conversation falls back to the id it points at",
  );
  assert.doesNotMatch(renderChip(), /另一段对话/, "another conversation's title is not borrowed");

  store.sessions = [{ id: "session-a", title: "  " }];
  assert.match(
    renderChip(),
    /会话引用 · session-/,
    "an empty title falls back to the id",
  );
  store.sessions = [];
});

test("a user message shows the reference as its body chip, not a second block", () => {
  locale = "en";
  store.sessions = [{ id: "session-a", title: "Nightly review" }];
  const html = renderRow(userMessage);
  assert.doesNotMatch(
    html,
    /class="message-attachments"/,
    "the reference needs no attachment row of its own",
  );
  assert.equal(
    html.match(/data-action="open-session-reference"/g)?.length,
    1,
    "the message carries the reference once",
  );
  assert.match(html, /data-session-id="session-a"/);
  assert.match(html, /Conversation · Nightly review/);
  assert.doesNotMatch(html, /pi-desktop:\/\/session\/session-a/, "the raw link is replaced by the chip");
});

test("an extra attachment chip continues the body text instead of heading it", () => {
  locale = "en";
  const withImage = {
    ...userMessage,
    content: "look at this",
    attachments: [{ kind: "image", name: "shot.png", ref: "attachments/abc" }],
  };
  const html = renderRow(withImage);
  const bodyAt = html.indexOf("message-user-text");
  assert.notEqual(bodyAt, -1, "the body text container is missing");
  assert.doesNotMatch(
    html.slice(0, bodyAt),
    /message-attachments/,
    "no attachment block above the body",
  );
  assert.match(
    html.slice(bodyAt),
    /class="message-attachments"/,
    "the chip lives inside the body text container",
  );
  assert.ok(
    html.indexOf("look at this") < html.indexOf("message-attachments"),
    "the body text comes before its attachment chip",
  );
});

test("a referenced conversation is not rendered as a file chip", () => {
  locale = "en";
  const withFile = {
    ...userMessage,
    attachments: [referenced, { kind: "file", name: "notes.md", ref: "/p/notes.md" }],
  };
  const html = renderRow(withFile);
  assert.match(html, /data-action="open-session-reference"/, "the reference is its body chip");
  assert.match(html, /aria-label="notes\.md — \/p\/notes\.md"/, "an ordinary file attachment is untouched");
  assert.equal(html.match(/chat-file-chip/g).length, 2, "the body chip and the file chip");
});

test("a referenced conversation never reaches the file-attachment resolver", async () => {
  const { promptAttachmentsFromMessage } = await import(
    "../src/stores/helpers/store-helpers.ts"
  );
  const prompt = promptAttachmentsFromMessage(userMessage.attachments);
  assert.deepEqual(prompt, [], "a session reference is not a prompt attachment");

  const mixed = promptAttachmentsFromMessage([
    { kind: "image", name: "shot.png", ref: "/p/shot.png", mimeType: "image/png" },
    referenced,
    { kind: "file", name: "notes.md", ref: "/p/notes.md", size: 12 },
  ]);
  assert.deepEqual(mixed, [
    { path: "/p/shot.png", name: "shot.png", kind: "image", mimeType: "image/png" },
    { path: "/p/notes.md", name: "notes.md", kind: "file", size: 12 },
  ]);
  assert.equal(isRenderableAttachment(referenced), false);
  assert.match(
    read("../src/stores/slices/transcript-slice.ts"),
    /\.filter\(isRenderableAttachment\)/,
    "the optimistic edit path uses the same narrowing as the prompt path",
  );
});

test("the session Copy submenu exposes the link to every reader", () => {
  const sidebar = read("../src/components/Sidebar.tsx");
  assert.match(
    sidebar,
    /id: "session-copy"[\s\S]*?id: "copy-conversation-id"[\s\S]*?id: "copy-session-link"/,
  );
  assert.match(sidebar, /navigator\.clipboard\.writeText\(formatSessionLink\(session\.id\)\)/);
  assert.doesNotMatch(sidebar, /pi-desktop:\/\/session\//, "the scheme stays in shared");

  const developerBlock = sidebar.slice(
    sidebar.indexOf("settings?.developerMode === true"),
    sidebar.indexOf('id: "session-danger"'),
  );
  assert.match(developerBlock, /id: "open-session-path"/);
  assert.doesNotMatch(developerBlock, /copy-conversation-id|copy-session-path/);
});
test("the reference keys exist in every shipped locale", () => {
  const locales = Object.keys(catalogs);
  assert.equal(locales.length, 9, "nine locales ship");
  for (const code of locales) {
    const catalog = catalogs[code];
    for (const [group, key] of [
      ["nav", "copySessionLink"],
      ["chat", "sessionReference"],
      ["chat", "sessionReferenceOpen"],
    ]) {
      const value = catalog[group]?.[key];
      assert.equal(typeof value, "string", `${code} is missing ${group}.${key}`);
      assert.ok(value.trim().length > 0, `${code} has an empty ${group}.${key}`);
    }
    assert.match(
      catalog.chat.sessionReferenceOpen,
      /\{\{title\}\}/,
      `${code} names the conversation it opens`,
    );
  }
  assert.equal(catalogs["zh-CN"].nav.copySessionLink, "复制会话链接");
  assert.equal(catalogs["zh-CN"].chat.sessionReference, "会话引用");
});

test("a session link in the message body renders as that chip", () => {
  // A bare link in prose segments as a session target and renders through the
  // same chip the structured attachment uses, named by the live conversation.
  const source = read("../src/features/chat/transcript/shared.tsx");
  assert.match(source, /export function SessionLinkChip\(/);
  assert.match(source, /\) : segment\.target\.kind === "session" \? \(/);
  assert.match(
    source,
    /<SessionLinkChip key=\{index\} sessionId=\{segment\.target\.sessionId\} \{\.\.\.position\} \/>/,
  );
  assert.match(source, /data-action="open-session-reference"/);
  assert.match(source, /session\.id === sessionId/);
});
