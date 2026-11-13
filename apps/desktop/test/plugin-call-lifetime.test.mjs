import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { register } from "node:module";
import test from "node:test";
register(new URL("helpers/ts-import-hooks.mjs", import.meta.url));
const lifetime = await import("../electron/main/plugin-call-lifetime.ts");
function fixture() { const page = new EventEmitter(); page.isDestroyed = () => false; return page; }
test("plugin document navigation aborts a pending call even when WebContents survives", () => {
  assert.equal(typeof lifetime.createPluginCallLifetime, "function");
  const page = fixture();
  const call = lifetime.createPluginCallLifetime(page);
  page.emit("did-start-navigation", {}, "file:///new.html", false, false);
  assert.equal(call.signal.aborted, false, "child-frame navigation must not cancel the document");
  page.emit("did-start-navigation", {}, "file:///new.html", true, true);
  assert.equal(call.signal.aborted, false, "same-document navigation retains the caller");
  page.emit("did-start-navigation", {}, "file:///new.html", false, true);
  assert.equal(call.signal.aborted, true);
  call.dispose();
  assert.deepEqual(page.eventNames(), []);
});
test("renderer crash and page destruction abort; completion removes all listeners", () => {
  for (const event of ["render-process-gone", "destroyed"]) {
    const page = fixture();
    const call = lifetime.createPluginCallLifetime(page);
    page.emit(event);
    assert.equal(call.signal.aborted, true);
    call.dispose();
    assert.deepEqual(page.eventNames(), []);
  }
  const page = fixture();
  const call = lifetime.createPluginCallLifetime(page);
  call.dispose();
  page.emit("destroyed");
  assert.equal(call.signal.aborted, false);
  assert.deepEqual(page.eventNames(), []);
});
