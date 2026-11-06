import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const compiled = ts.transpileModule(
  readFileSync(new URL("../src/features/app/useSidebarPreview.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;

function fixture() {
  const slots = [], pending = [], timers = new Map(), listeners = new Map();
  let cursor = 0, dirty = true, output, props = [true, "chat", "one"], id = 0, now = 0;
  let overlay = false;
  const document = { activeElement: null, querySelector: () => overlay ? {} : null };
  class Element {
    isConnected = true;
    constructor(toggle = false) { this.toggle = toggle; }
    closest() { return this.toggle ? this : null; }
    focus() { document.activeElement = this; }
    querySelector() { return firstButton; }
  }
  const trigger = new Element(true), firstButton = new Element(), outside = new Element();
  const react = {
    useRef(value) { return slots[cursor++] ??= { current: value }; },
    useCallback(fn, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, n) => !Object.is(value, previous.deps[n]))) slots[index] = { fn, deps };
      return slots[index].fn;
    },
    useState(value) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = value;
      return [slots[index], next => { if (!Object.is(slots[index], next)) { slots[index] = next; dirty = true; } }];
    },
    useEffect(fn, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, n) => !Object.is(value, previous.deps[n]))) {
        pending.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: fn() }; });
      }
    },
  };
  const window = {
    setTimeout(fn, delay) { timers.set(++id, { fn, at: now + delay }); return id; },
    clearTimeout(key) { timers.delete(key); },
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
  };
  const exports = {};
  runInNewContext(compiled, { exports, Element, document, window, require: name => {
    assert.equal(name, "react"); return react;
  } });
  const render = () => {
    while (dirty) {
      dirty = false; cursor = 0; output = exports.useSidebarPreview(...props);
      output.sidebarProps.ref.current = new Element();
      while (pending.length) pending.shift()();
    }
    return output;
  };
  const event = (target = outside, extra = {}) => ({ target, currentTarget: target, pointerType: "mouse", preventDefault() { this.defaultPrevented = true; }, ...extra });
  const act = fn => { fn(render()); return render(); };
  const emit = (name, e = event()) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(e); return render(); };
  const advance = ms => {
    now += ms;
    for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.fn(); }
    return render();
  };
  render();
  return { act, emit, advance, event, trigger, outside, firstButton, document, timers,
    get state() { return render(); },
    setOverlay(value) { overlay = value; },
    update(...next) { props = next; dirty = true; return render(); },
    hover(type = "mouse") { return act(s => s.triggerProps.onPointerEnter(event(trigger, { pointerType: type }))); },
    dispose() { for (const slot of slots) slot?.cleanup?.(); assert.equal(timers.size, 0); assert.ok([...listeners.values()].every(set => set.size === 0)); },
  };
}

test("hover is delayed, cancellable and independent of the dock; touch stays click-only", () => {
  const f = fixture();
  f.hover("touch"); assert.equal(f.timers.size, 0);
  f.hover(); assert.equal(f.advance(179).open, false);
  f.act(s => s.triggerProps.onPointerLeave()); assert.equal(f.advance(1).open, false);
  f.hover(); assert.equal(f.advance(180).open, true);
  assert.equal(f.state.triggerProps["aria-expanded"], true);
  f.act(s => s.triggerProps.onPointerLeave());
  f.advance(90); f.act(s => s.sidebarProps.onPointerEnter());
  assert.equal(f.advance(180).open, true);
  f.act(s => s.sidebarProps.onPointerLeave());
  assert.equal(f.advance(179).open, true);
  assert.equal(f.advance(1).open, false);
  f.dispose();
});

test("portal capture protects selectable menus and dialogs; outside movement eventually dismisses", () => {
  const f = fixture(); f.hover(); f.advance(180);
  f.act(s => s.sidebarProps.onPointerLeave()); f.setOverlay(true);
  assert.equal(f.advance(180).open, true);
  const portalEvent = f.event();
  f.act(s => s.sidebarProps.onPointerDownCapture({ nativeEvent: portalEvent }));
  assert.equal(f.emit("pointerdown", portalEvent).open, true);
  assert.equal(f.emit("keydown", f.event(f.outside, { key: "Escape" })).open, true);
  f.emit("blur"); assert.equal(f.state.open, true);
  f.setOverlay(false);
  f.emit("pointermove"); f.advance(90); f.emit("pointermove");
  assert.equal(f.advance(90).open, false, "continuous movement must not postpone dismissal");
  f.dispose();
});

test("keyboard entry keeps focus, Escape restores the trigger, and outside press dismisses", () => {
  const f = fixture();
  f.act(s => s.triggerProps.onKeyDown(f.event(f.trigger, { key: "ArrowDown" })));
  assert.equal(f.state.open, true); assert.equal(f.document.activeElement, f.firstButton);
  f.act(s => { s.sidebarProps.onFocusCapture(); s.sidebarProps.onPointerLeave(); });
  assert.equal(f.advance(180).open, true);
  f.emit("keydown", f.event(f.firstButton, { key: "Escape" }));
  assert.equal(f.state.open, false); assert.equal(f.document.activeElement, f.trigger);
  f.hover(); f.advance(180); assert.equal(f.emit("pointerdown").open, false);
  f.hover(); f.advance(180); assert.equal(f.emit("blur").open, false);
  f.dispose();
});

test("navigation, pinning, settings and unmount invalidate both visible and pending previews", () => {
  const f = fixture();
  f.hover(); f.update(true, "chat", "two"); assert.equal(f.advance(180).open, false);
  f.hover(); f.advance(180); assert.equal(f.update(true, "plugins", "two").open, false);
  f.hover(); f.advance(180); assert.equal(f.update(false, "plugins", "two").open, false);
  f.hover(); assert.equal(f.timers.size, 0);
  f.update(true, "chat", "two"); f.hover(); f.dispose();
});
