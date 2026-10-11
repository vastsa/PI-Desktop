import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PLUGIN_MARK_SEND_MAX_BYTES, validateManifest } from "@pi-desktop/plugin-sdk";
import { serializeComposerFileReferences } from "@pi-desktop/shared";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hostProcessEntry = join(here, "../electron/main/plugin-host-process.mjs");
const PLUGIN_DIR = join(here, "../resources/plugins/pi.session-mentions");

process.env.PI_DESKTOP_DATA_DIR = mkdtempSync(join(tmpdir(), "pi-session-mentions-data-"));

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

/*
 * Session Mentions, the bundled `pi.session-mentions` plugin, run the way the
 * app runs it: manifest through the SDK validator and the plugin runtime, its
 * headless entry in a real plugin host process reading sessions through
 * desktop control, its renderer entry through the production loader into the
 * slot registry, and a picked row placed and sent as a real composer mark.
 * It ships as plain modules, so nothing is built first.
 */

const PLUGIN = "pi.session-mentions";
const SESSION = "session-1";
const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "manifest.json"), "utf8"));
const ALPHA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BETA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function transcript(id, turns, size = 20) {
  return Array.from({ length: turns }, (_, i) => [
    { id: `${id}-u${i}`, role: "user", content: `Question ${i}`, status: "complete" },
    { id: `${id}-t${i}`, role: "assistant", content: "", thinking: "SECRET_THINKING", status: "complete" },
    { id: `${id}-x${i}`, role: "tool", content: "SECRET_TOOL", toolName: "bash", status: "complete" },
    { id: `${id}-a${i}`, role: "assistant", content: `Answer ${i} ${"z".repeat(size)}`, status: "complete" },
  ]).flat();
}

const CURRENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TASK_1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TASK_2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SESSIONS = [
  // The session being typed in: nothing answered yet, so nothing to reference.
  { id: CURRENT, title: "new task", updatedAt: "2026-10-09T12:00:00.000Z",
    messages: [{ id: "c-u0", role: "user", content: "Compare with", status: "complete" }] },
  { id: BETA, title: "Beta 发布\n计划", updatedAt: "2026-10-09T11:00:00.000Z", messages: transcript(BETA, 3, 30_000) },
  { id: ALPHA, title: "Alpha migration", updatedAt: "2026-10-09T10:00:00.000Z", messages: transcript(ALPHA, 12) },
  { id: TASK_1, title: "new task", updatedAt: "2026-10-09T09:30:00.000Z",
    messages: [{ id: "d-u0", role: "user", content: "Fix the login bug", status: "complete" },
      { id: "d-a0", role: "assistant", content: "Fixed.", status: "complete" }] },
  { id: TASK_2, title: "new task", updatedAt: "2026-10-09T08:15:00.000Z",
    messages: [{ id: "e-u0", role: "user", content: "Draft the release notes", status: "complete" },
      { id: "e-a0", role: "assistant", content: "Drafted.", status: "complete" }] },
];

/** Desktop control as the app wires it: `session/list` and paged `session/get`. */
function desktopControl(calls) {
  return {
    operations: [
      { id: "session/list", channel: "sessionList", description: "List durable sessions.", risk: "read" },
      { id: "session/get", channel: "sessionGet", description: "Read a session and its transcript.", risk: "read" },
      { id: "session/delete", channel: "sessionDelete", description: "Delete a session.", risk: "dangerous" },
    ],
    invoke: async ({ operation, args }) => {
      calls.push(operation);
      if (operation === "session/list") {
        return { sessions: SESSIONS.map(({ messages, ...summary }) => ({ ...summary, source: "desktop" })) };
      }
      if (operation === "session/get") {
        const { id, messageLimit, messageBefore } = args[0];
        const session = SESSIONS.find((candidate) => candidate.id === id);
        const end = messageBefore ?? session.messages.length;
        const start = Math.max(0, end - messageLimit);
        return { session: { id, title: session.title, messages: session.messages.slice(start, end),
          messageStart: start, messageEnd: end, hasMoreBefore: start > 0 } };
      }
      throw new Error(`unexpected operation ${operation}`);
    },
  };
}

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

async function pluginWindow(t) {
  const calls = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    getWorkspacePath: () => null,
    desktopControl: desktopControl(calls),
    audit: () => {},
  });
  t.after(() => runtime.disposeAll());
  await runtime.loadFromPath(PLUGIN_DIR, manifest.permissions);
  const ssr = await slotSsr(t);
  const { RendererModuleLoader } = await ssr.load("/src/plugins/renderer-host/loader.ts");
  const { createDispatchChannel } = await ssr.load("/src/plugins/renderer-host/dispatch.ts");
  const { ComposerDraftBridge } = await ssr.load("/src/features/chat/composer/plugins/draft-bridge.ts");
  const descriptor = runtime.rendererDescriptor(PLUGIN);
  const drafts = new ComposerDraftBridge((message, error) => assert.fail(`${message}: ${error?.stack ?? error}`));
  const loader = new RendererModuleLoader({
    importModule: () =>
      import(pathToFileURL(runtime.resolveRendererSource(PLUGIN, descriptor.generation, descriptor.entry)).href),
    registry: ssr.registry,
    injectStyle: () => () => {},
    openLayer: () => assert.fail("no layers"),
    openChannel: (pluginId, actions) =>
      createDispatchChannel(pluginId, actions, {
        pluginCall: (id, method, args) => runtime.callRenderer(id, method, args),
        composer: drafts,
        userGesture: () => false,
      }),
    subscribeDraft: (pluginId, listener) => drafts.subscribe(pluginId, listener),
    warn: (message, error) => assert.fail(`${message}: ${error?.stack ?? error}`),
  });
  const outcome = await loader.load({ pluginId: PLUGIN, version: manifest.version, descriptor });
  t.after(() => loader.unload(PLUGIN));
  return { ...ssr, runtime, outcome, calls };
}

test("the manifest asks only for the renderer and desktop control", () => {
  const validation = validateManifest(manifest);
  assert.equal(validation.ok, true, JSON.stringify(validation));
  assert.deepEqual(manifest.permissions, ["renderer.extension", "desktop.control"]);
  assert.deepEqual(manifest.rendererActions, ["plugin.call"]);
  assert.deepEqual(manifest.rendererCallMethods, ["sessions.items", "sessions.snapshots"]);
});

test("the plugin declares no settings: Session references live in Settings › AI", () => {
  assert.equal(manifest.contributes, undefined, "no second place to change the budget or the turn limit");
});

test("@ lists recent sessions, and a pick sends the session's recent Q&A", async (t) => {
  const win = await pluginWindow(t);
  assert.equal(win.registry.triggerFor("@")?.pluginId, PLUGIN, "the plugin owns @");
  assert.equal(win.registry.triggerFor("@")?.placement, "first", "its group leads the file rows");
  const { askPluginTrigger } = await win.load("/src/features/chat/composer/plugins/plugin-triggers.ts");
  const { placePluginMark } = await win.load("/src/features/chat/composer/plugins/plugin-marks.ts");
  const { items } = win.registry.triggerFor("@");
  const ask = (query) => askPluginTrigger(items, { trigger: "@", query }, PLUGIN);

  const rows = await ask("");
  const { shortStamp } = await import(pathToFileURL(join(PLUGIN_DIR, "service.js")).href);
  assert.deepEqual(rows.map((row) => row.label), [
    "Beta 发布 计划",
    "Alpha migration",
    `New task · ${shortStamp(SESSIONS[3].updatedAt)}`,
    `New task · ${shortStamp(SESSIONS[4].updatedAt)}`,
  ], "newest first, one line, the unanswered current session left out, equal titles told apart");
  assert.deepEqual(rows.map((row) => row.detail.replace(/^.+? · (?=“)/, "")), [
    "“Question 0” · first turn only · 2 between omitted",
    "“Question 0” · first + 9 most recent turns · 2 between omitted",
    "“Fix the login bug” · 1 Q&A turn",
    "“Draft the release notes” · 1 Q&A turn",
  ], "after the update time: the first question, then the coverage");
  assert.match(rows[0].detail, /^(\d{4}-\d\d-\d\d|\d+ (min|h|d) ago|just now) · /);
  for (const row of rows) {
    assert.ok(Buffer.byteLength(row.send, "utf8") <= PLUGIN_MARK_SEND_MAX_BYTES, "the host kept the row");
    assert.doesNotMatch(row.send, /SECRET_/);
  }
  // The list the composer draws: sessions on top, files after them under their
  // own heading; index 0 (the default highlight, what Enter picks) is the newest session.
  const { orderTriggerGroups } = await win.load("/src/features/chat/composer/plugins/plugin-triggers.ts");
  const { completionGroupHeadings } = await win.load("/src/features/chat/composer/completion-groups.ts");
  const files = [{ kind: "path", entry: { path: "README.md", kind: "file" }, match: { ranges: [] } }];
  const sessions = rows.map((row) => ({ kind: "plugin", pluginId: PLUGIN, pluginName: "Session Mentions", row }));
  const list = orderTriggerGroups(files, sessions, win.registry.triggerFor("@").placement);
  assert.equal(list[0].kind, "plugin");
  assert.equal(list[0].row.label, "Beta 发布 计划");
  assert.equal(list.at(-1).kind, "path");
  assert.deepEqual([...completionGroupHeadings(list).entries()].map(([index, heading]) => [index, heading.kind]), [
    [0, "plugin"],
    [rows.length, "files"],
  ]);
  assert.deepEqual((await ask("alpha")).map((row) => row.label), ["Alpha migration"]);
  assert.ok(win.calls.every((operation) => operation === "session/list" || operation === "session/get"));

  const alpha = rows.find((row) => row.label === "Alpha migration");
  const draft = "Compare with @al";
  const tokenStart = draft.indexOf("@");
  const text = draft.slice(0, tokenStart);
  const placed = placePluginMark([], text, { pluginId: PLUGIN, label: alpha.label, send: alpha.send }, SESSION);
  const sent = serializeComposerFileReferences(`${text}${placed.token} please`, placed.references);
  assert.match(sent, /^Compare with \n```pi\.session-mentions:chat\n<referenced-chat id="aaaaaaaa-[^"]+" title="Alpha migration" turns="10" first-turn="true" omitted="2"/);
  assert.match(sent, /Q: Question 0\nA: Answer 0 z+\n\n\[… 2 turns omitted here\]\n\nQ: Question 3\n/, "the first turn, then the newest");
  assert.match(sent, /Q: Question 11\nA: Answer 11 z+\n<\/referenced-chat>\n```\n please$/);
  assert.doesNotMatch(sent, /Question [12]\n/, "the turns between are omitted");

  // The sent message in the transcript: the plugin's blockRenderer draws the
  // fence as a closed card; the words around it stay text.
  const { UserMessageText } = await win.load("/src/features/chat/transcript/UserMessageText.tsx");
  const html = win.render(createElement(UserMessageText, { text: sent }));
  assert.match(html, /^<span data-source-start="0" data-source-end="13">Compare with <\/span>/);
  assert.match(html, /<div class="pi-plugin-block-renderer" style="max-height:4000px" data-source-start="13" data-source-end="\d+"><div class="pi-plugin-slot" data-pi-plugin="pi\.session-mentions" data-pi-slot="blockRenderer"><div class="psm-card" data-psm-open="false" data-session-id="aaaaaaaa-/);
  assert.match(html, /<span class="psm-title">Alpha migration<\/span>/);
  assert.match(html, /first \+ 9 recent turns · 2 between omitted · ~\d/);
  assert.doesNotMatch(html, /Question 11|referenced-chat/, "the Q&A is not drawn until the card is opened");
  assert.match(html, /<span data-source-start="\d+" data-source-end="\d+"> please<\/span>$/);
  const end = Number(/class="pi-plugin-block-renderer"[^>]* data-source-end="(\d+)"/.exec(html)[1]);
  assert.equal(sent.slice(end), " please", "the card stands for the whole fence, line breaks included");
});

test("the host's session and context reach the trigger: itself left out, a full context flagged", async (t) => {
  const win = await pluginWindow(t);
  const { askPluginTrigger, pluginTriggerScope } = await win.load("/src/features/chat/composer/plugins/plugin-triggers.ts");
  const { items } = win.registry.triggerFor("@");
  const ask = (query, scope) => askPluginTrigger(items, { trigger: "@", query }, PLUGIN, undefined, scope);

  // Typing in Alpha: Alpha is not offered, though it has answers.
  const roomy = await ask("", pluginTriggerScope(ALPHA, { usedTokens: 10_000, contextWindow: 200_000 }));
  assert.deepEqual(roomy.map((row) => row.label).filter((label) => label.startsWith("Alpha")), []);
  assert.ok(roomy.some((row) => row.label === "Beta 发布 计划"));

  // Nearly full: 25% of 2000 tokens. Beta's first turn (30 000 z) cannot fit, Task 1's small one can.
  const full = await ask("", pluginTriggerScope(ALPHA, { usedTokens: 200_000 - 8_192 - 2_000, contextWindow: 200_000 }));
  const beta = full.find((row) => row.label.endsWith("Beta 发布 计划"));
  assert.equal(beta.label, "⚠ Beta 发布 计划");
  assert.match(beta.detail, /\/compact/);
  assert.doesNotMatch(beta.send, /<referenced-chat/, "no clipped snapshot");
  const task = full.find((row) => row.label.startsWith("New task"));
  assert.match(task.send, /<referenced-chat id="dddddddd-/);

  // Settings › AI › Session references reach the plugin with the scope:
  // max 3 turns is Alpha's first turn and its 2 most recent.
  const scope = pluginTriggerScope(BETA, null, { sessionReferenceBudgetPercent: 100, sessionReferenceMaxTurns: 3 });
  assert.deepEqual(scope.sessionReferences, { budgetPercent: 100, maxTurns: 3 });
  const three = (await ask("alpha", scope)).find((row) => row.label === "Alpha migration");
  assert.deepEqual([...three.send.matchAll(/^Q: (Question \d+)$/gm)].map((match) => match[1]),
    ["Question 0", "Question 10", "Question 11"]);
  assert.match(three.detail, /first \+ 2 most recent turns · 9 between omitted/);
  // The app's UI language reaches the rows: the sidebar's 新建任务, Chinese times and coverage.
  const zh = await ask("", pluginTriggerScope(BETA, null, {}, "zh-CN"));
  const untitled = zh.filter((row) => row.label.startsWith("新建任务 · "));
  assert.equal(untitled.length, 2);
  assert.ok(!zh.some((row) => /new task|New task/.test(row.label)));
  assert.match(untitled[0].detail, /^(\d{4}-\d\d-\d\d|\d+ (分钟|小时|天)前|刚刚) · “.+” · 1 轮问答$/);
  assert.match(zh.find((row) => row.label === "Alpha migration").detail, /首轮 \+ 最近 9 轮 · 中间省略 2 轮$/);
  assert.equal((await ask("新建", pluginTriggerScope(BETA, null, {}, "zh-CN"))).length, 2);
  // Defaults when the settings say nothing: 10 turns.
  const plain = (await ask("alpha", pluginTriggerScope(BETA, null, {}))).find((row) => row.label === "Alpha migration");
  assert.match(plain.send, /turns="10" first-turn="true" omitted="2"/);
});
