import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readMainModuleSync } from "./helpers/source-contracts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  PLUGIN_VIEW_LOCATION_EVENT,
  PLUGIN_VIEW_LOCATION_PARAM,
  normalizeLocation,
  planLocationDelivery,
  viewEntryUrl,
} = await import("../electron/main/plugin-view-location.ts");

/**
 * Handing a contributed work panel view the subject it should show (ADR 0104).
 *
 * A view is opened either from the tool launcher, which has no subject, or from
 * a chat file reference, which names one — and a second click on the same
 * reference is a request to show *that file*, not a cache hit. The rule that
 * matters most here is the data-safety one: a view that has already finished
 * loading must never be navigated to show a different subject. Plugins such as
 * the bundled file manager keep unsaved editor state inside the page, so a
 * reload would discard it silently. The host therefore delivers the new subject
 * as the `view:open` preload event, and only a view whose first document has
 * not run yet — where nothing can have subscribed to that event — is restarted
 * against a new URL.
 *
 * The transport rules live in an Electron-free module, so they are asserted by
 * value; the host that applies them is asserted as a source contract, because
 * `plugin-view-host.ts` cannot be imported outside an Electron process.
 */

/** Absolute path to a view's entry HTML; nothing has to exist on disk. */
const htmlPath = join(here, "fake-plugin", "views", "index.html");
const viewHostSource = readMainModuleSync("plugin-view-host.ts");
const pluginUiIpcSource = readMainModuleSync("ipc/plugin-ui-ipc.ts");

test("the subject travels under one parameter and one event name", () => {
  assert.equal(PLUGIN_VIEW_LOCATION_PARAM, "piViewOpen");
  assert.equal(PLUGIN_VIEW_LOCATION_EVENT, "view:open");
  // The preload bridge turns the event into `pi-plugin-panel-event:<event>`,
  // the same channel a detached panel window receives, so a plugin subscribes
  // once regardless of where its page is shown.
  assert.match(
    viewHostSource,
    /pi-plugin-panel-event:\$\{PLUGIN_VIEW_LOCATION_EVENT\}/,
  );
});

test("a view created with a subject loads it in the entry URL", () => {
  const url = new URL(viewEntryUrl(htmlPath, "src/deep/a.ts"));
  assert.equal(url.protocol, "file:");
  assert.equal(url.searchParams.get(PLUGIN_VIEW_LOCATION_PARAM), "src/deep/a.ts");
  // Exactly one parameter: nothing else may end up in the entry URL.
  assert.equal([...url.searchParams.keys()].length, 1);
  assert.equal(decodeURI(url.pathname).endsWith("/views/index.html"), true);
});

test("a view created with no subject loads a plain entry URL", () => {
  const plain = viewEntryUrl(htmlPath, null);
  assert.equal(plain, pathToFileURL(htmlPath).toString());
  assert.equal(new URL(plain).search, "");
  assert.equal(new URL(plain).searchParams.has(PLUGIN_VIEW_LOCATION_PARAM), false);
});

test("reserved characters in a subject survive the round trip", () => {
  const location = "src/my folder/a#1.ts?x&y=z";
  const url = new URL(viewEntryUrl(htmlPath, location));
  // The value is read back whole: an unencoded `#` would have truncated the URL
  // into a fragment, and an unencoded `?` / `&` would have started a second
  // query or split the value in two.
  assert.equal(url.searchParams.get(PLUGIN_VIEW_LOCATION_PARAM), location);
  assert.equal(url.hash, "");
  const query = url.search.slice(1);
  assert.match(query, /%23/, "a raw `#` would end the URL at a fragment");
  assert.match(query, /%3F/, "a raw `?` would start a second query");
  assert.match(query, /%26/, "a raw `&` would split the value in two");
});

test("the query does not disturb the plugin's own asset references", () => {
  const entry = viewEntryUrl(htmlPath, "src/deep/a.ts");
  // A relative `./assets/...` reference resolves against the path, so the
  // plugin's bundle keeps loading from the view's own directory.
  const asset = new URL("./assets/index.js", entry);
  assert.equal(asset.search, "");
  assert.equal(
    decodeURI(asset.pathname).endsWith("/views/assets/index.js"),
    true,
  );
});

test("an absent or blank subject is the same as no subject", () => {
  assert.equal(normalizeLocation(undefined), null);
  assert.equal(normalizeLocation(""), null);
  assert.equal(normalizeLocation("   "), null);
  assert.equal(normalizeLocation("  src/deep/a.ts  "), "src/deep/a.ts");
});

test("an already loaded view is told, never navigated", () => {
  // The data-safety rule. A plugin can hold unsaved edits in the page, so the
  // host hands the new subject over and lets the plugin decide what to do.
  assert.deepEqual(planLocationDelivery("/old.ts", "/new.ts", true), {
    kind: "event",
    location: "/new.ts",
  });
});

test("a view whose first document has not run yet is restarted instead", () => {
  // Nothing can have subscribed to the event in a document that has not
  // finished loading, so its URL is the only channel it can read.
  assert.deepEqual(planLocationDelivery(null, "/new.ts", false), {
    kind: "reload",
    location: "/new.ts",
  });
});

test("the same subject a second time does nothing at all", () => {
  for (const loaded of [true, false]) {
    assert.deepEqual(planLocationDelivery("src/a.ts", "src/a.ts", loaded), {
      kind: "none",
    });
  }
});

test("no subject is never a request to reset the view", () => {
  // The launcher reopens a live view with nothing to show; that must not blank
  // a subject the user is working on, and must not disturb an empty view.
  for (const loaded of [true, false]) {
    assert.deepEqual(planLocationDelivery("src/a.ts", null, loaded), {
      kind: "none",
    });
    assert.deepEqual(planLocationDelivery(null, null, loaded), { kind: "none" });
  }
});

test("a first subject is delivered on whichever channel the view can read", () => {
  assert.deepEqual(planLocationDelivery(null, "src/a.ts", false), {
    kind: "reload",
    location: "src/a.ts",
  });
  assert.deepEqual(planLocationDelivery(null, "src/a.ts", true), {
    kind: "event",
    location: "src/a.ts",
  });
});

test("the view host routes every request through those rules", () => {
  assert.match(viewHostSource, /from "\.\/plugin-view-location"/);
  // Normalized once, at the door, so an empty string cannot reach the rules as
  // a subject of its own.
  assert.match(viewHostSource, /const location = normalizeLocation\(request\.location\)/);
  // The decision is the pure one, taken against the view's own load state.
  assert.match(
    viewHostSource,
    /planLocationDelivery\(entry\.location, location, entry\.loaded\)/,
  );
  assert.match(
    viewHostSource,
    /loadURL\(viewEntryUrl\(entry\.htmlPath, entry\.location\)\)/,
  );

  const deliver = viewHostSource.slice(
    viewHostSource.indexOf("private deliverLocation"),
  );
  const body = deliver.slice(0, deliver.indexOf("\n  }"));
  assert.match(body, /if \(delivery\.kind === "none"\) return;/);
  assert.match(
    body,
    /wc\.send\(`pi-plugin-panel-event:\$\{PLUGIN_VIEW_LOCATION_EVENT\}`, \{/,
  );
  assert.match(body, /path: delivery\.location,/);
  // A navigation exists on exactly one path — the document that has not run —
  // and the live path sends the event instead.
  const reload = body.indexOf('if (delivery.kind === "reload")');
  const load = body.indexOf("this.load(entry)");
  const send = body.indexOf("wc.send(");
  assert.ok(reload > 0, "expected the reload branch");
  assert.ok(load > reload, "a restart must happen only when nothing has run yet");
  assert.ok(send > reload, "a live view must be reached by event, not by navigation");
});

test("pi.browser keeps its own location channel", () => {
  // The browser view owns an address bar and its own history, so its location
  // is routed through `browserHost` and must not also be stamped into the
  // view's entry URL as if the host knew better.
  const open = pluginUiIpcSource.slice(
    pluginUiIpcSource.indexOf("IPC.invoke.pluginViewOpen"),
  );
  const body = open.slice(0, open.indexOf("\n  handle("));
  assert.match(
    body,
    /isBrowserView = pluginId === BROWSER_PLUGIN_ID && viewId === BROWSER_VIEW_ID/,
  );
  assert.match(
    body,
    /\.\.\.\(isBrowserView \|\| !location \? \{\} : \{ location \}\),/,
  );
  assert.match(body, /browserHost\.rememberLocation\(sessionId, location\)/);
  assert.match(body, /void browserHost\.navigate\(/);
});
