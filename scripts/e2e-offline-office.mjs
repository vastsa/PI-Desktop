#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { access, cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { bindingForCustomModel } from "../packages/shared/dist/model-catalog.js";
import { IPC } from "../packages/shared/dist/protocol.js";
import { waitFor } from "./e2e/wait.mjs";
import { verifyPdfSkillRecipes } from "./e2e/pdf-skill-recipes.mjs";

const appBin = process.env.PI_CODE_E2E_APP_BIN;
const pptx = process.argv.includes("--pptx");
const xlsx = process.argv.includes("--xlsx");
const pdf = process.argv.includes("--pdf");
const wx = process.argv.includes("--wx");
assert.ok([pptx, xlsx, pdf, wx].filter(Boolean).length <= 1, "Select one Office scenario at a time.");
const skillName = wx ? "wx-doc-format" : pdf ? "pdf" : xlsx ? "xlsx" : pptx ? "pptx" : "docx";
const sampleVariable = `PI_CODE_E2E_${wx ? "WX" : skillName.toUpperCase()}_SKILL`;
const sample = process.env[sampleVariable];
assert.ok(appBin && sample, `Set PI_CODE_E2E_APP_BIN and ${sampleVariable} to the installed binary and original ${skillName} Skill directory.`);
assert.ok(skillName === "docx" || (!process.argv.includes("--seed-legacy") && !process.env.PI_CODE_E2E_UPGRADE_STATE),
  "Use the Word scenario for legacy upgrade verification.");
assert.equal(process.platform + "/" + process.arch, "linux/arm64");
assert.ok(Object.values(networkInterfaces()).flat().every((address) => address.internal),
  "Run in an isolated network namespace with only loopback enabled.");
await access(join(sample, "SKILL.md"));

const root = await mkdtemp(join(tmpdir(), "pie-office-e2e-"));
const shellEnv = { HOME: root, PATH: process.env.PATH, SHELL: "/bin/bash" };
const runFile = promisify(execFile);
const workspace = join(root, "project");
const otherProject = join(root, "Project");
const skillPath = join(root, ".agents", "skills", skillName);
const skillSource = join(root, "skill-source", skillName);
const skillLink = relative(dirname(skillPath), skillSource);
const preserved = ["data", ".agents", "skill-source"];
const resources = join(dirname(appBin), "resources");
const runtime = join(resources, "office-runtime");
const model = "offline-office-fixture";
const original = "原始 文档.docx";
const created = "新建 文档.docx";
const edited = "另存 文档.docx";
const before = "这是原始正文";
const after = "这是修改正文";
const untouched = "这一段保持原样";
const createdText = "这是可编辑的新文档";
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const probe = "printf '%s\\n' \"$PATH\" \"\${NODE_PATH-}\"; command -v node || :; command -v python || :";
const skillScript = (name) => quote(join(skillPath, "scripts", "office", name));
const bash = (command) => ({ name: "Bash", args: { command } });
const loadSkill = () => ({ name: "Skill", args: { id: skillId } });
const words = [
  "import sys, xml.etree.ElementTree as E",
  "root = E.parse(sys.argv[1])",
  "for node in root.findall('.//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t'): print(node.text or '')",
].join("\n");
const wordSteps = () => [
  loadSkill(),
  bash([
    `node make.cjs ${quote(created)} ${quote(createdText)}`,
    `python ${skillScript("validate.py")} ${quote(created)}`,
    `python ${skillScript("unpack.py")} ${quote(original)} unpacked`,
    `python -B -c ${quote(words)} unpacked/word/document.xml`,
  ].join(" && ")),
  { name: "Edit", args: { path: "unpacked/word/document.xml", old_string: before, new_string: after } },
  bash([
    `test ! -e ${quote(edited)}`,
    `python ${skillScript("pack.py")} unpacked ${quote(edited)} --original ${quote(original)}`,
    `python ${skillScript("validate.py")} ${quote(edited)}`,
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
let turn = 0;
const toolPrefix = () => `office_${turn}_`;
const completionMarker = () => `OFFICE_RUNTIME_FIXTURE_${turn}_COMPLETE`;
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
    results = request.messages.filter((message) => message.role === "tool" && message.tool_call_id?.startsWith(toolPrefix()))
      .map((message) => toolText(message.content));
    const tool = steps[results.length];
    if (steps[0]?.name === "Skill" && results.length) {
      assert.ok(results[0].includes(`Location: ${join(skillPath, "SKILL.md")}`), results[0]);
      if (pdf) verifyPdfSkillRecipes(results[0]);
      else if (wx) assert.match(results[0], /scripts\/run\.sh[\s\S]*--review/);
      else assert.ok(results[0].includes(xlsx ? "scripts/recalc.py" : "scripts/office/unpack.py"), results[0]);
    }
    if (tool) assert.ok(tools.includes(tool.name), `Missing ${tool.name}`);
    const delta = tool ? { role: "assistant", tool_calls: [{
      index: 0, id: `${toolPrefix()}${results.length}`, type: "function",
      function: { name: tool.name, arguments: JSON.stringify(tool.args) },
    }] } : { role: "assistant", content: completionMarker() };
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
      ...shellEnv, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
      PI_DESKTOP_DATA_DIR: join(root, "data"), PI_CODING_AGENT_DIR: join(root, "agent"),
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

async function restart({ evaluate, invoke }) {
  const quit = async () => {
    await invoke(IPC.invoke.appQuit);
    await waitFor(() => evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"][aria-labelledby="lifecycle-confirmation-title"]');
      const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find(button => button.textContent.trim() === "Quit");
      if (!confirm) return false;
      confirm.click(); return true;
    })()`), 10_000, "Quit confirmation");
  };
  const [[code]] = await Promise.all([
    once(desktop, "exit", { signal: AbortSignal.timeout(20_000) }),
    quit(),
  ]);
  assert.equal(code, 0, "Pie Code should exit normally before restart");
  connected.close();
  return boot();
}

async function selectOffice({ evaluate }, mode) {
  const label = { global: "Everywhere", projects: "Projects", off: "Off" }[mode];
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
  await waitFor(() => evaluate(`Boolean((${row})?.querySelector(".scope-compact-trigger.is-${mode}"))`),
    20_000, "extension state " + label);
}

async function runTurn({ invoke }, providerId, label, plan, { projectPath, sessionId, deny, beforeApprove } = {}) {
  const { session } = sessionId
    ? await invoke(IPC.invoke.sessionGet, sessionId)
    : await invoke(IPC.invoke.sessionCreate, { title: label, projectPath, mode: "agent", providerId, modelId: model });
  assert.equal(session.projectPath ?? undefined, projectPath);
  turn++;
  steps = plan;
  results = [];
  modelError = undefined;
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
    const result = await invoke(IPC.invoke.sessionGet, session.id);
    if (!JSON.stringify(result).includes(completionMarker())) return false;
    const { runningSessionIds } = await invoke(IPC.invoke.sessionList);
    return !runningSessionIds.includes(session.id);
  }, 45_000, `${label}: completion`, 150);
  assert.equal(results.length, plan.length);
  return { sessionId: session.id, results: [...results] };
}

async function newProjectSession({ evaluate, invoke }, path) {
  const group = `[data-sidebar-project-group=${JSON.stringify(path)}]`;
  await waitFor(() => evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(group + ' [data-action="toggle-project-collapse"]')});
    if (!button?.getClientRects().length) return false;
    button.click(); return true;
  })()`), 20_000, "sidebar project " + path);
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(group + '[data-current-workspace="true"]')}))`),
    20_000, "active sidebar project " + path);

  const { sessions } = await invoke(IPC.invoke.sessionList);
  const existing = new Set(sessions.map(session => session.id));
  await waitFor(() => evaluate(`(() => {
    const button = [...document.querySelectorAll('[data-nav="new-task"]')].find(item => item.getClientRects().length);
    if (!button) return false;
    button.click(); return true;
  })()`), 20_000, "New Task");
  let session;
  await waitFor(async () => {
    const { sessions } = await invoke(IPC.invoke.sessionList);
    session = sessions.find(item => !existing.has(item.id));
    return session;
  }, 20_000, "new sidebar session");
  assert.equal(session.projectPath, path, "New Task should use the selected project");
  return session.id;
}

const legacyId = "pie.offline-office";
const runtimeId = "pie.office-runtime";
const legacyTitle = "Office upgrade fixture";
const upgradeState = process.env.PI_CODE_E2E_UPGRADE_STATE;

async function installLinkedSkill() {
  await mkdir(dirname(skillPath), { recursive: true });
  await cp(resolve(sample), skillSource, { recursive: true, verbatimSymlinks: true });
  await symlink(skillLink, skillPath, "dir");
}

async function seedLegacy() {
  assert.ok(upgradeState, "Set PI_CODE_E2E_UPGRADE_STATE to an empty test directory.");
  await installLinkedSkill();
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
  for (const name of preserved) {
    await cp(join(root, name), join(upgradeState, name), { recursive: true, verbatimSymlinks: true });
  }
  console.log("PASS: legacy installation saved an enabled project scope, session and user Skill.");
}

function stdout(result) {
  const { exitCode, stdout, stderr } = JSON.parse(result);
  assert.equal(exitCode, 0, result + "\n" + stderr);
  return stdout;
}

async function snapshot(directory, excluded = []) {
  const files = await readdir(directory, { recursive: true, withFileTypes: true });
  return Object.fromEntries(await Promise.all(files
    .filter((file) => file.isFile() || file.isSymbolicLink())
    .map((file) => [file, relative(directory, join(file.parentPath, file.name))])
    .filter(([, name]) => !excluded.includes(name.split("/", 1)[0]))
    .map(async ([file, name]) => {
      const path = join(directory, name);
      return [name, file.isSymbolicLink() ? await readlink(path) : await readFile(path)];
    })));
}

async function checkProjectPicker(app, checkBash, officeOn, officeOff) {
  await selectOffice(app, "projects");
  const option = (path) => `[...document.querySelectorAll(".scope-popover [role=option]")].find(
    option => option.querySelector(".scope-option-path")?.textContent === ${JSON.stringify(path)})`;
  for (const path of [workspace, otherProject]) {
    await waitFor(() => app.evaluate(`Boolean(${option(path)})`), 10_000, "project picker lists " + path);
  }

  const select = async (path, selected) => {
    await app.evaluate(`(() => {
      const option = ${option(path)};
      if (option.getAttribute("aria-selected") !== ${JSON.stringify(String(selected))}) option.click();
    })()`);
    await waitFor(() => app.evaluate(`(${option(path)})?.getAttribute("aria-selected") === ${JSON.stringify(String(selected))}`),
      10_000, "project picker selection " + path);
  };
  await select(workspace, true);
  await select(otherProject, false);
  await checkBash(workspace, officeOn);
  await checkBash(otherProject, officeOff.get(otherProject));
  await select(otherProject, true);
  await checkBash(workspace, officeOn);
  await checkBash(otherProject, officeOn);
  await select(workspace, false);
  await checkBash(workspace, officeOff.get(workspace));
  await checkBash(otherProject, officeOn);
  // Leave only the project that contains the Word fixture selected.
  await select(workspace, true);
  await select(otherProject, false);
  await app.evaluate(`document.querySelector(".scope-popover-close").click()`);
}

async function discoverSkill(app) {
  const { skills } = await app.invoke(IPC.invoke.skillList, { level: "global" });
  const skill = skills.find((item) => item.name === skillName);
  assert.equal(skill?.path, join(skillPath, "SKILL.md"));
  skillId = skill.id;
  assert.ok((await app.invoke(IPC.invoke.composerCommands)).commands.some((command) => command.skillId === skillId));
}

async function connectFixtureModel(app) {
  const { provider: configured } = await app.invoke(IPC.invoke.providersCreate, {
    name: "Office fixture", vendorKey: "custom", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    authKind: "none", apiStyle: "chat_completions", defaultModelId: model, models: [bindingForCustomModel(model)],
  });
  return configured.id;
}

async function startDocumentScenario(projectName) {
  await mkdir(workspace);
  if (wx) await cp(resolve(sample), skillPath, { recursive: true, verbatimSymlinks: true });
  else await installLinkedSkill();
  const skillFiles = await snapshot(sample);
  assert.deepEqual(await snapshot(wx ? skillPath : skillSource), skillFiles);
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const app = await boot();
  await app.invoke(IPC.invoke.settingsSet, { language: "en", defaultPermissionMode: "ask" });
  await discoverSkill(app);
  const providerId = await connectFixtureModel(app);
  await app.invoke(IPC.invoke.projectGroupCreate, { name: projectName, folders: [workspace] });
  await selectOffice(app, "global");
  const run = (label, plan, options) => runTurn(app, providerId, label, plan, { projectPath: workspace, ...options });
  return { run, skillFiles };
}

async function verifyWx() {
  const template = join(skillPath, "assets/wx_template.docx");
  const state = join(skillPath, ".deps/.wxdf-state.json");
  await Promise.all(["OFFLINE_PACKAGE", "scripts/run.sh", "assets/wx_template.docx", "wheelhouse/wheels.tar.xz"]
    .map((name) => access(join(sample, name))));
  const { run, skillFiles } = await startDocumentScenario("WX project");
  await assert.rejects(stat(join(skillPath, ".deps")), { code: "ENOENT" }, "Start with the original offline archive, before first use.");
  const inputs = [
    { file: "原始 说明.md", text: "这是 Markdown 原文。", output: "排版 Markdown.docx", audit: "转换 Markdown.json" },
    { file: "原始 文档.docx", text: "这是 Word 原文。", output: "排版 Word.docx", audit: "转换 Word.json" },
  ];
  const review = "独立 审查.md";
  const title = "离线技术说明";
  await writeFile(join(workspace, inputs[0].file), `# ${title}\n\n## 1. 验证目标\n\n${inputs[0].text}\n`);
  execFileSync(join(runtime, "node/bin/node"), ["-e", `
const { writeFile } = require('node:fs/promises');
const { Document, HeadingLevel, Packer, Paragraph } = require('docx');
const [file, title, text] = process.argv.slice(1);
const doc = new Document({ sections: [{ children: [
  new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
  new Paragraph({ text: '1. 验证目标', heading: HeadingLevel.HEADING_1 }),
  new Paragraph(text),
] }] });
Packer.toBuffer(doc).then(bytes => writeFile(file, bytes)).catch(error => { console.error(error); process.exitCode = 1; });
`, inputs[1].file, title, inputs[1].text], {
    cwd: workspace, env: { ...shellEnv, NODE_PATH: join(runtime, "node/lib/node_modules") },
  });
  const originals = await snapshot(workspace);
  const path = (file) => quote(join(workspace, file));
  const launch = `WX_DOC_FORMAT_RELEASE=1 sh ${quote(join(skillPath, "scripts/run.sh"))}`;
  const convert = ({ file, output, audit }) =>
    `${launch} --input ${path(file)} --output ${path(output)} --template ${quote(template)} --report ${path(audit)}`;

  const { results: denied } = await run("Deny the first WX conversion.", [loadSkill(), bash(convert(inputs[0]))], { deny: true });
  assert.match(denied[1], /denied|rejected/i);
  assert.deepEqual(await snapshot(workspace), originals);
  assert.deepEqual(await snapshot(skillPath), skillFiles);

  const readback = `
import json, sys, xml.etree.ElementTree as ET, zipfile
ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
def attr(name):
    return '{' + ns['w'] + '}' + name
with zipfile.ZipFile(sys.argv[1]) as doc:
    body = ET.fromstring(doc.read('word/document.xml'))
    styles = ET.fromstring(doc.read('word/styles.xml'))
with open(sys.argv[2], encoding='utf-8') as report:
    summary = json.load(report)['public_summary']
style_names = {s.get(attr('styleId')): s.find('w:name', ns).get(attr('val'))
    for s in styles.findall('w:style', ns)}
paragraphs = []
for p in body.findall('w:body/w:p', ns):
    style = p.find('w:pPr/w:pStyle', ns)
    paragraphs.append([''.join(t.text or '' for t in p.findall('.//w:t', ns)),
        style_names.get(style.get(attr('val'))) if style is not None else None])
print(json.dumps([summary, paragraphs]))`;
  const { results: conversions } = await run("Convert Markdown and Word using the original WX Skill.", [
    loadSkill(), bash("command -v python3"), ...inputs.map((input) => bash(convert(input))),
    ...inputs.map(({ output, audit }) => bash(`python3 -B -c ${quote(readback)} ${path(output)} ${path(audit)}`)),
  ]);
  assert.equal(stdout(conversions[1]).trim(), join(runtime, "bin/python3"));
  for (const [index, { text }] of inputs.entries()) {
    stdout(conversions[2 + index]);
    const [summary, paragraphs] = JSON.parse(stdout(conversions[2 + inputs.length + index]));
    assert.ok(paragraphs.some(([body, style]) => body === title && style === "文档标题"), JSON.stringify(paragraphs));
    assert.ok(paragraphs.some(([body]) => body === text), JSON.stringify(paragraphs));
    assert.equal(summary.schema_version, "1.0");
    assert.equal(summary.status, "completed", JSON.stringify(summary));
    assert.equal(summary.manual_review_required, false);
    assert.equal(summary.unexpected_styles_count, 0);
    assert.ok(Array.isArray(summary.diagnostic_codes));
    const auditStatus = (key) => summary.audits[key]?.status ?? summary.audits[key];
    for (const key of ["model_audit", "saved_output_audit"]) assert.equal(auditStatus(key), "passed", JSON.stringify(summary));
    for (const key of ["audit", "appendix_preservation_audit"]) {
      assert.ok(["passed", "not_run", "not_applicable", "skipped"].includes(auditStatus(key)), JSON.stringify(summary));
    }
  }

  const { results: reviewed } = await run("Review the original Word document, without converting it.", [
    loadSkill(), bash(`${launch} --review --input ${path(inputs[1].file)} --template ${quote(template)} --report-md ${path(review)}`),
    { name: "Read", args: { path: review } },
  ]);
  stdout(reviewed[1]);
  const score = /总分：(\d+(?:\.\d+)?)\/100/.exec(reviewed[2]);
  assert.ok(score && Number(score[1]) <= 100, reviewed[2]);
  assert.match(reviewed[2], /## 整改建议[\s\S]*开头的手工编号多余，请删掉/);
  for (const [name, bytes] of Object.entries(originals)) assert.deepEqual(await readFile(join(workspace, name)), bytes);
  assert.equal(JSON.parse(await readFile(state, "utf8")).python_tag, "cp312");
  // The original installer keeps its generated dependencies and lock in the user Skill directory.
  const installed = await snapshot(skillPath, [".deps", ".deps.lock"]);
  assert.deepEqual(Object.keys(installed).sort(), Object.keys(skillFiles).sort());
  for (const [name, content] of Object.entries(skillFiles)) assert.deepEqual(installed[name], content, `WX Skill file changed: ${name}`);
  console.log(`PASS: original standalone WX Skill, Bash denial, first-use offline setup, Markdown and DOCX conversion with audited readback, independent review (${score[1]}/100), and source preservation.`);
}

// Independent one-page inputs with a real xref and predictable text.
function plainPdf(text) {
  const stream = `BT /F1 12 Tf 36 144 Td (${text}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let document = "%PDF-1.4\n";
  const entries = objects.map((object, index) => {
    const offset = document.length;
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  return document + `xref\n0 6\n0000000000 65535 f \n${entries.join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${document.length}\n%%EOF\n`;
}

async function verifyPdf() {
  const { run, skillFiles } = await startDocumentScenario("PDF project");
  const pages = ["第一份 源文件.pdf", "第二份 源文件.pdf"];
  const merged = "按序 合并.pdf";
  const directory = "另存 PDF";
  const office = [
    { file: "独立 文档.docx", text: "文档验收", filter: "writer_pdf_Export" },
    { file: "独立 演示.pptx", text: "演示验收", filter: "impress_pdf_Export" },
    { file: "独立 表格.xlsx", text: "表格验收", filter: "calc_pdf_Export" },
  ];
  const outputPath = (file) => join(directory, file.replace(/\.[^.]+$/, ".pdf"));
  await writeFile(join(workspace, pages[0]), plainPdf("First source page"));
  await writeFile(join(workspace, pages[1]), plainPdf("Second source page"));
  execFileSync(join(runtime, "node/bin/node"), ["-e", `
const fs = require('node:fs/promises');
const { Document, Packer, Paragraph } = require('docx');
const PptxGenJS = require('pptxgenjs');
const [word, wordText, deck, deckText] = process.argv.slice(1);
const ppt = new PptxGenJS();
ppt.addSlide().addText(deckText, { x: 1, y: 1, w: 7, h: 1 });
Promise.all([
  Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(wordText)] }] }))
    .then(bytes => fs.writeFile(word, bytes)),
  ppt.writeFile({ fileName: deck }),
]).catch(error => { console.error(error); process.exitCode = 1; });
`, office[0].file, office[0].text, office[1].file, office[1].text], {
    cwd: workspace, env: { ...process.env, NODE_PATH: join(runtime, "node/lib/node_modules") },
  });
  execFileSync(join(runtime, "python/bin/python3"), ["-I", "-B", "-c", `
import sys, xlsxwriter
with xlsxwriter.Workbook(sys.argv[1]) as book:
    book.add_worksheet().write("A1", sys.argv[2])
`, office[2].file, office[2].text], { cwd: workspace });
  const inputs = await snapshot(workspace);

  const python = (program, ...args) => `python -c ${[program, ...args].map(quote).join(" ")}`;
  const extract = (file) => python(`
import json, pypdf, sys
print(json.dumps([pypdf.__file__, [p.extract_text().strip() for p in pypdf.PdfReader(sys.argv[1]).pages]]))
`, file);
  const merge = python(`
import pypdf, sys
writer = pypdf.PdfWriter()
for source in sys.argv[2:]:
    for page in pypdf.PdfReader(source).pages:
        writer.add_page(page)
with open(sys.argv[1], "xb") as output:
    writer.write(output)
`, merged, pages[1], pages[0]); // Deliberately reverse the source order.
  const exportOffice = [
    `mkdir -- ${quote(directory)}`,
    ...office.flatMap(({ file, filter }) => [
      `soffice --headless --convert-to pdf:${filter} --outdir ${quote(directory)} ${quote(file)}`,
      `test -s ${quote(outputPath(file))}`,
    ]),
  ].join(" && ");
  const absent = async () => {
    for (const name of [merged, directory]) await assert.rejects(stat(join(workspace, name)), { code: "ENOENT" });
  };
  const { results: denied } = await run("Deny PDF writes.", [bash(`${merge} && ${exportOffice}`)], { deny: true });
  assert.match(denied[0], /denied|rejected/i);
  await absent();

  function readPages(result) {
    const [module, text] = JSON.parse(stdout(result));
    assert.ok(module.startsWith(runtime + "/python/"), `pypdf resolved outside Office Runtime: ${module}`);
    return text;
  }
  const { results: pdfResults } = await run("Use the installed PDF Skill to extract and merge.", [
    loadSkill(), bash(extract(pages[0])), bash(merge), bash(extract(merged)),
  ]);
  assert.deepEqual(readPages(pdfResults[1]), ["First source page"]);
  stdout(pdfResults[2]);
  assert.deepEqual(readPages(pdfResults[3]), ["Second source page", "First source page"]);

  const { results: exports } = await run("Export the three independent Office inputs to PDF.", [
    bash("command -v soffice"), bash(exportOffice), ...office.map(({ file }) => bash(extract(outputPath(file)))),
  ]);
  assert.equal(stdout(exports[0]).trim(), join(runtime, "bin/soffice"));
  stdout(exports[1]);
  for (const [index, { text }] of office.entries()) assert.deepEqual(readPages(exports[index + 2]), [text]);
  for (const [name, bytes] of Object.entries(inputs)) assert.deepEqual(await readFile(join(workspace, name)), bytes);
  assert.equal(await readlink(skillPath), skillLink);
  assert.deepEqual(await snapshot(skillSource), skillFiles);
  console.log("PASS: original PDF Skill, Bash denial, text extraction, ordered merge, Word/PowerPoint/Excel PDF readback and source preservation.");
}

async function verifyPptx() {
  const source = "原始 演示.pptx";
  const fresh = "新建 演示.pptx";
  const copy = "另存 演示.pptx";
  const sourceTitle = "原始首页";
  const updatedTitle = "另存后的首页";
  const newTitle = "新建可编辑演示";
  const secondTitle = "第二页保持原样";
  const { run, skillFiles } = await startDocumentScenario("PPT project");
  await writeFile(join(workspace, "make-ppt.cjs"), `
const PptxGenJS = require('pptxgenjs');
const fs = require('node:fs/promises');
async function main() {
  const pptx = new PptxGenJS();
  for (const [title, color] of [[process.argv[3], '336699'], [${JSON.stringify(secondTitle)}, '993366']]) {
    const slide = pptx.addSlide();
    slide.background = { color };
    slide.addText(title, { x: 0.7, y: 0.7, w: 8, h: 1, fontSize: 26 });
  }
  await fs.writeFile(process.argv[2], await pptx.write({ outputType: 'nodebuffer' }), { flag: 'wx' });
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
`);
  const make = (file, title) => `node make-ppt.cjs ${quote(file)} ${quote(title)}`;
  const extract = (file) => `python -m markitdown ${quote(file)}`;
  const script = (file) => quote(join(skillPath, "scripts", file));
  const absent = (file) => assert.rejects(stat(join(workspace, file)), { code: "ENOENT" });
  const { results: denied } = await run("Decline creating an editable presentation.", [bash(make(fresh, newTitle))], { deny: true });
  assert.match(denied[0], /denied|rejected/i);
  await absent(fresh);
  const { results: [prepared] } = await run("Prepare the original presentation.", [bash(make(source, sourceTitle))], {
    beforeApprove: () => absent(source),
  });
  stdout(prepared);
  const originalBytes = await readFile(join(workspace, source));

  let bashApprovals = 0;
  const { results: ppt } = await run("Use the installed pptx Skill to extract, create, and save a copy.", [
    { name: "Skill", args: { id: skillId } },
    bash([
      `node -p ${quote("require.resolve('pptxgenjs')")}`,
      `python -c ${quote("import markitdown, PIL; print(markitdown.__file__); print(PIL.__file__)")}`,
      "command -v soffice && command -v pdftoppm",
      extract(source),
      `python ${script("thumbnail.py")} ${quote(source)} ${quote("原稿 缩略图")}`,
      make(fresh, newTitle),
      `python ${skillScript("unpack.py")} ${quote(source)} unpacked`,
    ].join(" && ")),
    { name: "Edit", args: { path: "unpacked/ppt/slides/slide1.xml", old_string: sourceTitle, new_string: updatedTitle } },
    bash([
      `test ! -e ${quote(copy)}`,
      `python ${script("clean.py")} unpacked`,
      `python ${skillScript("pack.py")} unpacked ${quote(copy)} --original ${quote(source)}`,
      extract(fresh),
      extract(copy),
    ].join(" && ")),
  ], {
    beforeApprove: (name) => name === "Bash" ? absent(bashApprovals++ === 0 ? fresh : copy) : undefined,
  });
  const sourceText = stdout(ppt[1]);
  for (const path of sourceText.split("\n").slice(0, 5)) {
    assert.ok(path.startsWith(runtime + "/"), `PPT dependency came from outside Office Runtime: ${path}`);
  }
  assert.ok(sourceText.includes(sourceTitle) && sourceText.includes(secondTitle), sourceText);
  const result = stdout(ppt[3]);
  assert.match(result, /All validations PASSED!/);
  for (const title of [newTitle, updatedTitle, secondTitle]) assert.ok(result.includes(title), result);
  execFileSync(join(runtime, "python/bin/python3"), ["-I", "-B", "-c", `
import sys
from PIL import Image
with Image.open(sys.argv[1]) as image:
    pixels = image.convert("RGB").getdata()
    for expected in [(51, 102, 153), (153, 51, 102)]:
        count = sum(all(abs(actual - target) <= 12 for actual, target in zip(pixel, expected)) for pixel in pixels)
        assert count > 1000, f"Slide color {expected} missing from the rendered thumbnail"
`, join(workspace, "原稿 缩略图.jpg")]);
  const readback = (name) => JSON.parse(execFileSync(join(runtime, "python/bin/python3"), ["-I", "-B", "-c", `
import json, sys
from pptx import Presentation
print(json.dumps([[shape.text for shape in slide.shapes if shape.has_text_frame]
                  for slide in Presentation(sys.argv[1]).slides]))
`, join(workspace, name)], { encoding: "utf8" }));
  assert.deepEqual(readback(fresh), [[newTitle], [secondTitle]]);
  assert.deepEqual(readback(copy), [[updatedTitle], [secondTitle]]);
  assert.deepEqual(await readFile(join(workspace, source)), originalBytes);
  assert.equal(await readlink(skillPath), skillLink);
  assert.deepEqual(await snapshot(skillSource), skillFiles, "Skill source changed after running its original commands");
  console.log("PASS: linked pptx Skill discovery, permission denial and approval, extraction, thumbnails, editable creation, and save-as with source preservation.");
}

async function verifyXlsx() {
  const source = "原始 工作簿.xlsx";
  const fresh = "新建 工作簿.xlsx";
  const copy = "另存 工作簿.xlsx";
  const { run, skillFiles } = await startDocumentScenario("Excel project");
  const abs = (file) => join(workspace, file);
  await writeFile(abs("workbook.py"), `
import sys
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font

path, second, *source = sys.argv[1:]
book = load_workbook(source[0]) if source else Workbook()
sheet = book.active
if not source:
    sheet.title = "销售"
    sheet.append(["城市", "金额"])
    sheet.append(["北京", 100])
    sheet.append(["成都", 150])
    sheet["B4"] = "=SUM(B2:B3)"
    reference = book.create_sheet("保留")
    reference.append(["说明", "金额"])
    reference.append(["保持原样", 42.5])
    reference["A1"].font = Font(bold=True)
    reference["B2"].number_format = "0.00"
sheet["B3"] = int(second)
with open(path, "xb") as output:
    book.save(output)
`);
  const make = (file, amount, from = "") => `python workbook.py ${quote(file)} ${amount}${from ? " " + quote(from) : ""}`;
  const absent = (file) => assert.rejects(stat(abs(file)), { code: "ENOENT" });
  const { results: [denied] } = await run("Decline creating a workbook.", [bash(make(fresh, 150))], { deny: true });
  assert.match(denied, /denied|rejected/i);
  await absent(fresh);
  const { results: [prepared] } = await run("Prepare the source workbook.", [bash(make(source, 150))],
    { beforeApprove: () => absent(source) });
  stdout(prepared);
  const original = await readFile(abs(source));
  const analyze = `import sys, pandas, openpyxl
print(pandas.__file__)
print(openpyxl.__file__)
sheets = pandas.read_excel(sys.argv[1], sheet_name=None)
print(int(sheets["销售"]["金额"].sum()))
print(sheets["保留"].iloc[0]["说明"])
`;
  const { results: [, edited] } = await run("Load the xlsx Skill, analyze the source, create, and save a copy.", [
    loadSkill(),
    bash([`python -c ${quote(analyze)} ${quote(source)}`, make(fresh, 150), make(copy, 160, source)].join(" && ")),
  ], { beforeApprove: () => Promise.all([absent(fresh), absent(copy)]) });
  const [pandasPath, openpyxlPath, total, untouchedText] = stdout(edited).trimEnd().split("\n");
  for (const path of [pandasPath, openpyxlPath]) {
    assert.ok(path.startsWith(runtime + "/"), `Excel library came from outside Office Runtime: ${path}`);
  }
  assert.deepEqual([total, untouchedText], ["250", "保持原样"]);

  const readback = (file) => JSON.parse(execFileSync(join(runtime, "python/bin/python3"), ["-I", "-B", "-c", `
import json, sys
from openpyxl import load_workbook
book = load_workbook(sys.argv[1])
cache = load_workbook(sys.argv[1], data_only=True)
reference = book["保留"]
print(json.dumps([book.sheetnames, book["销售"]["B3"].value, book["销售"]["B4"].value,
    cache["销售"]["B4"].value, list(reference.values), reference["A1"].font.bold,
    reference["B2"].number_format]))
`, abs(file)], { encoding: "utf8" }));
  const expected = (second, cached) => [
    ["销售", "保留"], second, "=SUM(B2:B3)", cached, [["说明", "金额"], ["保持原样", 42.5]], true, "0.00",
  ];
  const check = (cachedFresh, cachedCopy) => {
    assert.deepEqual(readback(fresh), expected(150, cachedFresh));
    assert.deepEqual(readback(copy), expected(160, cachedCopy));
  };
  check(null, null);
  const recalc = (name) => `python ${quote(join(skillPath, "scripts", "recalc.py"))} ${quote(name)} 15`;
  const { results: [, ...runs] } = await run("Use the xlsx Skill to recalculate both output workbooks.",
    [loadSkill(), bash(recalc(fresh)), bash(recalc(copy))]);
  for (const result of runs) {
    assert.deepEqual(JSON.parse(stdout(result)), { status: "success", total_errors: 0, error_summary: {}, total_formulas: 1 });
  }
  check(250, 260);
  assert.deepEqual(await readFile(abs(source)), original);
  assert.equal(await readlink(skillPath), skillLink);
  assert.deepEqual(await snapshot(skillSource), skillFiles);
  await assert.rejects(stat(join(root, ".config/libreoffice")), { code: "ENOENT" });
  console.log("PASS: original xlsx Skill, permission denial and approval, analysis, creation and save-as, formula caches 250 and 260, and preservation of source, styles, and untouched sheet.");
}

async function verifyWord() {
  await mkdir(workspace);
  if (upgradeState) {
    for (const name of preserved) {
      await cp(join(upgradeState, name), join(root, name), { recursive: true, verbatimSymlinks: true });
    }
  } else {
    await installLinkedSkill();
  }
  assert.equal(await readlink(skillPath), skillLink);
  const skillFiles = await snapshot(skillSource);
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
  const system = async () => (await runFile("/bin/bash", ["-lc", probe], {
    cwd: root, env: shellEnv, encoding: "utf8", timeout: 5_000,
  })).stdout;
  const terminal = await system();
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
  await discoverSkill(app);
  const providerId = await connectFixtureModel(app);
  await app.invoke(IPC.invoke.settingsSet, { defaultProviderId: providerId, defaultModelId: model });
  const run = (label, plan, opts) => runTurn(app, providerId, label, plan, opts);
  const readBash = async (projectPath, sessionId) => {
    const { results: [result] } = await run(`Check the Bash environment for ${projectPath ?? "an unbound session"}.`,
      [bash(probe)], { projectPath, sessionId });
    return stdout(result);
  };
  const checkBash = async (projectPath, expected, sessionId) => {
    assert.equal(await readBash(projectPath, sessionId), expected);
  };

  await mkdir(otherProject);
  for (const path of [workspace, otherProject]) {
    await app.invoke(IPC.invoke.projectGroupCreate, { name: path.split("/").at(-1), folders: [path] });
  }
  const off = new Map();
  for (const path of [workspace, otherProject, undefined]) {
    const baseline = await readBash(path);
    assert.ok(!baseline.includes(runtime));
    off.set(path, baseline);
  }
  await selectOffice(app, "global");
  const on = await readBash(undefined);
  assert.ok(on.includes(join(runtime, "node/bin/node")), on);
  assert.ok(on.includes(join(runtime, "bin/python")), on);
  assert.equal(await system(), terminal);
  await checkProjectPicker(app, checkBash, on, off);
  await checkBash(undefined, off.get(undefined));
  await selectOffice(app, "global");
  await checkBash(workspace, on);
  await checkBash(otherProject, on);
  await selectOffice(app, "projects");

  // Registered project groups are not automatically opened in the sidebar.
  const sidebar = await app.invoke(IPC.invoke.sidebarPreferencesGet);
  await app.invoke(IPC.invoke.sidebarPreferencesSet, { ...sidebar, openProjectPaths: [workspace, otherProject] });
  app = await restart(app);
  const scoped = await row();
  assert.equal(scoped?.enabled, true);
  assert.deepEqual(scoped.scope, { mode: "projects", projects: [workspace] });
  const checkSkillOutsideScope = async (projectPath, sessionId) => {
    const { results } = await run("Load the user Skill and check Bash outside Office Runtime.",
      [loadSkill(), bash(probe)], { projectPath, sessionId });
    assert.equal(stdout(results[1]), off.get(projectPath));
  };
  await checkSkillOutsideScope(otherProject, await newProjectSession(app, otherProject));
  await checkBash(workspace, on, await newProjectSession(app, workspace));
  await checkSkillOutsideScope(undefined);
  assert.equal(await system(), terminal);

  const rejectPath = join(workspace, "不得 创建.docx");
  const { results: denied } = await run("Decline the document write.", [
    bash(`node make.cjs ${quote(rejectPath)} ${quote(createdText)}`),
  ], { projectPath: workspace, deny: true });
  assert.match(denied[0], /denied|rejected/i);
  await assert.rejects(stat(rejectPath), { code: "ENOENT" });

  let bashApprovals = 0;
  const { sessionId: wordSessionId, results: word } = await run("Use the installed docx Skill to extract, create and save a copy.", wordSteps(), {
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
  assert.equal(await readlink(skillPath), skillLink);
  assert.deepEqual(await snapshot(skillSource), skillFiles, "Skill source changed after running the original commands");

  await selectOffice(app, "off");
  await checkBash(workspace, off.get(workspace), wordSessionId);
  app = await restart(app);
  assert.equal((await row())?.enabled, false);
  await checkBash(workspace, off.get(workspace));
  assert.equal((await app.invoke(IPC.invoke.skillList, { level: "global" })).skills.find((item) => item.id === skillId)?.path,
    join(skillPath, "SKILL.md"));
  assert.equal(await readlink(skillPath), skillLink);
  assert.deepEqual(await snapshot(skillSource), skillFiles);
  console.log(`PASS: ${upgradeState ? "legacy upgrade" : "clean installation"}, global and project-scoped Bash, selected scope after restart, separate terminal, permission denial and linked docx Skill in the selected project, Chinese DOCX readback and source preservation, disablement before and after restart.`);
}

try {
  if (process.argv.includes("--seed-legacy")) await seedLegacy();
  else if (wx) await verifyWx();
  else if (pdf) await verifyPdf();
  else if (pptx) await verifyPptx();
  else if (xlsx) await verifyXlsx();
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
