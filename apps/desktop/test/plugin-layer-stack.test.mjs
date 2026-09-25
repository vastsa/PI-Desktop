import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { fakeLayerDocument } from "./helpers/fake-layer-document.mjs";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/*
 * The plugin layer stack behind `pi.ui.openLayer`
 * (`docs/plugin-plan/ui/self-dialog/`): zero-size fixed layers in one root,
 * each carrying its plugin's style scope, stacked in opening order within the
 * plugin band, and all stepping aside together while the host waits on the
 * user's own decision.
 */
const { PluginLayerStack, PLUGIN_LAYER_Z_MIN, PLUGIN_LAYER_Z_MAX, PLUGIN_LAYER_ROOT_ID } = await import(
  "../src/plugins/renderer-layers/layer-stack.ts"
);

function stack() {
  const document = fakeLayerDocument();
  const layers = new PluginLayerStack(() => document);
  const root = () => document.body.children.find((child) => child.id === PLUGIN_LAYER_ROOT_ID);
  return { document, layers, root };
}

const z = (layer) => Number(layer.element.style.zIndex);

test("a layer is a zero-size fixed element in the shared root, scoped to its plugin", () => {
  const { layers, root } = stack();
  assert.equal(root(), undefined, "no root before the first layer");
  const layer = layers.open("demo.lab");
  assert.ok(Object.isFrozen(layer));
  assert.equal(layer.element.getAttribute("data-pi-plugin"), "demo.lab");
  assert.equal(layer.element.getAttribute("data-pi-layer"), "");
  assert.deepEqual(
    { ...layer.element.style },
    { position: "fixed", top: "0", left: "0", width: "0", height: "0", zIndex: String(PLUGIN_LAYER_Z_MIN) },
  );
  assert.deepEqual(root().children, [layer.element]);
  assert.equal(root().hidden, false);
  assert.equal(root().inert, false);
});

test("each layer opens above every open one, capped below the host's own ladder", () => {
  const { layers, root } = stack();
  const first = layers.open("demo.a");
  const second = layers.open("demo.b");
  const third = layers.open("demo.a");
  assert.deepEqual([first, second, third].map(z), [600, 601, 602]);

  // A layer closed below the top leaves the next one above the top still.
  second.close();
  assert.equal(z(layers.open("demo.c")), 603);
  // With the top closed, the next one takes its place above what is left.
  const top = layers.open("demo.c");
  assert.equal(z(top), 604);
  top.close();
  assert.equal(z(layers.open("demo.c")), 604);

  // At the cap, layers share its z and stack by DOM order: the later on top.
  const many = Array.from({ length: PLUGIN_LAYER_Z_MAX - PLUGIN_LAYER_Z_MIN + 5 }, () => layers.open("demo.x"));
  assert.ok(many.every((layer) => z(layer) <= PLUGIN_LAYER_Z_MAX));
  const capped = many.slice(-2);
  assert.deepEqual(capped.map(z), [PLUGIN_LAYER_Z_MAX, PLUGIN_LAYER_Z_MAX]);
  const children = root().children;
  assert.ok(children.indexOf(capped[0].element) < children.indexOf(capped[1].element));
  assert.equal(children.at(-1), capped[1].element);
});

test("closing is idempotent, and the root goes with the last layer", () => {
  const { layers, root, document } = stack();
  const first = layers.open("demo.a");
  const second = layers.open("demo.b");
  first.close();
  first.close();
  assert.deepEqual(root().children, [second.element]);
  second.close();
  assert.equal(root(), undefined);
  assert.deepEqual(document.body.children, []);

  // The stack starts over from the bottom of the band.
  const again = layers.open("demo.a");
  assert.equal(z(again), PLUGIN_LAYER_Z_MIN);
  second.close();
  assert.deepEqual(root().children, [again.element], "a stale close does not touch a new root");
});

test("suspension hides every layer from sight, pointer and focus, and brings them back unchanged", () => {
  const { layers, root } = stack();
  const layer = layers.open("demo.lab");
  layers.setSuspended(true);
  assert.equal(root().hidden, true);
  assert.equal(root().inert, true);
  assert.equal(layer.element.parentElement, root(), "suspended layers stay mounted");

  layers.setSuspended(false);
  assert.equal(root().hidden, false);
  assert.equal(root().inert, false);
  assert.deepEqual(root().children, [layer.element]);
});

test("a layer opened while suspended starts hidden, in a root created hidden", () => {
  const { layers, root } = stack();
  layers.setSuspended(true);
  assert.equal(root(), undefined, "suspension alone creates no root");
  const layer = layers.open("demo.lab");
  assert.equal(root().hidden, true);
  assert.equal(root().inert, true);
  layer.close();
  layers.setSuspended(false);
  layers.open("demo.lab");
  assert.equal(root().hidden, false);
  assert.equal(root().inert, false);
});
