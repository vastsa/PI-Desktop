import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { catalogs } from "@pi-desktop/i18n";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const SESSION = "sess_1";
const VIS_PATH = `/Users/me/.pi-desktop/visualizations/${SESSION}/chart.html`;
const MESSAGE = `Here is the chart.\n\n::visualize{"path":"${VIS_PATH}","title":"Growth"}`;

test("references are split out only once the message is no longer streaming", async (t) => {
  const ssr = await slotSsr(t);
  const { genUiSplitFor } = await ssr.load("/src/features/chat/gen-ui/gen-ui-split.ts");

  const streaming = genUiSplitFor(MESSAGE, true);
  // The trailing reference line is hidden while streaming, not parsed.
  assert.equal(streaming.content, "Here is the chart.");
  assert.deepEqual(streaming.references, []);

  const done = genUiSplitFor(MESSAGE, false);
  assert.equal(done.content, "Here is the chart.");
  assert.equal(done.references.length, 1);
  assert.equal(done.references[0].title, "Growth");
  assert.deepEqual(done.references[0].location, { sessionId: SESSION, fileName: "chart.html" });
});

test("the assistant bubble renders split content and cards; Markdown stays gen-ui free", async () => {
  const bubble = await read("../src/features/chat/transcript/AssistantTurnParts.tsx");
  // The feature is opt-in, so the bubble passes the setting into the split.
  assert.match(bubble, /s\.settings\?\.inlineVisualizations === true/);
  assert.match(bubble, /const genUi = useGenUiSplit\(displayContent, streaming, inlineVisualizations\);/);
  assert.match(bubble, /<Markdown source=\{genUi\.content\} streaming=\{streaming\} \/>/);
  assert.match(bubble, /<GenUiCards references=\{genUi\.references\} sessionId=\{sessionId\} remote=\{remote\} \/>/);
  assert.match(bubble, /const sessionId = useSlotSessionId\(\);/);
  const markdown = await read("../src/components/Markdown.tsx");
  assert.doesNotMatch(markdown, /gen-ui|genUi|GenUi/);
});

test("a switched-off feature strips reference lines without producing a card", async (t) => {
  const ssr = await slotSsr(t);
  const { genUiSplitFor } = await ssr.load("/src/features/chat/gen-ui/gen-ui-split.ts");

  const off = genUiSplitFor(MESSAGE, false, false);
  // No card is produced, so nothing is read from disk or framed.
  assert.deepEqual(off.references, []);
  // The absolute path must not leak into the transcript as text.
  assert.equal(off.content, "Here is the chart.");
  assert.doesNotMatch(off.content, /visualizations|chart\.html/);

  // Streaming behaves the same way in either state.
  assert.equal(genUiSplitFor(MESSAGE, true, false).content, "Here is the chart.");
});

test("the guest frame is sandboxed to scripts only with an opaque origin", async (t) => {
  const ssr = await slotSsr(t);
  const { GenUiFrame } = await ssr.load("/src/features/chat/gen-ui/GenUiFrame.tsx");
  const html = ssr.render(
    createElement(GenUiFrame, { url: `pi-genui://session/${SESSION}/chart.html`, title: "Visualization: Growth" }),
  );
  const sandbox = /<iframe[^>]* sandbox="([^"]*)"/.exec(html);
  assert.ok(sandbox, html);
  assert.equal(sandbox[1], "allow-scripts");
  assert.doesNotMatch(html, /allow-same-origin|allow-popups|allow-forms|allow-top-navigation/);
  assert.match(html, /src="pi-genui:\/\/session\/sess_1\/chart\.html"/);
  assert.match(html, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /height:240px/);
});

test("size reports are honored only from the card's own frame and are clamped", async (t) => {
  const ssr = await slotSsr(t);
  const { genUiHeightFromMessage, clampGenUiHeight } = await ssr.load(
    "/src/features/chat/gen-ui/gen-ui-frames.ts",
  );
  const own = {};
  const other = {};
  const report = (height, source = own, type = "pi-genui:size") => ({ source, data: { type, height } });

  assert.equal(genUiHeightFromMessage(report(480), own), 480);
  assert.equal(genUiHeightFromMessage(report(480, other), own), null);
  assert.equal(genUiHeightFromMessage(report(480), null), null);
  assert.equal(genUiHeightFromMessage(report(480, own, "pi-genui:theme"), own), null);
  assert.equal(genUiHeightFromMessage(report(Number.NaN), own), null);
  assert.equal(genUiHeightFromMessage(report("480"), own), null);
  assert.equal(genUiHeightFromMessage({ source: own, data: "pi-genui:size" }, own), null);
  assert.equal(genUiHeightFromMessage(report(10), own), 120);
  assert.equal(genUiHeightFromMessage(report(99999), own), 2000);
  assert.equal(clampGenUiHeight(300.2), 301);
});

test("wheel reports are honored only from the card's own frame and are bounded", async (t) => {
  const ssr = await slotSsr(t);
  const { genUiWheelFromMessage } = await ssr.load("/src/features/chat/gen-ui/gen-ui-frames.ts");
  const own = {};
  const wheel = (data, source = own) => ({ source, data: { type: "pi-genui:wheel", ...data } });

  assert.deepEqual(genUiWheelFromMessage(wheel({ deltaX: 0, deltaY: -120, deltaMode: 0 }), own), {
    deltaX: 0,
    deltaY: -120,
    deltaMode: 0,
  });
  assert.equal(genUiWheelFromMessage(wheel({ deltaX: 0, deltaY: -120, deltaMode: 0 }, {}), own), null);
  assert.equal(genUiWheelFromMessage(wheel({ deltaX: 0, deltaY: -120, deltaMode: 0 }), null), null);
  assert.equal(genUiWheelFromMessage(wheel({ deltaX: 0, deltaY: "x", deltaMode: 0 }), own), null);
  assert.equal(genUiWheelFromMessage(wheel({ deltaX: 0, deltaY: 1, deltaMode: 7 }), own), null);
  assert.deepEqual(genUiWheelFromMessage(wheel({ deltaX: 1e9, deltaY: -1e9, deltaMode: 0 }), own), {
    deltaX: 10000,
    deltaY: -10000,
    deltaMode: 0,
  });
});

test("guest wheel input reaches the transcript as a gesture on the frame element", async () => {
  // The guest is an out-of-process frame: its wheel events never reach the
  // transcript's gesture listeners, so a scroll that chains out of the card
  // looked programmatic and follow mode dragged the reader back down.
  const frame = await read("../src/features/chat/gen-ui/GenUiFrame.tsx");
  assert.match(frame, /const frameWindow = frameRef\.current\?\.contentWindow;/);
  assert.match(frame, /genUiWheelFromMessage\(event, frameWindow\)/);
  assert.match(frame, /new WheelEvent\("wheel", \{ \.\.\.wheel, bubbles: true \}\)/);
  const shell = await read("../electron/main/gen-ui-document.ts");
  assert.match(shell, /addEventListener\("wheel", \(event\) => \{/);
  assert.match(shell, /\{ passive: true \}/);
});

test("the expanded view tells its guest to center content", async () => {
  // A fragment laid out for the narrow inline card otherwise sits in the
  // top-left corner of the much larger dialog.
  const frame = await read("../src/features/chat/gen-ui/GenUiFrame.tsx");
  assert.match(frame, /type: GEN_UI_VIEW_MESSAGE, view: fill \? "expanded" : "inline"/);
  const shell = await read("../electron/main/gen-ui-document.ts");
  assert.match(shell, /root\.dataset\.piGenuiView = data\.view/);
  assert.match(
    shell,
    /html\[data-pi-genui-view="expanded"\] body \{[^}]*min-height: 100vh;[^}]*justify-content: safe center;[^}]*align-items: safe center;/,
  );
});

test("the live-frame pool evicts the oldest frame beyond its limit", async (t) => {
  const ssr = await slotSsr(t);
  const { createGenUiFramePool } = await ssr.load("/src/features/chat/gen-ui/gen-ui-frames.ts");
  const pool = createGenUiFramePool(2);
  const evicted = [];
  const [a, b, c] = [Symbol("a"), Symbol("b"), Symbol("c")];
  pool.acquire(a, () => evicted.push("a"));
  pool.acquire(b, () => evicted.push("b"));
  pool.acquire(c, () => evicted.push("c"));
  assert.deepEqual(evicted, ["a"]);
  assert.equal(pool.size, 2);
  pool.release(b);
  pool.acquire(a, () => evicted.push("a"));
  assert.deepEqual(evicted, ["a"]);
  assert.equal(pool.size, 2);
});

test("theme variables map from host design tokens and skip empty values", async (t) => {
  const ssr = await slotSsr(t);
  const { genUiThemeVars, GEN_UI_THEME_TOKENS } = await ssr.load(
    "/src/features/chat/gen-ui/gen-ui-theme.ts",
  );
  const tokens = { "--ds-text-primary": " #fff ", "--ds-bg-primary": "#181818", "--font-mono": "" };
  const vars = genUiThemeVars((name) => tokens[name] ?? "");
  assert.deepEqual(vars, {
    "--color-text-primary": "#fff",
    "--color-background-primary": "#181818",
    "--color-text-inverse": "#181818",
  });

  // Every posted guest variable is one the bundled visualize stylesheet reads.
  const kitSheet = await read("../resources/gen-ui/visualize.css");
  for (const guestName of Object.keys(GEN_UI_THEME_TOKENS)) {
    assert.match(kitSheet, new RegExp(`var\\(\\s*${guestName}[,)\\s]`), guestName);
  }

  const tokenSheet = await read("../src/styles/tokens.css");
  for (const hostToken of Object.values(GEN_UI_THEME_TOKENS)) {
    assert.match(tokenSheet, new RegExp(`${hostToken}:`), hostToken);
  }
});

test("a reference outside the visualization directory renders an unavailable card", async (t) => {
  const ssr = await slotSsr(t);
  const { GenUiCard } = await ssr.load("/src/features/chat/gen-ui/GenUiCard.tsx");
  const html = ssr.render(
    createElement(GenUiCard, {
      reference: { path: "/tmp/evil.html", title: undefined, location: null },
      sessionId: SESSION,
      remote: false,
    }),
  );
  assert.match(html, /gen-ui-card is-unavailable/);
  assert.match(html, /Visualization unavailable: evil\.html/);
  assert.match(html, new RegExp(catalogs.en.chat.genUi.unavailableOutside.replace("'", "&#x27;")));
  assert.doesNotMatch(html, /<iframe/);
});

test("a live card starts as a placeholder with a localized expand control", async (t) => {
  const ssr = await slotSsr(t);
  const { GenUiCard } = await ssr.load("/src/features/chat/gen-ui/GenUiCard.tsx");
  const html = ssr.render(
    createElement(GenUiCard, {
      reference: { path: VIS_PATH, title: "Growth", location: { sessionId: SESSION, fileName: "chart.html" } },
      sessionId: SESSION,
      remote: false,
    }),
  );
  assert.match(html, /data-gen-ui-url="pi-genui:\/\/session\/sess_1\/chart\.html"/);
  assert.match(html, />Growth</);
  assert.match(html, /aria-label="Expand visualization"/);
  // Frames mount only after the card nears the viewport (an effect).
  assert.doesNotMatch(html, /<iframe/);
});

test("every locale defines the gen-ui strings", () => {
  const keys = ["expand", "close", "unavailable", "unavailableOutside", "loadPrompt", "frameTitle"];
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const key of keys) {
      const value = catalog.chat?.genUi?.[key];
      assert.equal(typeof value, "string", `${locale} chat.genUi.${key}`);
      assert.ok(value.trim(), `${locale} chat.genUi.${key}`);
    }
    for (const key of ["unavailable", "frameTitle"]) {
      assert.match(catalog.chat.genUi[key], /\{\{title\}\}/, `${locale} ${key}`);
    }
  }
  assert.equal(Object.keys(catalogs).length, 9);
});

test("expanded frames share the quota without evicting their inline state", async (t) => {
  const ssr = await slotSsr(t);
  const { createGenUiFramePool } = await ssr.load("/src/features/chat/gen-ui/gen-ui-frames.ts");
  const pool = createGenUiFramePool(3);
  const [source, other, dialog, incoming] = [Symbol("source"), Symbol("other"), Symbol("dialog"), Symbol("incoming")];
  const evicted = [];
  pool.acquire(source, () => evicted.push("source"));
  pool.acquire(other, () => evicted.push("other"));
  pool.acquireExpanded(dialog, source, () => evicted.push("dialog"));
  pool.acquire(incoming, () => evicted.push("incoming"));
  assert.equal(pool.size, 3);
  assert.deepEqual(evicted, ["other"]);
  pool.release(dialog);
  pool.acquire(other, () => evicted.push("other"));
  const next = Symbol("next");
  pool.acquire(next, () => evicted.push("next"));
  assert.equal(pool.size, 3);
  assert.deepEqual(evicted, ["other", "source"], "closing releases the inline protection");
  for (const id of [source, other, incoming, next]) pool.release(id);
  assert.equal(pool.size, 0);
});
