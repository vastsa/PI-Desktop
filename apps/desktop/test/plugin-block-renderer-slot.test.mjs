import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { probed, propsProbe, slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * The keyed `blockRenderer` slot (`docs/plugin-plan/ui/block-renderer/`)
 * rendered with the production modules: a closed fence whose language a
 * plugin registered becomes that plugin's block, handed the fence's tag and
 * text; every other fence keeps the host block. Server rendering is the
 * first frame of a mount: a renderer that throws or draws past the 4000px
 * clamp handing the fence back to the host block is covered by the Electron
 * E2E.
 */

const FENCE = "```Demo.Lab:Chart\na,b\n1,2\n```";
const SOURCE = `Intro.\n\n${FENCE}\n\nAfter.`;
const START = SOURCE.indexOf(FENCE);
const END = START + FENCE.length;

async function blocks(t) {
  const ssr = await slotSsr(t);
  const { Markdown } = await ssr.load("/src/components/Markdown.tsx");
  const helpers = await ssr.load("/src/lib/block-renderer.ts");
  return {
    ...ssr,
    ...helpers,
    markdown: (source = SOURCE) => ssr.render(createElement(Markdown, { source })),
    claim: (language = "demo.lab:chart") =>
      ssr.register("demo.lab", { slot: "blockRenderer", language, component: propsProbe("block") }),
  };
}

/** The host code block in `html`, up to the paragraph after it. */
function hostBlock(html) {
  const start = html.indexOf('<div class="code-block"');
  assert.ok(start >= 0, "the fence renders as the host code block");
  return html.slice(start, html.indexOf("<p ", start));
}

test("a closed fence in a claimed language becomes the plugin's block", async (t) => {
  const ssr = await blocks(t);
  const plain = ssr.markdown();
  const host = hostBlock(plain);
  assert.ok(
    host.startsWith(`<div class="code-block" data-source-start="${START}" data-source-end="${END}">`),
    "the host block is anchored on the fence's span of the message",
  );

  const dispose = ssr.claim();
  const html = ssr.markdown();
  const [before, after] = plain.split(host);
  assert.ok(html.startsWith(before) && html.endsWith(after), "the text around the fence is untouched");
  assert.match(
    html.slice(before.length, html.length - after.length),
    new RegExp(
      `^<div class="pi-plugin-block-renderer" style="max-height:4000px" data-source-start="${START}" data-source-end="${END}">` +
        '<div class="pi-plugin-slot" data-pi-plugin="demo.lab" data-pi-slot="blockRenderer">' +
        '<output data-probe="block">[^<]*</output></div></div>$',
    ),
    "the host clamp keeps the fence's anchor for search and holds the plugin's mount",
  );
  assert.deepEqual(
    probed(html, "block"),
    [{ language: "Demo.Lab:Chart", source: "a,b\n1,2" }],
    "the tag as written, the text without the closing newline",
  );

  dispose();
  assert.equal(ssr.markdown(), plain, "the host block is back once the renderer leaves");
});

test("open fences, host languages and unclaimed tags keep the host block", async (t) => {
  const ssr = await blocks(t);
  const cases = [
    ["a fence still streaming", "```Demo.Lab:Chart\na,b\n1,2\n"],
    ["a host language", "```json\n{}\n```"],
    ["a diagram", "```mermaid\ngraph TD\nA-->B\n```"],
    ["a tag the plugin did not register", "```demo.lab:table\na\n```"],
    ["the same tag under another plugin", "```demo.other:chart\na\n```"],
  ];
  const plain = cases.map(([, source]) => ssr.markdown(source));
  ssr.claim();
  cases.forEach(([label, source], index) => {
    assert.equal(ssr.markdown(source), plain[index], label);
  });
});

test("only a prefixed tag is looked up, and only past 4000px is a block too tall", async (t) => {
  const { BLOCK_RENDERER_MAX_HEIGHT_PX, blockRendererCandidate, blockRendererOverflow } = await blocks(t);
  const candidates = ["json", "mermaid", "", "demo:chart", " Demo.Lab:Chart "].map(blockRendererCandidate);
  assert.deepEqual(candidates, [undefined, undefined, undefined, "demo:chart", "demo.lab:chart"]);

  assert.equal(BLOCK_RENDERER_MAX_HEIGHT_PX, 4000);
  assert.deepEqual([3_999, 4_000, 4_001].map(blockRendererOverflow), [false, false, true]);
});

/*
 * User messages are plain text, not Markdown: only a fence tagged in the
 * `<pluginId>:lang` shape whose language a plugin claimed leaves the text,
 * drawn by that plugin; anything else renders exactly as before.
 */
test("user text: only closed `<pluginId>:lang` fences are split out, line breaks included", async (t) => {
  const { splitPluginFences } = await blocks(t);
  assert.deepEqual(splitPluginFences("plain"), [{ kind: "text", text: "plain", start: 0 }]);
  assert.deepEqual(splitPluginFences(""), [{ kind: "text", text: "", start: 0 }]);
  for (const text of ["```json\n{}\n```", "```Demo.Lab:Chart\nopen", "x ```demo.lab:chart\na\n```", "```demo.lab:chart\na\n````"]) {
    assert.deepEqual(splitPluginFences(text), [{ kind: "text", text, start: 0 }], text);
  }
  const text = `Before\n${FENCE}\nAfter`;
  assert.deepEqual(splitPluginFences(text), [
    { kind: "text", text: "Before", start: 0 },
    { kind: "fence", raw: `\n${FENCE}\n`, language: "Demo.Lab:Chart", source: "a,b\n1,2", start: 6 },
    { kind: "text", text: "After", start: 6 + FENCE.length + 2 },
  ]);
  const long = "````demo.lab:chart\n```\ninner\n```\n````";
  assert.deepEqual(splitPluginFences(long).map((run) => run.kind === "fence" ? run.source : run.text),
    ["```\ninner\n```"], "a longer fence holds shorter ones");
});

test("user text: a claimed fence becomes the plugin's block; unclaimed, it stays text", async (t) => {
  const ssr = await blocks(t);
  const { UserMessageText } = await ssr.load("/src/features/chat/transcript/UserMessageText.tsx");
  const { LinkifiedText } = await ssr.load("/src/features/chat/transcript/shared.tsx");
  const text = `Before\n${FENCE}\nAfter`;
  const user = () => ssr.render(createElement(UserMessageText, { text, sourceOffset: 4 }));
  const asText = ssr.render(createElement(LinkifiedText, { text, sourceOffset: 4 }));
  const unclaimed = user();
  const textOf = (markup) => markup.replace(/<[^>]+>/g, "");
  assert.equal(textOf(unclaimed), textOf(asText), "without a renderer the fence is the same text as before");
  assert.deepEqual([...unclaimed.matchAll(/data-source-start="(\d+)" data-source-end="(\d+)"/g)].map((m) => [+m[1], +m[2]]),
    [[4, 10], [10, 4 + 6 + FENCE.length + 2], [4 + 6 + FENCE.length + 2, 4 + text.length]],
    "its runs cover the message without gaps");
  assert.match(unclaimed, /```Demo\.Lab:Chart/);

  const dispose = ssr.claim();
  const html = user();
  const end = 4 + 6 + FENCE.length + 2;
  assert.equal(html,
    `<span data-source-start="4" data-source-end="10">Before</span>` +
    `<div class="pi-plugin-block-renderer" style="max-height:4000px" data-source-start="10" data-source-end="${end}">` +
    `<div class="pi-plugin-slot" data-pi-plugin="demo.lab" data-pi-slot="blockRenderer">` +
    html.match(/<output data-probe="block">[^<]*<\/output>/)[0] + "</div></div>" +
    `<span data-source-start="${end}" data-source-end="${end + 5}">After</span>`);
  assert.deepEqual(probed(html, "block"), [{ language: "Demo.Lab:Chart", source: "a,b\n1,2" }]);
  dispose();
  assert.equal(user(), unclaimed, "the text is back once the renderer leaves");
});
