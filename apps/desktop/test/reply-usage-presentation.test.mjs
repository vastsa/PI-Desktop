import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { en } = await import("../../../packages/i18n/src/locales/en/index.ts");
const contextUsage = await import("../src/lib/context-usage.ts");
const messageTiming = await import("../src/lib/message-timing.ts");

const t = (key, values) =>
  String(en.chat[key.replace(/^chat\./, "")] ?? `«${key}»`).replace(
    /\{\{(\w+)\}\}/g,
    (_, name) => String(values?.[name] ?? ""),
  );
const Icon = (props) => React.createElement("svg", props);

function loadComponent(name, extras = {}) {
  const file = new URL(`../src/features/chat/transcript/${name}.tsx`, import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    fileName: file.pathname,
  });
  const imports = {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "react-dom": { createPortal: (node) => node },
    "react-i18next": { useTranslation: () => ({ t }) },
    "../../../components/icons": new Proxy({}, { get: () => Icon }),
    "../../../components/Markdown": {
      useCopy: () => ({ copied: false, copy: () => {} }),
    },
    "../../../lib/context-usage": contextUsage,
    "../../../lib/message-timing": messageTiming,
    "../../../lib/context-inspector-position": {
      placeContextInspector: () => ({ top: 0, left: 0, maxWidth: 320 }),
    },
    "@pi-desktop/shared": { formatTokenCount: (value) => String(value) },
    ...extras,
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unmocked readout dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

const { ReplyUsage } = loadComponent("ReplyUsage");

const usage = {
  inputTokens: 26_790,
  outputTokens: 38_508,
  cacheReadTokens: 7_590_784,
  reasoningTokens: 0,
  totalTokens: 7_655_582,
};

const props = {
  modelId: "deepseek-official/deepseek-v4-flash",
  usage,
  responseDurationMs: 685_000,
  responseOutputTokens: 38_508,
  firstTokenMs: 1_200,
  completedAt: "2026-09-15T10:43:00.000Z",
  totalMs: 685_000,
};

const render = (overrides) =>
  renderToStaticMarkup(React.createElement(ReplyUsage, { ...props, ...overrides }));

/**
 * The card exists only while it is open and a server render cannot click, so
 * this loads a second copy with its first `useState(false)` forced true.
 * `createPortal` also needs the `document` a browser would provide.
 */
const renderCard = (overrides) => {
  globalThis.document = { body: {} };
  const { ReplyUsage: OpenReplyUsage } = loadComponent("ReplyUsage", {
    react: {
      ...React,
      useState: (initial) => React.useState(initial === false ? true : initial),
    },
  });
  return renderToStaticMarkup(
    React.createElement(OpenReplyUsage, { ...props, ...overrides }),
  );
};

/** The text of each open card, in the order the segments render them. */
const cardTexts = (html) => {
  const starts = [...html.matchAll(/class="reply-usage-card"/g)].map(
    (match) => match.index,
  );
  return starts.map((start, index) =>
    text(html.slice(start, starts[index + 1] ?? html.length)),
  );
};

const text = (html) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

test("the compact readout carries usage, elapsed, and the time", () => {
  const html = render({});
  const line = text(html);
  assert.match(line, /Usage 7656082 tok/);
  // The first-token wait moved into the card, so the line is only the duration.
  assert.match(line, /Elapsed 11m 25s/);
  assert.doesNotMatch(line, /first token/i);
  // The clock keeps the locale's hour cycle, so a 12-hour build ends the line
  // with "07:00:05 AM" and a zh-CN build with "上午07:00:05": drop the trailing
  // day period before checking the shape. Minutes and seconds never wrap with
  // the hour cycle, so they still pin the clock to the completed instant.
  const clock = line.replace(/\s*[^\d\s:]+$/, "").trimEnd();
  assert.match(clock, /\d{2}:\d{2}:\d{2}$/);
  const completedAt = new Date(Date.parse(props.completedAt));
  const twoDigits = (value) => String(value).padStart(2, "0");
  assert.ok(
    clock.endsWith(
      `${twoDigits(completedAt.getMinutes())}:${twoDigits(completedAt.getSeconds())}`,
    ),
    clock,
  );
  assert.equal(html.match(/class="reply-usage-segment"/g)?.length, 3);
  // No `«key»` placeholder leaked, so every label used here is in the catalog.
  assert.doesNotMatch(line, /«/);
});

test("the usage and the elapsed segments open the card, the clock does not", () => {
  const html = render({});
  const triggers = [
    ...html.matchAll(
      /<button[^>]*class="reply-usage-trigger"[^>]*>(.*?)<\/button>/gs,
    ),
  ].map((match) => match[1]);
  assert.equal(triggers.length, 2, "usage and elapsed are both dialog triggers");
  assert.match(triggers[0], /Usage 7656082 tok/);
  assert.match(triggers[1], /Elapsed 11m 25s/);
  // The completion clock stays plain text.
  const clock = html.slice(html.lastIndexOf("reply-usage-segment"));
  assert.doesNotMatch(clock, /<button/);
});

test("a turn without usage or timings renders nothing", () => {
  assert.equal(
    render({
      modelId: undefined,
      usage: undefined,
      responseDurationMs: undefined,
      responseOutputTokens: undefined,
      firstTokenMs: undefined,
      completedAt: undefined,
      totalMs: undefined,
    }),
    "",
  );
});

test("an hours-long turn keeps hours, minutes and seconds in the elapsed form", () => {
  assert.match(text(render({ totalMs: 3_725_000 })), /Elapsed 1h 2m 5s/);
});

test("a stopped reply without provider usage falls back to its estimated count", () => {
  const overrides = {
    usage: undefined,
    responseDurationMs: 2_000,
    responseOutputTokens: 40,
  };
  const html = render(overrides);
  const line = text(html);
  // The runtime's estimate is the only count such a turn has, so it carries
  // the usage segment — and with it the rate row, which had no other way in.
  assert.match(line, /Usage 40 tok/);
  assert.match(line, /Elapsed 11m 25s/);
  assert.equal(html.match(/class="reply-usage-trigger"/g)?.length, 2);

  const [usageCard] = cardTexts(renderCard(overrides));
  assert.match(usageCard, /This turn's usage/);
  assert.match(usageCard, /40 tok/);
  assert.match(usageCard, /Generation speed ≈ 20 tokens\/s/);
});

test("the turn total counts the cache it wrote, beside the cache it read", () => {
  // input 100, output 50, cache read 40, cache write 10 — the four fields the
  // composer's session row adds up, so both surfaces read 200 for this turn.
  const usage = {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 40,
    cacheWriteTokens: 10,
    totalTokens: 200,
  };
  const html = render({
    usage,
    modelId: undefined,
    responseOutputTokens: undefined,
    responseDurationMs: undefined,
    totalMs: undefined,
    completedAt: undefined,
  });
  assert.match(text(html), /Usage 200 tok/);

  const [usageCard] = cardTexts(renderCard({ usage }));
  assert.match(usageCard, /200 tok/, "the rows add up to the heading");
  assert.match(usageCard, /Uncached input 100/);
  assert.match(usageCard, /Cache read 40/);
  assert.match(usageCard, /Cache write 10/);
  assert.match(usageCard, /Output 50/);
  // No `«key»` placeholder leaked, so `chat.usageCacheWrite` is in the catalog.
  assert.doesNotMatch(usageCard, /«/);
});

test("an estimated turn divides its summarized count, not a partial one", () => {
  // A stopped stream reported 30 output tokens before the runtime summarized
  // the visible output at 240: the partial count would report a rate four
  // times too low.
  const partialUsage = {
    inputTokens: 10,
    outputTokens: 30,
    totalTokens: 40,
  };
  const [estimatedCard] = cardTexts(
    renderCard({
      usage: partialUsage,
      responseOutputEstimated: true,
      responseOutputTokens: 240,
      responseDurationMs: 8_000,
      modelId: undefined,
    }),
  );
  assert.match(estimatedCard, /Generation speed ≈ 30 tokens\/s/);

  // A reported turn still trusts the provider's own count over the summary.
  const [reportedCard] = cardTexts(
    renderCard({
      usage: partialUsage,
      responseOutputEstimated: false,
      responseOutputTokens: 240,
      responseDurationMs: 8_000,
      modelId: undefined,
    }),
  );
  assert.match(reportedCard, /Generation speed 4 tokens\/s/);
  assert.doesNotMatch(reportedCard, /≈/);
});

test("a reported zero output still shows the runtime's estimated speed", () => {
  // The provider reported no output for a stream the runtime summarized at 40
  // tokens, so two seconds of generation is ≈ 20 tokens/s. Dropping the summary
  // would leave the card without a rate row.
  const [card] = cardTexts(
    renderCard({
      usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100 },
      responseOutputEstimated: true,
      responseOutputTokens: 40,
      responseDurationMs: 2_000,
      modelId: undefined,
    }),
  );
  assert.match(card, /Generation speed ≈ 20 tokens\/s/);
});

test("the card opens on click only, and its numbers can be copied", () => {
  const source = readFileSync(
    new URL("../src/features/chat/transcript/ReplyUsage.tsx", import.meta.url),
    "utf8",
  );
  // Hovering must not open it: the pointer has to be free to select the text.
  assert.doesNotMatch(source, /onMouseEnter/);
  assert.doesNotMatch(source, /onMouseLeave/);
  assert.doesNotMatch(source, /onFocus=\{/);
  // One popover component, rendered once per segment: a click toggles its own
  // card, and each card owns its rows.
  assert.equal(source.match(/<ReadoutPopover\b/g)?.length, 2);
  assert.match(source, /onClick=\{\(\) => setOpen\(\(value\) => !value\)\}/);
  assert.match(source, /className=\{`copy-btn icon reply-usage-copy/);
  // An explicit copy affordance beside the total, plus the selectable card.
  assert.match(source, /useCopy/);
  assert.match(source, /copy\(\s*\[/);
  const styles = readFileSync(
    new URL("../src/styles/messages.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /\.reply-usage-card \{[\s\S]*?user-select: text;/,
    "the portaled card opts back into text selection",
  );
});

test("each segment opens its own card, and the two do not share rows", () => {
  const html = renderCard();
  const starts = [...html.matchAll(/class="reply-usage-card"/g)].map(
    (match) => match.index,
  );
  assert.equal(starts.length, 2, "usage and elapsed each render a card");
  const usageCard = text(html.slice(starts[0], starts[1]));
  const timingCard = text(html.slice(starts[1]));

  // The usage card: the totals for this turn, with the unit only in the heading.
  assert.match(usageCard, /This turn's usage/);
  assert.match(usageCard, /7656082 tok/);
  assert.match(usageCard, /Provider \/ model deepseek-official\/deepseek-v4-flash/);
  assert.match(usageCard, /Uncached input 26790/);
  assert.match(usageCard, /Cache read 7590784/);
  assert.match(usageCard, /Output 38508/);
  assert.doesNotMatch(
    usageCard,
    /(Uncached input|Cache read|Output) [\d.]+k? ?tok/,
  );
  assert.doesNotMatch(usageCard, /First token/);

  // The elapsed card: only what the duration segment promised.
  assert.match(timingCard, /This turn's timing/);
  assert.match(timingCard, /Elapsed 11m 25s/);
  assert.match(timingCard, /First token 1\.2s/);
  assert.doesNotMatch(timingCard, /Uncached input/);
});
