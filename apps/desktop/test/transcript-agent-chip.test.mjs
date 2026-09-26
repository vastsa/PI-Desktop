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
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

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
  // One node, on the same surface a file reference uses.
  assert.match(html, /class="composer-chip chat-agent-chip"/);
  assert.match(html, /composer-chip-icon/);
  assert.match(html, /composer-chip-name/);
  // The bot badge, so it reads as a delegate rather than a file.
  assert.match(html, /lucide-bot/);
  // The chip shows the bare handle — the badge already says what it is, so the
  // `@` sigil is not repeated inside it.
  // Slice just the chip element. React separates text with comment markers, so
  // match the label rather than a `>label<` adjacency.
  const start = html.indexOf("chat-agent-chip");
  const chip = html.slice(start, html.indexOf("</span></span></span>", start));
  assert.match(chip, /composer-chip-name[^>]*>[^<]*explorer/);
  assert.doesNotMatch(chip, /@/);
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
  // Both chips carry the bare handle, not the sigil.
  assert.doesNotMatch(html, /@explorer|@code-reviewer/);
  assert.match(html, /composer-chip-name[^>]*>[^<]*explorer/);
  assert.match(html, /composer-chip-name[^>]*>[^<]*code-reviewer/);
  // The user's own words are untouched.
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
  assert.match(html, /composer-chip-name[^>]*>[^<]*explorer/);
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

test("the sigil survives everywhere the chip is not", async () => {
  // The chip drops its own `@`, and nothing else may. A mention that fails
  // validation falls back to the raw text, which must still read as typed.
  const fallback = await renderMessage(
    userMessage({
      command: "@explorer look",
      agentMentions: [{ start: 900, end: 909, name: "explorer" }],
    }),
  );
  assert.doesNotMatch(fallback, /chat-agent-chip/);
  assert.match(fallback, /@explorer look/);
  // Prose that merely contains the token is ordinary text, chip or not.
  const prose = await renderMessage(
    userMessage({ command: "ask @explorer about it", content: "ask @explorer about it" }),
  );
  assert.doesNotMatch(prose, /chat-agent-chip/);
  assert.match(prose, /@explorer/);
});

test("the stored command keeps its @token regardless of how the chip renders", async () => {
  // The chip is a display concern. The recorded offsets index the typed form,
  // so a chip that omits the sigil must not shift them.
  const command = "@explorer 帮我查找";
  const html = await renderMessage(
    userMessage({
      command,
      agentMentions: [{ start: 0, end: 9, name: "explorer" }],
    }),
  );
  const start = Number(html.match(/data-source-start="(\d+)"/)?.[1]);
  const end = Number(html.match(/data-source-end="(\d+)"/)?.[1]);
  assert.equal(command.slice(start, end), "@explorer");
  // And the text after the chip is intact.
  assert.match(html, /帮我查找/);
});

test("a turn with no mentions keeps the whole-draft chip", async () => {
  // Template expansions have always shown as one chip; that must not change.
  const html = await renderMessage(
    userMessage({ command: "/ship deploy", content: "expanded" }),
  );
  assert.match(html, /chat-command-chip/);
  assert.doesNotMatch(html, /chat-agent-chip/);
});

test("only the transcript chip drops the sigil", async () => {
  // The composer chip and the @ menu row are the token the user is choosing or
  // has typed, so they keep the `@`. Scoping this to the transcript is the
  // whole point: a chip that stopped showing the sigil everywhere would make
  // the menu disagree with the draft.
  const editor = await read("../src/features/chat/composer/editor.ts");
  assert.match(editor, /name: `\@\$\{name\}`,/);
  const menu = await read("../src/components/ComposerAutocomplete.tsx");
  assert.match(menu, /@<Highlighted text=\{item\.agent\.name\}/);
  // The transcript chip is the one place that passes the bare handle.
  const row = await read("../src/features/chat/transcript/MessageRow.tsx");
  assert.match(row, /name=\{mention\.name\}/);
  assert.doesNotMatch(row, /name=\{`@\$\{mention\.name\}`\}/);
});
