import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PLUGIN_RENDERER_ACTIONS, validateManifest } from "@pi-desktop/plugin-sdk";
import { composerToolbar } from "./helpers/composer-toolbar.mjs";
import { fakeLayerDocument } from "./helpers/fake-layer-document.mjs";
import { slotMounts, slotSsr } from "./helpers/slot-ssr.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hostProcessEntry = join(here, "../electron/main/plugin-host-process.mjs");
const LAB_DIR = join(here, "../../../examples/plugins/ui-slots-lab");

// Set before the runtime is imported so per-plugin data lands in a throwaway
// directory instead of the developer's real one.
process.env.PI_DESKTOP_DATA_DIR = mkdtempSync(join(tmpdir(), "pi-ui-slots-lab-data-"));

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

/*
 * The UI Slots Lab (`examples/plugins/ui-slots-lab`), the test plugin with a
 * visible sample in every slot, run the way the app runs it: its manifest
 * through the SDK validator and the plugin runtime, its headless entry in a
 * real plugin host process, and its renderer entry through the production
 * loader into the slot registry the host outlets read. What needs a live
 * window (clicks, crashes the host contains, the size clamps) is driven by
 * the Electron E2E against this same plugin.
 */

const LAB = "lab.ui-slots";
const PROBE = "plugin_lab_ui_slots_lab_probe";
const SESSION = "session-1";
const manifest = JSON.parse(readFileSync(join(LAB_DIR, "manifest.json"), "utf8"));

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

/** The lab loaded in a real runtime, with the grants its manifest asks for. */
async function labRuntime(t) {
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    getWorkspacePath: () => null,
    audit: () => {},
  });
  t.after(() => runtime.disposeAll());
  await runtime.loadFromPath(LAB_DIR, manifest.permissions);
  return runtime;
}

function refusedWith(code) {
  return (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  };
}

/**
 * The lab's renderer entry, loaded by the production loader from the files
 * the runtime serves for its current generation, into the registry the host
 * outlets read. Its `plugin.call` goes to the runtime; its composer words go
 * to a real draft bridge over a fake composer, whose writes are recorded and
 * whose staged files are kept in memory. `gesture.on` stands for a click.
 */
async function labWindow(t) {
  const runtime = await labRuntime(t);
  const ssr = await slotSsr(t);
  const { RendererModuleLoader, rendererModuleUrl } = await ssr.load("/src/plugins/renderer-host/loader.ts");
  const { createDispatchChannel } = await ssr.load("/src/plugins/renderer-host/dispatch.ts");
  const { PluginLayerStack } = await ssr.load("/src/plugins/renderer-layers/layer-stack.ts");
  const { ComposerDraftBridge } = await ssr.load("/src/features/chat/composer/plugins/draft-bridge.ts");
  const layerDocument = fakeLayerDocument();
  const layers = new PluginLayerStack(() => layerDocument);
  const descriptor = runtime.rendererDescriptor(LAB);
  const sheets = new Set();
  const composer = fakeComposer();
  const drafts = new ComposerDraftBridge((message, error) => assert.fail(`${message}: ${error?.stack ?? error}`));
  drafts.register(composer.handle);
  const gesture = { on: false };
  const channels = [];
  const loader = new RendererModuleLoader({
    importModule: (url) => {
      assert.equal(url, rendererModuleUrl(LAB, descriptor), "the loader asks for the current generation");
      return import(pathToFileURL(runtime.resolveRendererSource(LAB, descriptor.generation, descriptor.entry)).href);
    },
    registry: ssr.registry,
    injectStyle: (pluginId, css) => {
      const sheet = { pluginId, css };
      sheets.add(sheet);
      return () => sheets.delete(sheet);
    },
    openLayer: (pluginId) => layers.open(pluginId),
    openChannel: (pluginId, actions) => {
      const channel = createDispatchChannel(pluginId, actions, {
        pluginCall: (id, method, args) => runtime.callRenderer(id, method, args),
        composer: drafts,
        userGesture: () => gesture.on,
      });
      channels.push(channel);
      return channel;
    },
    subscribeDraft: (pluginId, listener) => drafts.subscribe(pluginId, listener),
    warn: (message, error) => assert.fail(`${message}: ${error?.stack ?? error}`),
  });
  const outcome = await loader.load({ pluginId: LAB, version: manifest.version, descriptor });
  t.after(() => loader.unload(LAB));
  return { ...ssr, runtime, loader, outcome, sheets, composer, drafts, gesture, dispatch: channels[0].dispatch };
}

/** A composer on `SESSION`'s draft that renders a write when told to. */
function fakeComposer() {
  const state = { text: "", references: [], writes: [], staged: [] };
  const handle = {
    read: () => ({ draftKey: `session:${SESSION}`, sessionId: SESSION, text: state.text, references: state.references }),
    focused: () => false,
    selection: () => ({ start: state.text.length, end: state.text.length }),
    write: (text, references, caret, focus) => state.writes.push({ text, references, caret, focus }),
    stage: async (sessionId, file) => {
      state.staged.push({ sessionId, file });
      return {
        path: `/scratch/${sessionId}/${file.name}`,
        name: file.name,
        kind: file.mimeType.startsWith("image/") ? "image" : "file",
        mimeType: file.mimeType,
        size: file.data.byteLength,
      };
    },
  };
  return { state, handle };
}

/** The composer renders its last write and tells the bridge. */
function render(lab) {
  const last = lab.composer.state.writes.at(-1);
  lab.composer.state.text = last.text;
  lab.composer.state.references = last.references;
  lab.drafts.publish(lab.composer.handle);
}

const USER = { id: "u1", role: "user", content: "Probe the lab\nplease", status: "complete", createdAt: "2026-09-24T00:00:00.000Z" };
const CHART = "```lab.ui-slots:chart\nalpha,3\nbeta,5\n```";

/** A reply that called the lab's tool and answered with a chart. */
const TURN = [
  USER,
  { id: "a1", role: "assistant", content: "Probing.", status: "complete", createdAt: "2026-09-24T00:00:01.000Z" },
  {
    id: "t1",
    role: "tool",
    content: "",
    status: "complete",
    createdAt: "2026-09-24T00:00:02.000Z",
    toolName: PROBE,
    toolCallId: "call-lab-1",
    toolArgs: { mode: "ok", text: "hi" },
    toolStatus: "success",
    toolResult: { ok: true, mode: "ok", text: "hi", length: 2 },
    toolDurationMs: 7,
  },
  { id: "a2", role: "assistant", content: `Here it is.\n\n${CHART}\n`, status: "complete", createdAt: "2026-09-24T00:00:03.000Z" },
];

async function transcript(ssr) {
  const { MessageRow } = await ssr.load("/src/features/chat/transcript/MessageRow.tsx");
  const { AssistantTurn } = await ssr.load("/src/features/chat/transcript/AssistantTurn.tsx");
  const { buildTranscriptEntries } = await ssr.load("/src/lib/assistant-turns.ts");
  const { createElement } = await import("react");
  const entry = buildTranscriptEntries(TURN).entries.find((candidate) => candidate.kind === "assistant-turn");
  return {
    row: () => ssr.render(createElement(MessageRow, { message: USER, isRunning: false }), { sessionId: SESSION }),
    turn: () => ssr.render(createElement(AssistantTurn, { entry, isActive: false }), { sessionId: SESSION }),
  };
}

/** Every lab sample in `html`, in document order. */
function samples(html) {
  return [...html.matchAll(/data-lab="([^"]*)"/g)].map((match) => match[1]);
}

/** The session every sample that carries one was mounted for. */
function sessions(html) {
  return [...new Set([...html.matchAll(/data-lab-session="([^"]*)"/g)].map((match) => match[1]))];
}

test("the manifest declares exactly what the lab uses", () => {
  const validation = validateManifest(manifest);
  assert.ok(validation.ok, validation.error);
  assert.deepEqual(manifest.rendererActions, [...PLUGIN_RENDERER_ACTIONS], "every action word the host implements");
  assert.deepEqual(manifest.permissions, ["renderer.extension", "agent.tool.register"]);
  assert.deepEqual(manifest.contributes.agentTools.map((tool) => tool.name), ["lab_probe"]);

  // Every word a sample dispatches, and every method it calls, is declared;
  // every declared method is one a sample calls.
  const renderer = join(LAB_DIR, "renderer");
  const source = readdirSync(renderer).map((file) => readFileSync(join(renderer, file), "utf8")).join("\n");
  const words = new Set([...source.matchAll(/run\("([^"]+)"/g)].map((match) => match[1]));
  const methods = new Set([...source.matchAll(/method: "([^"]+)"/g)].map((match) => match[1]));
  assert.deepEqual([...words].sort(), [...manifest.rendererActions].sort());
  assert.deepEqual([...methods].sort(), [...manifest.rendererCallMethods].sort());
});

test("the headless entry answers the lab's calls and runs its tool", async (t) => {
  const runtime = await labRuntime(t);

  assert.deepEqual(await runtime.callRenderer(LAB, "lab.echo", { messageId: "a2" }), { echo: { messageId: "a2" } });
  await assert.rejects(runtime.callRenderer(LAB, "lab.refuse", {}), refusedWith("LAB_REFUSED"));
  const started = Date.now();
  await assert.rejects(runtime.callRenderer(LAB, "lab.stall", {}), refusedWith("PLUGIN_CALL_TIMEOUT"));
  assert.ok(Date.now() - started < 4_000, "a stall ends at the relay's budget, not the plugin's sleep");

  const probe = runtime.getTools().find((tool) => tool.fullName === PROBE);
  assert.ok(probe, "the tool is registered under its qualified name");
  assert.deepEqual(await probe.execute({ text: "hi" }), { ok: true, mode: "ok", text: "hi", length: 2 });
  await assert.rejects(probe.execute({ mode: "fail", text: "x" }), /lab_probe failed on request: x/);
});

test("the renderer entry loads a sample into every slot", async (t) => {
  const lab = await labWindow(t);
  assert.deepEqual(lab.outcome, { status: "loaded" });
  assert.equal(lab.sheets.size, 1, "one style sheet");
  assert.equal([...lab.sheets][0].pluginId, LAB);

  const { row, turn } = await transcript(lab);
  const toolbar = await composerToolbar(t, lab);

  const user = row();
  assert.deepEqual(samples(user), ["userAction:left", "userAction:right"]);
  assert.deepEqual(sessions(user), [SESSION]);

  const reply = turn();
  assert.deepEqual(samples(reply), [
    "toolCard",
    "blockRenderer",
    "assistantAction:left",
    "assistantAction:right",
    "assistantAction:refuse",
    "assistantAction:crash",
    "entryExtra",
    "entryExtra:notes",
  ]);
  assert.deepEqual(sessions(reply), [SESSION]);
  assert.ok(slotMounts(reply).every(([pluginId]) => pluginId === LAB));
  // The fourth right item waits in the ⋯ menu, closed in the first frame.
  assert.match(reply, /<div class="pi-action-overflow" data-side="right">/);
  assert.match(reply, /data-lab="toolCard" data-lab-status="success"/);
  assert.match(reply, /data-lab-output="">result \{&quot;ok&quot;:true,&quot;mode&quot;:&quot;ok&quot;/);
  assert.match(reply, /data-lab="blockRenderer" data-lab-language="lab.ui-slots:chart"/);
  assert.equal([...reply.matchAll(/class="lab-bar-row"/g)].length, 2, "one bar per data line");
  assert.match(reply, /data-lab-message="a2"/, "the entryExtra panel sits under the final reply");

  // The layer launcher and the draft lab open their layers on a click, never
  // on their own.
  assert.deepEqual(samples(toolbar()), [
    "composerControl:left",
    "composerControl:draft",
    "composerControl:right",
    "composerControl:crash",
    "composerControl:layers",
  ]);
  assert.match(toolbar(), /data-lab-draft="none"><\/span>/, "no draft before the first effect");
  assert.equal(lab.registry.triggerFor("#")?.pluginId, LAB, "the lab owns #");
});

test("the samples' calls work through the host channel", async (t) => {
  const lab = await labWindow(t);

  assert.deepEqual(await lab.dispatch("plugin.call", { method: "lab.echo", args: { messageId: "a2" } }), {
    echo: { messageId: "a2" },
  });
  await assert.rejects(lab.dispatch("plugin.call", { method: "lab.refuse" }), refusedWith("LAB_REFUSED"));
  assert.equal((await lab.dispatch("composer.insertText", { text: "lab: hi " })).ok, true);
  assert.deepEqual(
    lab.composer.state.writes.map(({ text, focus }) => ({ text, focus })),
    [{ text: "lab: hi ", focus: true }],
  );
});

test("the # trigger lists the lab's issues, and fails or overflows on request", async (t) => {
  const lab = await labWindow(t);
  const { askPluginTrigger } = await lab.load("/src/features/chat/composer/plugins/plugin-triggers.ts");
  const { items } = lab.registry.triggerFor("#");
  const ask = (query) => askPluginTrigger(items, { trigger: "#", query }, LAB);

  assert.deepEqual(await ask("caret"), [
    { label: "#7", send: "Lab issue #7: Composer loses the caret after a paste", detail: "Composer loses the caret after a paste" },
  ]);
  assert.equal((await ask("")).length, 3);
  assert.equal((await ask("many")).length, 50, "the host keeps its first 50 rows");
  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(await ask("fail"), null, "a throw collapses the lab's group");
  assert.equal(warn.mock.callCount(), 1);
});

test("Polish rewrites the draft around its chips, only from a click", async (t) => {
  const lab = await labWindow(t);
  const { createFileReference, nextChipToken } = await lab.load("/src/features/chat/composer/editor.ts");
  const { polished } = await import(pathToFileURL(join(LAB_DIR, "renderer/composer.mjs")).href);
  const chip = createFileReference("/w/a.ts", "a.ts", SESSION, { kind: "file", token: nextChipToken() });
  lab.composer.state.text = `  fix   ${chip.token}   now  `;
  lab.composer.state.references = [chip];
  lab.drafts.publish(lab.composer.handle);

  const snapshot = await lab.dispatch("composer.readDraft", {});
  await assert.rejects(lab.dispatch("composer.replaceDraft", polished(snapshot)), refusedWith("PLUGIN_DRAFT_REMOTE"));
  lab.gesture.on = true;
  const written = await lab.dispatch("composer.replaceDraft", polished(snapshot));
  const write = lab.composer.state.writes.at(-1);
  const stamp = write.references.at(-1);
  assert.equal(write.text, `Fix ${chip.token} now ${stamp.token}`);
  assert.equal(write.focus, false);
  assert.deepEqual(stamp.plugin, { kind: "mark", pluginId: LAB, send: "(tidied by the UI Slots Lab)" });
  render(lab);

  // Polishing again replaces the stamp instead of adding one.
  const again = await lab.dispatch("composer.readDraft", {});
  assert.equal(again.generation, written.generation);
  await lab.dispatch("composer.replaceDraft", polished(again));
  render(lab);
  const after = await lab.dispatch("composer.readDraft", {});
  assert.equal(after.text, "Fix \uFFFC now \uFFFC");
  assert.deepEqual(
    after.marks.map((mark) => [mark.kind, mark.label]),
    [
      ["host", "a.ts"],
      ["plugin", "lab \u2713"],
    ],
  );
  await assert.rejects(lab.dispatch("composer.replaceDraft", polished(snapshot)), refusedWith("PLUGIN_DRAFT_STALE"));
});

test("the attachment controls stage the lab's files into the session's draft", async (t) => {
  const lab = await labWindow(t);
  const note = await lab.dispatch("attachments.add", {
    name: "lab-note.md",
    mimeType: "text/markdown",
    content: "# Lab note\n",
  });
  render(lab);
  await lab.dispatch("attachments.add", { name: "lab-dot.png", mimeType: "image/png", content: new Uint8Array([137, 80]) });
  render(lab);
  assert.deepEqual(
    lab.composer.state.staged.map(({ sessionId, file }) => [sessionId, file.name, file.data.byteLength]),
    [
      [SESSION, "lab-note.md", 11],
      [SESSION, "lab-dot.png", 2],
    ],
  );
  assert.deepEqual(
    (await lab.dispatch("attachments.list", {})).map(({ name, mimeType, size }) => [name, mimeType, size]),
    [
      ["lab-note.md", "text/markdown", 11],
      ["lab-dot.png", "image/png", 2],
    ],
  );
  assert.equal((await lab.dispatch("composer.readDraft", {})).text, "\uFFFC", "only the note is a chip");
  await assert.rejects(
    lab.dispatch("attachments.add", { name: "passwd.txt", mimeType: "text/plain", content: "/etc/passwd" }),
    refusedWith("PLUGIN_ATTACHMENT_REFERENCE_REFUSED"),
  );
  assert.deepEqual(await lab.dispatch("attachments.remove", { id: note.id }), { ok: true });
  render(lab);
  assert.equal(lab.composer.state.text, "");
  await assert.rejects(lab.dispatch("attachments.remove", { id: "none" }), refusedWith("PLUGIN_ATTACHMENT_NOT_FOUND"));
});

test("unloading the renderer entry takes every sample and its styles with it", async (t) => {
  const lab = await labWindow(t);
  const { row, turn } = await transcript(lab);
  const toolbar = await composerToolbar(t, lab);

  await lab.loader.unload(LAB);
  assert.equal(lab.sheets.size, 0);
  assert.equal(lab.registry.triggerFor("#"), undefined);
  for (const html of [row(), turn(), toolbar()]) {
    assert.deepEqual(samples(html), []);
    assert.deepEqual(slotMounts(html), []);
  }
  await assert.rejects(lab.dispatch("plugin.call", { method: "lab.echo" }), refusedWith("PLUGIN_UNLOADED"));
});
