import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { observeTranscriptContent } = await import("../src/lib/transcript-content-observer.ts");

test("content observers share viewport work and dispose after the last shell", () => {
  const original = { ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
  const frames = new Map();
  const observers = [];
  let sequence = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  globalThis.ResizeObserver = class {
    observed = new Set();
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(element) { this.observed.add(element); }
    unobserve(element) { this.observed.delete(element); }
    disconnect() { this.observed.clear(); }
  };
  try {
    const viewport = new EventTarget();
    viewport.ownerDocument = new EventTarget();
    const first = { closest: () => viewport };
    const second = { closest: () => viewport };
    let firstCalls = 0;
    let secondCalls = 0;
    const stopFirst = observeTranscriptContent(first, () => firstCalls++);
    const stopSecond = observeTranscriptContent(second, () => secondCalls++);
    assert.equal(observers.length, 1);
    assert.equal(observers[0].observed.size, 3);
    viewport.dispatchEvent(new Event("scroll"));
    viewport.dispatchEvent(new Event("focusin"));
    observers[0].callback();
    assert.equal(frames.size, 1);
    const callbacks = [...frames.values()]; frames.clear();
    callbacks.forEach(callback => callback());
    assert.equal(firstCalls, 1); assert.equal(secondCalls, 1);
    stopFirst();
    viewport.dispatchEvent(new Event("scroll"));
    assert.equal(frames.size, 1);
    stopSecond();
    assert.equal(frames.size, 0);
    assert.equal(observers[0].observed.size, 0);
    viewport.dispatchEvent(new Event("scroll"));
    viewport.ownerDocument.dispatchEvent(new Event("selectionchange"));
    assert.equal(frames.size, 0);
    const stopRemount = observeTranscriptContent(first, () => firstCalls++);
    assert.equal(observers.length, 2);
    stopRemount();
    assert.equal(frames.size, 0);
  } finally { Object.assign(globalThis, original); }
});

test("content outside a transcript does not allocate viewport resources", () => {
  const stop = observeTranscriptContent({ closest: () => null }, () => assert.fail("unexpected callback"));
  stop();
});
