import assert from "node:assert/strict";
import test from "node:test";
import {
  POINTER_OUTSIDE_CLASS,
  installPointerOutside,
} from "../src/lib/pointer-outside.ts";

function fakeRoot() {
  const classes = new Set();
  const listeners = [];
  const viewListeners = [];
  const mutations = [];
  return {
    hidden: false,
    listeners,
    viewListeners,
    classes,
    mutations,
    documentElement: {
      classList: {
        contains(name) {
          return classes.has(name);
        },
        add(name) {
          mutations.push(["add", name]);
          classes.add(name);
        },
        remove(name) {
          mutations.push(["remove", name]);
          classes.delete(name);
        },
      },
    },
    defaultView: {
      addEventListener(type, listener) {
        viewListeners.push({ type, listener });
      },
      removeEventListener(type, listener) {
        const i = viewListeners.findIndex(
          (item) => item.type === type && item.listener === listener,
        );
        if (i >= 0) viewListeners.splice(i, 1);
      },
    },
    addEventListener(type, listener) {
      listeners.push({ type, listener });
    },
    removeEventListener(type, listener) {
      const i = listeners.findIndex(
        (item) => item.type === type && item.listener === listener,
      );
      if (i >= 0) listeners.splice(i, 1);
    },
    emit(type, event) {
      for (const item of listeners) if (item.type === type) item.listener(event);
    },
    blur() {
      for (const item of viewListeners) if (item.type === "blur") item.listener();
    },
  };
}

test("leaving the document or blurring the window marks the pointer outside", () => {
  const root = fakeRoot();
  const dispose = installPointerOutside(root);
  root.emit("mouseleave");
  assert.equal(root.classes.has(POINTER_OUTSIDE_CLASS), true);
  root.emit("mouseenter");
  assert.equal(root.classes.has(POINTER_OUTSIDE_CLASS), false);
  root.blur();
  assert.equal(root.classes.has(POINTER_OUTSIDE_CLASS), true);
  root.hidden = true;
  root.emit("visibilitychange");
  assert.equal(root.classes.has(POINTER_OUTSIDE_CLASS), true);
  dispose();
  assert.equal(root.classes.has(POINTER_OUTSIDE_CLASS), false);
  assert.equal(root.listeners.length, 0);
  assert.equal(root.viewListeners.length, 0);
});

test("mouseout with no related target is a window exit, not an internal move", () => {
  const root = fakeRoot();
  installPointerOutside(root);
  root.emit("mouseout", { relatedTarget: {} });
  assert.equal(root.classes.has(POINTER_OUTSIDE_CLASS), false);
  root.emit("mouseout", { relatedTarget: null, toElement: null });
  assert.equal(root.classes.has(POINTER_OUTSIDE_CLASS), true);
  root.emit("mouseover");
  assert.equal(root.classes.has(POINTER_OUTSIDE_CLASS), false);
  root.emit("pointerleave");
  assert.equal(root.classes.has(POINTER_OUTSIDE_CLASS), true);
});

test("repeated pointer events only write the class on state changes", () => {
  const root = fakeRoot();
  const dispose = installPointerOutside(root);
  for (let i = 0; i < 100; i++) {
    root.emit("mouseout", { relatedTarget: {} });
    root.emit("mouseover");
  }
  assert.deepEqual(root.mutations, []);
  root.emit("mouseout", { relatedTarget: null, toElement: null });
  root.emit("mouseleave");
  root.emit("pointerleave");
  root.blur();
  assert.deepEqual(root.mutations, [["add", POINTER_OUTSIDE_CLASS]]);
  root.emit("mouseover");
  root.emit("mouseenter");
  root.emit("pointerenter");
  assert.deepEqual(root.mutations, [
    ["add", POINTER_OUTSIDE_CLASS],
    ["remove", POINTER_OUTSIDE_CLASS],
  ]);
  dispose();
  root.emit("mouseout", { relatedTarget: null });
  assert.equal(root.classes.has(POINTER_OUTSIDE_CLASS), false);
});
