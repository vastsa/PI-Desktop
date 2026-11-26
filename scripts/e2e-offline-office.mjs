#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { bindingForCustomModel } from "../packages/shared/dist/model-catalog.js";
import { IPC } from "../packages/shared/dist/protocol.js";
import { waitFor } from "./e2e/wait.mjs";

const appBin = process.env.PI_CODE_E2E_APP_BIN;
const sample = process.env.PI_CODE_E2E_DOCX_SKILL;
assert.ok(appBin && sample, "Set PI_CODE_E2E_APP_BIN and PI_CODE_E2E_DOCX_SKILL to the installed binary and original docx Skill directory.");
assert.equal(process.platform + "/" + process.arch, "linux/arm64");
assert.ok(Object.values(networkInterfaces()).flat().every((address) => address.internal),
  "Run in an isolated network namespace with only loopback enabled.");
await access(join(sample, "SKILL.md"));

const root = await mkdtemp(join(tmpdir(), "pie-office-e2e-"));
const workspace = join(root, "project");
const skillPath = join(root, ".agents", "skills", "docx");
const resources = join(dirname(appBin), "resources");
const runtime = join(resources, "office-runtime");
const model = "offline-office-fixture";
const marker = "OFFICE_RUNTIME_FIXTURE_COMPLETE";
const original = "原始 文档.docx";
const created = "新建 文档.docx";
const edited = "另存 文档.docx";
const before = "这是原始正文";
const after = "这是修改正文";
const untouched = "这一段保持原样";
const createdText = "这是可编辑的新文档";
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const probe = "printf '%s\\n' \"\${NODE_PATH-}\"; command -v node || :; command -v python || :";
const skillScript = (name) => quote(join(skillPath, "scripts", "office", name));
const bash = (command) => ({ name: "Bash", args: { command } });
const words = [
  "import sys, xml.etree.ElementTree as E",
  "root = E.parse(sys.argv[1])",
  "for node in root.findall('.//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t'): print(node.text or '')",
].join("\n");
const wordSteps = () => [
  { name: "Skill", args: { id: skillId } },
  bash([
    `node make.cjs ${quote(created)} ${quote(createdText)}`,
    `python -B ${skillScript("validate.py")} ${quote(created)}`,
    `python -B ${skillScript("unpack.py")} ${quote(original)} unpacked`,
    `python -B -c ${quote(words)} unpacked/word/document.xml`,
  ].join(" && ")),
  { name: "Edit", args: { path: "unpacked/word/document.xml", old_string: before, new_string: after } },
  bash([
    `test ! -e ${quote(edited)}`,
    `python -B ${skillScript("pack.py")} unpacked ${quote(edited)} --original ${quote(original)}`,
    `python -B ${skillScript("validate.py")} ${quote(edited)}`,
  ].join(" && ")),
];

const toolText = (content) => Array.isArray(content)
  ? content.map((part) => part.text ?? "").join("\n")
  : String(content);
let skillId;
let desktop;
let connected;
let log = "";
let modelError;
let steps = [];
let results = [];

const provider = createServer(async (req, res) => {
  try {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ data: [{ id: model }] }));
    }
    assert.equal(req.url, "/v1/chat/completions");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    const tools = request.tools.map((tool) => tool.function.name);
    results = request.messages.filter((message) => message.role === "tool" && /^office_\d+$/.test(message.tool_call_id))
      .map((message) => toolText(message.content));
    const tool = steps[results.length];
    if (steps[0]?.name === "Skill" && results.length) {
      assert.ok(results[0].includes(`Location: ${join(skillPath, "SKILL.md")}`), results[0]);
      assert.match(results[0], /scripts\/office\/unpack\.py/);
    }
    if (tool) assert.ok(tools.includes(tool.name), `Missing ${tool.name}`);
    const delta = tool ? { role: "assistant", tool_calls: [{
      index: 0, id: `office_${results.length}`, type: "function",
      function: { name: tool.name, arguments: JSON.stringify(tool.args) },
    }] } : { role: "assistant", content: marker };
    const frame = (change, reason) => "data: " + JSON.stringify({
      id: "office-fixture", object: "chat.completion.chunk", created: 1, model,
      choices: [{ index: 0, delta: change, finish_reason: reason }],
    }) + "\n\n";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(frame(delta, null) + frame({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n");
  } catch (error) {
    modelError = error;
    res.writeHead(500).end("Invalid fixture request");
  }
});

async function boot() {
  log = "";
  desktop = spawn(appBin, ["--remote-debugging-port=0", "--user-data-dir=" + join(root, "profile")], {
    cwd: dirname(appBin),
    env: {
      PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
      HOME: root, PI_DESKTOP_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: join(root, "agent"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [desktop.stdout, desktop.stderr]) stream.on("data", (chunk) => { log += chunk; });
  let page;
  await waitFor(async () => {
    if (desktop.exitCode !== null) throw new Error("Pie Code quit before opening its window.");
    const port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(log)?.[1];
    if (!port) return false;
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((result) => result.json());
    page = pages.find((entry) => entry.type === "page" && /renderer\/index\.html$/.test(entry.url));
    return page;
  }, 30_000, "Pie Code window", 200);
  connected = new WebSocket(page.webSocketDebuggerUrl);
  await once(connected, "open");
  let seq = 0;
  const evaluate = async (expression) => {
    const call = ++seq;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connected.removeEventListener("message", receive);
        reject(new Error("Desktop evaluation timed out."));
      }, 10_000);
      function receive(event) {
        const result = JSON.parse(event.data);
        if (result.id !== call) return;
        connected.removeEventListener("message", receive);
        clearTimeout(timer);
        resolve(result);
      }
      connected.addEventListener("message", receive);
    });
    connected.send(JSON.stringify({
      id: call, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true },
    }));
    const result = await reply;
    assert.ok(result.result && !result.result.exceptionDetails, JSON.stringify(result));
    return result.result.result.value;
  };
  const wire = (channel, ...args) => evaluate("window.piDesktop?.invoke(... " + JSON.stringify([channel, ...args]) + ")");
  await waitFor(async () => (await wire(IPC.invoke.appGetVersion))?.data?.hostVersion, 30_000, "Host ready", 200);
  const invoke = async (channel, ...args) => {
    const result = await wire(channel, ...args);
    assert.equal(result?.ok, true, channel + ": " + JSON.stringify(result));
    return result.data;
  };
  return { evaluate, invoke };
}

async function stop() {
  connected?.close();
  if (!desktop || desktop.exitCode !== null || desktop.signalCode !== null) return;
  const exited = once(desktop, "exit");
  desktop.kill("SIGTERM");
  const force = setTimeout(() => desktop.kill("SIGKILL"), 5_000);
  try { await exited; } finally { clearTimeout(force); }
}

async function selectOffice({ evaluate }, enabled) {
  const targetClass = enabled ? "is-global" : "is-off";
  const label = enabled ? "Everywhere" : "Off";
  const row = `[...document.querySelectorAll(".plugins-row")].find(
    el => el.querySelector(".plugins-row-id")?.textContent === "pie.office-runtime")`;
  await waitFor(() => evaluate(`(() => {
    if ((${row})?.getClientRects().length) return true;
    const nav = document.querySelector('[data-nav=plugins]');
    if (!nav) return false;
    nav.click(); return true;
  })()`), 20_000, "Extensions navigation");
  await waitFor(() => evaluate(`(${row})?.querySelector(".plugins-row-name")?.textContent === "Office Runtime"`),
    20_000, "English extension name");
  await waitFor(() => evaluate(`(() => {
    const trigger = (${row})?.querySelector(".scope-compact-trigger");
    if (!trigger) return false;
    trigger.click(); return true;
  })()`), 20_000, "bundled Office Runtime card");
  await waitFor(() => evaluate(`(() => {
    const option = [...document.querySelectorAll(".scope-compact-option")]
      .find(el => el.getAttribute("aria-label") === ${JSON.stringify(label)});
    if (!option) return false;
    option.click(); return true;
  })()`), 20_000, "extension scope " + label);
  await waitFor(() => evaluate(`Boolean((${row})?.querySelector(".scope-compact-trigger.${targetClass}"))`),
    20_000, "extension state " + label);
}

async function runTurn({ invoke }, providerId, label, plan, { projectPath, deny, beforeApprove } = {}) {
  steps = plan;
  results = [];
  modelError = undefined;
  const { session } = await invoke(IPC.invoke.sessionCreate, {
    title: label, projectPath, mode: "agent", providerId, modelId: model,
  });
  assert.equal(session.projectPath ?? undefined, projectPath);
  await invoke(IPC.invoke.agentPrompt, {
    sessionId: session.id, content: label, permissionMode: "ask",
  });
  const handled = new Set();
  for (const { name } of plan.filter((step) => step.name === "Bash" || step.name === "Edit")) {
    let permission;
    await waitFor(async () => {
      if (modelError) throw modelError;
      const pending = await invoke(IPC.invoke.pendingInteractive, { sessionId: session.id });
      permission = pending.permissions.find((entry) => entry.toolName === name && !handled.has(entry.requestId));
      return permission;
    }, 30_000, `${label}: ${name} approval`, 150);
    handled.add(permission.requestId);
    await beforeApprove?.(name);
    await invoke(IPC.invoke.toolResolvePermission, {
      requestId: permission.requestId, decision: deny ? "deny" : "allow-once",
    });
  }
  await waitFor(async () => {
    if (modelError) throw modelError;
    return JSON.stringify(await invoke(IPC.invoke.sessionGet, session.id)).includes(marker);
  }, 45_000, `${label}: completion`, 150);
  assert.equal(results.length, plan.length);
  return [...results];
}

const legacyId = "pie.offline-office";
const runtimeId = "pie.office-runtime";
const legacyTitle = "Office upgrade fixture";
const upgradeState = process.env.PI_CODE_E2E_UPGRADE_STATE;

async function seedLegacy() {
  assert.ok(upgradeState, "Set PI_CODE_E2E_UPGRADE_STATE to an empty test directory.");
  await cp(resolve(sample), skillPath, { recursive: true });
  const app = await boot();
  await app.invoke(IPC.invoke.settingsSet, { language: "en", defaultPermissionMode: "ask" });
  const { plugin } = await app.invoke(IPC.invoke.pluginSetScope, {
    id: legacyId, scope: { mode: "projects", projects: [workspace] },
  });
  assert.equal(plugin?.scope.mode, "projects");
  await app.invoke(IPC.invoke.pluginEnable, legacyId);
  const { plugins } = await app.invoke(IPC.invoke.pluginList);
  assert.equal(plugins.find((plugin) => plugin.id === legacyId)?.enabled, true);
  await app.invoke(IPC.invoke.sessionCreate, { title: legacyTitle, mode: "agent" });
  await stop();
  await mkdir(upgradeState);
  for (const name of ["data", ".agents"]) await cp(join(root, name), join(upgradeState, name), { recursive: true });
  console.log("PASS: legacy installation saved an enabled project scope, session and user Skill.");
}

function stdout(result) {
  const { exitCode, stdout, stderr } = JSON.parse(result);
  assert.equal(exitCode, 0, result + "\n" + stderr);
  return stdout;
}

async function snapshot(directory) {
  const files = (await readdir(directory, { recursive: true, withFileTypes: true })).filter((file) => file.isFile());
  return Object.fromEntries(await Promise.all(files.map(async (file) => {
    const filePath = join(file.parentPath, file.name);
    return [filePath.slice(directory.length), await readFile(filePath)];
  })));
}

async function verifyWord() {
  await mkdir(workspace);
  if (upgradeState) {
    for (const name of ["data", ".agents"]) await cp(join(upgradeState, name), join(root, name), { recursive: true });
  } else {
    await cp(resolve(sample), skillPath, { recursive: true });
  }
  const skillFiles = await snapshot(skillPath);
  assert.deepEqual(skillFiles, await snapshot(sample));
  await writeFile(join(workspace, "make.cjs"), `
const { Document, Packer, Paragraph, TextRun } = require('docx');
const fs = require('node:fs');
const doc = new Document({ sections: [{ children: [
  new Paragraph({ children: [new TextRun({ text: process.argv[3], bold: true })] }),
  new Paragraph(${JSON.stringify(untouched)}),
] }] });
Packer.toBuffer(doc).then((buf) => fs.writeFileSync(process.argv[2], buf, { flag: 'wx' }));
`);
  const node = join(runtime, "node/bin/node");
  execFileSync(node, ["make.cjs", original, before], {
    cwd: workspace, env: { ...process.env, NODE_PATH: join(runtime, "node/lib/node_modules") },
  });
  const originalBytes = await readFile(join(workspace, original));
  const system = () => execFileSync("/bin/bash", ["-lc", probe], { encoding: "utf8" });
  const terminal = system();
  assert.ok(!terminal.includes(runtime));

  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  let app = await boot();
  const row = async () => {
    const { plugins } = await app.invoke(IPC.invoke.pluginList);
    assert.ok(!plugins.some((plugin) => plugin.id === legacyId));
    return plugins.find((plugin) => plugin.id === runtimeId);
  };
  assert.equal((await row())?.bundled, true);
  assert.equal((await row())?.enabled, false);
  assert.equal((await row())?.scope.mode, "global");
  if (upgradeState) {
    const { sessions } = await app.invoke(IPC.invoke.sessionList);
    assert.ok(sessions.some((session) => session.title === legacyTitle));
  }
  await app.invoke(IPC.invoke.settingsSet, { language: "en", defaultPermissionMode: "ask" });
  const { skills } = await app.invoke(IPC.invoke.skillList, { level: "global" });
  const skill = skills.find((item) => item.name === "docx");
  assert.equal(skill?.path, join(skillPath, "SKILL.md"));
  skillId = skill.id;
  assert.ok((await app.invoke(IPC.invoke.composerCommands)).commands.some((command) => command.skillId === skillId));
  const { provider: configured } = await app.invoke(IPC.invoke.providersCreate, {
    name: "Office fixture", vendorKey: "custom", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    authKind: "none", apiStyle: "chat_completions", defaultModelId: model, models: [bindingForCustomModel(model)],
  });
  const run = (label, plan, opts) => runTurn(app, configured.id, label, plan, opts);
  const off = stdout((await run("Check the Bash environment before enabling.", [bash(probe)]))[0]);
  assert.ok(!off.includes(runtime));

  await selectOffice(app, true);
  const on = stdout((await run("Check the runtime in an unbound local session.", [bash(probe)]))[0]);
  assert.ok(on.includes(join(runtime, "node/bin/node")), on);
  assert.ok(on.includes(join(runtime, "python/bin/python")), on);
  assert.equal(system(), terminal);

  const rejectPath = join(workspace, "不得 创建.docx");
  const denied = await run("Decline the document write.", [
    bash(`node make.cjs ${quote(rejectPath)} ${quote(createdText)}`),
  ], { projectPath: workspace, deny: true });
  assert.match(denied[0], /denied|rejected/i);
  await assert.rejects(stat(rejectPath), { code: "ENOENT" });

  let bashApprovals = 0;
  const word = await run("Use the installed docx Skill to extract, create and save a copy.", wordSteps(), {
    projectPath: workspace,
    async beforeApprove(name) {
      if (name !== "Bash") return;
      const output = bashApprovals++ === 0 ? created : edited;
      await assert.rejects(stat(join(workspace, output)), { code: "ENOENT" });
    },
  });
  assert.match(stdout(word[1]), new RegExp(before));
  assert.match(stdout(word[1]), new RegExp(untouched));
  assert.match(stdout(word[3]), /All validations PASSED!/);
  await access(join(workspace, edited));
  const readback = (name) => JSON.parse(execFileSync(join(runtime, "python/bin/python3"), ["-I", "-B", "-c", `
import json, sys, xml.etree.ElementTree as ET, zipfile
with zipfile.ZipFile(sys.argv[1]) as doc:
    root = ET.fromstring(doc.read("word/document.xml"))
ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
print(json.dumps(["".join(t.text or "" for t in p.findall(".//w:t", ns)) for p in root.findall(".//w:body/w:p", ns)]))
`, join(workspace, name)], { encoding: "utf8" }));
  assert.deepEqual(readback(created), [createdText, untouched]);
  assert.deepEqual(readback(edited), [after, untouched]);
  assert.deepEqual(await readFile(join(workspace, original)), originalBytes);
  assert.deepEqual(await snapshot(skillPath), skillFiles);

  const other = join(root, "Project");
  await mkdir(other);
  await app.invoke(IPC.invoke.pluginSetScope, { id: runtimeId, scope: { mode: "projects", projects: [workspace] } });
  assert.equal(stdout((await run("Check the selected project.", [bash(probe)], { projectPath: workspace }))[0]), on);
  assert.equal(stdout((await run("Check the project outside the scope.", [bash(probe)], { projectPath: other }))[0]), off);

  await selectOffice(app, false);
  await stop();
  app = await boot();
  assert.equal((await row())?.enabled, false);
  assert.equal(stdout((await run("Check a new local session after disabling.", [bash(probe)]))[0]), off);
  assert.equal((await app.invoke(IPC.invoke.skillList, { level: "global" })).skills.find((item) => item.id === skillId)?.path,
    join(skillPath, "SKILL.md"));
  assert.deepEqual(await snapshot(skillPath), skillFiles);
  console.log(`PASS: ${upgradeState ? "legacy upgrade" : "clean installation"}, global unbound and selected project Bash, separate terminal, permission denial, unmodified docx Skill discovery and invocation, Chinese DOCX readback and source preservation, disablement after restart.`);
}

try {
  if (process.argv.includes("--seed-legacy")) await seedLegacy();
  else await verifyWord();
} catch (error) {
  console.error(log.slice(-9000));
  throw error;
} finally {
  await stop();
  provider.close();
  // Chromium children can finish writing profile data after the main process exits.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
