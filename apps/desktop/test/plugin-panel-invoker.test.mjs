import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { PanelSenders, PLUGIN_PAGE_CLOSE_SETTLE_MS, pageGoneWithin, resolvePanelInvocation } =
  await import("../electron/main/plugin-panel-senders.ts");

const panelHostSource = await readFile(
  new URL("../electron/main/plugin-panel-host.ts", import.meta.url),
  "utf8",
);
const viewHostSource = await readFile(
  new URL("../electron/main/plugin-view-host.ts", import.meta.url),
  "utf8",
);

/** A page double for `pageGoneWithin`: it only ends when the test says so. */
function fakePage() {
  const listeners = new Set();
  return {
    destroyed: false,
    listeners,
    isDestroyed() {
      return this.destroyed;
    },
    once(event, listener) {
      assert.equal(event, "destroyed");
      listeners.add(listener);
      return this;
    },
    removeListener(_event, listener) {
      listeners.delete(listener);
      return this;
    },
    die() {
      this.destroyed = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

test("a panel keeps its plugin while its page is still there", () => {
  const senders = new PanelSenders();
  senders.register(41, "pi.todo");

  // Closing the surface is the host's decision; a page that is still unloading
  // keeps calling the bridge as its own plugin.
  assert.equal(senders.pluginFor(41), "pi.todo");
  assert.deepEqual(resolvePanelInvocation(senders.pluginFor(41), false), {
    kind: "bridge",
    pluginId: "pi.todo",
  });

  senders.release(41);
  assert.equal(senders.pluginFor(41), null);
});

test("a call from a page that is already gone is settled, never reported", () => {
  // Regression: the reported "invalid panel invoker" came from a panel page
  // that called the bridge while the host was closing its surface, so its sender
  // no longer matched any open window. A page that is gone can never read the
  // answer, and the failure was logged in main as if a panel were reaching
  // outside its own plugin.
  assert.deepEqual(resolvePanelInvocation("pi.todo", true), { kind: "gone" });
  assert.deepEqual(resolvePanelInvocation(null, true), { kind: "gone" });

  // A live sender from outside the panel hosts is still a foreign invoker.
  assert.deepEqual(resolvePanelInvocation(null, false), { kind: "foreign" });
});

test("releasing the page of a closed surface leaves late calls foreign", () => {
  const senders = new PanelSenders();
  senders.register(7, "pi.token-insights");
  assert.equal(senders.pluginFor(7), "pi.token-insights");
  // Release happens on the page's own end, which the hosts wire to the window's
  // `closed` handler and to the view's web contents `destroyed` event.
  senders.release(7);
  assert.deepEqual(resolvePanelInvocation(senders.pluginFor(7), false), {
    kind: "foreign",
  });
});

test(
  "shutdown waits for a page to go, then releases the listener",
  { timeout: 5_000 },
  async () => {
    const page = fakePage();
    let settled = false;
    const pending = pageGoneWithin(page, 50).then(() => {
      settled = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "a live page must not settle the wait early");

    page.die();
    await pending;
    assert.equal(page.listeners.size, 0, "the destroyed listener is released");
  },
);

test(
  "a page that refuses to close cannot hold up a shutdown",
  { timeout: 5_000 },
  async () => {
    const page = fakePage();
    // The page never goes away, so only the budget can end the wait: if the
    // implementation waited for the event, this test would hit its own timeout.
    let settled = false;
    const pending = pageGoneWithin(page, 20).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "the wait is not over while the page lives");
    await pending;
    assert.equal(page.destroyed, false);
    assert.ok(PLUGIN_PAGE_CLOSE_SETTLE_MS > 0);
  },
);

test(
  "an already destroyed page does not subscribe at all",
  { timeout: 5_000 },
  async () => {
    const page = fakePage();
    page.destroyed = true;
    await pageGoneWithin(page);
    assert.equal(page.listeners.size, 0);
  },
);

test("panel windows and docked views bind bridge identity to the page", () => {
  assert.match(
    panelHostSource,
    /import \{ PanelSenders, pageGoneWithin, resolvePanelInvocation \} from "\.\/plugin-panel-senders"/,
  );
  assert.match(panelHostSource, /private senders = new PanelSenders\(\)/);
  // Registered before the document loads, released with the page — not with the
  // host's record of which surfaces are open.
  assert.match(panelHostSource, /this\.senders\.register\(webContentsId, request\.pluginId\)/);
  assert.match(panelHostSource, /this\.senders\.release\(webContentsId\)/);
  assert.match(panelHostSource, /const own = this\.senders\.pluginFor\(senderId\)/);

  // A window that closes slowly must not remove the entry of a newer window for
  // the same plugin, and reusing a panel re-checks it after the microphone prompt
  // awaits: a destroyed window has no `show`.
  assert.match(panelHostSource, /if \(this\.windows\.get\(request\.pluginId\) === win\) \{/);
  const reuse = panelHostSource.slice(
    panelHostSource.indexOf("async open(request: PluginPanelOpenRequest)"),
    panelHostSource.indexOf("const partition = pluginSessionPartition("),
  );
  assert.match(
    reuse,
    /await ensureOsMicrophone\(request\.allowMicrophone\);[\s\S]*if \(!existing\.isDestroyed\(\)\) \{/,
  );

  // `close` must not unregister a page it is closing: the calls that page has
  // already sent still have to resolve to its own plugin.
  const close = panelHostSource.slice(
    panelHostSource.indexOf("async close(pluginId"),
    panelHostSource.indexOf("async closeAll("),
  );
  assert.ok(close.length > 0);
  // The close waits for that page, so its bridge calls reach a live runtime.
  assert.match(close, /await pageGoneWithin\(page\)/);
  // Nothing is unregistered after `win.close()`: the `closed` handler owns the
  // removal, so a page that refuses the close stays an open panel.
  assert.doesNotMatch(close.slice(close.indexOf("win.close();")), /windows\.delete/);
  // `closeAll` is the shutdown path: every panel's page is waited for.
  const closeAll = panelHostSource.slice(panelHostSource.indexOf("async closeAll("));
  assert.match(closeAll, /this\.close\(pluginId\)/);

  assert.match(
    viewHostSource,
    /import \{ PanelSenders, pageGoneWithin \} from "\.\/plugin-panel-senders"/,
  );
  assert.match(viewHostSource, /this\.senders\.register\(senderId, request\.pluginId\)/);
  assert.match(viewHostSource, /this\.senders\.release\(senderId\)/);
  assert.match(viewHostSource, /return this\.senders\.pluginFor\(senderId\)/);
  assert.match(viewHostSource, /async dispose\(\): Promise<void>/);
});

test("the bridge settles a call from a page that is gone", () => {
  const handler = panelHostSource.slice(
    panelHostSource.indexOf('"pi-plugin-panel-invoke"'),
    panelHostSource.indexOf('ipcMain.on("pi-plugin-panel-drop"'),
  );
  assert.ok(handler.length > 0);
  assert.match(handler, /resolvePanelInvocation\(/);
  assert.match(handler, /event\.sender\.isDestroyed\(\)/);
  assert.match(handler, /if \(invocation\.kind === "gone"\) return;/);
  assert.match(
    handler,
    /if \(invocation\.kind === "foreign"\) throw new Error\("invalid panel invoker"\)/,
  );
  // The same rule covers the capsule channel: a page that is gone cannot read a
  // window-control answer either, while a live sender still reads as invalid.
  assert.match(
    panelHostSource,
    /if \(!window\) \{[\s\S]*?if \(event\.sender\.isDestroyed\(\)\) return;[\s\S]*?throw new Error\("invalid panel window control invoker"\)/,
  );
});
