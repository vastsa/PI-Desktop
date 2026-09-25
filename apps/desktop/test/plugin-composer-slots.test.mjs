import assert from "node:assert/strict";
import test from "node:test";
import { composerToolbar } from "./helpers/composer-toolbar.mjs";
import { parseProbe, probed, propsProbe, slotMounts, slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * The composer's `composerControl` slot (`docs/plugin-plan/ui/composer/`)
 * rendered with the production toolbar. The host controls keep their places
 * and their order: a plugin's controls sit after the host's left row and
 * before the host's right row, in registration order, fed only the side they
 * sit on. Server rendering is the first frame: a control that throws
 * disappearing alone is covered by the Electron E2E, and the draft actions a
 * control dispatches by the dispatch channel's tests.
 */

/** The toolbar's own controls below, by label. */
const HOST_LEFT = ["chat.addFiles", "settings.mode", "chat.permissionMode"];
const HOST_RIGHT = ["context", "chat.model: Model. chat.reasoningLevel: Off", "chat.enhancePrompt", "chat.send"];

async function composer(t) {
  const ssr = await slotSsr(t);
  return { ...ssr, toolbar: await composerToolbar(t, ssr) };
}

/**
 * What each toolbar side shows, in order: a host control by its label, a
 * plugin control as `probe:position`.
 */
function sidesOf(html) {
  const right = html.indexOf('<div class="composer-right">');
  assert.ok(right >= 0, "the toolbar has a right side");
  const side = (part) => {
    const shown = [];
    const token = /<output data-probe="([^"]*)">([^<]*)<\/output>|<button\b([^>]*)>/g;
    for (const [, probe, props, button] of part.matchAll(token)) {
      if (probe) shown.push(`${probe}:${parseProbe(props).position}`);
      // The context meter is labeled with its live numbers.
      else if (button.includes("context-inspector-trigger")) shown.push("context");
      else shown.push(button.match(/aria-label="([^"]*)"/)[1]);
    }
    return shown;
  };
  return { left: side(html.slice(0, right)), right: side(html.slice(right)) };
}

/** `html` without its plugin controls: the host's own markup. */
function hostOnly(html) {
  return html.replaceAll(/<div class="pi-plugin-slot"[^>]*><output data-probe="[^"]*">[^<]*<\/output><\/div>/g, "");
}

test("the toolbar is the host's own until a plugin adds a control", async (t) => {
  const ssr = await composer(t);
  const plain = ssr.toolbar();
  assert.deepEqual(sidesOf(plain), { left: HOST_LEFT, right: HOST_RIGHT });
  ssr.register("demo.a", { slot: "userAction", component: propsProbe("user") });
  assert.equal(ssr.toolbar(), plain, "a control of another slot is not on the toolbar");
});

test("controls follow the host's left row and lead its right row, in registration order", async (t) => {
  const ssr = await composer(t);
  const plain = ssr.toolbar();
  ssr.register("demo.a", { slot: "composerControl", component: propsProbe("a") });
  ssr.register("demo.b", { slot: "composerControl", component: propsProbe("b"), positions: ["left"] });
  ssr.register("demo.c", { slot: "composerControl", component: propsProbe("c"), positions: ["right"] });
  const html = ssr.toolbar();

  assert.deepEqual(sidesOf(html), {
    left: [...HOST_LEFT, "a:left", "b:left"],
    right: ["a:right", "c:right", ...HOST_RIGHT],
  });
  assert.deepEqual(slotMounts(html), [
    ["demo.a", "composerControl"],
    ["demo.b", "composerControl"],
    ["demo.a", "composerControl"],
    ["demo.c", "composerControl"],
  ]);
  assert.equal(hostOnly(html), plain, "the host controls and their order are untouched");
  assert.deepEqual(probed(html, "a"), [{ position: "left" }, { position: "right" }], "the side is the only prop");
});

test("a control leaves its side as soon as it is disposed", async (t) => {
  const ssr = await composer(t);
  const plain = ssr.toolbar();
  const disposeA = ssr.register("demo.a", { slot: "composerControl", component: propsProbe("a") });
  ssr.register("demo.b", { slot: "composerControl", component: propsProbe("b"), positions: ["right"] });

  disposeA();
  assert.deepEqual(sidesOf(ssr.toolbar()), { left: HOST_LEFT, right: ["b:right", ...HOST_RIGHT] });
  ssr.clear();
  assert.equal(ssr.toolbar(), plain);
});
