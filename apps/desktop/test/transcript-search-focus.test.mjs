import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { installTranscriptSearchFocus } = await import(
  "../src/hooks/use-transcript-search-focus.ts"
);

function browser(t) {
  const classes = new Set();
  const listeners = new Map();
  const timers = new Map();
  const observers = { resize: [], mutation: [] };
  let now = 100;
  let shift = 0;
  let scans = 0;
  const scroller = {
    scrollTop: 0,
    clientHeight: 600,
    getBoundingClientRect: () => ({ top: 10 }),
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name) => listeners.delete(name),
  };
  const rect = () => ({ top: 500 + shift - scroller.scrollTop });
  const text = { textContent: "Read needle here", parentElement: { closest: () => null } };
  const message = {
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
    querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: rect,
  };
  const content = { querySelector: () => message };
  const observer = (kind) =>
    class {
      constructor(callback) {
        this.callback = callback;
        this.connected = false;
        observers[kind].push(this);
      }
      observe() {
        this.connected = true;
      }
      disconnect() {
        this.connected = false;
      }
      fire() {
        if (this.connected) this.callback();
      }
    };
  const globals = {
    CSS: { escape: (value) => value, highlights: new Map() },
    Highlight: class {
      constructor(...ranges) {
        this.ranges = ranges;
      }
    },
    performance: { now: () => now },
    ResizeObserver: observer("resize"),
    MutationObserver: observer("mutation"),
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    document: {
      createTreeWalker: () => {
        scans++;
        let read = false;
        return {
          nextNode: () => {
            if (read) return null;
            read = true;
            return text;
          },
        };
      },
      createRange: () => ({ setStart() {}, setEnd() {}, getBoundingClientRect: rect }),
    },
    window: {
      setTimeout: (callback, delay) => {
        const id = Symbol();
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
    },
  };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const position = { current: { requestId: 0, alignUntil: 0 } };
  const navigations = [];
  return {
    classes,
    listeners,
    timers,
    observers,
    scroller,
    position,
    navigations,
    setNow: (value) => {
      now = value;
    },
    move: (value) => {
      shift = value;
    },
    scans: () => scans,
    install: (requestId = 1) =>
      installTranscriptSearchFocus({
        target: { sessionId: "s", messageId: "answer", query: "needle", requestId },
        source: text.textContent,
        scroller,
        content,
        position,
        onNavigate: (fresh) => navigations.push(fresh),
      }),
  };
}

test("search alignment reuses ranges for layout and yields permanently to reading gestures", (t) => {
  const b = browser(t);
  const cleanup = b.install();
  assert.equal(b.scroller.scrollTop, 330);
  assert.equal(b.scans(), 1);
  assert.equal(CSS.highlights.size, 1);
  b.move(200);
  b.observers.resize[0].fire();
  assert.equal(b.scroller.scrollTop, 530);
  assert.equal(b.scans(), 1, "geometry must not rescan a long message");
  b.listeners.get("keydown")({ type: "keydown", key: "a" });
  assert.equal(b.observers.resize[0].connected, true);
  b.listeners.get("keydown")({ type: "keydown", key: "PageDown" });
  assert.equal(b.listeners.size, 0);
  assert.equal(b.observers.resize[0].connected, false);
  b.move(400);
  b.observers.mutation[0].fire();
  assert.equal(b.scans(), 2, "changed text still refreshes its highlight");
  assert.equal(b.scroller.scrollTop, 530, "text changes cannot undo a reading gesture");
  cleanup();
  assert.equal(b.classes.size, 0);
  assert.equal(CSS.highlights.size, 0);
  assert.equal(b.observers.mutation[0].connected, false);
});

test("effect replay releases follow again without extending the alignment deadline", (t) => {
  const b = browser(t);
  b.install()();
  b.setNow(1100);
  const cleanup = b.install();
  assert.deepEqual(b.navigations, [true, false]);
  assert.equal(b.position.current.alignUntil, 1600);
  assert.equal([...b.timers.values()][0].delay, 500);
  [...b.timers.values()][0].callback();
  b.move(900);
  b.observers.resize[1].fire();
  assert.equal(b.scroller.scrollTop, 330);
  assert.equal(b.listeners.size, 0);
  // A separate surface now owns the shared registry entry.
  const newerHighlight = new Highlight();
  CSS.highlights.set("transcript-search", newerHighlight);
  cleanup();
  assert.equal(CSS.highlights.get("transcript-search"), newerHighlight);
  b.setNow(2000);
  const nextCleanup = b.install(2);
  assert.deepEqual(b.navigations, [true, false, true]);
  assert.equal(b.position.current.alignUntil, 3500);
  nextCleanup();
});
