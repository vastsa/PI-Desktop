/**
 * A delegate named in a sent message renders as one node, the way a file
 * reference does (ADR 0308).
 *
 * The offsets are recorded when the turn is sent rather than re-resolved on
 * render, so this asserts the stored shape is what the transcript consumes: a
 * mention whose range does not line up with the text must fall back to the
 * whole draft rather than drop or duplicate a run of characters.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import test from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

let server;
let MessageRow;

async function load() {
  server ??= await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  MessageRow ??= (await server.ssrLoadModule("/src/features/chat/transcript/MessageRow.tsx"))
    .MessageRow;
  return MessageRow;
}

test.after(async () => {
  await server?.close();
});

/** Render one user message whose typed form carries the given mentions. */
async function renderMessage(message) {
  const Row = await load();
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Row, { message }),
    ),
  );
}

const userMessage = (over) => ({
  id: "m1",
  role: "user",
  content: "rewritten text the model saw",
  createdAt: "2026-09-26T00:00:00.000Z",
  status: "complete",
  ...over,
});

test("a named delegate renders as one chip, with the user's words beside it", async () => {
  const command = "@explorer 帮我查找一下是否存在沙箱";
  const html = await renderMessage(
    userMessage({
      command,
      content: "Call the `Task` tool…\n\n帮我查找一下是否存在沙箱",
      agentMentions: [{ start: 0, end: 9, name: "explorer" }],
    }),
  );
  // The chip carries the exact token the user typed, not a re-derived one.
  assert.match(html, /@explorer/);
  // One node, on the same surface a file reference uses.
  assert.match(html, /class="composer-chip chat-agent-chip"/);
  assert.match(html, /composer-chip-icon/);
  assert.match(html, /composer-chip-name/);
  // The bot badge, so it reads as a delegate rather than a file.
  assert.match(html, /lucide-bot/);
  // And the rest of the sentence is still text, not swallowed by the chip.
  assert.match(html, /帮我查找一下是否存在沙箱/);
  // A delegate is not a file: it must not masquerade as the openable chip.
  assert.doesNotMatch(html, /chat-file-chip/);
});

test("a delegate chip is not a button, because there is nothing to open", async () => {
  const html = await renderMessage(
    userMessage({
      command: "@explorer look",
      agentMentions: [{ start: 0, end: 9, name: "explorer" }],
    }),
  );
  // The element carrying the chip must not be an <a> or <button>.
  const chip = html.slice(html.indexOf("chat-agent-chip") - 200, html.indexOf("chat-agent-chip"));
  assert.ok(!/<button|<a\s/.test(chip.split("chat-agent-chip").pop()?.slice(0, 40) ?? ""));
});

test("several delegates each get their own chip", async () => {
  const html = await renderMessage(
    userMessage({
      command: "@explorer and @code-reviewer compare",
      agentMentions: [
        { start: 0, end: 9, name: "explorer" },
        { start: 14, end: 28, name: "code-reviewer" },
      ],
    }),
  );
  assert.equal((html.match(/chat-agent-chip/g) ?? []).length, 2);
  assert.match(html, /@explorer/);
  assert.match(html, /@code-reviewer/);
  assert.match(html, /compare/);
});

test("a skill mention and a delegate mention coexist in one turn", async () => {
  const html = await renderMessage(
    userMessage({
      command: "/review-pr @explorer fix it",
      skillMentions: [{ start: 0, end: 10, id: "review-pr" }],
      agentMentions: [{ start: 11, end: 20, name: "explorer" }],
    }),
  );
  // The Skill chip keeps its own shape, the delegate gets its own, and the
  // user's words survive between them.
  assert.match(html, /chat-command-chip/);
  assert.match(html, /chat-agent-chip/);
  assert.match(html, /@explorer/);
  assert.match(html, /fix it/);
});

test("a mention that does not line up falls back to the whole draft", async () => {
  // A stored range pointing outside the text must not silently swallow
  // characters; the whole typed form renders instead.
  const html = await renderMessage(
    userMessage({
      command: "@explorer look",
      agentMentions: [{ start: 400, end: 409, name: "explorer" }],
    }),
  );
  assert.doesNotMatch(html, /chat-agent-chip/);
  assert.match(html, /@explorer look/);
});

test("a mention that does not start with @ is not a delegate", async () => {
  const html = await renderMessage(
    userMessage({
      command: "explorer look",
      agentMentions: [{ start: 0, end: 8, name: "explorer" }],
    }),
  );
  assert.doesNotMatch(html, /chat-agent-chip/);
  assert.match(html, /explorer look/);
});

test("a turn with no mentions keeps the whole-draft chip", async () => {
  // Template expansions have always shown as one chip; that must not change.
  const html = await renderMessage(
    userMessage({ command: "/ship deploy", content: "expanded" }),
  );
  assert.match(html, /chat-command-chip/);
  assert.doesNotMatch(html, /chat-agent-chip/);
});
