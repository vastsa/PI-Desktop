import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// Electron is the boundary: the protocol module hands its request handler to
// `protocol.handle`, and this stand-in keeps it for the tests to drive.
const electron = `data:text/javascript,${encodeURIComponent(`
  export const protocol = {
    handle(scheme, handler) {
      globalThis.__piProtocolHandlers ??= new Map();
      globalThis.__piProtocolHandlers.set(scheme, handler);
    },
  };
`)}`;
registerHooks({ resolve(specifier, context, next) {
  return specifier === "electron" ? { url: electron, shortCircuit: true } : next(specifier, context);
} });
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/*
 * The main-process half of a renderer extension (`docs/plugin-plan/ui/`,
 * `docs/plugin-plan/render/plugin-call/`): which loads get a descriptor, which
 * files `plugin-renderer://` serves for them, and what the `plugin.call` relay
 * lets through to the plugin's headless entry.
 */
const {
  RENDERER_CALL_BREAKER_COOLDOWN_MS,
  RENDERER_CALL_MAX_BYTES,
  RENDERER_CALL_QPS,
  RENDERER_CALL_TIMEOUT_MS,
  RendererCallRelay,
  rendererDescriptorFor,
  resolveRendererSourcePath,
} = await import("../electron/main/plugin-renderer-extension.ts");
const { PLUGIN_RENDERER_SCHEME_PRIVILEGES, installPluginRendererProtocol, parseRendererRequestPath } =
  await import("../electron/main/plugin-renderer-protocol.ts");

const PLUGIN = "demo.lab";
const GRANT = "renderer.extension";

/** A runtime load record as the extension reads it. */
function loadedPlugin({ dir = "/nowhere", permissions = [GRANT], disposing = false, manifest = {} } = {}) {
  return {
    path: dir,
    permissions: new Set(permissions),
    disposing,
    manifest: {
      id: PLUGIN,
      renderer: "renderer/index.js",
      rendererActions: ["plugin.call"],
      rendererCallMethods: ["ping", "echo"],
      contributes: { agentTools: [{ name: "lookup" }, { name: "fetch" }] },
      ...manifest,
    },
  };
}

const ENTRY_SOURCE = "export function onLoad() {}\n";

/** A plugin package next to files it must never serve. */
function pluginPackage(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-renderer-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "pkg");
  const files = {
    "pkg/renderer/index.js": ENTRY_SOURCE,
    "pkg/renderer/lib/chart.js": "export const chart = 1;\n",
    "pkg/renderer/extra.mjs": "export {};\n",
    "pkg/renderer/LOUD.JS": "export {};\n",
    "pkg/renderer/style.css": ".lab {}\n",
    "pkg/renderer/data.json": "{}\n",
    "pkg/renderer/index.js.map": "{}\n",
    "pkg/renderer/page.html": "<p></p>\n",
    "pkg/renderer/module.wasm": "\0asm",
    "pkg/renderer/README": "readme\n",
    "pkg-evil/x.js": "export const evil = 1;\n",
    "secret.js": "export const secret = 1;\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  symlinkSync(join(root, "secret.js"), join(dir, "renderer", "escape.js"));
  symlinkSync(join(dir, "renderer", "lib", "chart.js"), join(dir, "renderer", "alias.js"));
  return { root, dir };
}

function codedAs(code) {
  return (error) => {
    assert.ok(error instanceof Error, `expected an Error, got ${error}`);
    assert.equal(error.code, code);
    assert.equal(error.errorCode, code, "errorCode is what the IPC layer forwards");
    return true;
  };
}

test("a running plugin with the grant and a renderer entry gets a descriptor stamped with its load", () => {
  const plugin = loadedPlugin();
  const descriptor = rendererDescriptorFor(plugin);
  assert.ok(Number.isSafeInteger(descriptor.generation) && descriptor.generation > 0);
  assert.deepEqual(descriptor, {
    entry: "renderer/index.js",
    generation: descriptor.generation,
    actions: ["plugin.call"],
    callMethods: ["ping", "echo"],
    tools: ["lookup", "fetch"],
  });
  assert.notEqual(descriptor.actions, plugin.manifest.rendererActions, "the descriptor holds copies");

  // One load keeps its generation; a reload is a new record with a new one.
  assert.equal(rendererDescriptorFor(plugin).generation, descriptor.generation);
  assert.ok(rendererDescriptorFor(loadedPlugin()).generation > descriptor.generation);

  const { generation: _generation, ...bare } = rendererDescriptorFor(
    loadedPlugin({ manifest: { rendererActions: undefined, rendererCallMethods: undefined, contributes: undefined } }),
  );
  assert.deepEqual(bare, { entry: "renderer/index.js", actions: [], callMethods: [], tools: [] });

  for (const [label, candidate] of [
    ["not running", undefined],
    ["unloading", loadedPlugin({ disposing: true })],
    ["without the grant", loadedPlugin({ permissions: ["ui.panel"] })],
    ["without an entry", loadedPlugin({ manifest: { renderer: undefined } })],
  ]) {
    assert.equal(rendererDescriptorFor(candidate), undefined, label);
  }
});

test("the source resolver serves the current load's regular files from inside the package only", (t) => {
  const { root, dir } = pluginPackage(t);
  const plugin = loadedPlugin({ dir });
  const real = (path) => realpathSync(join(dir, path));

  // Asking the resolver never hands a generation out; only a descriptor does.
  const probe = rendererDescriptorFor(loadedPlugin({ dir })).generation;
  assert.equal(resolveRendererSourcePath(plugin, probe + 1, "renderer/index.js"), null);
  const { generation } = rendererDescriptorFor(plugin);
  assert.equal(generation, probe + 1);

  assert.equal(resolveRendererSourcePath(plugin, generation, "renderer/index.js"), real("renderer/index.js"));
  assert.equal(resolveRendererSourcePath(plugin, generation, "renderer/lib/chart.js"), real("renderer/lib/chart.js"));
  assert.equal(
    resolveRendererSourcePath(plugin, generation, "renderer/alias.js"),
    real("renderer/lib/chart.js"),
    "a link inside the package serves its target",
  );
  for (const [label, requestPath] of [
    ["a parent escape", "../secret.js"],
    ["a parent escape through the entry folder", "renderer/../../secret.js"],
    ["a sibling folder sharing the name prefix", "../pkg-evil/x.js"],
    ["an absolute path", join(root, "secret.js")],
    ["a link out of the package", "renderer/escape.js"],
    ["a folder", "renderer"],
    ["the package itself", ""],
    ["a missing file", "renderer/missing.js"],
  ]) {
    assert.equal(resolveRendererSourcePath(plugin, generation, requestPath), null, label);
  }

  // Only the generation the current load handed out resolves.
  assert.equal(resolveRendererSourcePath(plugin, probe, "renderer/index.js"), null);
  assert.equal(resolveRendererSourcePath(plugin, generation + 1, "renderer/index.js"), null);
  const reloaded = loadedPlugin({ dir });
  const next = rendererDescriptorFor(reloaded).generation;
  assert.equal(resolveRendererSourcePath(reloaded, generation, "renderer/index.js"), null, "a URL from before the reload");
  assert.equal(resolveRendererSourcePath(reloaded, next, "renderer/index.js"), real("renderer/index.js"));

  // The same record stops serving while it lacks the grant or unloads.
  plugin.permissions.delete(GRANT);
  assert.equal(resolveRendererSourcePath(plugin, generation, "renderer/index.js"), null, "without the grant");
  plugin.permissions.add(GRANT);
  plugin.disposing = true;
  assert.equal(resolveRendererSourcePath(plugin, generation, "renderer/index.js"), null, "while unloading");
  plugin.disposing = false;
  assert.equal(resolveRendererSourcePath(plugin, generation, "renderer/index.js"), real("renderer/index.js"));
  assert.equal(resolveRendererSourcePath(undefined, generation, "renderer/index.js"), null, "not running");
});

/** The relay over a fake clock and a fake child process. */
function relayHarness() {
  let clock = 1_000_000;
  const relay = new RendererCallRelay(() => clock);
  const sent = [];
  let answer = async (payload) => ({ pong: payload.method });
  const send = (plugin, payload, timeoutMs) => {
    sent.push({ plugin, payload, timeoutMs });
    return answer(payload);
  };
  return {
    sent,
    advance(ms) {
      clock += ms;
    },
    answerWith(fn) {
      answer = fn;
    },
    call: (plugin, method, args) => relay.call(PLUGIN, plugin, method, args, send),
  };
}

const boom = async () => {
  throw new Error("boom");
};

test("calls the relay must not make are refused before it, and never count against the plugin", async () => {
  const h = relayHarness();
  const plugin = loadedPlugin();
  const cyclic = {};
  cyclic.self = cyclic;
  // 66 bytes short of nothing: 1 + 2 × 32767 bytes of text plus the quotes is
  // 65537 bytes, while its length in characters is only 32770.
  const oversize = `a${"é".repeat(32_767)}`;
  const cases = [
    ["not running", undefined, "ping", undefined, "PLUGIN_NOT_FOUND"],
    ["unloading", loadedPlugin({ disposing: true }), "ping", undefined, "PLUGIN_NOT_FOUND"],
    ["without the grant", loadedPlugin({ permissions: [] }), "ping", undefined, "PLUGIN_PERMISSION_DENIED"],
    ["without an entry", loadedPlugin({ manifest: { renderer: undefined } }), "ping", undefined, "PLUGIN_CALL_NO_HANDLER"],
    ["without methods", loadedPlugin({ manifest: { rendererCallMethods: undefined } }), "ping", undefined, "PLUGIN_CALL_NO_HANDLER"],
    ["an undeclared method", plugin, "shutdown", undefined, "PLUGIN_CALL_NO_HANDLER"],
    ["cyclic args", plugin, "echo", cyclic, "PLUGIN_CALL_UNSERIALIZABLE"],
    ["BigInt args", plugin, "echo", { n: 1n }, "PLUGIN_CALL_UNSERIALIZABLE"],
    ["function args", plugin, "echo", () => 1, "PLUGIN_CALL_UNSERIALIZABLE"],
    ["args over 64KB of UTF-8", plugin, "echo", oversize, "PLUGIN_CALL_TOO_LARGE"],
  ];
  // Twice over: ten refusals of `plugin` would trip both the rate brake and
  // the breaker if either of them counted refusals.
  for (let round = 0; round < 2; round += 1) {
    for (const [label, target, method, args, code] of cases) {
      await assert.rejects(h.call(target, method, args), codedAs(code), label);
    }
  }
  assert.deepEqual(h.sent, []);
  assert.deepEqual(await h.call(plugin, "ping"), { pong: "ping" });
});

test("the plugin gets the JSON reading of the args, and the caller the JSON reading of the answer", async () => {
  const h = relayHarness();
  const plugin = loadedPlugin();
  const shaped = () => ({ at: new Date(0), skipped: undefined, list: [1, undefined] });
  const json = { at: "1970-01-01T00:00:00.000Z", list: [1, null] };
  h.answerWith(async () => shaped());
  assert.deepEqual(await h.call(plugin, "echo", shaped()), json);
  assert.deepEqual(h.sent, [{ plugin, payload: { method: "echo", args: json }, timeoutMs: 2_000 }]);
  assert.equal(RENDERER_CALL_TIMEOUT_MS, 2_000);

  h.answerWith(async () => undefined);
  assert.equal(await h.call(plugin, "ping"), null, "no answer is null");
  assert.deepEqual(h.sent[1].payload, { method: "ping", args: undefined }, "omitted args stay omitted");
});

test("args and answer share one budget of 64KB counted in UTF-8 bytes", async () => {
  const h = relayHarness();
  const plugin = loadedPlugin();
  assert.equal(RENDERER_CALL_MAX_BYTES, 65_536);
  // The JSON text of these args is 65532 bytes: four are left for the answer.
  const args = "x".repeat(RENDERER_CALL_MAX_BYTES - 4 - 2);
  h.answerWith(async () => undefined);
  assert.equal(await h.call(plugin, "echo", args), null);
  h.answerWith(async () => "ab");
  assert.equal(await h.call(plugin, "echo", args), "ab");
  // Four characters of JSON text, six bytes.
  h.answerWith(async () => "éé");
  await assert.rejects(h.call(plugin, "echo", args), codedAs("PLUGIN_CALL_TOO_LARGE"));
});

test("more than ten relayed calls inside one second are refused until the window moves on", async () => {
  const h = relayHarness();
  const plugin = loadedPlugin();
  assert.equal(RENDERER_CALL_QPS, 10);
  for (let i = 0; i < 10; i += 1) {
    await h.call(plugin, "ping");
    h.advance(50);
  }
  // Ten calls at t, t+50 … t+450; the clock reads t+500.
  for (let i = 0; i < 6; i += 1) {
    await assert.rejects(h.call(plugin, "ping"), codedAs("PLUGIN_CALL_RATE_LIMITED"));
  }
  h.advance(499);
  await assert.rejects(h.call(plugin, "ping"), codedAs("PLUGIN_CALL_RATE_LIMITED"), "t is still inside the window");
  h.advance(1);
  assert.deepEqual(await h.call(plugin, "ping"), { pong: "ping" }, "t has left it");
  await assert.rejects(h.call(plugin, "ping"), codedAs("PLUGIN_CALL_RATE_LIMITED"), "and the slot is taken again");
  assert.equal(h.sent.length, 11, "refused calls are never relayed, nor counted as failures");
  // The brake belongs to the load: a reload starts with an empty window.
  assert.deepEqual(await h.call(loadedPlugin(), "ping"), { pong: "ping" });
});

test("five relayed failures in a row close the relay for 30s; a success resets the count", async () => {
  const h = relayHarness();
  const plugin = loadedPlugin();
  // One call a second keeps the rate brake out of the way.
  const call = () => {
    h.advance(1_000);
    return h.call(plugin, "ping");
  };
  h.answerWith(boom);
  for (let i = 0; i < 4; i += 1) await assert.rejects(call(), codedAs("PLUGIN_CALL_FAILED"));
  h.answerWith(async () => "fine");
  assert.equal(await call(), "fine");
  h.answerWith(boom);
  for (let i = 0; i < 4; i += 1) await assert.rejects(call(), codedAs("PLUGIN_CALL_FAILED"));
  await assert.rejects(call(), codedAs("PLUGIN_CALL_FAILED"), "the fifth in a row is still relayed");
  assert.equal(h.sent.length, 10);

  h.answerWith(async () => "fine");
  await assert.rejects(h.call(plugin, "ping"), codedAs("PLUGIN_CALL_DISABLED"));
  assert.equal(RENDERER_CALL_BREAKER_COOLDOWN_MS, 30_000);
  h.advance(RENDERER_CALL_BREAKER_COOLDOWN_MS - 1);
  await assert.rejects(h.call(plugin, "ping"), codedAs("PLUGIN_CALL_DISABLED"));
  assert.equal(h.sent.length, 10, "a closed relay relays nothing");
  // Another load of the plugin has a relay of its own.
  assert.equal(await h.call(loadedPlugin(), "ping"), "fine");

  // Reopened, the count starts from zero: four more failures leave it open.
  h.advance(1);
  h.answerWith(boom);
  for (let i = 0; i < 4; i += 1) await assert.rejects(call(), codedAs("PLUGIN_CALL_FAILED"));
  h.answerWith(async () => "fine");
  assert.equal(await call(), "fine");
});

test("what goes wrong past the relay reaches the caller coded, and counts against the plugin", async () => {
  const coded = (code, message) => async () => {
    throw Object.assign(new Error(message), { code });
  };
  const cases = [
    ["a timeout", coded("TIMEOUT", "no reply"), "PLUGIN_CALL_TIMEOUT", /did not answer ping within 2000ms/],
    ["the plugin's own code", coded("LAB_NOT_READY", "not ready"), "LAB_NOT_READY", /^not ready$/],
    ["a missing handler", coded("PLUGIN_CALL_NO_HANDLER", "no onRendererCall"), "PLUGIN_CALL_NO_HANDLER", /onRendererCall/],
    ["an uncoded error", boom, "PLUGIN_CALL_FAILED", /^boom$/],
    [
      "a thrown string",
      async () => {
        throw "bad";
      },
      "PLUGIN_CALL_FAILED",
      /^bad$/,
    ],
    ["an answer that is not JSON", async () => ({ n: 1n }), "PLUGIN_CALL_UNSERIALIZABLE", /answer/],
    ["an answer over the budget", async () => "x".repeat(RENDERER_CALL_MAX_BYTES), "PLUGIN_CALL_TOO_LARGE", /answer/],
  ];
  for (const [label, answer, code, message] of cases) {
    const h = relayHarness();
    const plugin = loadedPlugin();
    h.answerWith(answer);
    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(
        h.call(plugin, "ping"),
        (error) => codedAs(code)(error) && message.test(error.message),
        label,
      );
      h.advance(1_000);
    }
    await assert.rejects(h.call(plugin, "ping"), codedAs("PLUGIN_CALL_DISABLED"), `${label} counts`);
    assert.equal(h.sent.length, 5, label);
  }
});

test("the request path splits into the load generation and the package-relative path", () => {
  assert.deepEqual(parseRendererRequestPath("/g1/renderer/index.js"), { generation: 1, requestPath: "renderer/index.js" });
  assert.deepEqual(parseRendererRequestPath("g12/a.js"), { generation: 12, requestPath: "a.js" });
  assert.deepEqual(parseRendererRequestPath("//g3/a/b.js"), { generation: 3, requestPath: "a/b.js" });
  assert.deepEqual(parseRendererRequestPath("/g999999999999999/a.js"), {
    generation: 999_999_999_999_999,
    requestPath: "a.js",
  });
  for (const pathname of ["", "/", "/g1", "/g1/", "/g0/a.js", "/g01/a.js", "/g1234567890123456/a.js", "/G1/a.js", "/x1/a.js", "/g-1/a.js", "/g1.5/a.js"]) {
    assert.equal(parseRendererRequestPath(pathname), null, JSON.stringify(pathname));
  }
});

function assertNotFound(response, label) {
  assert.equal(response.status, 404, label);
  assert.equal(response.headers.get("content-type"), "text/plain", label);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", label);
}

test("plugin-renderer:// answers GET for module files the resolver allows, and 404 for anything else", async (t) => {
  const { dir } = pluginPackage(t);
  const stale = rendererDescriptorFor(loadedPlugin({ dir })).generation;
  const plugin = loadedPlugin({ dir });
  const { generation } = rendererDescriptorFor(plugin);
  const asked = [];
  // The wiring `startup.ts` installs: the runtime's current load decides.
  installPluginRendererProtocol((pluginId, requested, requestPath) => {
    asked.push([pluginId, requested, requestPath]);
    return resolveRendererSourcePath(pluginId === PLUGIN ? plugin : undefined, requested, requestPath);
  });
  assert.deepEqual(PLUGIN_RENDERER_SCHEME_PRIVILEGES, {
    scheme: "plugin-renderer",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  });
  const handler = globalThis.__piProtocolHandlers.get("plugin-renderer");
  const fetchSource = (url, init) => handler(new Request(url, init));
  const base = `plugin-renderer://${PLUGIN}/g${generation}`;

  const entry = await fetchSource(`${base}/renderer/index.js`);
  assert.equal(entry.status, 200);
  assert.equal(await entry.text(), ENTRY_SOURCE);
  assert.deepEqual(Object.fromEntries(entry.headers), {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(ENTRY_SOURCE)),
    "content-type": "text/javascript",
    "x-content-type-options": "nosniff",
  });
  assert.deepEqual(asked, [[PLUGIN, generation, "renderer/index.js"]]);

  for (const [path, type] of [
    ["renderer/lib/chart.js", "text/javascript"],
    ["renderer/extra.mjs", "text/javascript"],
    ["renderer/LOUD.JS", "text/javascript"],
    ["renderer/style.css", "text/css"],
    ["renderer/data.json", "application/json"],
    ["renderer/index.js.map", "application/json"],
  ]) {
    const response = await fetchSource(`${base}/${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-type"), type, path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
  }
  const spaced = await fetchSource(`${base}/renderer/lib/chart.js`.replace("chart", "%63hart"));
  assert.equal(spaced.status, 200, "segments are percent-decoded");

  asked.length = 0;
  for (const [label, url, init] of [
    ["a POST", `${base}/renderer/index.js`, { method: "POST", body: "x" }],
    ["a HEAD", `${base}/renderer/index.js`, { method: "HEAD" }],
    ["no generation", `plugin-renderer://${PLUGIN}/renderer/index.js`],
    ["generation zero", `plugin-renderer://${PLUGIN}/g0/renderer/index.js`],
    ["a zero-padded generation", `plugin-renderer://${PLUGIN}/g0${generation}/renderer/index.js`],
    ["a parent segment", `${base}/../secret.js`],
    ["an encoded parent segment", `${base}/%2e%2e/secret.js`],
    ["nothing after the generation", `${base}/`],
    ["an HTML page", `${base}/renderer/page.html`],
    ["a wasm module", `${base}/renderer/module.wasm`],
    ["a file without an extension", `${base}/renderer/README`],
    ["broken percent-encoding", `${base}/renderer/%E0%A4%A.js`],
  ]) {
    assertNotFound(await fetchSource(url, init), label);
  }
  assert.deepEqual(asked, [], "none of these reach the resolver");

  const refusedByResolver = [
    ["a URL from before the reload", `plugin-renderer://${PLUGIN}/g${stale}/renderer/index.js`],
    ["another plugin", `plugin-renderer://demo.other/g${generation}/renderer/index.js`],
    ["an escape hidden in one segment", `${base}/..%2Fsecret.js`],
    ["an escape hidden after the entry folder", `${base}/renderer%2F..%2F..%2Fsecret.js`],
    ["a link out of the package", `${base}/renderer/escape.js`],
    ["a missing file", `${base}/renderer/missing.js`],
  ];
  for (const [label, url] of refusedByResolver) {
    assertNotFound(await fetchSource(url), label);
  }
  assert.equal(asked.length, refusedByResolver.length);
  assert.deepEqual(asked[2], [PLUGIN, generation, "../secret.js"]);
});

test("only the app's main window may relay a plugin.call", () => {
  // Renderer extensions run in the main window's `PluginRendererHost`; the
  // launcher window loads the same bundle and must not reach plugin entries.
  const source = readFileSync(new URL("../electron/main/ipc/plugin-ipc.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /registrar\.handleWithEvent\(\s*IPC\.invoke\.pluginRendererCall,[\s\S]*?registrar\.assertMainWindowSender\(event\);[\s\S]*?plugins\.callRenderer\(pluginId, method, args\)/,
  );
  assert.doesNotMatch(source, /handle\(IPC\.invoke\.pluginRendererCall/);
});
