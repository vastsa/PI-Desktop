import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  SCROLLING_ATTRIBUTE,
  installScrollbarReveal,
} from "./lib/scrollbar-reveal.ts";

function fakeElement() {
  const attrs = new Map();
  return {
    attrs,
    setAttribute(name, value) {
      attrs.set(name, value);
    },
    removeAttribute(name) {
      attrs.delete(name);
    },
  };
}

function fakeRoot() {
  const listeners = [];
  return {
    listeners,
    documentElement: fakeElement(),
    addEventListener(type, listener, options) {
      listeners.push({ type, listener, options });
    },
    removeEventListener(type, listener) {
      const i = listeners.findIndex((l) => l.type === type && l.listener === listener);
      if (i >= 0) listeners.splice(i, 1);
    },
    scroll(target) {
      for (const l of listeners) if (l.type === "scroll") l.listener({ target });
    },
  };
}

test("scroll marks the scrolling element and clears it after the hold", async () => {
  const root = fakeRoot();
  const pane = fakeElement();
  const dispose = installScrollbarReveal(root, { holdMs: 10 });

  // scroll does not bubble: the listener must be a passive capture listener.
  assert.equal(root.listeners.length, 1);
  assert.deepEqual(root.listeners[0].options, { capture: true, passive: true });

  root.scroll(pane);
  assert.equal(pane.attrs.get(SCROLLING_ATTRIBUTE), "");

  await sleep(25);
  assert.equal(pane.attrs.has(SCROLLING_ATTRIBUTE), false);
  dispose();
});

test("continuous scrolling keeps the mark until the element goes quiet", async () => {
  const root = fakeRoot();
  const pane = fakeElement();
  const dispose = installScrollbarReveal(root, { holdMs: 20 });

  root.scroll(pane);
  await sleep(12);
  root.scroll(pane);
  await sleep(12);
  // 24ms after the first scroll but only 12ms after the last: still marked.
  assert.equal(pane.attrs.has(SCROLLING_ATTRIBUTE), true);

  await sleep(20);
  assert.equal(pane.attrs.has(SCROLLING_ATTRIBUTE), false);
  dispose();
});

test("only the element that scrolled is marked, and a document scroll marks <html>", () => {
  const root = fakeRoot();
  const a = fakeElement();
  const b = fakeElement();
  const dispose = installScrollbarReveal(root, { holdMs: 1000 });

  root.scroll(a);
  assert.equal(a.attrs.has(SCROLLING_ATTRIBUTE), true);
  assert.equal(b.attrs.has(SCROLLING_ATTRIBUTE), false);

  // `document` has no setAttribute; the mark goes on documentElement.
  root.scroll({ nodeType: 9 });
  assert.equal(root.documentElement.attrs.has(SCROLLING_ATTRIBUTE), true);
  dispose();
});

test("dispose removes the listener, cancels hides, and clears marks", async () => {
  const root = fakeRoot();
  const pane = fakeElement();
  const dispose = installScrollbarReveal(root, { holdMs: 1000 });

  root.scroll(pane);
  assert.equal(pane.attrs.has(SCROLLING_ATTRIBUTE), true);

  dispose();
  assert.equal(root.listeners.length, 0);
  assert.equal(pane.attrs.has(SCROLLING_ATTRIBUTE), false);

  // A late scroll after dispose is ignored (no listener left to receive it).
  root.scroll(pane);
  assert.equal(pane.attrs.has(SCROLLING_ATTRIBUTE), false);
  await sleep(5);
});
