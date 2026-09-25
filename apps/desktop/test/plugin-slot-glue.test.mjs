import assert from "node:assert/strict";
import test from "node:test";
import { createElement, useState } from "react";
import { probed, propsProbe, slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * The React glue every slot outlet shares (`src/plugins/renderer-slots/
 * use-slots.tsx`): a registration's component becomes an element of its own,
 * mounts inside the element its plugin's styles are scoped to, and sits in an
 * error boundary that takes only its own region down (出错隔离). Server
 * rendering has no error boundaries, so the boundary is driven here the way
 * React drives it after a throw; the Electron E2E crashes real slots.
 */

const entry = (overrides = {}) => ({
  id: "slot-1",
  pluginId: "demo.a",
  slot: "entryExtra",
  component: () => null,
  sides: [],
  ...overrides,
});

test("a registration's component is rendered as its own element, so its hooks are its own", async (t) => {
  const ssr = await slotSsr(t);
  const { slotElement, SlotMount } = await ssr.load("/src/plugins/renderer-slots/use-slots.tsx");
  function Counter({ start }) {
    const [count] = useState(start);
    return createElement("output", { "data-probe": "count" }, JSON.stringify({ count }));
  }
  const counter = entry({ component: Counter });
  const element = slotElement(counter, { start: 2 });
  assert.equal(element.type, Counter, "an element of the component, not the result of calling it");
  assert.deepEqual(element.props, { start: 2 });
  const html = ssr.render(createElement(SlotMount, { entry: counter }, element));
  assert.equal(
    html,
    '<div class="pi-plugin-slot" data-pi-plugin="demo.a" data-pi-slot="entryExtra"><output data-probe="count">{&quot;count&quot;:2}</output></div>',
  );
});

test("the error boundary renders its region until it catches, then nothing or the fallback", async (t) => {
  const ssr = await slotSsr(t);
  const { SlotErrorBoundary } = await ssr.load("/src/plugins/renderer-slots/use-slots.tsx");
  assert.deepEqual(SlotErrorBoundary.getDerivedStateFromError(new Error("boom")), { failed: true });

  const bare = new SlotErrorBoundary({ entry: entry(), children: "plugin region" });
  assert.equal(bare.render(), "plugin region");
  bare.state = SlotErrorBoundary.getDerivedStateFromError(new Error("boom"));
  assert.equal(bare.render(), null, "an additive region collapses");

  const keyed = new SlotErrorBoundary({ entry: entry(), fallback: "host card", children: "plugin card" });
  keyed.state = SlotErrorBoundary.getDerivedStateFromError(new Error("boom"));
  assert.equal(keyed.render(), "host card", "a replacing region gives the host's back");
});

test("a caught throw is reported on the console with the plugin and slot it came from", async (t) => {
  const ssr = await slotSsr(t);
  const { SlotErrorBoundary } = await ssr.load("/src/plugins/renderer-slots/use-slots.tsx");
  const warned = [];
  t.mock.method(console, "warn", (...args) => warned.push(args));
  const error = new Error("boom");
  new SlotErrorBoundary({
    entry: entry({ pluginId: "demo.b", slot: "toolCard" }),
    children: null,
  }).componentDidCatch(error);
  assert.deepEqual(warned, [["[plugin-slot] demo.b toolCard component failed", error]]);
});

test("slot props carry the transcript's session, and an empty id outside of one", async (t) => {
  const ssr = await slotSsr(t);
  const { EntryExtraStack } = await ssr.load("/src/features/chat/transcript/EntryExtraStack.tsx");
  ssr.register("demo.a", { slot: "entryExtra", component: propsProbe("extra") });
  const message = { id: "a1", role: "assistant", content: "x", createdAt: "2026-09-24T00:00:00.000Z" };
  const stack = createElement(EntryExtraStack, { message });
  assert.equal(probed(ssr.render(stack, { sessionId: "s-9" }), "extra")[0].sessionId, "s-9");
  assert.equal(probed(ssr.render(stack, { sessionId: null }), "extra")[0].sessionId, "");
});
