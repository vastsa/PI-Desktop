/*
 * Pinned latest prompt.
 *
 * The newest prompt leaves the top of the transcript as soon as its answer gets
 * long, so the transcript repeats one line of it in a strip above the rows while
 * the row itself is out of view. These tests pin the three pieces that make that
 * work: which message pins, what the strip says, and when it is allowed to show.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

import {
  isPinnedPromptScrolledPast,
  latestUserPrompt,
  pinnedPromptPreview,
  pinnedPromptSelector,
} from "../src/lib/pinned-prompt.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const LOCALES = ["en", "de", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"];

function message(overrides) {
  return {
    id: "m1",
    role: "user",
    content: "hello",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("the strip pins the newest prompt, not the newest row", () => {
  const messages = [
    message({ id: "u1", content: "first" }),
    message({ id: "a1", role: "assistant", content: "answer" }),
    message({ id: "u2", content: "second" }),
    message({ id: "a2", role: "assistant", content: "answer two", status: "streaming" }),
  ];
  assert.equal(latestUserPrompt(messages)?.id, "u2");
  assert.equal(latestUserPrompt([]), undefined);
  assert.equal(latestUserPrompt([message({ id: "a1", role: "assistant" })]), undefined);
});

test("an agent delivery is not the user speaking", () => {
  const messages = [
    message({ id: "u1", content: "mine" }),
    message({
      id: "relay",
      content: "Message from 🤖 helper: done",
      sessionMessage: { kind: "agent", sessionId: "s-other", title: "helper" },
    }),
  ];
  assert.equal(latestUserPrompt(messages)?.id, "u1", "pinning a relay would misquote the user");
});

test("the preview is one collapsed line, cut on a word boundary", () => {
  assert.equal(
    pinnedPromptPreview(message({ content: "  fix\n\n  the   parser\tplease " })),
    "fix the parser please",
  );
  const long = "word ".repeat(80).trim();
  const preview = pinnedPromptPreview(message({ content: long }), 40);
  assert.ok(preview.length <= 41, `preview stays bounded: ${preview.length}`);
  assert.ok(preview.endsWith("…"));
  assert.ok(!preview.includes("  "), "the preview never keeps the source's spacing");
  assert.equal(pinnedPromptPreview(undefined), "");
});

test("the row's own edge decides when the strip takes over", () => {
  assert.equal(isPinnedPromptScrolledPast(100, 100), true, "touching the top counts as gone");
  assert.equal(isPinnedPromptScrolledPast(101, 100), false);
  assert.equal(isPinnedPromptScrolledPast(99, 100), true);
});

test("the row selector survives quotes and backslashes in an id", () => {
  assert.equal(pinnedPromptSelector("a\"b\\c"), '[data-message-id="a\\"b\\\\c"]');
});

test("the strip renders one line, and nothing at all until the row is gone", async () => {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { PinnedPrompt } = await server.ssrLoadModule("/src/features/chat/transcript/PinnedPrompt.tsx");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = (props) =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(PinnedPrompt, { attachmentCount: 0, onJump: () => {}, ...props }),
        ),
      );

    assert.equal(render({ text: "why is the parser slow", visible: false }), "");

    const shown = render({ text: "why is the parser slow", visible: true });
    assert.match(shown, /data-pinned-prompt="true"/);
    assert.match(shown, /why is the parser slow/);
    assert.match(shown, /aria-label="Back to your latest message"/);

    // A prompt that was only an attachment still names itself instead of
    // rendering an empty pill.
    const attachments = render({ text: "", attachmentCount: 2, visible: true });
    assert.match(attachments, /2 attachment\(s\)/);
  } finally {
    await server.close();
  }
});

test("the transcript owns the pin, yields the top edge to find, and rides the row", async () => {
  const transcript = await readFile(
    new URL("../src/features/chat/transcript/ChatTranscript.tsx", import.meta.url),
    "utf8",
  );
  assert.match(transcript, /const pinnedMessage = useMemo\(\(\) => latestUserPrompt\(messages\)/);
  assert.match(transcript, /messageId: pinnedMessage\?\.id/);
  assert.match(transcript, /enabled: !find\.open && paneVisible/);
  assert.match(transcript, /<PinnedPrompt[\s\S]{0,200}visible=\{pinnedPast\}/);
  // Jumping back is a scroll to the row itself, not a jump to the bottom.
  assert.match(transcript, /pinnedPromptSelector\(messageId\)/);
  assert.match(transcript, /scroller\.scrollTop = Math\.max\(0, offset - 12\)/);

  const styles = await readFile(new URL("../src/styles/chat-shell.css", import.meta.url), "utf8");
  assert.match(styles, /\.transcript-pinned-prompt \{[\s\S]{0,300}position: absolute/);
  assert.match(styles, /\.transcript-pinned-prompt-text \{[\s\S]{0,200}text-overflow: ellipsis/);
});

test("every locale names the jump target and the attachment-only case", async () => {
  for (const locale of LOCALES) {
    const catalog = await readFile(
      new URL(`../../../packages/i18n/src/locales/${locale}/index.ts`, import.meta.url),
      "utf8",
    );
    assert.match(catalog, /"?pinnedPromptJump"?:/, `${locale} names the jump`);
    assert.match(catalog, /"?pinnedPromptAttachments"?:/, `${locale} names the attachment case`);
  }
});
