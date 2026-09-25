import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { fakeLayerDocument } from "./helpers/fake-layer-document.mjs";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/*
 * The renderer module loader (`docs/plugin-plan/slot-contract.html` §1, §5):
 * one load per plugin generation, a frozen `pi` bound to the plugin, and an
 * end that takes everything the load registered, injected or dispatched with
 * it before the plugin's `onUnload` runs, whatever the plugin did. The
 * registry, the layer stack and the dispatch channel are the real ones; only
 * the module import, the style sheets, the document under the layers and the
 * routes behind the channel are faked.
 */
const { RendererModuleLoader, rendererModuleUrl, rendererLoadSpecs } = await import(
  "../src/plugins/renderer-host/loader.ts"
);
const { SlotRegistry } = await import("../src/plugins/renderer-slots/registry.ts");
const { createDispatchChannel } = await import("../src/plugins/renderer-host/dispatch.ts");
const { PluginRendererError } = await import("../src/plugins/renderer-error.ts");
const { PluginLayerStack } = await import("../src/plugins/renderer-layers/layer-stack.ts");

const PLUGIN = "demo.lab";
const component = () => null;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function unloadedError(error) {
  assert.ok(error instanceof PluginRendererError, `expected a PluginRendererError, got ${error}`);
  assert.equal(error.code, "PLUGIN_UNLOADED");
  return true;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function spec(pluginId = PLUGIN, overrides = {}) {
  return {
    pluginId,
    version: "1.2.3",
    descriptor: {
      entry: "renderer/index.js",
      generation: 1,
      actions: ["plugin.call"],
      callMethods: ["ping"],
      tools: ["lookup"],
      ...overrides,
    },
  };
}

/**
 * A loader over fake module imports. `modules` maps a module URL to a module
 * namespace, a promise of one, or a function returning either.
 */
function harness(modules = {}) {
  const registry = new SlotRegistry();
  const document = fakeLayerDocument();
  const layerStack = new PluginLayerStack(() => document);
  const sheets = [];
  const imports = [];
  const warnings = [];
  const calls = [];
  let answerCall = () => Promise.resolve({ pong: true });
  const loader = new RendererModuleLoader({
    importModule: async (url) => {
      imports.push(url);
      const entry = modules[url];
      if (entry === undefined) throw new Error(`no module at ${url}`);
      return typeof entry === "function" ? entry() : entry;
    },
    registry,
    injectStyle: (pluginId, css) => {
      const sheet = { pluginId, css };
      sheets.push(sheet);
      return () => {
        const at = sheets.indexOf(sheet);
        if (at >= 0) sheets.splice(at, 1);
      };
    },
    openLayer: (pluginId) => layerStack.open(pluginId),
    openChannel: (pluginId, actions) =>
      createDispatchChannel(pluginId, actions, {
        pluginCall: (id, method, args) => {
          calls.push({ id, method, args });
          return answerCall(id, method, args);
        },
        insertText: () => true,
      }),
    warn: (message, error) => warnings.push({ message, error }),
  });
  return {
    loader,
    registry,
    sheets,
    /** The open layers' elements, bottom to top. */
    layers: () => document.body.children.flatMap((root) => root.children),
    imports,
    warnings,
    calls,
    openLayerFor: (pluginId) => layerStack.open(pluginId),
    answerCallsWith(fn) {
      answerCall = fn;
    },
  };
}

const url = (pluginId = PLUGIN, generation = 1, entry = "renderer/index.js") =>
  rendererModuleUrl(pluginId, { entry, generation });

test("the module URL carries the plugin, its load generation and the encoded entry path", () => {
  assert.equal(
    rendererModuleUrl("demo.lab", { entry: "renderer/index.js", generation: 7 }),
    "plugin-renderer://demo.lab/g7/renderer/index.js",
  );
  assert.equal(
    rendererModuleUrl("demo.lab", { entry: "/ui/main entry#1?.js", generation: 1 }),
    "plugin-renderer://demo.lab/g1/ui/main%20entry%231%3F.js",
  );
});

test("onLoad gets a frozen pi bound to its plugin, and what it registers shows up", async () => {
  let pi;
  const h = harness({
    [url()]: {
      onLoad(api) {
        pi = api;
        api.slots.register({ slot: "entryExtra", component });
        api.slots.register({ slot: "toolCard", toolName: "lookup", component });
        api.ui.injectStyle(".lab { color: red; }");
        layer = api.ui.openLayer();
      },
    },
  });
  let layer;
  assert.deepEqual(await h.loader.load(spec()), { status: "loaded" });
  assert.deepEqual(h.imports, [url()]);

  assert.ok(Object.isFrozen(pi) && Object.isFrozen(pi.plugin) && Object.isFrozen(pi.slots) && Object.isFrozen(pi.ui));
  assert.deepEqual({ ...pi.plugin }, { id: PLUGIN, version: "1.2.3" });
  assert.deepEqual(
    h.registry.getSnapshot().entries.map((entry) => [entry.pluginId, entry.slot, entry.key]),
    [
      [PLUGIN, "entryExtra", undefined],
      [PLUGIN, "toolCard", "plugin_demo_lab_lookup"],
    ],
  );
  assert.deepEqual(h.sheets, [{ pluginId: PLUGIN, css: ".lab { color: red; }" }]);
  assert.ok(Object.isFrozen(layer));
  assert.deepEqual(h.layers(), [layer.element]);
  assert.equal(layer.element.getAttribute("data-pi-plugin"), PLUGIN);

  // The descriptor is the plugin's grant: its own tools, its declared words.
  assert.throws(
    () => pi.slots.register({ slot: "toolCard", toolName: "search", component }),
    (error) => error instanceof PluginRendererError && error.code === "PLUGIN_SLOT_NOT_OWNED",
  );
  assert.deepEqual(await pi.dispatch("plugin.call", { method: "ping", args: { n: 1 } }), { pong: true });
  assert.deepEqual(h.calls, [{ id: PLUGIN, method: "ping", args: { n: 1 } }]);
  await assert.rejects(
    pi.dispatch("composer.insertText", { text: "hi" }),
    (error) => error.code === "PLUGIN_ACTION_UNDECLARED",
  );
  assert.deepEqual(h.warnings, []);
});

test("a module's default export can carry onLoad and onUnload", async () => {
  const seen = [];
  const h = harness({
    [url()]: {
      default: {
        onLoad: (pi) => {
          seen.push("load");
          pi.slots.register({ slot: "entryExtra", component });
        },
        onUnload: () => seen.push("unload"),
      },
    },
  });
  assert.deepEqual(await h.loader.load(spec()), { status: "loaded" });
  await h.loader.unload(PLUGIN);
  assert.deepEqual(seen, ["load", "unload"]);
  assert.deepEqual(h.registry.getSnapshot().entries, []);
});

test("a load that fails is torn down, reported once and not retried for its generation", async () => {
  const broken = new Error("onLoad broke");
  const cases = [
    ["the import rejects", () => Promise.reject(new Error("syntax error"))],
    ["the module has no onLoad", () => ({ onUnload() {} })],
    [
      "onLoad throws after registering",
      () => ({
        onLoad(pi) {
          pi.slots.register({ slot: "entryExtra", component });
          pi.ui.injectStyle(".half { }");
          pi.ui.openLayer();
          throw broken;
        },
      }),
    ],
    [
      "onLoad rejects after registering",
      () => ({
        async onLoad(pi) {
          pi.slots.register({ slot: "assistantAction", component });
          await tick();
          throw broken;
        },
      }),
    ],
  ];
  for (const [label, module] of cases) {
    const h = harness({ [url()]: module, [url(PLUGIN, 2)]: { onLoad() {} } });
    const outcome = await h.loader.load(spec());
    assert.equal(outcome.status, "failed", label);
    assert.ok(outcome.error instanceof Error, label);
    await tick();
    assert.deepEqual(h.registry.getSnapshot().entries, [], `${label}: registrations are gone`);
    assert.deepEqual(h.sheets, [], `${label}: styles are gone`);
    assert.deepEqual(h.layers(), [], `${label}: layers are gone`);
    assert.deepEqual(
      h.warnings.map((warning) => warning.message),
      [`[plugin-renderer] ${PLUGIN} failed to load`],
      label,
    );
    assert.equal(h.warnings[0].error, outcome.error, label);

    // Asking again for the same generation is the same failed load.
    assert.equal(await h.loader.load(spec()), outcome, label);
    assert.deepEqual(h.loader.loadedPluginIds(), [PLUGIN], label);
    assert.equal(h.imports.length, 1, `${label}: no retry`);
    // A reload of the plugin is a new generation, and a new load.
    assert.deepEqual(await h.loader.load(spec(PLUGIN, { generation: 2 })), { status: "loaded" }, label);
    assert.deepEqual(h.imports, [url(), url(PLUGIN, 2)], label);
  }
});

test("a plugin whose onLoad failed still gets its onUnload, after the host cleaned up", async () => {
  const seen = [];
  const h = harness({
    [url()]: {
      onLoad(pi) {
        pi.slots.register({ slot: "entryExtra", component });
        throw new Error("half loaded");
      },
      onUnload() {
        seen.push(h.registry.getSnapshot().entries.length);
      },
    },
  });
  assert.equal((await h.loader.load(spec())).status, "failed");
  await tick();
  assert.deepEqual(seen, [0]);
});

test("ending a load disposes its registrations, styles, layers and calls before onUnload runs", async () => {
  let pi;
  let kept;
  let keptLayer;
  const observed = [];
  const answer = deferred();
  const h = harness({
    [url()]: {
      onLoad(api) {
        pi = api;
        api.slots.register({ slot: "entryExtra", component });
        kept = api.slots.register({ slot: "userAction", component, positions: ["left"] });
        api.ui.injectStyle(".lab { }");
        api.ui.openLayer();
        keptLayer = api.ui.openLayer();
      },
      onUnload() {
        observed.push({
          entries: h.registry.getSnapshot().entries.length,
          sheets: h.sheets.length,
          layers: h.layers().length,
        });
      },
    },
  });
  h.answerCallsWith(() => answer.promise);
  await h.loader.load(spec());
  const inFlight = pi.dispatch("plugin.call", { method: "ping" });
  // Another plugin's registration is not this load's to dispose.
  h.registry.register("demo.other", { slot: "entryExtra", component }, []);
  const otherLayer = h.openLayerFor("demo.other");

  await h.loader.unload(PLUGIN);
  assert.deepEqual(observed, [{ entries: 1, sheets: 0, layers: 1 }]);
  assert.deepEqual(h.layers(), [otherLayer.element]);
  assert.deepEqual(
    h.registry.getSnapshot().entries.map((entry) => entry.pluginId),
    ["demo.other"],
  );
  await assert.rejects(inFlight, unloadedError);
  answer.resolve({ late: true });

  // The pi of an ended load stays dead.
  assert.throws(() => pi.slots.register({ slot: "entryExtra", component }), unloadedError);
  assert.throws(() => pi.ui.injectStyle(".late { }"), unloadedError);
  assert.throws(() => pi.ui.openLayer(), unloadedError);
  await assert.rejects(pi.dispatch("plugin.call", { method: "ping" }), unloadedError);
  const version = h.registry.getSnapshot().version;
  kept();
  assert.equal(h.registry.getSnapshot().version, version, "a kept disposer does nothing afterwards");
  keptLayer.close();
  assert.deepEqual(h.layers(), [otherLayer.element], "a kept close does nothing afterwards");
  assert.deepEqual(h.loader.loadedPluginIds(), []);
  await h.loader.unload(PLUGIN);
  assert.equal(observed.length, 1, "unloading twice runs onUnload once");
});

test("a registration or layer the plugin disposed itself is not disposed again at the end", async () => {
  let dispose;
  let layer;
  const h = harness({
    [url()]: {
      onLoad(pi) {
        dispose = pi.slots.register({ slot: "entryExtra", component });
        layer = pi.ui.openLayer();
      },
    },
  });
  await h.loader.load(spec());
  dispose();
  layer.close();
  const version = h.registry.getSnapshot().version;
  // A layer another load opens after is not the closed one's to take along.
  const other = h.openLayerFor("demo.other");
  await h.loader.unload(PLUGIN);
  assert.equal(h.registry.getSnapshot().version, version);
  assert.deepEqual(h.layers(), [other.element]);
});

test("onUnload waits for a slow onLoad, whose late registrations are refused", async () => {
  const gate = deferred();
  const order = [];
  let lateRegistration;
  const h = harness({
    [url()]: {
      async onLoad(pi) {
        pi.slots.register({ slot: "entryExtra", component });
        order.push("onLoad awaits");
        await gate.promise;
        try {
          pi.slots.register({ slot: "assistantAction", component });
        } catch (error) {
          lateRegistration = error;
        }
        order.push("onLoad done");
      },
      onUnload() {
        order.push("onUnload");
      },
    },
  });
  const ready = h.loader.load(spec());
  await tick();
  const unloaded = h.loader.unload(PLUGIN).then(() => order.push("unloaded"));
  assert.deepEqual(h.registry.getSnapshot().entries, [], "the host side ends at once");
  await tick();
  assert.deepEqual(order, ["onLoad awaits"], "onUnload does not overtake onLoad");

  gate.resolve();
  assert.deepEqual(await ready, { status: "cancelled" });
  await unloaded;
  assert.deepEqual(order, ["onLoad awaits", "onLoad done", "onUnload", "unloaded"]);
  assert.ok(unloadedError(lateRegistration));
  assert.deepEqual(h.registry.getSnapshot().entries, []);
  assert.deepEqual(h.warnings, []);
});

test("a load ended during its import never runs the plugin", async () => {
  for (const settle of ["resolve", "reject"]) {
    const imported = deferred();
    let ran = false;
    const h = harness({ [url()]: () => imported.promise });
    const ready = h.loader.load(spec());
    await tick();
    await h.loader.unload(PLUGIN);
    if (settle === "resolve") {
      imported.resolve({
        onLoad() {
          ran = true;
        },
      });
    } else {
      imported.reject(new Error("network gone"));
    }
    assert.deepEqual(await ready, { status: "cancelled" }, settle);
    assert.equal(ran, false, settle);
    assert.deepEqual(h.warnings, [], `${settle}: a cancelled load is not a failure`);
  }
});

test("the same generation is one load; a new generation ends it at once and replaces it", async () => {
  const seen = [];
  const module = (name) => ({
    onLoad(pi) {
      seen.push(`${name} load`);
      pi.slots.register({ slot: "entryExtra", component: Object.assign(() => null, { label: name }) });
    },
    onUnload() {
      seen.push(`${name} unload`);
    },
  });
  const secondImport = deferred();
  const h = harness({ [url()]: module("g1"), [url(PLUGIN, 2)]: () => secondImport.promise });
  const labels = () => h.registry.entriesFor("entryExtra").map((entry) => entry.component.label);
  const first = h.loader.load(spec());
  assert.equal(h.loader.load(spec()), first);
  await first;
  assert.equal(await h.loader.load(spec()), await first);
  assert.deepEqual(h.imports, [url()]);
  assert.deepEqual(labels(), ["g1"]);

  // The old load does not wait for the new code to arrive.
  const second = h.loader.load(spec(PLUGIN, { generation: 2 }));
  assert.deepEqual(labels(), []);
  await tick();
  assert.deepEqual(seen, ["g1 load", "g1 unload"]);

  secondImport.resolve(module("g2"));
  assert.deepEqual(await second, { status: "loaded" });
  assert.deepEqual(seen, ["g1 load", "g1 unload", "g2 load"]);
  assert.deepEqual(labels(), ["g2"]);
  assert.deepEqual(h.imports, [url(), url(PLUGIN, 2)]);
});

test("sync loads exactly the given plugins and leaves failed ones failed", async () => {
  const unloaded = [];
  const module = (id) => ({
    onLoad(pi) {
      pi.slots.register({ slot: "entryExtra", component });
    },
    onUnload() {
      unloaded.push(id);
    },
  });
  const h = harness({
    [url("demo.a")]: module("demo.a"),
    [url("demo.b")]: module("demo.b"),
    [url("demo.broken")]: { onLoad() { throw new Error("broken"); } },
  });
  h.loader.sync([spec("demo.a"), spec("demo.b"), spec("demo.broken")]);
  await tick();
  await tick();
  assert.deepEqual(h.loader.loadedPluginIds().sort(), ["demo.a", "demo.b", "demo.broken"]);
  assert.deepEqual(
    h.registry.getSnapshot().entries.map((entry) => entry.pluginId).sort(),
    ["demo.a", "demo.b"],
  );

  h.loader.sync([spec("demo.b"), spec("demo.broken")]);
  await tick();
  assert.deepEqual(unloaded, ["demo.a"]);
  assert.deepEqual(h.loader.loadedPluginIds().sort(), ["demo.b", "demo.broken"]);
  assert.equal(h.imports.length, 3, "kept and failed plugins are not imported again");

  h.loader.sync([]);
  await tick();
  assert.deepEqual(unloaded.sort(), ["demo.a", "demo.b"]);
  assert.deepEqual(h.loader.loadedPluginIds(), []);
  assert.deepEqual(h.registry.getSnapshot().entries, []);
});

test("an onUnload that throws is reported and the load still ends", async () => {
  const broken = new Error("cleanup broke");
  const h = harness({
    [url()]: {
      onLoad(pi) {
        pi.slots.register({ slot: "entryExtra", component });
      },
      onUnload() {
        throw broken;
      },
    },
  });
  await h.loader.load(spec());
  await h.loader.unload(PLUGIN);
  assert.deepEqual(h.warnings, [{ message: `[plugin-renderer] ${PLUGIN} onUnload failed`, error: broken }]);
  assert.deepEqual(h.registry.getSnapshot().entries, []);
  assert.deepEqual(h.loader.loadedPluginIds(), []);
});

test("the plugin list asks for the running renderer plugins active in the open project", () => {
  const descriptor = spec().descriptor;
  const plugins = [
    { id: "demo.global", version: "1.0.0", enabled: true, renderer: descriptor },
    { id: "demo.headless", version: "1.0.0", enabled: true },
    { id: "demo.off", version: "1.0.0", enabled: false, renderer: descriptor },
    {
      id: "demo.scoped",
      version: "2.0.0",
      enabled: true,
      scope: { mode: "projects", projects: ["/work/app"] },
      renderer: descriptor,
    },
  ];
  const ids = (projectPath) => rendererLoadSpecs(plugins, projectPath).map((entry) => entry.pluginId);
  assert.deepEqual(ids("/work/app"), ["demo.global", "demo.scoped"]);
  assert.deepEqual(ids("/Work/App/packages/ui"), ["demo.global", "demo.scoped"]);
  assert.deepEqual(ids("/work/other"), ["demo.global"]);
  assert.deepEqual(ids(null), ["demo.global"]);
  assert.deepEqual(rendererLoadSpecs(plugins, "/work/app")[1], {
    pluginId: "demo.scoped",
    version: "2.0.0",
    descriptor,
  });
});
