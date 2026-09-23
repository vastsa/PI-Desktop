import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { readComposerModule } from "./helpers/composer-source.mjs";

const hookSource = await readComposerModule("hooks/useComposerDockHeight.ts");
const { outputText } = ts.transpileModule(hookSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});

// Isolate the React effect scheduler and browser geometry boundary. Real editor
// sizing and session-entry paint ordering are covered by the renderer fixture.
function mountDock({ withObserver = true } = {}) {
  const slots = [];
  const layout = [];
  const passive = [];
  const observers = [];
  const writes = [];
  let index = 0;
  let height = 0;
  let reads = 0;
  const changed = (slot, deps) => !slot || !deps ||
    deps.length !== slot.deps?.length || deps.some((dep, i) => !Object.is(dep, slot.deps[i]));
  const effect = (queue, create, deps) => {
    const at = index++;
    if (!changed(slots[at], deps)) return;
    const slot = { deps, cleanup: slots[at]?.cleanup };
    slots[at] = slot;
    queue.push(() => {
      slot.cleanup?.();
      slot.cleanup = create();
    });
  };
  const react = {
    useRef(initial) {
      const at = index++;
      return slots[at] ??= { current: initial };
    },
    useCallback(callback, deps) {
      const at = index++;
      if (changed(slots[at], deps)) slots[at] = { deps, callback };
      return slots[at].callback;
    },
    useLayoutEffect: (create, deps) => effect(layout, create, deps),
    useEffect: (create, deps) => effect(passive, create, deps),
  };
  class Observer {
    constructor(callback) {
      this.deliver = callback;
      this.disconnected = false;
      observers.push(this);
    }
    observe(element) { this.element = element; }
    disconnect() { this.disconnected = true; }
  }
  const exports = {};
  runInNewContext(outputText, {
    exports,
    require: (specifier) => {
      assert.equal(specifier, "react");
      return react;
    },
    ResizeObserver: withObserver ? Observer : undefined,
    document: {
      documentElement: {
        style: { setProperty: (name, value) => writes.push([name, value]) },
      },
    },
  });
  const element = {
    getBoundingClientRect() {
      reads += 1;
      return { height };
    },
  };
  return {
    observers,
    writes,
    element,
    get reads() { return reads; },
    get reserve() { return writes.at(-1)?.[1]; },
    commit(nextHeight, variant = "docked") {
      height = nextHeight;
      index = 0;
      const ref = exports.useComposerDockHeight(variant);
      ref.current = element;
      for (const run of layout.splice(0)) run();
    },
    resize(nextHeight) {
      height = nextHeight;
      observers.at(-1).deliver();
    },
    unmount() {
      for (const slot of slots) slot.cleanup?.();
    },
  };
}

test("dock reserve matches each content commit before passive effects or resize delivery", () => {
  const dock = mountDock();
  for (const height of [208.4, 127.2, 208.4, 252.1, 127.2]) {
    const before = dock.reads;
    dock.commit(height);
    assert.equal(dock.reserve, `${Math.round(height)}px`);
    assert.equal(dock.reads - before, 1, "one dock measurement per commit");
  }
  assert.equal(dock.observers.length, 1, "content commits do not resubscribe");
  assert.equal(dock.observers[0].element, dock.element);
  assert.ok(dock.writes.every(([name]) => name === "--composer-dock-height"));
  dock.unmount();
});

test("equal rounded pixels do not invalidate global styles, including late resize delivery", () => {
  const dock = mountDock();
  dock.commit(127.1);
  dock.commit(127.4);
  dock.resize(126.6);
  assert.equal(dock.writes.length, 1);
  dock.resize(128.6);
  assert.equal(dock.reserve, "129px");
  assert.equal(dock.writes.length, 2);
  dock.commit(129.2);
  assert.equal(dock.writes.length, 2);
  dock.unmount();
});

test("variant changes and unmount disconnect the owned resize observer", () => {
  const dock = mountDock();
  dock.commit(127.2, "home");
  const first = dock.observers[0];
  dock.commit(208.2, "docked");
  assert.equal(first.disconnected, true);
  assert.equal(dock.observers.length, 2);
  assert.equal(dock.observers[1].disconnected, false);
  assert.equal(dock.reserve, "208px");
  dock.unmount();
  assert.equal(dock.observers[1].disconnected, true);
});

test("layout commits still publish when ResizeObserver is unavailable", () => {
  const dock = mountDock({ withObserver: false });
  dock.commit(208.4);
  dock.commit(127.2);
  assert.equal(dock.reserve, "127px");
  assert.equal(dock.observers.length, 0);
  dock.unmount();
});

test("Composer registers dock publication after its editor sizing layout effect", async () => {
  const source = await readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  const sizing = source.indexOf("}, [value]);");
  const publication = source.indexOf("const dockRef = useComposerDockHeight(variant);");
  assert.ok(sizing > -1 && publication > sizing);
  assert.match(source, /ref=\{dockRef\}/);
});

test("retained settings-hidden chat cannot replace its measured dock reserve with zero", () => {
  const dock = mountDock();
  dock.commit(208.4);
  dock.commit(0);
  dock.resize(0);
  assert.equal(dock.reserve, "208px");
  assert.equal(dock.writes.length, 1);
  dock.commit(127.2);
  assert.equal(dock.reserve, "127px");
  dock.unmount();
});

test("a dock initially mounted under hidden chat waits for its first layout", () => {
  const dock = mountDock();
  dock.commit(0);
  assert.equal(dock.writes.length, 0);
  dock.resize(127.2);
  assert.equal(dock.reserve, "127px");
  dock.unmount();
});
