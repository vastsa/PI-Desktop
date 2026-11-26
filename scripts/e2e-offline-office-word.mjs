#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bindingForCustomModel } from "../packages/shared/dist/model-catalog.js";
import { IPC } from "../packages/shared/dist/protocol.js";
import { waitFor } from "./e2e/wait.mjs";

const appBin = process.env.PI_CODE_E2E_APP_BIN;
const [option, ...extraOptions] = process.argv.slice(2);
assert.ok(!extraOptions.length && (option === undefined || option === "--ppt"), "Expected no argument or --ppt.");
const ppt = option === "--ppt";
assert.ok(appBin, "Set PI_CODE_E2E_APP_BIN to the installed Pie Code binary.");
assert.equal(process.platform + "/" + process.arch, "linux/arm64");
assert.ok(Object.values(networkInterfaces()).flat().every((address) => address.internal),
  "Run in an isolated network namespace with only loopback enabled.");

const root = await mkdtemp(join(tmpdir(), "pie-office-e2e-"));
const workspace = join(root, "project");
const resources = join(dirname(appBin), "resources");
const python = join(resources, "office-runtime/python/bin/python3.12");
const skill = ppt ? "ppt" : "word";
const extension = ppt ? "pptx" : "docx";
const skillDir = join(resources, "plugins", "pie.offline-office", skill);
const launcher = join(skillDir, `${skill}.sh`);
const id = `pie.offline-office/${skill}`;
const model = `offline-${skill}-fixture`;
const created = `新建 样例.${extension}`;
const original = `原始 样例.${extension}`;
const edited = `另存 样例.${extension}`;
const marker = `OFFLINE_${skill.toUpperCase()}_FIXTURE_COMPLETE`;
const requests = [];
const before = "跨格式文字";
const after = "替换内容";
const untouched = ppt ? "不修改的第二页" : "不修改的中文段落";
const newBody = "新建正文含中文";
const hiddenPptText = "隐藏形状中的文字";
const ambiguousPptCopy = "有歧义的 副本.pptx";
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
let connected;
let desktop;
let log = "";
let modelError;

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
    requests.push(request);
    const system = request.messages.filter((message) => ["system", "developer"].includes(message.role));
    const enabled = JSON.stringify(system).includes(id);
    const tools = request.tools.map((tool) => tool.function.name);
    const skillResult = request.messages.find((message) => message.role === "tool" &&
      String(message.content).includes("Location: ") && String(message.content).includes(id));
    let tool;
    if (enabled && !skillResult) {
      assert.ok(tools.includes("Skill"));
      tool = { name: "Skill", arguments: JSON.stringify({ id }) };
    } else if (skillResult && !request.messages.some((message) =>
      message.tool_calls?.some((call) => call.function.name === "Bash"))) {
      const location = /Location: ([^\n]+\/SKILL\.md)/.exec(String(skillResult.content))?.[1];
      assert.equal(location, join(skillDir, "SKILL.md"));
      const office = "/bin/sh " + quote(join(dirname(location), `${skill}.sh`));
      const edit = ppt ? [original, edited, "1", before, after] : [original, edited, before, after];
      const command = (ppt ? [
        `${office} create -- ${quote(created)} < slides.json`,
        "printf '%s\\n' 'Created deck:'",
        `${office} extract -- ${quote(created)}`,
        "printf '%s\\n' 'Source deck:'",
        `${office} extract -- ${quote(original)}`,
        `${office} replace -- ${edit.map(quote).join(" ")}`,
        "printf '%s\\n' 'Edited deck:'",
        `${office} extract -- ${quote(edited)}`,
        `! ${office} replace -- ${[original, ambiguousPptCopy, "1", "1", after].map(quote).join(" ")}`,
      ] : [
        `${office} create ${quote(created)} '中文标题' < body.txt`,
        `${office} extract ${quote(original)}`,
        `${office} replace ${edit.map(quote).join(" ")}`,
      ]).join(" && ");
      assert.ok(tools.includes("Bash"));
      tool = { name: "Bash", arguments: JSON.stringify({ command }) };
    }
    const delta = tool ? { role: "assistant", tool_calls: [{
      index: 0, id: `${skill}_${tool.name}`, type: "function", function: tool,
    }] } : { role: "assistant", content: marker };
    const frame = (change, reason) => "data: " + JSON.stringify({
      id: model, object: "chat.completion.chunk", created: 1, model,
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
    el => el.querySelector(".plugins-row-id")?.textContent === "pie.offline-office")`;
  await waitFor(() => evaluate(`(() => {
    if ((${row})?.getClientRects().length) return true;
    const nav = document.querySelector('[data-nav=plugins]');
    if (!nav) return false;
    nav.click(); return true;
  })()`), 20_000, "Extensions navigation");
  await waitFor(() => evaluate(`(${row})?.querySelector(".plugins-row-name")?.textContent === "Offline Office"`),
    20_000, "English extension name");
  await waitFor(() => evaluate(`(() => {
    const trigger = (${row})?.querySelector(".scope-compact-trigger");
    if (!trigger) return false;
    trigger.click(); return true;
  })()`), 20_000, "bundled Offline Office card");
  await waitFor(() => evaluate(`(() => {
    const option = [...document.querySelectorAll(".scope-compact-option")]
      .find(el => el.getAttribute("aria-label") === ${JSON.stringify(label)});
    if (!option) return false;
    option.click(); return true;
  })()`), 20_000, "extension scope " + label);
  await waitFor(() => evaluate(`Boolean((${row})?.querySelector(".scope-compact-trigger.${targetClass}"))`),
    20_000, "extension state " + label);
}

async function runTurn({ invoke }, providerId, enabled) {
  requests.length = 0;
  const { session } = await invoke(IPC.invoke.sessionCreate, {
    title: `${skill} fixture`, projectPath: workspace, mode: "agent", providerId, modelId: model,
  });
  await invoke(IPC.invoke.agentPrompt, { sessionId: session.id, content: `Perform the offline ${skill} fixture.`, permissionMode: "ask" });
  if (enabled) {
    let permission;
    await waitFor(async () => {
      if (modelError) throw modelError;
      const pending = await invoke(IPC.invoke.pendingInteractive, { sessionId: session.id });
      permission = pending.permissions.find((entry) => entry.toolName === "Bash");
      return permission;
    }, 25_000, "normal Bash approval", 150);
    await assert.rejects(stat(join(workspace, created)), { code: "ENOENT" });
    await invoke(IPC.invoke.toolResolvePermission, { requestId: permission.requestId, decision: "allow-once" });
  }
  await waitFor(async () => {
    if (modelError) throw modelError;
    return JSON.stringify(await invoke(IPC.invoke.sessionGet, session.id)).includes(marker);
  }, 25_000, `${skill} turn completion`, 150);
  assert.equal(JSON.stringify(requests[0]?.messages).includes(id), enabled);
  if (enabled) {
    const results = requests.at(-1).messages.filter((message) => message.role === "tool")
      .map((message) => String(message.content));
    assert.ok(results.some((result) => result.includes(untouched)));
    if (ppt) {
      const bash = JSON.parse(results.find((result) => result.includes("Created deck:")) ?? "{}");
      assert.equal(bash.exitCode, 0, "The PowerPoint command sequence must succeed.");
      assert.ok(bash.stdout.split("Source deck:")[0].includes(`Slide 1\n中文标题\n${newBody}\n\nSlide 2\n新建第二页\n可编辑正文`),
        "The Agent must see text from both slides of the created deck.");
      assert.ok(bash.stdout.split("Edited deck:")[1]?.includes(`Slide 1\n原件首页\n${after}，保留后缀\n1\n页码 1\n\nSlide 2\n${untouched}\n${before}`),
        "The Agent must see the edited first slide and untouched second slide in the saved copy.");
      assert.ok(!bash.stdout.includes(hiddenPptText), "Hidden shape text must not reach the Agent.");
      assert.match(bash.stderr, /Text occurs more than once on this slide/);
      await assert.rejects(stat(join(workspace, ambiguousPptCopy)), { code: "ENOENT" });
    }
  }
}

const py = (script, ...args) => execFileSync(python, ["-I", "-B", "-X", "utf8", "-c", script, ...args], { cwd: workspace });

async function prepareOfficeFiles() {
  if (ppt) {
    await writeFile(join(workspace, "slides.json"), JSON.stringify([
      { title: "中文标题", body: newBody }, { title: "新建第二页", body: "可编辑正文" },
    ]));
    py(`from pptx import Presentation
from pptx.oxml import parse_xml
from pptx.oxml.ns import qn
from pptx.util import Inches
import sys
deck = Presentation()
slide = deck.slides.add_slide(deck.slide_layouts[1])
slide.shapes.title.text = "原件首页"
para = slide.placeholders[1].text_frame.paragraphs[0]
para.add_run().text = "跨格式"
para.runs[0].font.bold = True
para.add_run().text = "文字，保留后缀"
def box(text):
    shape = slide.shapes.add_textbox(0, 0, Inches(2), Inches(1))
    shape.text = text
    return shape
box(${JSON.stringify(hiddenPptText)})._element.find(".//" + qn("p:cNvPr")).set("hidden", "1")
box("1")
footer = box("页码 ")
footer.text_frame.paragraphs[0]._p.append(parse_xml(
    '<a:fld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'id="{9AE197BA-8C2B-4FC0-AFA6-C3138E0160A1}" type="slidenum"><a:t>1</a:t></a:fld>'))
slide = deck.slides.add_slide(deck.slide_layouts[1])
slide.shapes.title.text = ${JSON.stringify(untouched)}
slide.placeholders[1].text = ${JSON.stringify(before)}
deck.save(sys.argv[1])`, original);
    return;
  }
  await writeFile(join(workspace, "body.txt"), `${newBody}\n`);
  py(`from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
import sys
doc = Document()
doc.add_heading("原件标题", level=1)
p = doc.add_paragraph()
p.add_run("跨格式").bold = True
p.add_run("文字，保留后缀").italic = True
doc.add_paragraph(${JSON.stringify(untouched)})
p = doc.add_paragraph()
p.add_run("AB")._r.append(OxmlElement("w:noBreakHyphen"))
p.add_run("CD")
p = doc.add_paragraph()
p.add_run("甲")
tab = OxmlElement("w:ptab")
for key, value in {"alignment": "center", "relativeTo": "margin", "leader": "none"}.items():
    tab.set(qn("w:" + key), value)
p.add_run()._r.append(tab)
p.add_run("乙")
doc.save(sys.argv[1])`, original);
}

async function verifyOfficeFiles(originalBytes) {
  assert.deepEqual(await readFile(join(workspace, original)), originalBytes);
  if (ppt) {
    py(`from pptx import Presentation
from zipfile import ZipFile
import sys
created, original, edited = sys.argv[1:]
new, copy = Presentation(created), Presentation(edited)
assert [(s.shapes.title.text, s.placeholders[1].text) for s in new.slides] == [
    ("中文标题", ${JSON.stringify(newBody)}), ("新建第二页", "可编辑正文")]
assert len(copy.slides) == 2 and copy.slides[0].shapes.title.text == "原件首页"
assert copy.slides[0].placeholders[1].text == "${after}，保留后缀"
assert copy.slides[0].placeholders[1].text_frame.paragraphs[0].runs[0].font.bold
assert copy.slides[1].shapes.title.text == ${JSON.stringify(untouched)}
assert copy.slides[1].placeholders[1].text == ${JSON.stringify(before)}
with ZipFile(original) as a, ZipFile(edited) as b:
    assert a.namelist() == b.namelist()
    assert [part for part in a.namelist() if a.read(part) != b.read(part)] == ["ppt/slides/slide1.xml"]
`, created, original, edited);
    return;
  }
  py(`from docx import Document
from zipfile import ZipFile
import sys
created, original, edited = sys.argv[1:]
new, copy = Document(created), Document(edited)
assert [p.text for p in new.paragraphs] == ["中文标题", "新建正文含中文"]
assert new.paragraphs[0].style.name == "Heading 1"
assert [p.text for p in copy.paragraphs[:3]] == ["原件标题", "${after}，保留后缀", "${untouched}"]
assert [p._p.xml for p in copy.paragraphs[3:]] == [p._p.xml for p in Document(original).paragraphs[3:]]
assert copy.paragraphs[0].style.name == "Heading 1"
assert copy.paragraphs[1].runs[0].bold and copy.paragraphs[1].runs[1].italic
with ZipFile(original) as a, ZipFile(edited) as b:
    assert a.namelist() == b.namelist()
    assert all(a.read(part) == b.read(part) for part in a.namelist() if part != "word/document.xml")
`, created, original, edited);
  const rejected = "不能覆盖.docx";
  const tool = (operation, ...args) => execFileSync("/bin/sh", [launcher, operation, ...args], {
    cwd: workspace, encoding: "utf8", input: "should not overwrite", stdio: "pipe",
  });
  assert.ok(tool("extract", original).split("\n").includes("甲\t乙"));
  for (const separated of ["ABCD", "甲乙"]) {
    assert.throws(() => tool("replace", original, rejected, separated, "collapsed"), /Text was not found/);
    await assert.rejects(stat(join(workspace, rejected)), { code: "ENOENT" });
  }
  for (const [name, bytes] of [[original, originalBytes], [edited, await readFile(join(workspace, edited))]]) {
    assert.throws(() => tool("replace", original, name, before, after), /Output already exists/);
    assert.throws(() => tool("create", name, "Not a new document"), /Output already exists/);
    assert.deepEqual(await readFile(join(workspace, name)), bytes);
  }
}

try {
  await mkdir(workspace);
  await prepareOfficeFiles();
  const originalBytes = await readFile(join(workspace, original));
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const app = await boot();
  const row = async (current) => (await current.invoke(IPC.invoke.pluginList)).plugins.find((plugin) => plugin.id === "pie.offline-office");
  assert.equal((await row(app))?.bundled, true);
  assert.equal((await row(app))?.enabled, false);
  await app.invoke(IPC.invoke.settingsSet, { language: "en", defaultPermissionMode: "ask" });
  await app.invoke(IPC.invoke.projectSet, workspace);
  const { provider: configured } = await app.invoke(IPC.invoke.providersCreate, {
    name: `${skill} fixture`, vendorKey: "custom", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    authKind: "none", apiStyle: "chat_completions", defaultModelId: model, models: [bindingForCustomModel(model)],
  });
  await selectOffice(app, true);
  await waitFor(async () => (await app.invoke(IPC.invoke.composerCommands)).commands.some((command) => command.skillId === id),
    15_000, `Office ${skill} skill registration`, 150);
  await runTurn(app, configured.id, true);
  await verifyOfficeFiles(originalBytes);
  await selectOffice(app, false);
  await stop();
  const restarted = await boot();
  assert.equal((await row(restarted))?.enabled, false);
  await runTurn(restarted, configured.id, false);
  console.log(`PASS: offline ${skill} extension enablement, Bash approval, ${extension} creation, extraction, copy readback, and disablement after restart`);
} catch (error) {
  console.error(log.slice(-6000));
  const pluginLog = await readFile(join(root, "data/logs/app/plugin.log"), "utf8").catch(() => "");
  console.error(pluginLog.split("\n").filter((line) => line.includes("pie.offline-office")).slice(-12).join("\n"));
  console.error("Fixture requests:", requests.map((request) => ({
    roles: request.messages.map((message) => message.role),
    advertised: JSON.stringify(request.messages).includes(id),
    calls: request.messages.flatMap((message) => message.tool_calls?.map((call) => call.function.name) ?? []),
    results: request.messages.filter((message) => message.role === "tool").map((message) => String(message.content).slice(0, 320)),
  })));
  throw error;
} finally {
  await stop();
  provider.close();
  provider.closeAllConnections();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
